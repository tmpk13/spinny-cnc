"""A virtual pick and place machine: a LumenPnP's Marlin as the backend's
G-code link meets it, so the PNP tab can be tried with no hardware.

`VirtualMarlin` is the machine. It takes G-code a line at a time and
answers each the way Opulo's Marlin does: `ok` once the line is taken, a
position for M114 (where the moves sent so far end, as Marlin reports
it), its name for M115. Moves take the time their feed gives them when
`timed`, queued sixteen deep as Marlin's planner holds them; M400 answers
once they are done, with `echo:busy: processing` every two seconds while
it waits, and M410 (read as it arrives, as Marlin's emergency parser
does) stops the head where it is and drops what is queued. With `timed`
off every move is done at once, which the tests use.

The nozzle (N1, down as Z falls) picks a part when its suction is on and
its tip is down on something: at or below `touch_z`, anywhere but over
the bottom camera's window. The suction is the pump (fan 0, M106/M107)
and, when `valve_fan` names one, that fan's valve open too. A part held
stays on the nozzle, turning with it, until the suction stops; it then
lies where it was let go. The vacuum sensor behind the I2C mux (M260 to
pick the channel, M261 to read it) reads low with a part held, a little
under the open air with the nozzle open, and the open air with the pump
off, as a LumenPnP's XGZP6857D does. `miss_every` makes every that many
picks find nothing, to try a run's misses.

The Photon feeders on the RS-485 bus answer M485 packets (`PhotonBus`).
The ring light (M150) and the motors (M17/M18) are kept for the cameras
and the record.

`serve` puts a machine on a TCP socket, one client at a time, as a USB
serial port is held by one program; the machine keeps its place across
clients. `main` is the `spinny-virtual-pnp` program: the machine from a
machine file (machines/virtual-pnp.toml by default), on 127.0.0.1:2327,
and its two cameras as HTTP snapshot servers (virtual_camera.py).
"""

from __future__ import annotations

import argparse
import math
import queue
import random
import re
import socket
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

Point = tuple[float, float]

# The axes a move and M114 carry, in order.
AXES = "XYZAB"
# Moves Marlin's planner holds before it stops taking more (BLOCK_BUFFER_SIZE).
PLANNER_BLOCKS = 16
# How often a waiting command says it is still busy, s (Marlin's host keepalive).
KEEPALIVE = 2.0
# The feed before any F, mm/min.
DEFAULT_FEED = 1500.0
# The feed G28 moves at, mm/min.
HOMING_FEED = 3000.0
# The I2C addresses of the LumenPnP's sensor mux and of each sensor behind it.
MUX_ADDRESS = 112
SENSOR_ADDRESS = 109
# What the sensor reads, the pressure's top byte: the open air, the pump
# drawing through an open nozzle, and a part sealing it (Opulo's ranges for
# the N045 tip: 248 to 255 empty, 220 to 241 held).
AIR_READING = 254
OPEN_READING = 251
HELD_READING = 231
# How far a reading wanders from one read to the next.
READING_NOISE = 2
FIRMWARE = "FIRMWARE_NAME:Marlin 2.1.2 (Opulo) SOURCE_CODE_URL:github.com/MarlinFirmware/Marlin MACHINE_TYPE:LumenPnP EXTRUDER_COUNT:0"
NUMBER = re.compile(r"([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))?")


def turn(point: Point, degrees: float) -> Point:
    """`point` turned counterclockwise by `degrees` about the origin."""
    radians = math.radians(degrees)
    c, s = math.cos(radians), math.sin(radians)
    return (point[0] * c - point[1] * s, point[0] * s + point[1] * c)


def to_picture(mm: Point, roll: float, mirror: bool, scale: float) -> Point:
    """A displacement in the machine's frame as one in a camera's picture,
    px, right and down positive, for a camera turned `roll` degrees,
    mirrored or not, at `scale` mm a pixel: what the backend's
    picture_to_machine undoes."""
    u, v = turn(mm, -roll)
    u, v = u / scale, v / scale
    return ((-u if mirror else u), -v)


