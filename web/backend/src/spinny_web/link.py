"""Serial link to the firmware: lines out under credits, lines in classified.

The firmware answers every line with exactly one `ok` or `error:` line and
keeps a fixed number of lines waiting, so the link never has more than that
many unanswered lines in flight; realtime bytes bypass the credits. A reader
thread accumulates bytes and splits on newline, so a line is only ever
decoded whole, and the input buffer is never flushed: the banner, messages
and alarms arrive unasked and would be lost.
"""

from __future__ import annotations

import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

import serial

DEFAULT_CREDITS = 16
BAUD = 115200
# The reader wakes at least this often to notice a close request.
READ_TIMEOUT = 0.05
WRITE_TIMEOUT = 2.0
POLL_IDLE = 0.2
POLL_MOVING = 0.1
MOVING_STATES = ("Run", "Jog", "Hold")
MAX_LINE = 96

# What a port raises once it is gone. pyserial does not settle on one
# exception: a closed socket url leaves its handler reading from None, and
# a closed file object raises ValueError, so both reach the caller as
# something other than SerialException.
PORT_ERRORS = (serial.SerialException, OSError, TypeError, AttributeError, ValueError)

REALTIME_STATUS = b"?"
REALTIME_HOLD = b"!"
REALTIME_RESUME = b"~"
REALTIME_RESET = b"\x18"
REALTIME_JOG_CANCEL = b"\x85"

_BANNER = re.compile(r"^\[spinny v(?P<version>[^\s\]]+)(?P<rest>[^\]]*)\]$")
_BANNER_FIELD = re.compile(r"(\w+):(\d+)")


class LinkError(Exception):
    """The link could not do what was asked."""


class LinkClosed(LinkError):
    """The port is closed or went away."""


class LinkTimeout(LinkError):
    """No answer in time."""


class CommandError(LinkError):
    """The firmware answered with an error line."""

    def __init__(self, line: str, response: str) -> None:
        super().__init__(f"{line!r}: {response}")
        self.line = line
        self.response = response


@dataclass
class Status:
    """One parsed status report."""

    state: str = "Idle"
    alarm: int | None = None
    r: float = 0.0
    a: float = 0.0
    # Cross slide position in mm. A firmware that does not report the field
    # leaves it at zero, which is what a machine without the axis reads as.
    z: float = 0.0
    rate: float = 0.0
    laser: int = 0
    planner: int = 0
    lines: int = 0
    mode: str = "dyn"
    enabled: bool = False
    raw: str = ""

    @property
    def moving(self) -> bool:
        return self.state in MOVING_STATES

    @property
    def joint(self) -> tuple[float, float]:
        return (self.r, self.a)


@dataclass
class Banner:
    version: str
    lines: int = DEFAULT_CREDITS
    blocks: int = 0


@dataclass
class Event:
    """Something the link saw: status, console, message, banner, disconnect."""

    kind: str
    data: Any


@dataclass
class Pending:
    """A line on the wire waiting for its ok or error."""

    line: str
    done: threading.Event = field(default_factory=threading.Event)
    response: str | None = None
    lines: list[str] = field(default_factory=list)
    callback: Callable[["Pending"], None] | None = None
    sent_at: float = field(default_factory=time.monotonic)

    @property
    def ok(self) -> bool:
        return self.response == "ok"

    @property
    def failed(self) -> bool:
        """Answered with an error, or never answered because the link went."""
        return self.response is not None and self.response != "ok"

    @property
    def answered(self) -> bool:
        """The firmware answered; false while waiting and after a reset or a lost port dropped it."""
        return self.response == "ok" or (self.response is not None and self.response.startswith("error:"))

    def wait(self, timeout: float | None = None) -> bool:
        return self.done.wait(timeout)


