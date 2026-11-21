"""The link to an xTool galvo: one transport per firmware generation.

A transport does what every generation must: read the machine's info
(`info`), read what it is doing (`state`), hand it a whole job file
(`send_job`) and stop it (`stop`). The machine file's `[firmware]
generation` picks it (`transport_for`); a firmware that talks another way
is one more transport behind the same four calls, and the writer, the
machine file and whatever drives them stay as they are.

`check_firmware` holds the info to the machine file: a firmware package
the file has not been tried with, or another kind of machine, refuses to
run until the file says otherwise.

V1 is the F1's firmware before 40.51.020.04 (docs/XTOOL_F1.md). It
answers JSON over HTTP, `{"code": 0, "data": ..., "msg": "Success"}`, a
nonzero code or `"result": "fail"` being a refusal, and takes G-code on a
TCP port with an `ok` for every line. Its `?` is a line, and is answered
with the position and two oks, so the line stream, which keeps step by
counting oks, never sends one; the state comes from HTTP instead. A stop
goes over HTTP, out of band: it does not wait behind lines the socket
still holds. It never talks to port 8087, where the F1 takes firmware.
"""

from __future__ import annotations

import json
import secrets
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from .xtool import FIRMWARE_PORT, LINE, XtoolMachine

# The states the F1 reports at rest: idle, and done with the last job (a
# line session that ended with $P left it at P_WORK_DONE until the next).
# Anything else is reported as it reads.
REST = ("P_IDLE", "P_WORK_DONE")
# A file handed over and waiting for the machine's button, and one running,
# as (mode, subMode) (check 5, 2026-11-21).
READY = ("Work", "workReady")
WORKING = ("Work", "working")
# V1's HTTP paths, the upload's aside (the machine file says where).
INFO_PATH = "/device/machineInfo"
STATUS_PATH = "/device/runningStatus"
STOP_PATH = "/processing/stop"
# The largest answer read from the machine, bytes.
ANSWER_LIMIT = 1 << 20


class XtoolError(RuntimeError):
    """The machine could not be reached, refused, or answered out of turn."""


def _table(data: dict, key: str) -> dict:
    """A table in an answer, empty when the answer has none there."""
    value = data.get(key)
    return value if isinstance(value, dict) else {}


@dataclass(frozen=True)
class Info:
    """What machineInfo says of the machine: the firmware package, the
    machine type, the field (None when not said) and the sources."""

    firmware: str
    machine_type: str
    size: tuple[float, float] | None
    sources: tuple[str, ...]

    @classmethod
    def from_data(cls, data: dict) -> "Info":
        firmware = _table(data, "firmware")
        size = None
        work = data.get("workSize")
        if isinstance(work, dict) and all(isinstance(work.get(k), (int, float)) and not isinstance(work.get(k), bool) for k in ("x", "y")):
            size = (float(work["x"]), float(work["y"]))
        sources = data.get("laserType")
        return cls(
            firmware=str(firmware.get("package_version") or ""),
            machine_type=str(data.get("machineType") or ""),
            size=size,
            sources=tuple(str(s) for s in sources) if isinstance(sources, list) else (),
        )

    def to_dict(self) -> dict:
        return {"firmware": self.firmware, "machine_type": self.machine_type, "size": list(self.size) if self.size else None, "sources": list(self.sources)}


@dataclass(frozen=True)
class State:
    """What runningStatus says the machine is doing: its mode and submode as
    it names them, the task it reports, and the alarm it has now (None for none)."""

    mode: str
    sub_mode: str
    task: str
    alarm: object

    @property
    def at_rest(self) -> bool:
        return self.mode in REST

    @property
    def ready(self) -> bool:
        """A file is held, waiting for the machine's button."""
        return (self.mode, self.sub_mode) == READY

    @property
    def working(self) -> bool:
        return (self.mode, self.sub_mode) == WORKING

    @classmethod
    def from_data(cls, data: dict) -> "State":
        mode = _table(data, "curMode")
        alarm = _table(data, "curAlarmInfo")
        return cls(
            mode=str(mode.get("mode") or ""),
            sub_mode=str(mode.get("subMode") or ""),
            task=str(mode.get("taskId") or ""),
            alarm=alarm.get("alarm"),
        )

    def to_dict(self) -> dict:
        return {"mode": self.mode, "sub_mode": self.sub_mode, "task": self.task, "alarm": self.alarm, "at_rest": self.at_rest, "ready": self.ready, "working": self.working}