def picture_angle(direction: float, roll: float, mirror: bool) -> float:
    """A direction in the machine's frame, degrees, as pcbv reports one in
    the picture: from its +x toward its +y (down), in (-90, 90]."""
    du, dv = to_picture((math.cos(math.radians(direction)), math.sin(math.radians(direction))), roll, mirror, 1.0)
    angle = math.degrees(math.atan2(dv, du))
    while angle <= -90.0:
        angle += 180.0
    while angle > 90.0:
        angle -= 180.0
    return angle


class PhotonBus:
    """Photon feeders on the RS-485 bus behind Marlin's M485: each answers
    the find, its id, initialize, feed and status packets as a feeder does,
    a feed taking `asks` status asks to finish. `feeders` maps an address
    to the feeder's hardware id, as hex."""

    def __init__(self, feeders: dict[int, str], asks: int = 2) -> None:
        self.feeders = dict(feeders)
        self.ready: set[int] = set()
        self.asks = asks
        self.feeding: dict[int, int] = {}
        # Every feed asked: (address, tenths of a mm).
        self.fed: list[tuple[int, int]] = []

    def answer(self, hex_packet: str) -> str:
        """The line Marlin prints for the packet's answer, or its timeout."""
        from .feederbus import HEADER_FIELDS, Packet, decode

        packet = decode(hex_packet, HEADER_FIELDS)
        if packet is None or not packet.payload:
            return "rs485-reply: TIMEOUT"
        code, body = packet.payload[0], packet.payload[1:]

        def reply(sender: int, payload: bytes) -> str:
            return "rs485-reply: " + Packet(to=packet.sender, sender=sender, number=packet.number, payload=payload).encode(HEADER_FIELDS)

        if packet.to == 255 and code == 0xC0:
            wanted = body.hex().upper()
            address = next((a for a, i in self.feeders.items() if i == wanted), None)
            return reply(address, bytes([0])) if address is not None else "rs485-reply: TIMEOUT"
        feeder = self.feeders.get(packet.to)
        if feeder is None:
            return "rs485-reply: TIMEOUT"
        if code == 0x01:
            return reply(packet.to, bytes([0]) + bytes.fromhex(feeder))
        if code == 0x02:
            if body.hex().upper() != feeder:
                return reply(packet.to, bytes([1]) + bytes.fromhex(feeder))
            self.ready.add(packet.to)
            return reply(packet.to, bytes([0]) + bytes.fromhex(feeder))
        if code == 0x04:
            if packet.to not in self.ready:
                return reply(packet.to, bytes([3]))
            self.feeding[packet.to] = self.asks
            self.fed.append((packet.to, body[0]))
            return reply(packet.to, bytes([0, 0x01, 0xF4]))
        if code == 0x06:
            left = self.feeding.get(packet.to, 0)
            if left > 1:
                self.feeding[packet.to] = left - 1
                return reply(packet.to, bytes([4]))
            self.feeding.pop(packet.to, None)
            return reply(packet.to, bytes([0]))
        return "rs485-reply: TIMEOUT"


@dataclass
class Segment:
    """One queued move: from where to where, over which span of the clock."""

    start: tuple[float, ...]
    end: tuple[float, ...]
    t0: float
    t1: float


@dataclass
class Held:
    """A part on the nozzle, in the nozzle's own frame (its turn at 0):
    its center from the turning axis, mm, and its long side's direction,
    degrees; and its length and width, mm."""

    center: Point
    angle: float
    size: tuple[float, float]


@dataclass
class Lying:
    """A part let go: where its center lies on the machine, its long side's
    direction, degrees, and its length and width, mm."""

    center: Point
    angle: float
    size: tuple[float, float]