def parse_status(text: str) -> Status | None:
    """`<Run|J:7.512,135.0000|V:300|L:400|Q:30,16|M:dyn|E:1|Z:0.000>` to a Status."""
    if len(text) < 2 or text[0] != "<" or text[-1] != ">":
        return None
    parts = text[1:-1].split("|")
    status = Status(raw=text)
    head = parts[0]
    try:
        if head.lower().startswith("alarm"):
            status.state = "Alarm"
            _, _, code = head.partition(":")
            status.alarm = int(code) if code else 0
        else:
            status.state = head
        for part in parts[1:]:
            key, _, value = part.partition(":")
            if key == "J":
                r, _, a = value.partition(",")
                status.r = float(r)
                status.a = float(a)
            elif key == "Z":
                status.z = float(value)
            elif key == "V":
                status.rate = float(value)
            elif key == "L":
                status.laser = int(float(value))
            elif key == "Q":
                planner, _, lines = value.partition(",")
                status.planner = int(planner)
                status.lines = int(lines) if lines else 0
            elif key == "M":
                status.mode = value
            elif key == "E":
                status.enabled = value.strip() not in ("0", "")
    except ValueError:
        return None
    return status


def parse_banner(text: str) -> Banner | None:
    """`[spinny v0.1.0 lines:16 blocks:32]` to a Banner."""
    match = _BANNER.match(text)
    if match is None:
        return None
    banner = Banner(version=match.group("version"))
    for key, value in _BANNER_FIELD.findall(match.group("rest")):
        if key == "lines":
            banner.lines = int(value)
        elif key == "blocks":
            banner.blocks = int(value)
    return banner


def open_serial(url: str):
    """A raw pyserial port for a device path or a `socket://host:port` url."""
    port = serial.serial_for_url(
        url,
        baudrate=BAUD,
        timeout=READ_TIMEOUT,
        write_timeout=WRITE_TIMEOUT,
        do_not_open=True,
    )
    # pyserial's open() discards whatever the port already holds, which is
    # where a banner sent at connect would be; nothing the firmware sends
    # is stale, so the flush is disabled on this instance before opening.
    port.reset_input_buffer = lambda: None
    port._reset_input_buffer = lambda: None
    port.open()
    return port


