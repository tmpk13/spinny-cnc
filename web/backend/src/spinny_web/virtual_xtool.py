"""A virtual xTool F1 on V1 firmware, for the tests and `mise run virtual-f1`.

It answers as the F1 here answered on 2026-11-21 (xtool_v1_recording.json,
the serial number and MAC replaced): machineInfo and runningStatus over
HTTP, `ok` for every G-code line on its TCP port, and `?` as a line with
the position and two oks, the second behind a NUL byte; a `?` with no line
end gets nothing. It follows `G0`/`G1` X and Y for that position and
`M114 S1`/`S2` for the source, and keeps every line it was sent.

What the recording does not say is the virtual F1's own, named so it
cannot pass for the F1's: an empty line gets no answer, a job file handed
over is held as it was sent, and its virtual button (`POST /virtual/button`,
which the F1 has none of) runs the file held, the state reading
VIRTUAL_RUNNING until a stop or `run_seconds` later. The F1's states while
it works, what its upload answers and how a V1 job is started are not
known here (docs/XTOOL_F1.md, checks 5 and on).

`mute` leaves every G-code line unanswered, as a machine that stopped
answering would.
"""

from __future__ import annotations

import argparse
import copy
import email
import email.policy
import json
import re
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from spinny_laser import machines as machine_files

from .xtool import machine_of

RECORDING = Path(__file__).with_name("xtool_v1_recording.json")
IDLE = "P_IDLE"
RUNNING = "VIRTUAL_RUNNING"
BUTTON_PATH = "/virtual/button"
STOP_PATH = "/processing/stop"
# The answer to `?` as the F1 gave it, with its position filled in.
STATUS_ANSWER = "<MPos:{x},{y},0,0>\nok\n\x00ok\n"
# Words of a move: G0 or G1 and its X and Y, spaced or not.
MOVE = re.compile(r"^G0*[01](?![0-9])", re.IGNORECASE)
WORD = re.compile(r"([XY])\s*(-?[0-9]*\.?[0-9]+)", re.IGNORECASE)
SOURCE = re.compile(r"^M114\s*S([12])\s*$", re.IGNORECASE)
# The largest request body taken, bytes.
BODY_LIMIT = 16 << 20


def load_recording(path: Path = RECORDING) -> dict:
    return json.loads(path.read_text(encoding="ascii"))


