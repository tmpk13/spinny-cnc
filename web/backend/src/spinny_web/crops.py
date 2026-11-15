"""Crops: the part of a camera's picture a task looks in.

A crop is a box (x0, y0, x1, y1) in shares of the full picture's width
and height from its top left corner, 0 to 1, so another capture size
keeps it. Each camera of a G-code machine has one crop per task, given in
its machine file (`[top_camera.crops]`, `[up_camera.crops]`); a task with
none looks at the whole picture. pcbv takes a crop on `spot` and `edges`
requests and keeps one for its board look (`crop`); the pictures measured
here by their pixels are cut to it before they are measured.
"""

from __future__ import annotations

import math

Crop = tuple[float, float, float, float]

# The top camera's tasks: the board look with its searches and scans,
# the spot looks (Find mark, Measure offset, Find fiducials, Home by
# fiducial, Look once), Corner by edges, and the pictures measured by their
# pixels (Measure camera, the empty picture test).
TOP_TASKS = ("board", "spot", "edges", "measure")
# The bottom camera's: the nozzle's tip (Center nozzle, Measure runout)
# and the part on it.
UP_TASKS = ("nozzle", "part")

# What a camera says once when its pcbv takes no crops.
NO_CROPS = "its pcbv takes no crops (it needs a pcbv built with the crop request): it looks at the whole picture"


def check_crop(box) -> Crop:
    """A crop from four numbers, 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1; a
    ValueError says what is wrong."""
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("a crop is [x0, y0, x1, y1]")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in box):
        raise ValueError("a crop's four values must be numbers")
    x0, y0, x1, y1 = (float(v) for v in box)
    if not (0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0):
        raise ValueError("a crop needs 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1: shares of the picture from its top left")
    return (x0, y0, x1, y1)


def check_tasks(crops: dict, tasks: tuple[str, ...]) -> dict[str, Crop]:
    """A camera's crops by task, each checked; a ValueError names an
    unknown task with the known ones, or the task whose box is wrong."""
    if not isinstance(crops, dict):
        raise ValueError(f"crops are a table of tasks: {', '.join(tasks)}")
    taken: dict[str, Crop] = {}
    for task, box in crops.items():
        if task not in tasks:
            raise ValueError(f"no task {task!r}: the tasks are {', '.join(tasks)}")
        try:
            taken[task] = check_crop(box)
        except ValueError as exc:
            raise ValueError(f"{task}: {exc}") from None
    return taken


def is_whole(crop: Crop | None) -> bool:
    """Whether a crop leaves the whole picture (or there is none)."""
    return crop is None or crop == (0.0, 0.0, 1.0, 1.0)


def crop_rows(crop: Crop | None, width: int, height: int) -> tuple[int, int, int, int]:
    """The pixel span a crop keeps of a `width` by `height` picture,
    columns x0 to x1 and rows y0 to y1 (end excluded), two pixels at least
    each way; the whole picture without a crop."""
    if crop is None:
        return (0, width, 0, height)
    x0 = min(max(int(math.floor(crop[0] * width)), 0), max(width - 2, 0))
    y0 = min(max(int(math.floor(crop[1] * height)), 0), max(height - 2, 0))
    x1 = max(min(int(math.ceil(crop[2] * width)), width), x0 + 2)
    y1 = max(min(int(math.ceil(crop[3] * height)), height), y0 + 2)
    return (x0, min(x1, width), y0, min(y1, height))


def cut(gray, crop: Crop | None):
    """A picture (a height by width array) cut to a crop; the picture as it
    is without one."""
    if crop is None:
        return gray
    height, width = gray.shape[:2]
    x0, x1, y0, y1 = crop_rows(crop, width, height)
    return gray[y0:y1, x0:x1]


def reach(crop: Crop | None, width: float, height: float) -> float | None:
    """How far from the picture's center, px, the crop reaches at most (its
    corner farthest from the center); None without a crop."""
    if crop is None:
        return None
    cx, cy = width / 2.0, height / 2.0
    dx = max(abs(crop[0] * width - cx), abs(crop[2] * width - cx))
    dy = max(abs(crop[1] * height - cy), abs(crop[3] * height - cy))
    return math.hypot(dx, dy)


def clip_radius(radius: float | None, crop: Crop | None, width: float, height: float) -> float | None:
    """A spot look's radius about the picture's center clipped to what the
    crop reaches: a circle reaching past the crop's farthest corner finds
    nothing more. Without a crop the radius as it is; without a radius the
    crop's reach."""
    far = reach(crop, width, height)
    if far is None:
        return radius
    return far if radius is None else min(radius, far)


def picture_size(size: str) -> tuple[float, float] | None:
    """A camera's capture size WIDTHxHEIGHT as two numbers; None when it
    does not read."""
    try:
        width, height = (float(v) for v in str(size).lower().split("x"))
    except ValueError:
        return None
    return (width, height) if width > 0.0 and height > 0.0 else None