class Transport(Protocol):
    """What every firmware generation's transport does."""

    machine: XtoolMachine

    def info(self) -> Info: ...

    def state(self) -> State: ...

    def send_job(self, text: str, name: str) -> dict: ...

    def stop(self) -> str: ...

    def close(self) -> None: ...


def transport_for(machine: XtoolMachine, host: str | None = None, gcode_port: int | None = None, http_port: int | None = None) -> "V1Transport":
    """The transport for the machine's firmware generation; the host and
    ports may be put elsewhere (a virtual F1) without another file."""
    if machine.generation == "v1":
        return V1Transport(machine, host, gcode_port, http_port)
    raise XtoolError(f"{machine.name}: no transport for firmware generation {machine.generation!r}")


def check_firmware(info: Info, machine: XtoolMachine) -> None:
    """Refuses a machine whose firmware the file has not been tried with,
    or that says it is another kind of machine."""
    if machine.machine_type and info.machine_type != machine.machine_type:
        raise XtoolError(
            f"{machine.name}: the machine says it is type {info.machine_type or '(none)'}, the file is for {machine.machine_type}"
        )
    if info.firmware not in machine.tried:
        raise XtoolError(
            f"{machine.name} runs firmware {info.firmware or '(none said)'}, which this file has not been tried with"
            f" ({', '.join(machine.tried)}): try it as docs/XTOOL_F1.md says, then add it to [firmware] tried"
        )


