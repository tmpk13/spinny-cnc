"""A port whose other end is a small model of the firmware.

Everything the host reads is delivered by a background thread one byte at a
time, so read boundaries fall anywhere, including inside lines. Lines are
answered in order after a settable delay, realtime bytes act at once, and
motion lines move a joint position and keep the state at Run for a moment.
"""

from __future__ import annotations

import math
import queue
import re
import threading
import time
from collections import deque
from typing import Callable

import serial

WORD = re.compile(r"([A-Za-z])(-?\d*\.?\d+)")

DEFAULT_SETTINGS = {
    "r_steps": 256,
    "a_steps": 888.889,
    "r_rate": 1000,
    "a_rate": 1080,
    "r_accel": 50,
    "a_accel": 50,
    "r_jerk": 3,
    "a_jerk": 10,
    "r_max": 0,
    "z_steps": 256,
    "z_rate": 1000,
    "z_accel": 50,
    "jog_z": 120,
    "jog_r": 600,
    "jog_a": 720,
    "dir_invert": 0,
    "en_invert": 0,
    "idle_ms": 0,
    "step_us": 2,
    "laser_hz": 5000,
    "s_max": 1000,
    "s_min": 0,
    "laser_invert": 0,
    "laser_ms": 5000,
    "tmc_r_ma": 800,
    "tmc_a_ma": 800,
    "tmc_hold_pct": 50,
    "tmc_r_micro": 16,
    "tmc_a_micro": 16,
    "tmc_z_ma": 800,
    "tmc_z_micro": 16,
    "tmc_stealth": 1,
    "h_axis": 0,
    "h_steps": 6400,
    "h_rate": 600,
    "h_accel": 50,
    "h_jerk": 1,
    "jog_h": 120,
    "probe_invert": 0,
    "tmc_h_ma": 600,
    "tmc_h_micro": 256,
    "probe_ms": 20,
    "z_jerk": 3,
    "z_max": 0,
    "cartesian": 0,
    "spindle": 0,
}


