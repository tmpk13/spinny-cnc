"""Replays protocol lines the way the firmware runs them: linear in joint space.

Each `cut` is interpolated between its start and end joint and every sample
is mapped back to the board, which is the mark the beam leaves. Rapids,
turns and jogs move the joint without a mark.
"""

from __future__ import annotations

import math
import re

WORD = re.compile(r"([A-Za-z])(-?\d*\.?\d+)")

Point = tuple[float, float]


def board(joint: tuple[float, float]) -> Point:
    theta = math.radians(joint[1])
    return (joint[0] * math.cos(theta), joint[0] * math.sin(theta))


def parse(line: str) -> tuple[str, dict[str, float]]:
    keyword, _, rest = line.partition(" ")
    return keyword.lower(), {k.upper(): float(v) for k, v in WORD.findall(rest)}


def replay(lines: list[str], start: tuple[float, float] = (0.0, 0.0)):
    """Cut marks as board polylines, plus the final joint."""
    joint = start
    marks: list[list[Point]] = []
    current: list[Point] = []
    for line in lines:
        keyword, words = parse(line)
        if keyword not in ("cut", "go", "jog", "jogto"):
            continue
        r = words.get("R", 0.0 if keyword == "jog" else joint[0])
        a = words.get("A", 0.0 if keyword == "jog" else joint[1])
        target = (joint[0] + r, joint[1] + a) if keyword == "jog" else (r, a)
        if keyword == "cut":
            if not current:
                current = [board(joint)]
            steps = max(1, int(abs(target[1] - joint[1]) / 0.25) + 1, int(abs(target[0] - joint[0]) / 0.05) + 1)
            for i in range(1, steps + 1):
                t = i / steps
                current.append(
                    board((joint[0] + (target[0] - joint[0]) * t, joint[1] + (target[1] - joint[1]) * t))
                )
        else:
            if current:
                marks.append(current)
                current = []
        joint = target
    if current:
        marks.append(current)
    return marks, joint