class V1Transport:
    """The F1's firmware before 40.51.020.04: JSON over HTTP, G-code lines on TCP."""

    def __init__(self, machine: XtoolMachine, host: str | None = None, gcode_port: int | None = None, http_port: int | None = None) -> None:
        self.machine = machine
        self.host = host or machine.host
        self.gcode_port = gcode_port or machine.gcode_port
        self.http_port = http_port or machine.http_port
        if FIRMWARE_PORT in (self.gcode_port, self.http_port):
            raise XtoolError(f"port {FIRMWARE_PORT} is the F1's firmware update service, which this backend never talks to")
        self.timeout = machine.timeout

    # --- HTTP -------------------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"http://{self.host}:{self.http_port}{path}"

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> object:
        """One HTTP request; the answer's JSON unwrapped to its data, the
        answer's text when it is not JSON. A refusal raises."""
        request = urllib.request.Request(self._url(path), data=body, method=method)
        if content_type:
            request.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as answer:
                raw = answer.read(ANSWER_LIMIT + 1)
        except urllib.error.HTTPError as exc:
            raise XtoolError(f"{self.machine.name}: {method} {path} answered HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise XtoolError(f"{self.machine.name} at {self.host}:{self.http_port} did not answer {method} {path}: {reason}") from exc
        if len(raw) > ANSWER_LIMIT:
            raise XtoolError(f"{self.machine.name}: {method} {path} answered more than {ANSWER_LIMIT} bytes")
        text = raw.decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except ValueError:
            return text
        if isinstance(data, dict):
            code = data.get("code", 0)
            if (code not in (0, None) and not isinstance(code, bool)) or data.get("result") == "fail":
                raise XtoolError(f"{self.machine.name} refused {method} {path}: {data.get('msg') or data.get('result') or code}")
            return data.get("data", data)
        return data

    def info(self) -> Info:
        data = self._request("GET", INFO_PATH)
        if not isinstance(data, dict):
            raise XtoolError(f"{self.machine.name}: {INFO_PATH} did not answer with the machine's info")
        return Info.from_data(data)

    def state(self) -> State:
        data = self._request("GET", STATUS_PATH)
        if not isinstance(data, dict):
            raise XtoolError(f"{self.machine.name}: {STATUS_PATH} did not answer with the machine's state")
        return State.from_data(data)

    def send_job(self, text: str, name: str) -> dict:
        """Hands the machine a whole job file at the file's upload path, as
        a form's `file` field or as the request's body; what it answered.
        Nothing here starts the job: the F1 holds it as Work/workReady
        until its own button is pressed (check 5)."""
        if not LINE.match(name) or not name or "/" in name or '"' in name:
            raise XtoolError(f"{name!r} is not a file name to hand over")
        payload = text.encode("ascii")
        if self.machine.upload_as == "multipart":
            boundary = f"spinny{secrets.token_hex(12)}"
            body = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode("ascii") + payload + f"\r\n--{boundary}--\r\n".encode("ascii")
            answer = self._request("POST", self.machine.upload, body, f"multipart/form-data; boundary={boundary}")
        else:
            answer = self._request("POST", self.machine.upload, payload, "text/plain")
        return {"path": self.machine.upload, "bytes": len(payload), "answer": answer}

    def stop(self) -> str:
        """Stops whatever the machine runs: POST to the stop path, then GET
        when the POST is refused, as BeamInk does; the method that took."""
        try:
            self._request("POST", STOP_PATH)
            return "POST"
        except XtoolError as first:
            try:
                self._request("GET", STOP_PATH)
                return "GET"
            except XtoolError as second:
                raise XtoolError(f"{second} (POST: {first})") from second

    # --- G-code lines -------------------------------------------------------------

    def send_lines(self, lines: list[str]) -> list[str]:
        """Sends lines on the G-code port, each written once the last one
        was answered `ok`; what each line was answered, ok included. An
        error, an alarm or a line left unanswered for the timeout ends the
        connection, since an answer that comes late would be taken for the
        next line's. `?` is refused: the F1 answers it twice."""
        for line in lines:
            if not isinstance(line, str) or not LINE.match(line) or not line.strip():
                raise XtoolError(f"{line!r} is not one line of printable ASCII")
            if line.strip() == "?":
                raise XtoolError("? is answered with two oks on V1, which would put every later answer out of step: read the state instead")
        answers: list[str] = []
        try:
            connection = socket.create_connection((self.host, self.gcode_port), timeout=self.timeout)
        except OSError as exc:
            raise XtoolError(f"{self.machine.name} at {self.host}:{self.gcode_port} took no connection: {exc}") from exc
        with connection:
            pending = b""
            for line in lines:
                connection.sendall(line.strip().encode("ascii") + b"\n")
                said: list[str] = []
                deadline = time.monotonic() + self.timeout
                while True:
                    while b"\n" not in pending:
                        left = deadline - time.monotonic()
                        if left <= 0:
                            raise XtoolError(f"{self.machine.name} did not answer {line.strip()!r} in {self.timeout:g} s: the connection is let go")
                        connection.settimeout(left)
                        try:
                            chunk = connection.recv(4096)
                        except socket.timeout:
                            continue
                        except OSError as exc:
                            raise XtoolError(f"{self.machine.name} dropped the connection at {line.strip()!r}: {exc}") from exc
                        if not chunk:
                            raise XtoolError(f"{self.machine.name} closed the connection at {line.strip()!r}")
                        pending += chunk.replace(b"\x00", b"")
                    raw, pending = pending.split(b"\n", 1)
                    answer = raw.decode("ascii", "replace").strip()
                    if not answer:
                        continue
                    said.append(answer)
                    lowered = answer.lower()
                    if lowered == "ok":
                        break
                    if lowered.startswith(("error", "alarm")):
                        raise XtoolError(f"{self.machine.name} answered {line.strip()!r} with {answer}")
                answers.append("\n".join(said))
        return answers

    def close(self) -> None:
        """Nothing stays open between calls: each opens and closes its own."""
