"""The camera, through pcb-vision's `pcbv serve`.

pcbv owns the capture and the localizer and answers a line protocol: one
JSON request a line, one JSON reply a line in the same order carrying the
request's id, and a frame's JPEG bytes right after its reply line. The
backend runs it as a program on a device here, or reaches one serving over
TCP elsewhere (a `socket://host:port` device, a Raspberry Pi with the
camera). Either way one request is in flight at a time, each with an id of
its own; a reader thread takes the replies off the stream so a request can
time out instead of blocking the caller for good.
"""

from __future__ import annotations

import itertools
import json
import os
import queue
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

from .log import log

# How long pcbv has to answer: a board load reads and rasterizes a file, a
# camera open waits for its first frame.
REQUEST_SECONDS = 6.0
LOAD_SECONDS = 30.0
# How long a request waits for its turn behind the one in flight. That one
# can take its whole time when pcbv is slow or silent, and callers queued
# behind it would each hold a thread (the server's route threads among
# them, which Stop and Hold need too) for every turn ahead of theirs.
TURN_SECONDS = 1.0
# The largest frame taken from the stream, bytes.
MAX_FRAME_BYTES = 32 * 1024 * 1024
# The width, px, a pcbv started here scales each frame down to before it
# looks for a board or a spot in it.
WORK_WIDTH = 1024
# Where the pcbv program is looked for when the settings name it by a
# bare name that is not on PATH: the sibling repository's builds.
PCBV_SIBLING = Path(__file__).resolve().parents[5] / "pcb-vision" / "target"


class VisionError(Exception):
    """pcbv could not be started, went away, or refused a request."""


def find_pcbv(name: str) -> str:
    """The pcbv program to run: a path as given, a name on PATH, or that
    name in the sibling repository's release or debug build."""
    name = (name or "pcbv").strip() or "pcbv"
    if os.sep in name:
        if Path(name).is_file():
            return name
        raise VisionError(f"pcbv is not at {name}")
    found = shutil.which(name)
    if found:
        return found
    for build in ("release", "debug"):
        candidate = PCBV_SIBLING / build / name
        if candidate.is_file():
            return str(candidate)
    raise VisionError(
        f"{name} is not on PATH and not built in {PCBV_SIBLING}: build pcb-vision (mise run build-pcbv),"
        " or name the program in the camera settings"
    )


class _Stream:
    """A byte stream to pcbv: a program's pipes, or a socket, and the
    replies its reader thread has taken off it."""

    def __init__(self, reader, writer, process: subprocess.Popen | None, sock: socket.socket | None) -> None:
        self._reader = reader
        self._writer = writer
        self.process = process
        self._socket = sock
        # Each stream's replies are its own: a reader still draining a
        # stream that was closed can never answer a request on the next.
        self.replies: queue.Queue[tuple[dict, bytes] | Exception] = queue.Queue()

    def write(self, data: bytes) -> None:
        self._writer.write(data)
        self._writer.flush()

    def readline(self) -> bytes:
        return self._reader.readline()

    def read_exactly(self, count: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < count:
            chunk = self._reader.read(count - len(chunks))
            if not chunk:
                break
            chunks.extend(chunk)
        return bytes(chunks)

    @property
    def alive(self) -> bool:
        if self.process is not None:
            return self.process.poll() is None
        return self._socket is not None

    def close(self) -> None:
        try:
            self._writer.close()
        except OSError:
            pass
        if self._socket is not None:
            try:
                self._socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._socket.close()
            self._socket = None
        if self.process is not None:
            try:
                self.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2.0)


