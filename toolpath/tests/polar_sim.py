"""A model of the machine: replays polar gcode and reports where the beam went."""

from __future__ import annotations

import math
import re

WORD = re.compile(r"([A-Za-z])(-?\d*\.?\d+)")


# grblHAL's polar kinematics splits cuts into pieces this long.
GRBLHAL_SEGMENT = 0.5


def grblhal_joint(point, last_angle: float) -> tuple[float, float]:
    """grblHAL's transform_from_cartesian: radius, and the angle unwrapped."""
    radius = math.hypot(point[0], point[1])
    if radius == 0.0:
        return (0.0, last_angle)
    angle = math.degrees(math.atan2(point[1], point[0])) % 360.0
    delta = angle - (last_angle % 360.0)
    if abs(delta) <= 180.0:
        return (radius, last_angle + delta)
    return (radius, last_angle + (delta - 360.0 if delta > 0 else delta + 360.0))


def replay_grblhal(text: str):
    """What grblHAL polar mode does with board X/Y: the marks it leaves.

    Cuts longer than the piece length are split evenly and each piece is
    one joint move; rapids are a single joint move. Every joint move is
    sampled and mapped back to the board, like `replay`.
    """
    position = (0.0, 0.0)
    joint = (0.0, 0.0)
    power = 0.0
    mode = None
    paths: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []

    def board(r: float, a: float) -> tuple[float, float]:
        theta = math.radians(a)
        return (r * math.cos(theta), r * math.sin(theta))

    def joint_move(target_joint):
        nonlocal joint
        if current == []:
            current.append(board(*joint))
        steps = max(1, int(abs(target_joint[1] - joint[1]) / 0.5) + 1)
        for i in range(1, steps + 1):
            t = i / steps
            current.append(
                board(
                    joint[0] + (target_joint[0] - joint[0]) * t,
                    joint[1] + (target_joint[1] - joint[1]) * t,
                )
            )
        joint = target_joint

    for raw in text.splitlines():
        line = raw.split(";")[0].strip()
        if not line:
            continue
        words = dict((k.upper(), float(v)) for k, v in WORD.findall(line))
        if "M" in words:
            power = 0.0 if words["M"] == 5 else words.get("S", power)
            continue
        if "S" in words:
            power = words["S"]
        if "G" in words:
            code = words["G"]
            assert code != 93, "grblHAL polar mode must not be fed G93"
            if code in (0, 1):
                mode = int(code)
            elif code in (2, 3):
                raise AssertionError("arcs are not expected")
            elif code not in (21, 90, 94):
                continue
        if "X" not in words and "Y" not in words:
            continue
        target = (words.get("X", position[0]), words.get("Y", position[1]))
        if mode == 1 and power > 0:
            distance = math.dist(position, target)
            pieces = 1
            if distance > GRBLHAL_SEGMENT and target != position:
                pieces = math.ceil(distance / GRBLHAL_SEGMENT)
            for i in range(1, pieces + 1):
                t = i / pieces
                piece = (
                    position[0] + (target[0] - position[0]) * t,
                    position[1] + (target[1] - position[1]) * t,
                )
                joint_move(grblhal_joint(piece, joint[1]))
        else:
            if current:
                paths.append(current)
                current = []
            joint = grblhal_joint(target, joint[1])
        position = target
    if current:
        paths.append(current)
    return paths


def replay(text: str, rotary: str = "A", axis_x: float = 0.0, invert: bool = False):
    """Board-coordinate cut paths, sampled finely along each joint move.

    Each G1 at non zero power is interpolated linearly in joint space, which
    is what the controller does, and every sample is mapped back to the
    board. The result is the mark the beam leaves, path by path.
    """
    radius = 0.0
    angle = 0.0
    power = 0.0
    mode = None
    inverse = False
    paths: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    feeds: list[float] = []
    sign = -1.0 if invert else 1.0

    def board(r: float, a: float) -> tuple[float, float]:
        theta = math.radians(a)
        return (r * math.cos(theta), r * math.sin(theta))

    for raw in text.splitlines():
        line = raw.split(";")[0].strip()
        if not line:
            continue
        words = dict((k.upper(), float(v)) for k, v in WORD.findall(line))
        if "M" in words:
            power = 0.0 if words["M"] == 5 else words.get("S", power)
            continue
        if "S" in words:
            power = words["S"]
        if "G" in words:
            code = words["G"]
            if code == 93:
                inverse = True
                continue
            if code == 94:
                inverse = False
                continue
            if code in (0, 1):
                mode = int(code)
            elif code in (2, 3):
                raise AssertionError("arcs are not expected")
            elif code not in (21, 90):
                continue
        has_axis = "X" in words or rotary in words
        if not has_axis:
            continue
        nr = words.get("X", radius + axis_x) - axis_x
        na = sign * words[rotary] if rotary in words else angle
        if mode == 1 and power > 0:
            if inverse:
                assert "F" in words, f"inverse time cut without F: {raw}"
            if not current:
                current = [board(radius, angle)]
            steps = max(1, int(abs(na - angle) / 0.5) + 1)
            for i in range(1, steps + 1):
                t = i / steps
                current.append(board(radius + (nr - radius) * t, angle + (na - angle) * t))
            if "F" in words:
                feeds.append(words["F"])
        elif current:
            paths.append(current)
            current = []
        radius, angle = nr, na
    if current:
        paths.append(current)
    return paths


def deviation(mark: list[tuple[float, float]], path: list[tuple[float, float]]) -> float:
    """Worst distance from any sampled mark point to the intended polyline."""
    worst = 0.0
    for point in mark:
        worst = max(worst, _point_to_path(point, path))
    return worst


def nearest_deviation(mark, paths, slack: float = 0.5) -> float:
    """Deviation from the intended path this mark belongs to.

    Only paths whose bounding box holds the mark's first point are measured,
    which turns a job of hundreds of loops from minutes into a second.
    """
    x0, y0 = mark[0]
    candidates = []
    for path in paths:
        xs = [x for x, _ in path]
        ys = [y for _, y in path]
        if min(xs) - slack <= x0 <= max(xs) + slack and min(ys) - slack <= y0 <= max(ys) + slack:
            candidates.append(path)
    if not candidates:
        return math.inf
    return min(deviation(mark, path) for path in candidates)


def _point_to_path(point, path) -> float:
    best = math.inf
    for a, b in zip(path, path[1:]):
        best = min(best, _point_to_segment(point, a, b))
    return best


def _point_to_segment(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return math.dist(p, a)
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2
    t = min(1.0, max(0.0, t))
    return math.dist(p, (a[0] + dx * t, a[1] + dy * t))