class VirtualMarlin:
    """A LumenPnP's Marlin behind a port: `write` takes lines, `read` gives
    the answers (see the module's text). It records every line sent
    (`lines`) and keeps the commanded place (`position`, X Y Z), the turn
    (`angle`, A), the fans, the light, the part held and the parts let go.

    For the tests: a line that starts with BAD is refused with an `ok`
    after; M105 answers the next of `readings` as Marlin reports a sensor;
    `silent` stops every answer; `hold`, while set and not released, keeps
    M400 and every line after it unanswered until it is; `report_angle`
    puts A and B in M114's answer, as a LumenPnP's Marlin does."""

    def __init__(
        self,
        position=(12.5, -3.0, 0.0),
        timed: bool = False,
        pace: float = 1.0,
        home: tuple[float, float, float] | None = None,
        touch_z: float | None = None,
        valve_fan: int | None = None,
        runout: Point = (0.0, 0.0),
        cw: bool = False,
        part_size: tuple[float, float] = (1.6, 0.8),
        no_parts_near: Point | None = None,
        miss_every: int = 0,
        seed: int = 1,
        home_error: Point = (0.0, 0.0),
    ) -> None:
        self.out: queue.Queue[bytes] = queue.Queue()
        self.lines: list[str] = []
        self._place = [float(position[0]), float(position[1]), float(position[2]), 0.0, 0.0]
        # Where the controller's numbers are from where the head truly is on
        # the bed: the head is at its numbers plus this. G92 changes the
        # numbers, not the head; a home puts the head `home_error` off the
        # place its numbers say, as homing switches do.
        self.origin = [0.0, 0.0, 0.0, 0.0, 0.0]
        self.home_error = (float(home_error[0]), float(home_error[1]))
        self.relative = False
        self.feed = DEFAULT_FEED
        self.timed = timed
        # How many times faster than its feeds the machine moves.
        self.pace = max(1e-3, float(pace))
        # Where G28 leaves the head (X, Y, Z); None leaves it where it is.
        self.home_place = home
        self.homed = False
        self.motors = True
        self.readings: list[float] = [0.0]
        self.closed = False
        self.silent = False
        self.report_angle = False
        self.bus: PhotonBus | None = None
        self.hold: threading.Event | None = None
        # Fan number to its PWM, 0 to 255; the ring light's brightness.
        self.fans: dict[int, int] = {}
        self.light = 0
        # The I2C buffer M260 fills, the address it goes to, and the mux's channels.
        self._i2c_address: int | None = None
        self._i2c_bytes: list[int] = []
        self.mux = 0
        # The nozzle: where a part is, how the tip sits off the axis, which
        # way the axis turns, and the parts it has picked and let go.
        self.touch_z = touch_z
        self.valve_fan = valve_fan
        self.runout = (float(runout[0]), float(runout[1]))
        self.cw = cw
        self.part_size = part_size
        self.no_parts_near = no_parts_near
        self.miss_every = miss_every
        self.held: Held | None = None
        self.lying: list[Lying] = []
        self.picks = 0
        self._tried = False
        self._random = random.Random(seed)
        # The planner: queued moves and when the last one ends.
        self._segments: deque[Segment] = deque()
        self._motion_end = 0.0
        self._motion = threading.Condition()
        self._lock = threading.RLock()
        self._commands: queue.Queue[str | None] = queue.Queue()
        self._worker = threading.Thread(target=self._work, name="virtual-marlin", daemon=True)
        self._worker.start()
        self.out.put(b"start\r\necho: External Reset\r\n")

    # --- the port -------------------------------------------------------------------

    def read(self, size: int) -> bytes:
        try:
            return self.out.get(timeout=0.05)
        except queue.Empty:
            return b""

    def write(self, data: bytes) -> int:
        for line in data.decode("ascii", errors="replace").splitlines():
            self.lines.append(line)
            if self.silent:
                continue
            code = line.split(";", 1)[0].strip()
            if not code:
                continue
            # Marlin's emergency parser acts on a quickstop as it arrives,
            # ahead of whatever waits; it is answered in its turn.
            if code.upper() == "M410":
                self.quickstop()
            self._commands.put(code)
        return len(data)

    def close(self) -> None:
        self.closed = True

    def drain(self) -> None:
        """Drops the answers nobody read, as a port opened anew shows none."""
        while True:
            try:
                self.out.get_nowait()
            except queue.Empty:
                return

    # --- where things are --------------------------------------------------------------

    @property
    def position(self) -> tuple[float, float, float]:
        """Where the moves sent so far leave the head: X, Y, Z."""
        with self._lock:
            return (self._place[0], self._place[1], self._place[2])

    @property
    def angle(self) -> float:
        """Where the moves sent so far leave N1's turn, degrees."""
        with self._lock:
            return self._place[3]

    @property
    def vacuum(self) -> bool:
        """Whether the pump (fan 0) runs."""
        return self.fans.get(0, 0) > 0

    @property
    def suction(self) -> bool:
        """Whether N1 draws: the pump on, and its valve open when it has one."""
        valve = self.fans.get(self.valve_fan, 0) > 0 if self.valve_fan is not None else True
        return self.vacuum and valve

    def head(self, now: float | None = None) -> tuple[float, ...]:
        """Where the head is now, X Y Z A B, partway along a move under way."""
        now = time.monotonic() if now is None else now
        with self._lock:
            for segment in self._segments:
                if now < segment.t0:
                    return segment.start
                if now < segment.t1:
                    part = (now - segment.t0) / (segment.t1 - segment.t0)
                    return tuple(a + (b - a) * part for a, b in zip(segment.start, segment.end))
            return tuple(self._place)

    def bed(self, now: float | None = None) -> tuple[float, ...]:
        """Where the head truly is on the bed now (what the cameras see),
        X Y Z A B: where its numbers put it, plus the origin."""
        here = self.head(now)
        with self._lock:
            return tuple(value + shift for value, shift in zip(here, self.origin))

    @property
    def bed_position(self) -> tuple[float, float, float]:
        """Where the moves sent so far leave the head on the bed: X, Y, Z."""
        with self._lock:
            return (self._place[0] + self.origin[0], self._place[1] + self.origin[1], self._place[2] + self.origin[2])

    def nozzle_turn(self, degrees: float) -> float:
        """The nozzle's turn counterclockwise seen from above for an A of `degrees`."""
        return -degrees if self.cw else degrees

    def tip(self, at: tuple[float, ...]) -> Point:
        """Where N1's tip is with the head at `at` (X Y Z A ...)."""
        arm = turn(self.runout, self.nozzle_turn(at[3]))
        return (at[0] + arm[0], at[1] + arm[1])

    def held_part(self, at: tuple[float, ...]) -> Lying | None:
        """The part on the nozzle with the head at `at`, placed on the machine; None when it holds none."""
        held = self.held
        if held is None:
            return None
        degrees = self.nozzle_turn(at[3])
        arm = turn(held.center, degrees)
        return Lying(center=(at[0] + arm[0], at[1] + arm[1]), angle=held.angle + degrees, size=held.size)

    def quickstop(self) -> None:
        """Stops the head where it is now and drops the moves queued."""
        with self._motion:
            now = time.monotonic()
            here = self.head(now)
            with self._lock:
                self._place = list(here)
                self._segments.clear()
                self._motion_end = now
            self._motion.notify_all()

    # --- the commands -------------------------------------------------------------------

    def _answer(self, text: str) -> None:
        self.out.put(text.encode("ascii", errors="replace"))

    def _work(self) -> None:
        while True:
            code = self._commands.get()
            if code is None:
                return
            try:
                self._do(code)
            except Exception as exc:
                self._answer(f"Error:{exc}\r\nok\r\n")

    def _do(self, code: str) -> None:
        if code.startswith("BAD"):
            self._answer("Error:Unknown command\r\nok\r\n")
            return
        word, _, rest = code.partition(" ")
        word = word.upper()
        fields = {letter: value for letter, value in NUMBER.findall(rest.upper())}
        if word in ("G0", "G1"):
            self._move(fields)
            self._answer("ok\r\n")
        elif word == "G4":
            seconds = float(fields.get("P") or 0) / 1000.0 + float(fields.get("S") or 0)
            if self.timed:
                self._wait_moves()
                time.sleep(seconds / self.pace)
            self._answer("ok\r\n")
        elif word == "G28":
            self._answer("echo:busy: processing\r\n")
            self._home()
            self._answer("ok\r\n")
        elif word == "G90":
            self.relative = False
            self._answer("ok\r\n")
        elif word == "G91":
            self.relative = True
            self._answer("ok\r\n")
        elif word == "G92":
            self._wait_moves()
            with self._lock:
                for letter, value in fields.items():
                    if letter in AXES and value:
                        # The numbers change; the head stays where it is.
                        index = AXES.index(letter)
                        self.origin[index] += self._place[index] - float(value)
                        self._place[index] = float(value)
            self._answer("ok\r\n")
        elif word == "M400":
            hold = self.hold
            if hold is not None and not hold.is_set():
                hold.wait(5.0)
            self._wait_moves()
            self._answer("ok\r\n")
        elif word == "M114":
            x, y, z, a, b = self._place
            turns = f" A:{a:.2f} B:{b:.2f}" if self.report_angle else ""
            self._answer(f"X:{x:.2f} Y:{y:.2f} Z:{z:.2f}{turns} E:0.00 Count X:0 Y:0 Z:0\r\nok\r\n")
        elif word == "M115":
            self._answer(f"{FIRMWARE}\r\nCap:EEPROM:1\r\nok\r\n")
        elif word == "M105":
            value = self.readings.pop(0) if len(self.readings) > 1 else self.readings[0]
            self._answer(f"ok T:{value:.2f} /0.00 B:0.00 /0.00 @:0 B@:0\r\n")
        elif word in ("M106", "M107"):
            fan = int(float(fields.get("P") or 0))
            self.fans[fan] = 0 if word == "M107" else max(0, min(255, int(float(fields.get("S") or 255))))
            self._grip()
            self._answer("ok\r\n")
        elif word == "M150":
            self.light = max(0, min(255, int(float(fields.get("P") or 255)))) if "P" in fields else 255
            self._answer("ok\r\n")
        elif word == "M260":
            self._i2c_send(fields)
            self._answer("ok\r\n")
        elif word == "M261":
            self._answer(self._i2c_read(fields) + "\r\nok\r\n")
        elif word == "M485" and self.bus is not None:
            self._answer(f"{self.bus.answer(rest.strip())}\r\nok\r\n")
        elif word == "M17":
            self.motors = True
            self._answer("ok\r\n")
        elif word in ("M18", "M84"):
            self._wait_moves()
            self.motors = False
            self._answer("ok\r\n")
        else:
            self._answer("ok\r\n")

    # --- motion ---------------------------------------------------------------------------

    def _move(self, fields: dict[str, str]) -> None:
        if fields.get("F"):
            self.feed = max(1.0, float(fields["F"]))
        with self._lock:
            target = list(self._place)
        for letter, value in fields.items():
            if letter in AXES and value:
                index = AXES.index(letter)
                target[index] = target[index] + float(value) if self.relative else float(value)
        self._queue_move(target, self.feed)

    def _queue_move(self, target: list[float], feed: float) -> None:
        with self._motion:
            with self._lock:
                start = tuple(self._place)
            if self.timed:
                # The planner takes no more once it holds its fill.
                while True:
                    now = time.monotonic()
                    while self._segments and self._segments[0].t1 <= now:
                        self._segments.popleft()
                    if len(self._segments) < PLANNER_BLOCKS:
                        break
                    self._motion.wait(self._segments[0].t1 - now)
                    with self._lock:
                        start = tuple(self._place)
                length = math.dist(start[:3], target[:3]) or max(abs(a - b) for a, b in zip(start[3:], target[3:]))
                if length > 0.0:
                    t0 = max(time.monotonic(), self._motion_end)
                    t1 = t0 + length / (feed / 60.0) / self.pace
                    with self._lock:
                        self._segments.append(Segment(start=start, end=tuple(target), t0=t0, t1=t1))
                    self._motion_end = t1
            with self._lock:
                self._place = list(target)
        self._grip()

    def _wait_moves(self) -> None:
        """Until the moves queued are done or a quickstop drops them, saying
        busy every two seconds."""
        if not self.timed:
            return
        said = time.monotonic()
        with self._motion:
            while True:
                now = time.monotonic()
                if now >= self._motion_end:
                    break
                if now - said >= KEEPALIVE:
                    self._answer("echo:busy: processing\r\n")
                    said = now
                self._motion.wait(min(self._motion_end - now, KEEPALIVE - (now - said)))
            with self._lock:
                self._segments.clear()

    def _home(self) -> None:
        self.homed = True
        if self.home_place is None:
            return
        with self._lock:
            # The switches set the numbers again, a little off the bed.
            self.origin = [self.home_error[0], self.home_error[1], 0.0, 0.0, 0.0]
            target = list(self._place)
        target[0], target[1], target[2] = self.home_place
        self._queue_move(target, HOMING_FEED)
        self._wait_moves()

    # --- the nozzle and the vacuum ----------------------------------------------------------

    def _grip(self) -> None:
        """A part picked when the suction comes on with the tip down on
        something (or the tip comes down on something with it on), and let
        go when the suction stops."""
        with self._lock:
            place = tuple(value + shift for value, shift in zip(self._place, self.origin))
        if not self.suction:
            self._tried = False
            if self.held is not None:
                lying = self.held_part(place)
                if lying is not None:
                    self.lying.append(lying)
                self.held = None
            return
        if self.held is not None or self.touch_z is None:
            return
        tip = self.tip(place)
        down = place[2] <= self.touch_z and not (self.no_parts_near is not None and math.dist(tip, self.no_parts_near) < 10.0)
        if not down:
            self._tried = False
            return
        if self._tried:
            return
        self._tried = True
        self.picks += 1
        if self.miss_every > 0 and self.picks % self.miss_every == 0:
            return
        # The part sits a little off the tip and a little turned from the
        # feeder's angle (0: its long side along X), as a real pick leaves it.
        off = (self._random.uniform(-0.08, 0.08), self._random.uniform(-0.08, 0.08))
        center = (tip[0] + off[0] - place[0], tip[1] + off[1] - place[1])
        degrees = self.nozzle_turn(place[3])
        self.held = Held(center=turn(center, -degrees), angle=self._random.uniform(-4.0, 4.0) - degrees, size=self.part_size)

    def sensor(self, channel: int) -> int:
        """What the vacuum sensor on the mux's `channel` (1 for N1) reads now."""
        if channel != 1 or not self.suction:
            value = AIR_READING
        else:
            value = HELD_READING if self.held is not None else OPEN_READING
        return max(0, min(255, value + self._random.randint(-READING_NOISE, READING_NOISE)))

    def _i2c_send(self, fields: dict[str, str]) -> None:
        if fields.get("A"):
            self._i2c_address = int(float(fields["A"]))
        if fields.get("B"):
            self._i2c_bytes.append(int(float(fields["B"])) & 0xFF)
        if "S" in fields:
            if self._i2c_address == MUX_ADDRESS and self._i2c_bytes:
                self.mux = self._i2c_bytes[-1]
            self._i2c_bytes = []
        elif "R" in fields:
            self._i2c_bytes = []

    def _i2c_read(self, fields: dict[str, str]) -> str:
        address = int(float(fields["A"])) if fields.get("A") else (self._i2c_address or 0)
        count = max(1, min(32, int(float(fields.get("B") or 1))))
        style = int(float(fields.get("S") or 0))
        channel = 1 if self.mux & 1 else 2 if self.mux & 2 else 0
        data = [self.sensor(channel) if address == SENSOR_ADDRESS else 0] + [0] * (count - 1)
        if style == 1:
            text = " ".join(f"{byte:02X}" for byte in data)
        elif style == 2:
            value = data[0] if count == 1 else (data[-2] << 8) | data[-1]
            text = str(value - 0x10000 if value >= 0x8000 else value)
        elif style == 3:
            text = " ".join(str(byte) for byte in data)
        else:
            text = "".join(chr(byte) if 32 <= byte < 127 else "?" for byte in data)
        return f"echo:i2c-reply: from:{address} bytes:{count} data:{text}"