class VisionClient:
    """One pcbv, started or connected, and the requests to it."""

    def __init__(self) -> None:
        self._stream: _Stream | None = None
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        # Request ids, never reused while the client lives, so no reply to
        # an earlier request, on this stream or one before it, carries the
        # id a request waits for.
        self._ids = itertools.count(1)
        self.device: str | None = None

    @property
    def running(self) -> bool:
        return self._stream is not None and self._stream.alive

    def start(self, device: str, size: str, fps: int, pcbv: str) -> dict:
        """Starts pcbv on the device, or connects to one serving at a
        `socket://host:port` device; answers its `hello`."""
        said: list[str] = []
        stderr: threading.Thread | None = None
        with self._lock:
            if self._stream is not None:
                raise VisionError("the camera is already running")
            if device.startswith("socket://"):
                host, _, port = device[len("socket://"):].rpartition(":")
                try:
                    sock = socket.create_connection((host or "127.0.0.1", int(port)), timeout=5.0)
                except (OSError, ValueError) as exc:
                    raise VisionError(f"cannot reach pcbv at {device}: {exc}") from exc
                sock.settimeout(None)
                stream = _Stream(sock.makefile("rb"), sock.makefile("wb"), None, sock)
            else:
                program = find_pcbv(pcbv)
                command = [program, "serve", "--camera", device, "--size", size, "--fps", str(int(fps)), "--work-width", str(WORK_WIDTH)]
                try:
                    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                except OSError as exc:
                    raise VisionError(f"cannot start {program}: {exc}") from exc
                assert process.stdin is not None and process.stdout is not None and process.stderr is not None
                stderr = threading.Thread(target=self._log_stderr, args=(process.stderr, said), name="pcbv-stderr", daemon=True)
                stderr.start()
                stream = _Stream(process.stdout, process.stdin, process, None)
            self._stream = stream
            self.device = device
            self._reader = threading.Thread(target=self._read_replies, args=(stream,), name="pcbv-reader", daemon=True)
            self._reader.start()
        try:
            hello = self.request("hello", timeout=REQUEST_SECONDS)
        except VisionError as exc:
            self.close()
            if device.startswith("socket://"):
                # A port forwarded over ssh takes the connection here and
                # closes it when nothing listens at the far end.
                raise VisionError(
                    f"no pcbv answers at {device} ({exc}): a port forwarded from a Pi has no camera unit serving it there"
                ) from exc
            # A pcbv that could not open its camera says why on stderr
            # and ends; the reason belongs in the error, not only the log.
            if stderr is not None:
                stderr.join(timeout=1.0)
                if said:
                    raise VisionError(f"{exc}: {said[-1]}") from exc
            raise
        try:
            if device.startswith("socket://"):
                # A pcbv serving elsewhere opened its camera with the size
                # and rate on its own command line; the ones asked for here
                # replace them.
                if not hello.get("camera"):
                    raise VisionError(f"pcbv at {device} has no camera open")
                width, height = (int(v) for v in size.split("x"))
                self.request("camera", timeout=REQUEST_SECONDS, path=hello["camera"], width=width, height=height, fps=int(fps))
            return hello
        except VisionError:
            self.close()
            raise

    def close(self) -> None:
        with self._lock:
            stream = self._stream
            self._stream = None
            self.device = None
        if stream is not None:
            self._end(stream)

    @staticmethod
    def _end(stream: _Stream) -> None:
        # A pcbv this started is told to end; one serving over TCP would end
        # for every later client too, so it is only left.
        try:
            if stream.alive and stream.process is not None:
                stream.write(json.dumps({"id": 0, "cmd": "quit"}).encode() + b"\n")
        except (OSError, ValueError):
            pass
        stream.close()

    def request(self, cmd: str, timeout: float = REQUEST_SECONDS, **fields) -> dict:
        """One request and its reply; the reply's bytes, for a frame, come
        back under `bytes`. A request that cannot have its turn within
        TURN_SECONDS is refused as busy. When the stream fails, or pcbv
        leaves the request unanswered past its time, the camera is closed:
        every later request then fails at once instead of waiting on a
        silent pcbv, and a reply that comes late has nothing to answer."""
        if not self._lock.acquire(timeout=TURN_SECONDS):
            raise VisionError(f"the camera is busy: {cmd!r} waited {TURN_SECONDS:g} s behind another request")
        broken: tuple[_Stream, str | None] | None = None
        try:
            stream = self._stream
            if stream is None or not stream.alive:
                self._stream = None
                raise VisionError("the camera is not running")
            try:
                reply, data = self._exchange(stream, cmd, timeout, fields)
            except VisionError as exc:
                broken = (stream, self.device)
                self._stream = None
                self.device = None
                log.warning("closed the camera on %s: %s", broken[1], exc)
                raise
        finally:
            self._lock.release()
            if broken is not None:
                self._end(broken[0])
        if "error" in reply:
            raise VisionError(str(reply["error"]))
        if data:
            reply = {**reply, "bytes": data}
        return dict(reply)

    def _exchange(self, stream: _Stream, cmd: str, timeout: float, fields: dict) -> tuple[dict, bytes]:
        """Sends one request and waits for the reply carrying its id; a
        VisionError says the stream is past use."""
        rid = next(self._ids)
        line = json.dumps({"id": rid, "cmd": cmd, **fields}).encode() + b"\n"
        try:
            stream.write(line)
        except (OSError, ValueError) as exc:
            raise VisionError(f"pcbv went away: {exc}") from exc
        deadline = time.monotonic() + timeout
        while True:
            try:
                answer = stream.replies.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                raise VisionError(f"pcbv did not answer {cmd!r} within {timeout:g} s") from None
            if isinstance(answer, Exception):
                raise VisionError(f"pcbv went away: {answer}")
            reply, data = answer
            # A line pcbv cannot read is answered in its turn with a null id.
            if reply.get("id") in (rid, None):
                return reply, data
            log.warning("pcbv answered request %r while %r was awaited: the reply is dropped", reply.get("id"), rid)

    # --- the requests ---------------------------------------------------------

    def board(self, path: str | None, side: str = "front", finish: str = "masked") -> dict:
        if path is None:
            return self.request("board", path=None)
        return self.request("board", timeout=LOAD_SECONDS, path=path, side=side, finish=finish)

    def pose(self) -> dict:
        return self.request("pose")

    def frame(self, width: int | None = None, overlay: bool = False, quality: int = 80) -> tuple[dict, bytes]:
        fields: dict = {"overlay": bool(overlay), "quality": int(quality)}
        if width is not None:
            fields["width"] = int(width)
        reply = self.request("frame", **fields)
        data = reply.pop("bytes", b"")
        reply["bytes"] = len(data)
        return reply, data

    def spot(self, radius: float | None = None, polarity: str = "dark", min_area: float | None = None, max_area: float | None = None) -> dict:
        """The spot of that shade nearest the picture's center, within
        `radius` px, of `min_area` to `max_area` px when given."""
        fields: dict = {"polarity": polarity}
        if radius is not None:
            fields["radius"] = float(radius)
        if min_area is not None:
            fields["min_area"] = float(min_area)
        if max_area is not None:
            fields["max_area"] = float(max_area)
        return self.request("spot", **fields)

    # --- the threads ----------------------------------------------------------

    def _read_replies(self, stream: _Stream) -> None:
        try:
            while True:
                line = stream.readline()
                if not line:
                    raise VisionError("pcbv closed its output")
                try:
                    reply = json.loads(line)
                except ValueError as exc:
                    raise VisionError(f"pcbv said something that is not JSON: {line[:80]!r}") from exc
                if not isinstance(reply, dict):
                    raise VisionError(f"pcbv answered with {type(reply).__name__}, not an object")
                data = b""
                count = reply.get("bytes")
                if isinstance(count, int) and count > 0:
                    if count > MAX_FRAME_BYTES:
                        raise VisionError(f"pcbv announced a frame of {count} bytes")
                    data = stream.read_exactly(count)
                    if len(data) != count:
                        raise VisionError("pcbv's frame ended early")
                stream.replies.put((reply, data))
        except Exception as exc:
            stream.replies.put(exc)

    @staticmethod
    def _log_stderr(pipe, said: list[str]) -> None:
        try:
            for raw in iter(pipe.readline, b""):
                text = raw.decode("utf-8", errors="replace").rstrip()
                if text:
                    log.info("pcbv: %s", text)
                    said.append(text)
                    del said[:-3]
        except (OSError, ValueError):
            pass