class VirtualXtool:
    """The virtual F1: a G-code port and an HTTP port on `host`, port 0
    picking free ones. `firmware` puts another package version in its info."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        gcode_port: int = 0,
        http_port: int = 0,
        firmware: str | None = None,
        upload: str = "/processing/upload",
        run_seconds: float = 2.0,
        mute: bool = False,
        recording: dict | None = None,
    ) -> None:
        self.recording = recording if recording is not None else load_recording()
        self.upload = upload
        self.run_seconds = run_seconds
        self.mute = mute
        self._lock = threading.Lock()
        self.lines: list[str] = []
        self.files: list[tuple[str, str]] = []
        self.stops = 0
        self.mode = IDLE
        self.position = (0.0, 0.0)
        self.source = 1
        self._run_ends = 0.0
        self.info = copy.deepcopy(self.recording["machineInfo"])
        if firmware is not None:
            self.info["data"]["firmware"]["package_version"] = firmware
        virtual = self

        class Lines(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                pending = b""
                while True:
                    chunk = self.request.recv(4096)
                    if not chunk:
                        return
                    pending += chunk
                    while b"\n" in pending:
                        raw, pending = pending.split(b"\n", 1)
                        answer = virtual.answer(raw.rstrip(b"\r").decode("ascii", "replace").strip())
                        if answer:
                            self.request.sendall(answer.encode("ascii"))

        class Requests(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:
                return

            def do_GET(self) -> None:
                self._send(*virtual.http("GET", self.path, b"", ""))

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                if length > BODY_LIMIT:
                    self._send(413, {"code": 413, "msg": "too large"})
                    return
                body = self.rfile.read(length) if length else b""
                self._send(*virtual.http("POST", self.path, body, self.headers.get("Content-Type", "")))

            def _send(self, status: int, answer: dict) -> None:
                payload = json.dumps(answer).encode("ascii")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        class LineServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._line_server = LineServer((host, gcode_port), Lines)
        self._http_server = ThreadingHTTPServer((host, http_port), Requests)
        self._http_server.daemon_threads = True
        self._threads: list[threading.Thread] = []

    @property
    def gcode_port(self) -> int:
        return self._line_server.server_address[1]

    @property
    def http_port(self) -> int:
        return self._http_server.server_address[1]

    def start(self) -> "VirtualXtool":
        for server in (self._line_server, self._http_server):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def close(self) -> None:
        for server in (self._line_server, self._http_server):
            server.shutdown()
            server.server_close()

    def __enter__(self) -> "VirtualXtool":
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.close()

    # --- G-code lines -------------------------------------------------------------

    def answer(self, line: str) -> str:
        """What a line is answered with: `?` the position and two oks, any
        other line ok, an empty line nothing; nothing at all when mute."""
        if not line:
            return ""
        with self._lock:
            self.lines.append(line)
            if line == "?":
                x, y = (f"{v:g}" for v in self.position)
                reply = STATUS_ANSWER.format(x=x, y=y)
            else:
                self._follow(line)
                reply = "ok\n"
        return "" if self.mute else reply

    def _follow(self, line: str) -> None:
        """The spot's place after a move, and the source after a select."""
        selected = SOURCE.match(line)
        if selected:
            self.source = int(selected.group(1))
            return
        if MOVE.match(line):
            x, y = self.position
            for letter, value in WORD.findall(line):
                if letter.upper() == "X":
                    x = float(value)
                else:
                    y = float(value)
            self.position = (x, y)

    # --- HTTP ---------------------------------------------------------------------

    def http(self, method: str, path: str, body: bytes, content_type: str) -> tuple[int, dict]:
        with self._lock:
            if self.mode == RUNNING and time.monotonic() >= self._run_ends:
                self.mode = IDLE
            if method == "GET" and path == "/device/machineInfo":
                return 200, self.info
            if method == "GET" and path == "/device/runningStatus":
                status = copy.deepcopy(self.recording["runningStatus"])
                status["data"]["curMode"]["mode"] = self.mode
                return 200, status
            if method == "POST" and path == self.upload:
                held = _upload(body, content_type)
                if held is None:
                    return 400, {"code": 400, "msg": "virtual F1: no file in the request"}
                self.files.append(held)
                return 200, {"code": 0, "msg": "virtual F1: file held"}
            if path == STOP_PATH:
                self.stops += 1
                self.mode = IDLE
                return 200, {"code": 0, "msg": "Success"}
            if method == "POST" and path == BUTTON_PATH:
                if not self.files:
                    return 409, {"code": 409, "msg": "virtual F1: no file held"}
                self.mode = RUNNING
                self._run_ends = time.monotonic() + self.run_seconds
                return 200, {"code": 0, "msg": "virtual F1: running the file held"}
        return 404, {"code": 404, "msg": f"virtual F1: nothing at {method} {path}"}


def _upload(body: bytes, content_type: str) -> tuple[str, str] | None:
    """The file in an upload: a multipart form's `file` field, or the whole
    body; its name ("" when not given) and its text."""
    if content_type.startswith("multipart/form-data"):
        message = email.message_from_bytes(
            b"Content-Type: " + content_type.encode("ascii", "replace") + b"\r\n\r\n" + body, policy=email.policy.HTTP
        )
        if not message.is_multipart():
            return None
        for part in message.iter_parts():
            if part.get_param("name", header="content-disposition") == "file":
                payload = part.get_payload(decode=True)
                if not isinstance(payload, bytes):
                    return None
                return (part.get_filename() or "", payload.decode("ascii", "replace"))
        return None
    if not body:
        return None
    return ("", body.decode("ascii", "replace"))


def main() -> None:
    parser = argparse.ArgumentParser(description="A virtual xTool F1 on V1 firmware, answering as the F1 here did.")
    parser.add_argument("--machine", help="a machine file whose [link] says the host and ports (default 127.0.0.1:2330 and 2331)")
    parser.add_argument("--host", help="the address to listen on")
    parser.add_argument("--gcode-port", type=int, help="the G-code lines' port")
    parser.add_argument("--http-port", type=int, help="the HTTP port")
    parser.add_argument("--firmware", help="another firmware package version for its info")
    parser.add_argument("--run-seconds", type=float, default=10.0, help="how long the virtual button's run takes (default 10)")
    args = parser.parse_args()
    host, gcode_port, http_port, upload = "127.0.0.1", 2330, 2331, "/processing/upload"
    if args.machine:
        machine = machine_of(machine_files.load(args.machine))
        host, gcode_port, http_port, upload = machine.host, machine.gcode_port, machine.http_port, machine.upload
    host = args.host or host
    gcode_port = args.gcode_port or gcode_port
    http_port = args.http_port or http_port
    virtual = VirtualXtool(host, gcode_port, http_port, firmware=args.firmware, upload=upload, run_seconds=args.run_seconds).start()
    print(f"virtual F1: G-code on {host}:{virtual.gcode_port}, HTTP on {host}:{virtual.http_port}; POST {BUTTON_PATH} presses its button", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        virtual.close()


if __name__ == "__main__":
    main()
