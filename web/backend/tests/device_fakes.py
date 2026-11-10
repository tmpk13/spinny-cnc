"""Stand-ins for a G-code pick and place device and its cameras: a port
that answers like Marlin, an up camera fixed to the device, and a top
camera riding on its head. Each sees what the fake device's moves put in
front of it through a true scale, roll and mirror."""

from __future__ import annotations

import math
import queue
import re
import threading
import time


class FakeMarlin:
    """A port that answers like Marlin: `ok` for every line, a position for
    M114 (where its moves took it), `echo:busy` for a slow G28, a refusal
    followed by `ok` for a line that starts with BAD, and for M105 the next
    of `readings` as Marlin reports a sensor (`ok T:...`); it records every
    line it was sent and how its vacuum and rotation axis stand."""

    def __init__(self, position=(12.5, -3.0, 0.0)) -> None:
        self.out: queue.Queue[bytes] = queue.Queue()
        self.lines: list[str] = []
        self.position = tuple(position)
        # The rotation axis, degrees, as the moves left it.
        self.angle = 0.0
        self.vacuum = False
        # What M105 reads, one after another; the last one stays.
        self.readings: list[float] = [0.0]
        self.closed = False
        self.silent = False
        # While set and not yet released, an M400 is answered only once
        # released, and every answer after it waits behind it, in order.
        self.hold: threading.Event | None = None
        self._behind: list[bytes] | None = None
        self.out.put(b"start\r\necho: External Reset\r\n")

    def _answer(self, data: bytes) -> None:
        if self._behind is not None:
            self._behind.append(data)
        else:
            self.out.put(data)

    def _release(self, gate: threading.Event) -> None:
        gate.wait(5.0)
        behind, self._behind = self._behind or [], None
        self.out.put(b"ok\r\n")
        for data in behind:
            self.out.put(data)

    def read(self, size: int) -> bytes:
        try:
            return self.out.get(timeout=0.05)
        except queue.Empty:
            return b""

    def write(self, data: bytes) -> int:
        for line in data.decode().splitlines():
            self.lines.append(line)
            if self.silent:
                continue
            if line.startswith(("G0 ", "G1 ")):
                moved = list(self.position)
                for letter, value in re.findall(r"([XYZ])(-?\d+(?:\.\d+)?)", line):
                    moved["XYZ".index(letter)] = float(value)
                self.position = tuple(moved)
                turned = re.search(r"\bA(-?\d+(?:\.\d+)?)", line)
                if turned:
                    self.angle = float(turned.group(1))
            if line == "M106":
                self.vacuum = True
            elif line == "M107":
                self.vacuum = False
            if line == "M400" and self.hold is not None and not self.hold.is_set() and self._behind is None:
                self._behind = []
                threading.Thread(target=self._release, args=(self.hold,), daemon=True).start()
                continue
            if line.startswith("BAD"):
                self._answer(b"Error:Unknown command\r\nok\r\n")
            elif line == "M114":
                x, y, z = self.position
                self._answer(f"X:{x:.2f} Y:{y:.2f} Z:{z:.2f} E:0.00 Count X:0 Y:0 Z:0\r\nok\r\n".encode())
            elif line == "M105":
                value = self.readings.pop(0) if len(self.readings) > 1 else self.readings[0]
                self._answer(f"ok T:{value:.2f} /0.00 B:0.00 /0.00 @:0 B@:0\r\n".encode())
            elif line == "G28":
                self._answer(b"echo:busy: processing\r\n")
                self._answer(b"ok\r\n")
            else:
                self._answer(b"ok\r\n")
        return len(data)

    def close(self) -> None:
        self.closed = True


def turn(point, degrees: float):
    radians = math.radians(degrees)
    return (point[0] * math.cos(radians) - point[1] * math.sin(radians), point[0] * math.sin(radians) + point[1] * math.cos(radians))


def to_picture(mm, roll: float, mirror: bool, scale: float):
    """A displacement in the machine's frame as one in the picture, px,
    right and down positive: what picture_to_machine undoes."""
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


