"""Stand-ins for a G-code pick and place device's cameras: an up camera
fixed to the device and a top camera riding on its head, each seeing what
the device's moves put in front of it through a true scale, roll and
mirror. The device itself is the virtual LumenPnP's Marlin
(spinny_web.virtual_pnp), its moves done at once."""

from __future__ import annotations

import math
import time

from spinny_web.virtual_pnp import PhotonBus as FakePhotonBus
from spinny_web.virtual_pnp import VirtualMarlin as FakeMarlin
from spinny_web.virtual_pnp import picture_angle, to_picture, turn

__all__ = ["DeviceTopCamera", "DeviceUpCamera", "FakeMarlin", "FakePhotonBus", "picture_angle", "to_picture", "turn", "wait_for"]


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

    def nozzle_angle(self, axis: float | None = None) -> float:
        axis = self.fake.angle if axis is None else axis
        return -axis if self.cw else axis

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None):
        return self.spot_at(self.fake.position, self.fake.angle, polarity)

    def spot_at(self, position, axis: float, polarity: str):
        """What the camera sees with the head at `position` and the rotation axis at `axis`."""
        angle = self.nozzle_angle(axis)
        arm = self.runout if polarity == "dark" else (self.runout[0] + self.part[0], self.runout[1] + self.part[1])
        swung = turn(arm, angle)
        mm = (position[0] - self.where[0] + swung[0], position[1] - self.where[1] + swung[1])
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


class LaggingUpCamera(DeviceUpCamera):
    """An up camera whose pictures come late, as a USB camera's do: a frame
    reaches pcbv every `period` s and shows the head where it was `lag` s
    before that, so a look taken at once after a move sees the head where
    it stood before it. The fake's places are sampled as they change."""

    def __init__(self, fake: FakeMarlin, where, roll: float, mirror: bool, lag: float = 0.08, period: float = 0.04, **extra) -> None:
        super().__init__(fake, where, roll, mirror, **extra)
        self.lag = lag
        self.period = period
        self.started = time.monotonic()
        self.history: list[tuple[float, tuple, float]] = [(self.started - 1.0, fake.position, fake.angle)]
        self._watch = threading.Thread(target=self._sample, daemon=True)
        self._watch.start()

    def _sample(self) -> None:
        while self.running:
            now = time.monotonic()
            last = self.history[-1]
            if self.fake.position != last[1] or self.fake.angle != last[2]:
                self.history.append((now, self.fake.position, self.fake.angle))
            time.sleep(0.002)

    def _newest(self) -> float:
        """When the newest frame reached pcbv."""
        now = time.monotonic()
        return self.started + math.floor((now - self.started) / self.period) * self.period

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None):
        shown = self._newest() - self.lag
        position, angle = self.history[0][1], self.history[0][2]
        for at, place, turned in self.history:
            if at <= shown:
                position, angle = place, turned
        return self.spot_at(position, angle, polarity)

    def pose(self):
        return {**super().pose(), "age_ms": int((time.monotonic() - self._newest()) * 1000.0)}


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
