"""The link to a G-code machine: a serial port or a `socket://` url, one
line out at a time, each answered before the next goes, as OpenPnP's
GcodeDriver talks to Marlin, Smoothieware, RepRapFirmware or Grbl. It is
the backend's connection to a machine whose machine file says
`controller = "gcode"`, opened from the top bar like any other.

`ok` (with whatever it carries, as Smoothie's position) answers a line;
`error...` or `!!` refuses it, and an `ok` that may follow the refusal is
taken with it so it does not answer the next line. Marlin's `busy:` keeps
a slow line (a home, a wait for the moves) alive past its timeout. Lines
nobody asked for (a boot banner, `echo:`, `wait`) go to the log only, and
any left over are cleared before the next line goes out, so a late `ok`
can never be taken for the next line's.

Every line out and in goes to `on_line` for the console and the wire
log, a poll's marked so; a link that fails on its own says why to
`on_lost`. A poll (`poll`) goes out only when no line is in flight and no
program is being sent, so it never waits behind a move.

`GcodeMover` lets the cameras' routines move the machine's head: a move,
then the wait command, so a picture is read with the head at rest.

A run sends a job on its own thread (`run_job`): a placement that decides
each next line from what the cameras and the vacuum sensor say (see
placer.py). Every line it sends is counted, and a stop ends it after the
line in flight.
"""

from __future__ import annotations

import queue
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

import serial

from .camera import DONE, ERROR, RUNNING, STOPPED
from .link import check_url
from .log import log
from .openpnp import GcodeMachine, code_of, move_xy, move_z, read_position
from .pnp import Mover, PnpError

OK = re.compile(r"^ok\b", re.IGNORECASE)
REFUSED = re.compile(r"^(error|!!)", re.IGNORECASE)
BUSY = re.compile(r"^(echo:\s*)?busy:", re.IGNORECASE)
READ_TIMEOUT = 0.05
WRITE_TIMEOUT = 2.0
# How long an `ok` that follows a refusal is waited for, s.
TRAILING_OK = 0.3
# The machine's last lines in and out, which its state shows.
LOG_LINES = 60
# A run's last steps in words, which its progress shows.
STEP_LINES = 300


class GcodeLinkError(Exception):
    """The machine is not connected, went away, refused a line or did not answer."""


def open_port(url: str, baud: int):
    """A pyserial port for a machine path or a `socket://host:port` url, held
    by this program alone."""
    check_url(url)
    return serial.serial_for_url(url, baudrate=baud, timeout=READ_TIMEOUT, write_timeout=WRITE_TIMEOUT, exclusive=True)


# What a firmware says of itself (Marlin, RepRapFirmware, Smoothieware
# answer M115 so), asked once a connection is open.
IDENTIFY = "M115"
FIRMWARE = re.compile(r"FIRMWARE_NAME:\s*(.+?)(?:\s+[A-Z_]+:|$)")
MACHINE = re.compile(r"MACHINE_TYPE:\s*(.+?)(?:\s+[A-Z_]+:|$)")


def firmware_of(lines: list[str]) -> dict:
    """The firmware's name and the machine's type in an answer to M115, None where it says none."""
    firmware = machine = None
    for line in lines:
        found = FIRMWARE.search(line)
        if found and firmware is None:
            firmware = found.group(1).strip()
        found = MACHINE.search(line)
        if found and machine is None:
            machine = found.group(1).strip()
    return {"firmware": firmware, "machine": machine}


@dataclass
class RunProgress:
    state: str = RUNNING
    sent: int = 0
    total: int = 0
    part: str | None = None
    placed: list[str] = field(default_factory=list)
    error: str | None = None
    # Parts left out under way, with why: no part came in their tries.
    failed: list[dict] = field(default_factory=list)
    # What the run is doing now, in words (finding the fiducials, a retry).
    doing: str | None = None
    # The job placed, when the run places one.
    job: str | None = None
    # What the run did, a line per step (a pick, a look, a place, a retry),
    # each with its time from the start, the part and how it went.
    steps: deque = field(default_factory=lambda: deque(maxlen=STEP_LINES))
    started: float = field(default_factory=time.monotonic, repr=False)
    finished: float | None = field(default=None, repr=False)

    def note(self, text: str, ref: str | None = None, level: str = "info") -> None:
        self.steps.append({"t": round(time.monotonic() - self.started, 1), "ref": ref, "text": text, "level": level})

    def to_dict(self) -> dict:
        end = self.finished if self.finished is not None else time.monotonic()
        return {
            "state": self.state,
            "sent": self.sent,
            "total": max(self.total, self.sent),
            "part": self.part,
            "placed": list(self.placed),
            "failed": [dict(entry) for entry in self.failed],
            "doing": self.doing,
            "job": self.job,
            "error": self.error,
            "seconds": round(end - self.started, 1),
            "steps": [dict(entry) for entry in self.steps],
        }