class Link:
    """One open port with a reader thread, a status poll and credit flow."""

    def __init__(
        self,
        url: str,
        open_port: Callable[[str], Any] | None = None,
        credits: int = DEFAULT_CREDITS,
        poll: bool = True,
    ) -> None:
        self.url = url
        self.credits = credits
        self.poll = poll
        self._open_port = open_port or open_serial
        self._port: Any = None
        self._pending: deque[Pending] = deque()
        self._credit = threading.Condition()
        self._send_lock = threading.Lock()
        # Held around a line's bookkeeping and its bytes, and around a
        # reset's flush and its byte, so the two cannot interleave: a line
        # written between a reset dropping the outstanding lines and the
        # reset byte itself is flushed by the firmware yet kept here, and
        # every answer after it would go to the wrong line. Reentrant, as
        # the reset takes it and then writes through the same lock.
        self._write_lock = threading.RLock()
        self._subscribers: list[Callable[[Event], None]] = []
        self._closed = threading.Event()
        self._opened = False
        self._reader: threading.Thread | None = None
        self._poller: threading.Thread | None = None
        self._status_cond = threading.Condition()
        self._status_seq = 0
        self.status: Status | None = None
        self.banner: Banner | None = None
        self.close_reason: str | None = None
        self._banner_cond = threading.Condition()
        self._banner_seq = 0
        self._expected_banners = 0
        # Status polls sent by this link and not yet answered, so their
        # reports can be told from one an operator asked for.
        self._polls_out = 0

    # --- lifecycle ------------------------------------------------------

    def open(self, banner_timeout: float = 1.0) -> None:
        try:
            self._port = self._open_port(self.url)
        except (serial.SerialException, OSError, ValueError) as exc:
            raise LinkError(f"cannot open {self.url}: {exc}") from exc
        self._opened = True
        self._reader = threading.Thread(target=self._read_loop, name="link-reader", daemon=True)
        self._reader.start()
        if self.poll:
            self._poller = threading.Thread(target=self._poll_loop, name="link-poll", daemon=True)
            self._poller.start()
        # A banner sent at connect may have gone by before the port opened,
        # so the credit and version are asked for when none shows up.
        deadline = time.monotonic() + 0.3
        while self.banner is None and time.monotonic() < deadline:
            time.sleep(0.02)
        if self.banner is None:
            try:
                self.request("version", timeout=banner_timeout)
            except LinkError:
                pass

    @property
    def restarts(self) -> int:
        """How many times the firmware has announced itself.

        It prints its banner at every reset, so a count that moves while
        something is streaming means the machine went back to the start
        underneath it, taking the queue and the modal words with it.
        """
        with self._banner_cond:
            return self._banner_seq

    @property
    def is_open(self) -> bool:
        return self._opened and not self._closed.is_set()

    def close(self, reason: str = "closed") -> None:
        if self._closed.is_set():
            return
        self.close_reason = reason
        self._closed.set()
        with self._status_cond:
            self._polls_out = 0
        with self._credit:
            self._credit.notify_all()
        with self._banner_cond:
            self._banner_cond.notify_all()
        with self._status_cond:
            self._status_cond.notify_all()
        port = self._port
        if port is not None:
            try:
                port.close()
            except Exception:
                pass
        self._fail_pending(reason)
        me = threading.current_thread()
        for thread in (self._reader, self._poller):
            if thread is not None and thread is not me:
                thread.join(timeout=1.0)
        if self._opened:
            self._publish(Event("disconnect", {"reason": reason}))

    def subscribe(self, callback: Callable[[Event], None]) -> None:
        self._subscribers.append(callback)

    def unsubscribe(self, callback: Callable[[Event], None]) -> None:
        if callback in self._subscribers:
            self._subscribers.remove(callback)

    # --- sending --------------------------------------------------------

    @property
    def outstanding(self) -> int:
        with self._credit:
            return len(self._pending)

    def send(
        self,
        line: str,
        timeout: float | None = None,
        abort: threading.Event | None = None,
        callback: Callable[[Pending], None] | None = None,
    ) -> Pending:
        """Queue one line, blocking until a credit is free; returns its Pending."""
        line = line.strip()
        if not line or "\n" in line or "\r" in line:
            raise ValueError("a command is one non-empty line")
        data = (line + "\n").encode("ascii")
        if len(data) > MAX_LINE:
            raise ValueError(f"line longer than {MAX_LINE} bytes")
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._send_lock:
            pending = Pending(line=line, callback=callback)
            with self._credit:
                while len(self._pending) >= self.credits:
                    if self._closed.is_set():
                        raise LinkClosed(self.close_reason or "closed")
                    if abort is not None and abort.is_set():
                        raise LinkError("aborted")
                    wait = 0.05
                    if deadline is not None:
                        left = deadline - time.monotonic()
                        if left <= 0:
                            raise LinkTimeout(f"no credit for {line!r}")
                        wait = min(wait, left)
                    self._credit.wait(wait)
            # The credit found above stays free: senders are serialized by
            # the send lock, and nothing else appends. The line is queued
            # and written under the write lock, so a reset either goes out
            # before the whole of it or after the whole of it.
            with self._write_lock:
                with self._credit:
                    if self._closed.is_set():
                        raise LinkClosed(self.close_reason or "closed")
                    if abort is not None and abort.is_set():
                        # Checked again here, not only while waiting: the
                        # credit that came free may have been freed by a
                        # reset failing everything outstanding, and its
                        # callbacks (which is where a run learns of the
                        # reset) have run by the time the lock is free.
                        # Writing now would put a line into a machine that
                        # was just stopped, which would take it and move.
                        raise LinkError("aborted")
                    self._pending.append(pending)
                try:
                    self._write(data)
                except LinkError:
                    with self._credit:
                        if pending in self._pending:
                            self._pending.remove(pending)
                        self._credit.notify_all()
                    raise
        self._publish(Event("console", {"dir": "tx", "text": line, "poll": False}))
        return pending

    def request(self, line: str, timeout: float = 5.0) -> list[str]:
        """Send and wait: the lines the command printed, then its ok or error."""
        pending = self.send(line, timeout=timeout)
        if not pending.wait(timeout):
            raise LinkTimeout(f"no answer to {line!r}")
        if not pending.answered:
            raise LinkClosed(f"{line!r} was dropped: {pending.response}")
        return pending.lines + [pending.response or ""]

    def request_ok(self, line: str, timeout: float = 5.0) -> list[str]:
        """Like request, raising CommandError on an error answer."""
        lines = self.request(line, timeout)
        if lines[-1] != "ok":
            raise CommandError(line, lines[-1])
        return lines[:-1]

    def realtime(self, byte: bytes | int, routine: bool = False) -> None:
        """One realtime byte, outside the credits.

        `routine` marks the status poll this link sends on its own, so a
        console can tell the machine's heartbeat from what an operator or a
        job asked for.
        """
        data = bytes([byte]) if isinstance(byte, int) else bytes(byte)
        if len(data) != 1:
            raise ValueError("a realtime command is one byte")
        if data == REALTIME_RESET:
            # The firmware flushes what was waiting, so nothing gets an
            # answer, and the banner it prints next is not a second restart.
            # The flush and the byte go together under the write lock, so
            # no line can be sent between them.
            with self._write_lock:
                with self._banner_cond:
                    self._expected_banners += 1
                self._fail_pending("reset")
                self._write(data)
        else:
            if routine:
                with self._status_cond:
                    self._polls_out += 1
            self._write(data)
        self._publish(Event("console", {"dir": "tx", "text": _show_byte(data), "poll": routine}))

    def reset(self, timeout: float = 1.0) -> bool:
        """Send the reset byte and wait for the banner that follows it."""
        with self._banner_cond:
            seq = self._banner_seq
        self.realtime(REALTIME_RESET)
        with self._banner_cond:
            return self._banner_cond.wait_for(
                lambda: self._banner_seq != seq or self._closed.is_set(), timeout
            ) and not self._closed.is_set()

    def status_now(self, timeout: float = 1.0) -> Status:
        """Ask for a status report and wait for it."""
        with self._status_cond:
            seq = self._status_seq
        self.realtime(REALTIME_STATUS)
        with self._status_cond:
            if not self._status_cond.wait_for(
                lambda: self._status_seq != seq or self._closed.is_set(), timeout
            ):
                raise LinkTimeout("no status report")
        if self.status is None:
            raise LinkClosed(self.close_reason or "closed")
        return self.status

    def _write(self, data: bytes) -> None:
        if self._closed.is_set() or self._port is None:
            raise LinkClosed(self.close_reason or "closed")
        try:
            with self._write_lock:
                self._port.write(data)
        except PORT_ERRORS as exc:
            self._fail(f"write failed: {exc}")
            raise LinkClosed(str(exc)) from exc

    # --- receiving ------------------------------------------------------

    def _read_loop(self) -> None:
        buffer = bytearray()
        port = self._port
        while not self._closed.is_set():
            try:
                chunk = port.read(1)
                if chunk:
                    waiting = port.in_waiting
                    while waiting:
                        chunk += port.read(waiting)
                        waiting = port.in_waiting
            except PORT_ERRORS as exc:
                if not self._closed.is_set():
                    self._fail(f"port error: {exc}")
                return
            if not chunk:
                continue
            buffer += chunk
            while True:
                cut = buffer.find(b"\n")
                if cut < 0:
                    break
                raw = bytes(buffer[:cut])
                del buffer[: cut + 1]
                text = raw.decode("ascii", errors="replace").strip("\r").strip()
                if text:
                    self._handle_line(text)

    def _handle_line(self, text: str) -> None:
        routine = False
        if text.startswith("<") and text.endswith(">"):
            with self._status_cond:
                routine = self._polls_out > 0
                if routine:
                    self._polls_out -= 1
        self._publish(Event("console", {"dir": "rx", "text": text, "poll": routine}))
        if text == "ok" or text.startswith("error:"):
            self._complete(text)
        elif text.startswith("<") and text.endswith(">"):
            status = parse_status(text)
            if status is not None:
                self.status = status
                with self._status_cond:
                    self._status_seq += 1
                    self._status_cond.notify_all()
                self._publish(Event("status", status))
        elif text.startswith("[spinny v"):
            self._handle_banner(text)
        elif text.startswith("[MSG:") and text.endswith("]"):
            self._publish(Event("message", {"level": "info", "text": text[5:-1]}))
        elif text.startswith("ALARM:"):
            self._publish(Event("message", {"level": "error", "text": text}))
        else:
            with self._credit:
                if self._pending:
                    self._pending[0].lines.append(text)

    def _handle_banner(self, text: str) -> None:
        with self._credit:
            oldest = self._pending[0] if self._pending else None
        answer = oldest is not None and oldest.line.lower() == "version"
        expected = False
        if not answer:
            with self._banner_cond:
                expected = self._expected_banners > 0
                if expected:
                    self._expected_banners -= 1
        if answer:
            # The same line answers `version`: that is an answer, not a
            # restart, and a run in progress must not be told otherwise.
            oldest.lines.append(text)
        elif not expected:
            # An unasked banner means the firmware restarted and dropped
            # whatever was waiting for an answer.
            self._fail_pending("reset")
        banner = parse_banner(text)
        if banner is not None:
            self.banner = banner
            if banner.lines > 0:
                with self._credit:
                    self.credits = banner.lines
                    self._credit.notify_all()
            self._publish(Event("banner", banner))
        if not answer:
            with self._banner_cond:
                self._banner_seq += 1
                self._banner_cond.notify_all()

    def _complete(self, response: str) -> None:
        with self._credit:
            if not self._pending:
                return
            pending = self._pending.popleft()
            self._credit.notify_all()
        pending.response = response
        pending.done.set()
        if pending.callback is not None:
            pending.callback(pending)

    def _fail_pending(self, reason: str) -> None:
        # Under the write lock, so a sender that has found a credit waits
        # until every dropped line has been told; the callbacks are where
        # a run learns that the machine was emptied, and the credit is
        # only announced after they have run.
        with self._write_lock:
            with self._credit:
                dropped = list(self._pending)
                self._pending.clear()
            for pending in dropped:
                pending.response = reason
                pending.done.set()
                if pending.callback is not None:
                    pending.callback(pending)
            with self._credit:
                self._credit.notify_all()

    def _fail(self, reason: str) -> None:
        self.close(reason)

    # --- polling --------------------------------------------------------

    def _poll_loop(self) -> None:
        while not self._closed.wait(self._poll_interval()):
            try:
                self.realtime(REALTIME_STATUS, routine=True)
            except LinkError:
                return

    def _poll_interval(self) -> float:
        status = self.status
        return POLL_MOVING if status is not None and status.moving else POLL_IDLE

    def _publish(self, event: Event) -> None:
        for callback in list(self._subscribers):
            try:
                callback(event)
            except Exception:
                pass


def _show_byte(data: bytes) -> str:
    names = {
        REALTIME_STATUS: "?",
        REALTIME_HOLD: "!",
        REALTIME_RESUME: "~",
        REALTIME_RESET: "<reset>",
        REALTIME_JOG_CANCEL: "<jog cancel>",
    }
    return names.get(data, f"<0x{data[0]:02x}>")