class DeviceUpCamera:
    """An up camera fixed to the fake device: the head at `where` (its X, Y)
    puts the nozzle's turning axis over the picture's center, and the tip
    sits `runout` off the axis at 0. The dark spot is the tip; the bright
    one a part held `part` mm off the tip at 0, `size` long and wide, its
    long side along `part_angle` at 0; both turn with the rotation axis
    (counterclockwise for a positive one unless `cw`). `rect` false leaves
    the rectangle out, as a pcbv before it did."""

    def __init__(
        self,
        fake: FakeMarlin,
        where,
        roll: float,
        mirror: bool,
        scale: float = 0.01,
        part=(0.12, -0.05),
        cw: bool = False,
        runout=(0.0, 0.0),
        size=(1.6, 0.8),
        part_angle: float = 0.0,
        rect: bool = False,
    ) -> None:
        self.fake = fake
        self.where = where
        self.roll = roll
        self.mirror = mirror
        self.scale = scale
        self.part = part
        self.cw = cw
        self.runout = runout
        self.size = size
        self.part_angle = part_angle
        self.rect = rect
        self.running = True
        self.device = "/dev/video1"

    def nozzle_angle(self) -> float:
        return -self.fake.angle if self.cw else self.fake.angle

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None):
        angle = self.nozzle_angle()
        arm = self.runout if polarity == "dark" else (self.runout[0] + self.part[0], self.runout[1] + self.part[1])
        swung = turn(arm, angle)
        mm = (self.fake.position[0] - self.where[0] + swung[0], self.fake.position[1] - self.where[1] + swung[1])
        u, v = to_picture(mm, self.roll, self.mirror, self.scale)
        if math.hypot(u, v) > 350.0:
            return {"found": False}
        length, width = max(self.size) / self.scale, min(self.size) / self.scale
        found = {"found": True, "dx": u, "dy": v, "x": 640 + u, "y": 360 + v, "area": length * width, "major": length, "minor": width, "contrast": 70.0}
        if polarity == "bright" and self.rect:
            found["rect"] = {"length": length, "width": width, "angle": picture_angle(self.part_angle + angle, self.roll, self.mirror)}
        return found

    def pose(self):
        return {"state": "none", "width": 1280, "height": 720, "frame": 1, "age_ms": 4, "fps": 15.0, "spots": 0}

    def close(self):
        self.running = False


class DeviceTopCamera:
    """A top camera on the fake device's head: its picture's center is
    `offset` from the nozzle's tip, so it looks at the head's place plus
    the offset. `things` are what it can see: (shade, X, Y, length, width)
    in the device's places, a round one with its diameter twice."""

    def __init__(self, fake: FakeMarlin, offset, things, roll: float = 1.5, mirror: bool = False, scale: float = 0.02) -> None:
        self.fake = fake
        self.offset = offset
        self.things = list(things)
        self.roll = roll
        self.mirror = mirror
        self.scale = scale
        self.running = True
        self.device = "/dev/video4"

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None):
        center = (self.fake.position[0] + self.offset[0], self.fake.position[1] + self.offset[1])
        best = None
        for shade, x, y, length, width in self.things:
            if shade != polarity:
                continue
            u, v = to_picture((x - center[0], y - center[1]), self.roll, self.mirror, self.scale)
            if abs(u) > 640 or abs(v) > 360:
                continue
            if radius is not None and math.hypot(u, v) > radius:
                continue
            area = length * width / (self.scale * self.scale)
            if (min_area is not None and area < min_area) or (max_area is not None and area > max_area):
                continue
            if best is None or math.hypot(u, v) < math.hypot(best["dx"], best["dy"]):
                best = {"found": True, "dx": u, "dy": v, "x": 640 + u, "y": 360 + v, "area": area, "major": length / self.scale, "minor": width / self.scale, "contrast": 60.0}
        return best or {"found": False}

    def pose(self):
        return {"state": "none", "width": 1280, "height": 720, "frame": 1, "age_ms": 4, "fps": 15.0, "spots": 0}

    def close(self):
        self.running = False


def wait_for(check, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("waited too long")
        time.sleep(0.02)