# --- on a socket -------------------------------------------------------------------------


def _pump(machine: VirtualMarlin, conn: socket.socket, done: threading.Event) -> None:
    while not done.is_set():
        data = machine.read(4096)
        if not data:
            continue
        try:
            conn.sendall(data)
        except OSError:
            return


def serve_client(machine: VirtualMarlin, conn: socket.socket) -> None:
    """Talks to one client until it goes: its lines to the machine, whole,
    and the machine's answers back."""
    machine.drain()
    done = threading.Event()
    pump = threading.Thread(target=_pump, args=(machine, conn, done), name="virtual-marlin-out", daemon=True)
    pump.start()
    pending = b""
    try:
        while True:
            try:
                chunk = conn.recv(4096)
            except OSError:
                break
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                machine.write(line.rstrip(b"\r") + b"\n")
    finally:
        done.set()
        pump.join(timeout=1.0)
        conn.close()


def serve(machine: VirtualMarlin, server: socket.socket, stop: threading.Event | None = None) -> None:
    """Takes clients on `server` one at a time until `stop` is set."""
    server.settimeout(0.2)
    while stop is None or not stop.is_set():
        try:
            conn, _ = server.accept()
        except TimeoutError:
            continue
        except OSError:
            return
        conn.settimeout(None)
        serve_client(machine, conn)