class FakeSerial:
    def __init__(
        self,
        credits: int = 16,
        blocks: int = 32,
        ok_delay: float = 0.0,
        byte_delay: float = 0.0002,
        move_time: float = 0.02,
        banner_at_open: bool = True,
        version: str = "0.1.0",
        hold_ramp: float = 0.0,
    ) -> None:
        self.credits = credits
        self.blocks = blocks
        self.ok_delay = ok_delay
        self.byte_delay = byte_delay
        self.move_time = move_time
        # How long a hold takes to bring the machine to rest. The firmware
        # reports `Hold` only once the brake has finished; until then a
        # reset lands on a moving machine and raises the alarm.
        self.hold_ramp = hold_ramp
        self.version = version
        self.timeout = 0.05
        self.is_open = True
        self.received_lines: list[str] = []
        # Lines that got an answer; a reset flushes the rest unanswered.
        self.answered_lines: list[str] = []
        self.realtime_bytes: list[int] = []
        # When each realtime byte arrived, so a test can check that a
        # reset waited for the hold to finish.
        self.realtime_at: list[tuple[int, float]] = []
        # How many lines had been received when each reset byte arrived,
        # so a test can tell the lines that came after one.
        self.received_at_reset: list[int] = []
        self.max_outstanding = 0
        self.joint = [0.0, 0.0]
        # The cross slide, which moves on its own and never with R or A.
        self.z = 0.0
        # The focus axis, taken only with `h_axis` set, and the board under
        # the probe: a function of the board point under the tip giving the
        # height at which the probe touches, or None for no board.
        self.h = 0.0
        self.surface: Callable[[float, float], float | None] | None = None
        self.probe_offset = (0.0, 0.0)
        self.mode = "dyn"
        self.enabled = False
        self.laser = 0
        # The spindle's S while it turns, with `spindle` set.
        self.spindle = 0
        self.settings = dict(DEFAULT_SETTINGS)
        self.saved = 0
        self.hold = False
        self._held_at = 0.0
        self._hold_done_at = 0.0
        self.alarm: int | None = None
        self.busy_until = 0.0
        self.jogging = False
        self._lock = threading.Lock()
        self._outstanding: deque[str] = deque()
        self._line = bytearray()
        self._rx: deque[int] = deque()
        self._rx_cond = threading.Condition()
        self._out: queue.Queue[str | None] = queue.Queue()
        self._answers: queue.Queue[str | None] = queue.Queue()
        self._vanished = False
        self._broken: BaseException | None = None
        self._feeder = threading.Thread(target=self._feed, daemon=True)
        self._worker = threading.Thread(target=self._answer, daemon=True)
        self._feeder.start()
        self._worker.start()
        if banner_at_open:
            self._emit(self.banner())

    # --- the serial port interface the link uses ------------------------

    @property
    def in_waiting(self) -> int:
        self._check()
        with self._rx_cond:
            return len(self._rx)

    def read(self, size: int = 1) -> bytes:
        self._check()
        with self._rx_cond:
            if not self._rx:
                self._rx_cond.wait(self.timeout)
            self._check()
            out = bytes(self._rx.popleft() for _ in range(min(size, len(self._rx))))
        return out

    def write(self, data: bytes) -> int:
        self._check()
        for byte in data:
            if byte in (0x3F, 0x21, 0x7E, 0x18, 0x85):
                self.realtime_bytes.append(byte)
                self.realtime_at.append((byte, time.monotonic()))
                self._realtime(byte)
            elif byte == 0x0A:
                text = bytes(self._line).decode("ascii", errors="replace").strip("\r").strip()
                self._line = bytearray()
                if text:
                    self._receive(text)
            else:
                self._line.append(byte)
        return len(data)

    def close(self) -> None:
        self.is_open = False
        self._out.put(None)
        self._answers.put(None)
        with self._rx_cond:
            self._rx_cond.notify_all()

    def vanish(self) -> None:
        """The device is unplugged: every call raises from now on."""
        self._vanished = True
        with self._rx_cond:
            self._rx_cond.notify_all()

    def break_with(self, error: BaseException) -> None:
        """Every call raises this instead, for the errors a closed port
        raises that are not SerialException."""
        self._broken = error
        with self._rx_cond:
            self._rx_cond.notify_all()

    def _check(self) -> None:
        if self._broken is not None:
            raise self._broken
        if self._vanished:
            raise serial.SerialException("device reports readiness to read but returned no data")
        if not self.is_open:
            raise serial.PortNotOpenError()

    # --- the firmware model ----------------------------------------------

    def state(self) -> str:
        if self.alarm is not None:
            return f"Alarm:{self.alarm}"
        if self.hold:
            if time.monotonic() >= self._hold_done_at:
                return "Hold"
            return "Jog" if self.jogging else "Run"
        if time.monotonic() < self.busy_until:
            return "Jog" if self.jogging else "Run"
        return "Idle"

    def status(self) -> str:
        with self._lock:
            waiting = len(self._outstanding)
        r, a = self.joint
        moving = time.monotonic() < self.busy_until and not self.hold
        rate = 300 if moving else 0
        laser = self.laser if moving else 0
        if self.settings["spindle"]:
            laser = self.spindle
        focus = f"|H:{self.h:.3f}|P:{int(self.touching())}" if self.settings["h_axis"] else ""
        return (
            f"<{self.state()}|J:{r:.3f},{a:.4f}|V:{rate}|L:{laser}"
            f"|Q:{self.blocks},{self.credits - waiting}|M:{self.mode}|E:{int(self.enabled)}"
            f"|Z:{self.z:.3f}{focus}>"
        )

    def top(self) -> float | None:
        """Height at which the probe touches the board under its tip."""
        if self.surface is None:
            return None
        r, a = self.joint
        theta = math.radians(a)
        along, across = self.probe_offset
        # A cartesian head sits across the rail by the slide's position.
        if self.settings["cartesian"]:
            across += self.z
        x = (r + along) * math.cos(theta) - across * math.sin(theta)
        y = (r + along) * math.sin(theta) + across * math.cos(theta)
        return self.surface(x, y)

    def touching(self) -> bool:
        top = self.top()
        return top is not None and self.h <= top + 1e-9

    def banner(self) -> str:
        return f"[spinny v{self.version} lines:{self.credits} blocks:{self.blocks}]"

    def message(self, text: str) -> None:
        self._emit(f"[MSG:{text}]")

    def _receive(self, text: str) -> None:
        self.received_lines.append(text)
        with self._lock:
            self._outstanding.append(text)
            self.max_outstanding = max(self.max_outstanding, len(self._outstanding))
        self._answers.put(text)

    def _answer(self) -> None:
        while True:
            text = self._answers.get()
            if text is None:
                return
            if self.ok_delay:
                time.sleep(self.ok_delay)
            with self._lock:
                if not self._outstanding or self._outstanding[0] != text:
                    # Flushed by a reset: no answer.
                    continue
            for line in self._execute(text):
                self._emit(line)
            self.answered_lines.append(text)
            with self._lock:
                if self._outstanding and self._outstanding[0] == text:
                    self._outstanding.popleft()

    def _execute(self, text: str) -> list[str]:
        words = text.split(";", 1)[0].split()
        if not words:
            # An empty or comment-only line is answered like any other.
            return ["ok"]
        keyword = words[0].lower()
        rest = " ".join(words[1:])
        values = {k.upper(): float(v) for k, v in WORD.findall(rest)}
        if keyword == "version":
            return [self.banner(), "ok"]
        if keyword == "status":
            return [self.status(), "ok"]
        if keyword == "help":
            return ["go cut jog jogto dwell mode laser set enable disable unlock", "ok"]
        if keyword.startswith("$"):
            return self._setting(text.strip())
        if keyword == "probe":
            return self._probe(values)
        if keyword == "spindle":
            if not self.settings["spindle"]:
                return ["error:2 bad word"]
            if rest.lower() == "off":
                self.spindle = 0
                return ["ok"]
            if "S" not in values:
                return ["error:3 missing word"]
            self.spindle = int(values["S"])
            return ["ok"]
        if keyword in ("go", "cut", "jog", "jogto") and self.settings["cartesian"]:
            return self._cartesian(keyword, values)
        if keyword in ("go", "cut", "jog", "jogto"):
            if self.alarm is not None:
                return ["error:5 not now"]
            r = values.get("R")
            a = values.get("A")
            z = values.get("Z")
            h = values.get("H")
            if h is not None:
                if not self.settings["h_axis"] or z is not None:
                    return ["error:2 bad word"]
                self.h = self.h + h if keyword == "jog" else h
            if z is not None:
                if keyword not in ("jog", "jogto") or r is not None or a is not None:
                    return ["error:2 bad word"]
                self.z = self.z + z if keyword == "jog" else z
                self.jogging = True
                self.enabled = True
                self.busy_until = max(self.busy_until, time.monotonic()) + self.move_time
                return ["ok"]
            if keyword == "jog":
                r = self.joint[0] + r if r is not None else None
                a = self.joint[1] + a if a is not None else None
            # A negative radius is the far side of the axis, open to every
            # move; the soft limit is on the distance from the axis.
            if r is not None and self.settings["r_max"] and abs(r) > self.settings["r_max"]:
                return ["error:4 out of range"]
            if r is not None:
                self.joint[0] = r
            if a is not None:
                self.joint[1] = a
            if keyword == "cut" and "S" in values:
                self.laser = int(values["S"])
            self.jogging = keyword.startswith("jog")
            self.enabled = True
            self.busy_until = max(self.busy_until, time.monotonic()) + self.move_time
            return ["ok"]
        if keyword == "dwell":
            self.busy_until = max(self.busy_until, time.monotonic()) + values.get("T", 0) / 1000.0
            return ["ok"]
        if keyword == "mode":
            if rest.lower() not in ("dyn", "const"):
                return ["error:2 bad word"]
            self.mode = rest.lower()
            return ["ok"]
        if keyword == "laser":
            if rest.lower() == "off":
                self.laser = 0
                return ["ok"]
            if "S" not in values:
                return ["error:3 missing word"]
            self.laser = int(values["S"])
            return ["ok"]
        if keyword == "set":
            if "Z" in values and ("R" in values or "A" in values) and not self.settings["cartesian"]:
                return ["error:2 bad word"]
            if "H" in values:
                if not self.settings["h_axis"]:
                    return ["error:2 bad word"]
                self.h = values["H"]
            if "R" in values:
                self.joint[0] = values["R"]
            if "A" in values:
                self.joint[1] = values["A"]
            if "Z" in values:
                self.z = values["Z"]
            return ["ok"]
        if keyword in ("enable", "disable"):
            self.enabled = keyword == "enable"
            return ["ok"]
        if keyword == "unlock":
            self.alarm = None
            return ["ok"]
        return ["error:1 unknown command"]

    def _cartesian(self, keyword: str, values: dict) -> list[str]:
        """A move with the cross slide as a joint beside the others."""
        if self.alarm is not None:
            return ["error:5 not now"]
        if keyword in ("go", "cut") and "A" in values:
            return ["error:2 bad word"]
        if self.settings["spindle"] and keyword == "cut" and ("S" in values or "M" in values):
            return ["error:2 bad word"]
        if "H" in values and not self.settings["h_axis"]:
            return ["error:2 bad word"]
        relative = keyword == "jog"
        target = {
            "R": self.joint[0],
            "A": self.joint[1],
            "Z": self.z,
            "H": self.h,
        }
        for axis in target:
            if axis in values:
                target[axis] = target[axis] + values[axis] if relative else values[axis]
        if self.settings["r_max"] and abs(target["R"]) > self.settings["r_max"]:
            return ["error:4 out of range"]
        if self.settings["z_max"] and abs(target["Z"]) > self.settings["z_max"]:
            return ["error:4 out of range"]
        self.joint = [target["R"], target["A"]]
        self.z = target["Z"]
        self.h = target["H"]
        if keyword == "cut" and "S" in values:
            self.laser = int(values["S"])
        self.jogging = keyword.startswith("jog")
        self.enabled = True
        self.busy_until = max(self.busy_until, time.monotonic()) + self.move_time
        return ["ok"]

    def _probe(self, values: dict) -> list[str]:
        """The focus axis down (or up) by at most H until the board is met,
        answered at once with where."""
        if not self.settings["h_axis"]:
            return ["error:2 bad word"]
        if self.alarm is not None:
            return ["error:5 not now"]
        distance = values.get("H")
        if distance is None:
            return ["error:3 missing word"]
        if self.touching():
            return ["error:10 probe active"]
        target = self.h + distance
        top = self.top()
        self.enabled = True
        self.busy_until = max(self.busy_until, time.monotonic()) + self.move_time
        if top is not None and target <= top:
            self.h = top
            return [f"[PRB:{top:.4f}:1]", "ok"]
        self.h = target
        self.alarm = 2
        return [f"[PRB:{target:.4f}:0]", "ALARM:2 probe missed, check the head before moving", "error:11 probe missed"]

    def _setting(self, text: str) -> list[str]:
        body = text[1:]
        if body == "":
            return [f"{name}={_show(value)}" for name, value in self.settings.items()] + ["ok"]
        if body == "save":
            self.saved += 1
            return ["ok"]
        if body in ("load", "defaults"):
            return ["ok"]
        if body == "tmc":
            return ["r: ok", "a: ok", "ok"]
        name, _, value = body.partition("=")
        if name not in self.settings:
            return ["error:6 unknown setting"]
        if value == "" and "=" not in body:
            return [f"{name}={_show(self.settings[name])}", "ok"]
        try:
            number = float(value)
        except ValueError:
            return ["error:7 bad setting value"]
        if number < 0:
            return ["error:7 bad setting value"]
        self.settings[name] = int(number) if number == int(number) else number
        return ["ok"]

    def _realtime(self, byte: int) -> None:
        if byte == 0x3F:
            self._emit(self.status())
        elif byte == 0x21:
            if self.state() in ("Run", "Jog") and not self.hold:
                self.hold = True
                # Time stands still while held.
                self._held_at = time.monotonic()
                self._hold_done_at = self._held_at + self.hold_ramp
        elif byte == 0x7E:
            if self.hold:
                self.hold = False
                self.busy_until += time.monotonic() - self._held_at
        elif byte == 0x18:
            # A hold that has come to rest is not moving: the reset that
            # follows it costs no steps and raises no alarm.
            moving = self.state() in ("Run", "Jog")
            self.received_at_reset.append(len(self.received_lines))
            with self._lock:
                self._outstanding.clear()
            self.hold = False
            self.busy_until = 0.0
            self.laser = 0
            self.spindle = 0
            # The modal state goes with the queue, as on the firmware.
            self.mode = "dyn"
            if moving:
                self.alarm = 1
            self._emit("[MSG:reset]")
            if moving:
                self._emit("ALARM:1 reset while moving, position may be off")
            self._emit(self.banner())
        elif byte == 0x85:
            if self.jogging:
                self.busy_until = 0.0

    # --- output, one byte at a time ------------------------------------

    def _emit(self, line: str) -> None:
        self._out.put(line + "\n")

    def _feed(self) -> None:
        while True:
            text = self._out.get()
            if text is None:
                return
            for byte in text.encode("ascii"):
                with self._rx_cond:
                    self._rx.append(byte)
                    self._rx_cond.notify_all()
                if self.byte_delay:
                    time.sleep(self.byte_delay)


def _show(value) -> str:
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def fake_opener(fake: FakeSerial):
    """An `open_port` for the Link that hands out this fake."""

    def open_port(url: str):
        return fake

    return open_port