class RunContext:
    """What a job sent on the run thread has of the link: `send` a line
    (counted, refused once the run is told to stop), its progress, and
    `publish` to show it."""

    def __init__(self, link: "GcodeLink", timeout: float, progress: RunProgress) -> None:
        self.link = link
        self.timeout = timeout
        self.progress = progress

    def send(self, line: str) -> list[str]:
        if self.link._stop.is_set():
            raise GcodeLinkError("stopped")
        code = code_of(line)
        if not code:
            return []
        reply = self.link.command(code, self.timeout)
        self.progress.sent += 1
        return reply

    def publish(self) -> None:
        self.link._publish()


class GcodeLink:
    """The connected G-code machine: its reader, its lines a line at a time,
    the head's place as last read, and a program being sent to it."""

    def __init__(
        self,
        publish: Callable[[], None],
        opener: Callable[[str, int], Any] = open_port,
        on_line: Callable[[str, str, bool], None] | None = None,
        on_lost: Callable[[str], None] | None = None,
    ) -> None:
        self._publish = publish
        self._opener = opener
        self._on_line = on_line or (lambda direction, text, poll: None)
        self._on_lost = on_lost or (lambda reason: None)
        # A poll's line is in flight: what comes back is the poll's too.
        self._polling = False
        self._port: Any = None
        self._reader: threading.Thread | None = None
        self._replies: queue.Queue[str] = queue.Queue()
        # One line in flight at a time: a command and a program take turns.
        self._lock = threading.Lock()
        self._closing = threading.Event()
        self._stop = threading.Event()
        self._lost: str | None = None
        self._thread: threading.Thread | None = None
        self.url: str | None = None
        self.progress: RunProgress | None = None
        self.position: dict | None = None
        self.homed = False
        # Whether the lights were last switched on, and the vacuum, and its
        # last reading; None until this link switched or read them.
        self.light: bool | None = None
        self.vacuum: bool | None = None
        self.reading: float | None = None
        self.log: deque[dict] = deque(maxlen=LOG_LINES)
        # What the backend has the machine doing outside a program: "Jog"
        # while a goto's moves run to their end, "Home" while it homes.
        self.busy: str | None = None
        # The firmware's name as its answer to M115 gave it, and whether the
        # motors were last switched on (they are at a connect).
        self.firmware: str | None = None
        self.motors = True

    # --- the port ---------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._port is not None and self._lost is None

    @property
    def running(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    @property
    def stopping(self) -> bool:
        """A program being sent has been told to stop."""
        return self._stop.is_set() and self.running

    def connect(self, url: str, baud: int, wait_ms: int, init: tuple[str, ...], timeout: float) -> None:
        if self._port is not None:
            if self._lost is None:
                raise GcodeLinkError("the machine is already connected: disconnect first")
            # A link that was lost lets its port go before a new one opens.
            self.disconnect()
        if not url:
            raise GcodeLinkError("the machine file names no port: set [port] url")
        try:
            port = self._opener(url, baud)
        except (serial.SerialException, OSError, ValueError) as exc:
            raise GcodeLinkError(f"cannot open {url}: {exc}") from exc
        self._closing.clear()
        self._lost = None
        self._replies = queue.Queue()
        self._port = port
        self.url = url
        self.homed = False
        self.position = None
        self.light = None
        self.vacuum = None
        self.reading = None
        self.busy = None
        self.firmware = None
        self.motors = True
        self._reader = threading.Thread(target=self._read_loop, args=(port,), name="gcode-machine-reader", daemon=True)
        self._reader.start()
        self._note("info", f"connected to {url} at {baud} baud")
        try:
            # A board that resets when its port opens says its banner while
            # it boots and takes nothing before; what it says is kept.
            deadline = time.monotonic() + wait_ms / 1000.0
            while time.monotonic() < deadline and self.connected:
                time.sleep(0.02)
            for line in init:
                self.command(line, timeout)
        except GcodeLinkError:
            self.disconnect()
            raise
        finally:
            self._publish()

    def disconnect(self) -> None:
        self._stop.set()
        port, self._port = self._port, None
        self._closing.set()
        if port is not None:
            try:
                port.close()
            except Exception:
                pass
        reader = self._reader
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=1.0)
        self._reader = None
        if self.url is not None:
            self._note("info", f"disconnected from {self.url}")
        self.url = None
        self.busy = None
        self._publish()

    def _read_loop(self, port) -> None:
        pending = b""
        while not self._closing.is_set():
            try:
                chunk = port.read(256)
            except Exception as exc:
                if not self._closing.is_set():
                    self._lose(f"the machine went away: {exc}")
                return
            if not chunk:
                continue
            pending += chunk
            while b"\n" in pending:
                raw, pending = pending.split(b"\n", 1)
                text = raw.decode("utf-8", errors="replace").strip()
                if text:
                    self._note("rx", text)
                    self._replies.put(text)

    def _note(self, direction: str, text: str) -> None:
        self.log.append({"dir": direction, "text": text})
        if direction in ("tx", "rx"):
            self._on_line(direction, text, self._polling)

    def _lose(self, reason: str) -> None:
        """The port failed on its own: nothing more goes out on it."""
        if self._lost is not None:
            return
        self._lost = reason
        self.busy = None
        self._note("error", reason)
        self._on_lost(reason)
        self._publish()

    # --- lines -----------------------------------------------------------------

    def command(self, line: str, timeout: float) -> list[str]:
        """One line out and its answer: the lines that came with its `ok`.
        GcodeLinkError for a refusal, no answer in `timeout` s, or a machine
        that is gone."""
        with self._lock:
            return self._exchange(line, timeout)

    def poll(self, line: str, timeout: float) -> list[str] | None:
        """One line and its answer when nothing else is in flight and no
        program is being sent; None when the line did not go out."""
        if not self._lock.acquire(blocking=False):
            return None
        try:
            if self.running or not self.connected:
                return None
            self._polling = True
            try:
                return self._exchange(line, timeout)
            finally:
                self._polling = False
        finally:
            self._lock.release()

    def _exchange(self, line: str, timeout: float) -> list[str]:
        code = code_of(line)
        if not code:
            return []
        port = self._port
        if port is None or self._lost is not None:
            raise GcodeLinkError(self._lost or "the machine is not connected")
        # What came unasked since the last answer is not this line's.
        while True:
            try:
                self._replies.get_nowait()
            except queue.Empty:
                break
        self._note("tx", code)
        try:
            port.write((code + "\n").encode("ascii"))
        except Exception as exc:
            self._lose(f"the machine went away: {exc}")
            raise GcodeLinkError(self._lost or str(exc)) from exc
        reply: list[str] = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GcodeLinkError(f"'{code}': no answer in {timeout:g} s")
            try:
                text = self._replies.get(timeout=min(0.1, remaining))
            except queue.Empty:
                if self._lost is not None:
                    raise GcodeLinkError(self._lost) from None
                continue
            if OK.match(text):
                reply.append(text)
                return reply
            if REFUSED.match(text):
                self._take_trailing_ok()
                raise GcodeLinkError(f"'{code}': {text}")
            if BUSY.match(text):
                deadline = time.monotonic() + timeout
            reply.append(text)

    def _take_trailing_ok(self) -> None:
        deadline = time.monotonic() + TRAILING_OK
        while time.monotonic() < deadline:
            try:
                text = self._replies.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                return
            if OK.match(text):
                return

    # --- a program ---------------------------------------------------------------

    def run_job(
        self,
        job: Callable[[RunContext], None],
        total: int,
        timeout: float,
        on_end: Callable[[RunProgress], None] | None = None,
        job_id: str | None = None,
    ) -> None:
        """Sends a job on its own thread: `job` sends its lines through the
        context it is given, `total` is how many it means to send, as far
        as it can tell, and `job_id` the board job it places, if any. A job
        raises GcodeLinkError to end in an error."""
        if not self.connected:
            raise GcodeLinkError(self._lost or "the machine is not connected")
        if self.running:
            raise GcodeLinkError("a program is already being sent")
        self._stop.clear()
        self.progress = RunProgress(total=total, job=job_id)
        progress = self.progress
        self._thread = threading.Thread(target=self._run_job, args=(job, timeout, progress, on_end), name="gcode-machine-run", daemon=True)
        self._thread.start()
        self._publish()

    def _run_job(self, job: Callable[[RunContext], None], timeout: float, progress: RunProgress, on_end) -> None:
        try:
            job(RunContext(self, timeout, progress))
            progress.part = None
            progress.doing = None
            progress.total = progress.sent
            progress.state = DONE
        except GcodeLinkError as exc:
            if self._stop.is_set():
                progress.state = STOPPED
                progress.error = "stopped"
            else:
                progress.state = ERROR
                progress.error = str(exc)
                log.warning("gcode machine: %s", exc)
        except Exception as exc:
            progress.state = ERROR
            progress.error = repr(exc)
            log.exception("gcode machine run")
        finally:
            progress.finished = time.monotonic()
            if on_end is not None:
                on_end(progress)
            self._publish()

    def stop(self, line: str) -> None:
        """Stops sending after the line in flight, and sends `line` (a
        quickstop) at once, ahead of its turn; its answer is cleared before
        the next line, like anything else that comes late."""
        self._stop.set()
        port = self._port
        code = code_of(line)
        if code and port is not None and self._lost is None:
            self._note("tx", code)
            try:
                port.write((code + "\n").encode("ascii"))
            except Exception as exc:
                self._lose(f"the machine went away: {exc}")
        self._publish()

    def state(self) -> dict:
        return {
            "connected": self.connected,
            "url": self.url,
            "lost": self._lost,
            "running": self.running,
            "homed": self.homed,
            "position": self.position,
            "light": self.light,
            "vacuum": {"on": self.vacuum, "reading": self.reading},
            "progress": self.progress.to_dict() if self.progress is not None else None,
            "log": list(self.log),
        }


