"""The link to a G-code device: a serial port or a `socket://` url, one
line out at a time, each answered before the next goes, as OpenPnP's
GcodeDriver talks to Marlin, Smoothieware, RepRapFirmware or Grbl.

`ok` (with whatever it carries, as Smoothie's position) answers a line;
`error...` or `!!` refuses it, and an `ok` that may follow the refusal is
taken with it so it does not answer the next line. Marlin's `busy:` keeps
a slow line (a home, a wait for the moves) alive past its timeout. Lines
nobody asked for (a boot banner, `echo:`, `wait`) go to the log only, and
any left over are cleared before the next line goes out, so a late `ok`
can never be taken for the next line's.

`DeviceMover` lets the up camera's routines move the device's head: a
move, then the wait command, so a picture is read with the head at rest.
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

from .link import check_url
from .log import log
from .openpnp import Block, Device, Plan, code_of, num, read_position
from .pnp import Mover, PnpError

OK = re.compile(r"^ok\b", re.IGNORECASE)
REFUSED = re.compile(r"^(error|!!)", re.IGNORECASE)
BUSY = re.compile(r"^(echo:\s*)?busy:", re.IGNORECASE)
READ_TIMEOUT = 0.05
WRITE_TIMEOUT = 2.0
# How long an `ok` that follows a refusal is waited for, s.
TRAILING_OK = 0.3
LOG_LINES = 200
RUNNING, DONE, STOPPED, ERROR = "running", "done", "stopped", "error"


class DeviceLinkError(Exception):
    """The device is not connected, went away, refused a line or did not answer."""


def open_port(url: str, baud: int):
    """A pyserial port for a device path or a `socket://host:port` url, held
    by this program alone."""
    check_url(url)
    return serial.serial_for_url(url, baudrate=baud, timeout=READ_TIMEOUT, write_timeout=WRITE_TIMEOUT, exclusive=True)


@dataclass
class RunProgress:
    state: str = RUNNING
    sent: int = 0
    total: int = 0
    part: str | None = None
    placed: list[str] = field(default_factory=list)
    error: str | None = None
    started: float = field(default_factory=time.monotonic, repr=False)
    finished: float | None = field(default=None, repr=False)

    def to_dict(self) -> dict:
        end = self.finished if self.finished is not None else time.monotonic()
        return {
            "state": self.state,
            "sent": self.sent,
            "total": self.total,
            "part": self.part,
            "placed": list(self.placed),
            "error": self.error,
            "seconds": round(end - self.started, 1),
        }


class GcodeDevice:
    """One G-code device, its reader, and a program being sent to it."""

    def __init__(self, publish: Callable[[], None], opener: Callable[[str, int], Any] = open_port) -> None:
        self._publish = publish
        self._opener = opener
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
        self.log: deque[dict] = deque(maxlen=LOG_LINES)

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
            raise DeviceLinkError("the device is already connected: disconnect first")
        if not url:
            raise DeviceLinkError("the device profile names no port: set [port] url")
        try:
            port = self._opener(url, baud)
        except (serial.SerialException, OSError, ValueError) as exc:
            raise DeviceLinkError(f"cannot open {url}: {exc}") from exc
        self._closing.clear()
        self._lost = None
        self._replies = queue.Queue()
        self._port = port
        self.url = url
        self.homed = False
        self.position = None
        self._reader = threading.Thread(target=self._read_loop, args=(port,), name="gcode-device-reader", daemon=True)
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
        except DeviceLinkError:
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
        self._publish()

    def _read_loop(self, port) -> None:
        pending = b""
        while not self._closing.is_set():
            try:
                chunk = port.read(256)
            except Exception as exc:
                if not self._closing.is_set():
                    self._lost = f"the device went away: {exc}"
                    self._note("error", self._lost)
                    self._publish()
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

    # --- lines -----------------------------------------------------------------

    def command(self, line: str, timeout: float) -> list[str]:
        """One line out and its answer: the lines that came with its `ok`.
        DeviceLinkError for a refusal, no answer in `timeout` s, or a device
        that is gone."""
        with self._lock:
            return self._exchange(line, timeout)

    def _exchange(self, line: str, timeout: float) -> list[str]:
        code = code_of(line)
        if not code:
            return []
        port = self._port
        if port is None or self._lost is not None:
            raise DeviceLinkError(self._lost or "the device is not connected")
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
            self._lost = f"the device went away: {exc}"
            raise DeviceLinkError(self._lost) from exc
        reply: list[str] = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DeviceLinkError(f"'{code}': no answer in {timeout:g} s")
            try:
                text = self._replies.get(timeout=min(0.1, remaining))
            except queue.Empty:
                if self._lost is not None:
                    raise DeviceLinkError(self._lost) from None
                continue
            if OK.match(text):
                reply.append(text)
                return reply
            if REFUSED.match(text):
                self._take_trailing_ok()
                raise DeviceLinkError(f"'{code}': {text}")
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

    def run(
        self,
        plan: Plan,
        timeout: float,
        on_block: Callable[[Block], None],
        on_end: Callable[[RunProgress], None] | None = None,
        look: Callable[[Block], list[str]] | None = None,
    ) -> None:
        """Sends a program on its own thread; `on_block` hears of every part
        once its last line is answered, so a stop leaves the feeders counted
        by what was picked. `look`, for a part marked for the up camera, is
        called between its pick and its place and answers the place lines
        to send instead, made from where the part was seen."""
        if not self.connected:
            raise DeviceLinkError(self._lost or "the device is not connected")
        if self.running:
            raise DeviceLinkError("a program is already being sent")
        if not plan.blocks:
            raise DeviceLinkError("the program places no part")
        lines = [code_of(line) for line in plan.head] + [code_of(line) for block in plan.blocks for line in block.lines] + [code_of(line) for line in plan.tail]
        self._stop.clear()
        self.progress = RunProgress(total=sum(1 for line in lines if line))
        progress = self.progress
        self._thread = threading.Thread(target=self._run, args=(plan, timeout, progress, on_block, on_end, look), name="gcode-device-run", daemon=True)
        self._thread.start()
        self._publish()

    def _send(self, line: str, timeout: float, progress: RunProgress) -> None:
        if self._stop.is_set():
            raise DeviceLinkError("stopped")
        code = code_of(line)
        if not code:
            return
        self.command(code, timeout)
        progress.sent += 1

    def _run(self, plan: Plan, timeout: float, progress: RunProgress, on_block, on_end, look) -> None:
        try:
            for line in plan.head:
                self._send(line, timeout, progress)
            for block in plan.blocks:
                progress.part = block.ref
                self._publish()
                for line in block.pick:
                    self._send(line, timeout, progress)
                place = block.place
                if block.vision and look is not None:
                    if self._stop.is_set():
                        raise DeviceLinkError("stopped")
                    place = look(block)
                    self._publish()
                for line in place:
                    self._send(line, timeout, progress)
                progress.placed.append(block.ref)
                on_block(block)
                self._publish()
            for line in plan.tail:
                self._send(line, timeout, progress)
            progress.part = None
            progress.state = DONE
        except DeviceLinkError as exc:
            if self._stop.is_set():
                progress.state = STOPPED
                progress.error = "stopped"
            else:
                progress.state = ERROR
                progress.error = str(exc)
                log.warning("gcode device: %s", exc)
        except Exception as exc:
            progress.state = ERROR
            progress.error = repr(exc)
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
                self._lost = f"the device went away: {exc}"
        self._publish()

    def state(self) -> dict:
        return {
            "connected": self.connected,
            "url": self.url,
            "lost": self._lost,
            "running": self.running,
            "homed": self.homed,
            "position": self.position,
            "progress": self.progress.to_dict() if self.progress is not None else None,
            "log": list(self.log)[-60:],
        }


class DeviceMover(Mover):
    """A G-code device's head for the up camera's routines: X and Y, Z as
    the height, every move followed by the wait command so a picture is
    read with the head at rest. `in_run` lets a program being sent use it
    between a pick and a place; `aborted` is the routine's own stop."""

    name = "device"
    letters = ("X", "Y")

    def __init__(self, link: GcodeDevice, device: Device, in_run: bool = False, aborted: Callable[[], bool] | None = None) -> None:
        self.link = link
        self.device = device
        self.in_run = in_run
        self._aborted = aborted or (lambda: False)
        self._at: list[float | None] = [0.0, 0.0, None]

    def check(self) -> None:
        if not self.link.connected:
            raise ValueError("the device is not connected")
        if self.link.running and not self.in_run:
            raise PnpError("a program is being sent to the device")
        if not self.device.position:
            raise ValueError("the device profile has no position command, which the up camera's routines need")

    def begin(self) -> None:
        position = read_position(self._command(self.device.position), self.device.axes)
        if "x" not in position or "y" not in position:
            raise PnpError(f"'{self.device.position}' answered no {self.device.axes[0]} and {self.device.axes[1]}")
        self._at = [position["x"], position["y"], position.get("z")]

    def stopped(self) -> bool:
        return self.link.stopping or self._aborted()

    def here(self):
        return (float(self._at[0]), float(self._at[1]))

    def height(self) -> float | None:
        return self._at[2]

    def lift(self) -> None:
        z = self._at[2]
        if z is None or z < self.device.safe_z - 1e-6:
            self._z(self.device.safe_z)

    def go(self, point) -> None:
        x, y, _, _ = self.device.axes
        self._command(f"{self.device.move} {x}{num(point[0])} {y}{num(point[1])} F{num(self.device.feed_xy, 0)}")
        self._wait()
        self._at[0], self._at[1] = float(point[0]), float(point[1])

    def lower(self, height: float) -> None:
        self._z(height)

    def halt(self) -> None:
        if not self.in_run:
            self.link.stop(self.device.stop)

    def _z(self, height: float) -> None:
        self._command(f"{self.device.move} {self.device.axes[2]}{num(height)} F{num(self.device.feed_z, 0)}")
        self._wait()
        self._at[2] = height

    def _wait(self) -> None:
        if self.device.wait:
            self._command(self.device.wait)

    def _command(self, line: str) -> list[str]:
        if self.stopped():
            raise PnpError("stopped")
        try:
            return self.link.command(line, self.device.timeout)
        except DeviceLinkError as exc:
            raise PnpError(str(exc)) from exc