def listen(address: str) -> socket.socket:
    """A listening TCP socket at `host:port`."""
    host, _, port = address.rpartition(":")
    return socket.create_server((host or "127.0.0.1", int(port)), reuse_port=False)


# --- the program ----------------------------------------------------------------------------


def _point(text: str) -> Point:
    parts = [float(part) for part in text.split(",")]
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"{text}: give X,Y")
    return (parts[0], parts[1])


def _board(text: str) -> tuple[str, float, float, float]:
    path, _, where = text.rpartition("@")
    parts = [float(part) for part in where.split(",")] if path else []
    if not path or len(parts) not in (2, 3):
        raise argparse.ArgumentTypeError(f"{text}: give FILE.kicad_pcb@X,Y or @X,Y,ANGLE")
    return (path, parts[0], parts[1], parts[2] if len(parts) == 3 else 0.0)


def default_machine_file() -> Path:
    """virtual-pnp.toml in the machines directory of the spinny home, or,
    in a release whose backend has not made that directory yet, the copy
    it ships."""
    from spinny_laser import home

    kept = home.root() / "machines" / "virtual-pnp.toml"
    shipped = Path(__file__).resolve().parent / "defaults" / "machines" / "virtual-pnp.toml"
    return kept if kept.is_file() or not shipped.is_file() else shipped