class GcodeMover(Mover):
    """A G-code machine's head: X and Y, Z as the height, every move
    followed by the wait command so a picture is read with the head at
    rest. It serves the up and top cameras' routines, and, given a run's
    `send`, the looks a run takes between a pick and a place; `aborted` is
    a routine's own stop."""

    name = "gcode"
    letters = ("X", "Y")
    can_turn = True

    def __init__(
        self,
        link: GcodeLink,
        machine: GcodeMachine,
        aborted: Callable[[], bool] | None = None,
        send: Callable[[str], list[str]] | None = None,
    ) -> None:
        self.link = link
        self.machine = machine
        self._aborted = aborted or (lambda: False)
        # A run's own sender, which counts the lines it sends.
        self._send = send
        self._at: list[float | None] = [0.0, 0.0, None]

    def check(self) -> None:
        if not self.link.connected:
            raise ValueError("the machine is not connected")
        if self.link.running:
            raise PnpError("a program is being sent to the machine")
        if not self.machine.position:
            raise ValueError("the machine file has no position command, which the cameras' routines need")

    def begin(self) -> None:
        # The cameras see by the profile's lights: on before the first look.
        if self.machine.light_on and self.link.light is not True:
            for line in self.machine.light_on:
                self._command(line)
            self.link.light = True
        position = read_position(self._command(self.machine.position), self.machine.axes)
        if "x" not in position or "y" not in position:
            raise PnpError(f"'{self.machine.position}' answered no {self.machine.axes[0]} and {self.machine.axes[1]}")
        self._at = [position["x"], position["y"], position.get("z")]

    def stopped(self) -> bool:
        return self.link.stopping or self._aborted()

    def here(self):
        return (float(self._at[0]), float(self._at[1]))

    def height(self) -> float | None:
        return self._at[2]

    def lift(self) -> None:
        # To the safe height from either side: on a seesaw Z (two nozzles on
        # one motor) a Z above it lowers the other nozzle.
        z = self._at[2]
        if z is None or abs(z - self.machine.safe_z) > 1e-6:
            self._z(self.machine.safe_z)

    def go(self, point) -> None:
        self._command(move_xy(self.machine, (point[0], point[1])))
        self._wait()
        self._at[0], self._at[1] = float(point[0]), float(point[1])

    def lower(self, height: float) -> None:
        self._z(height)

    def halt(self) -> None:
        self.link.stop(self.machine.stop)

    def turn(self, degrees: float) -> None:
        self._command(move_xy(self.machine, None, degrees))
        self._wait()

    def _z(self, height: float) -> None:
        self._command(move_z(self.machine, height))
        self._wait()
        self._at[2] = height

    def _wait(self) -> None:
        if self.machine.wait:
            self._command(self.machine.wait)

    def _command(self, line: str) -> list[str]:
        if self.stopped():
            raise PnpError("stopped")
        try:
            if self._send is not None:
                return self._send(line)
            return self.link.command(line, self.machine.timeout)
        except GcodeLinkError as exc:
            raise PnpError(str(exc)) from exc