def main(argv: list[str] | None = None) -> int:
    from . import virtual_camera
    from .openpnp import parse

    parser = argparse.ArgumentParser(
        prog="spinny-virtual-pnp",
        description="A virtual LumenPnP: its Marlin on a TCP socket and its two cameras as HTTP snapshot servers, for the PNP tab with no hardware.",
    )
    parser.add_argument("--machine", type=Path, default=None, help="the machine file it plays (default: machines/virtual-pnp.toml in the spinny home)")
    parser.add_argument("--listen", default="127.0.0.1:2327", help="where the G-code is taken (default: 127.0.0.1:2327)")
    parser.add_argument("--bottom-camera", default="127.0.0.1:2328", help="where the bottom camera's pictures are served, or `off` (default: 127.0.0.1:2328)")
    parser.add_argument("--top-camera", default="127.0.0.1:2329", help="where the top camera's pictures are served, or `off` (default: 127.0.0.1:2329)")
    parser.add_argument("--fast", type=float, default=1.0, metavar="FACTOR", help="move this many times faster than the feeds say (default: 1)")
    parser.add_argument("--mark", type=_point, default=(150.0, 150.0), metavar="X,Y", help="where the dark mark the top camera's offset is measured from lies (default: 150,150)")
    parser.add_argument(
        "--board",
        type=_board,
        action="append",
        default=[],
        metavar="FILE@X,Y[,ANGLE]",
        help="a .kicad_pcb lying on the bed, its origin at X,Y and turned ANGLE degrees: the top camera sees its outline and fiducials; repeatable",
    )
    parser.add_argument("--feeders", type=int, default=3, help="Photon feeders on the bus, at addresses 1 and up (default: 3)")
    parser.add_argument("--miss-every", type=int, default=0, metavar="N", help="every Nth pick finds no part (default: never)")
    parser.add_argument("--home-error", type=_point, default=(0.2, -0.15), metavar="DX,DY", help="how far off its numbers a home leaves the head on the bed, mm, for Home by fiducial to find (default: 0.2,-0.15)")
    parser.add_argument("--seed", type=int, default=1, help="the seed of the small errors a pick leaves (default: 1)")
    args = parser.parse_args(argv)

    path = args.machine or default_machine_file()
    try:
        machine_file = parse(path.read_text(encoding="utf-8"), path.stem, str(path))
    except (OSError, ValueError) as exc:
        print(f"spinny-virtual-pnp: {exc}", file=sys.stderr)
        return 2
    world = virtual_camera.World.from_machine(machine_file, mark=args.mark)
    for board, x, y, angle in args.board:
        try:
            world.add_board(Path(board), (x, y), angle)
        except (OSError, ValueError) as exc:
            print(f"spinny-virtual-pnp: {board}: {exc}", file=sys.stderr)
            return 2
    machine = VirtualMarlin(
        position=(machine_file.park or (0.0, 0.0))[:2] + (machine_file.safe_z if machine_file.safe_z is not None else 0.0,),
        timed=True,
        pace=args.fast,
        home=(0.0, 0.0, machine_file.safe_z if machine_file.safe_z is not None else 0.0),
        touch_z=world.touch_z,
        valve_fan=1,
        runout=world.runout,
        cw=machine_file.rotation_cw,
        no_parts_near=world.bottom.place,
        miss_every=args.miss_every,
        seed=args.seed,
        home_error=args.home_error,
    )
    machine.report_angle = True
    machine.light = 0
    machine.bus = PhotonBus({address: f"{0x5350494E4E59000000000000 + address:024X}" for address in range(1, args.feeders + 1)})
    world.machine = machine
    try:
        server = listen(args.listen)
        cameras = [
            virtual_camera.serve_camera(camera, address)
            for camera, address in ((world.bottom, args.bottom_camera), (world.top, args.top_camera))
            if address != "off"
        ]
    except OSError as exc:
        print(f"spinny-virtual-pnp: {exc}", file=sys.stderr)
        return 2
    print(f"virtual LumenPnP from {path}: G-code on socket://{args.listen}", flush=True)
    for camera, address in ((world.bottom, args.bottom_camera), (world.top, args.top_camera)):
        if address != "off":
            print(f"  {camera.name} camera: http://{address}/snapshot", flush=True)
    for address, feeder in sorted(machine.bus.feeders.items()):
        print(f"  Photon feeder at address {address}: id {feeder}", flush=True)
    try:
        serve(machine, server)
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        for camera_server in cameras:
            camera_server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
