"""A job drawn small, as an SVG for the job list: every group's paths in
its color (the preview's four, in turn), a group switched off faint, a
one-point path a dot, a model's moves by their X and Y; fitted to the
box round everything drawn, with the board's Y up. Points nearer than a
100th of the box to the last one kept are skipped, and drawing stops
after `MAX_POINTS`, so a large board stays a few tens of kilobytes."""

from __future__ import annotations

import math

from .jobs import Job

# Solarized red, blue, green and violet: the preview's group colors.
COLORS = ("#dc322f", "#268bd2", "#859900", "#6c71c4")
# The image's longer side, px.
SIZE = 64
# Points drawn at most, all paths together.
MAX_POINTS = 6000
# A point is kept once it is this share of the box from the last one kept.
STEP_SHARE = 1.0 / 100.0


def _paths(job: Job) -> list[tuple[int, bool, list[list[tuple[float, float]]]]]:
    """Each group's index, whether it is on, and its paths as X and Y."""
    out = []
    for index, group in enumerate(job.groups):
        # An empty path, which a job put back from the page may hold, draws
        # nothing.
        paths = [[(float(x), float(y)) for x, y in path] for path in group.paths if path]
        if not paths and group.moves:
            paths = [[(float(move[0]), float(move[1])) for move in path] for path in group.moves if path]
        out.append((index, group.enabled, paths))
    return out


def thumbnail(job: Job) -> str:
    """The job as a small SVG; an empty one when it draws nothing."""
    groups = _paths(job)
    points = [point for _, _, paths in groups for path in paths for point in path]
    if not points:
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 1 1"></svg>'
    x0 = min(x for x, _ in points)
    x1 = max(x for x, _ in points)
    y0 = min(y for _, y in points)
    y1 = max(y for _, y in points)
    span = max(x1 - x0, y1 - y0, 1e-6)
    margin = span * 0.06
    width = (x1 - x0) + 2 * margin
    height = (y1 - y0) + 2 * margin
    # Enough decimals to place a point to a thousandth of the box.
    digits = max(0, 3 - math.floor(math.log10(span)))
    step = span * STEP_SHARE
    stroke = span / 60.0

    def at(x: float, y: float) -> str:
        return f"{x:.{digits}f},{-y:.{digits}f}"

    shapes: list[str] = []
    left = MAX_POINTS
    for index, enabled, paths in groups:
        color = COLORS[index % len(COLORS)]
        opacity = "" if enabled else ' opacity="0.3"'
        lines: list[str] = []
        dots: list[str] = []
        for path in paths:
            if left <= 0:
                break
            if len(path) == 1:
                x, y = path[0]
                dots.append(f'<circle cx="{x:.{digits}f}" cy="{-y:.{digits}f}" r="{stroke:.{digits + 1}f}"/>')
                left -= 1
                continue
            kept = [path[0]]
            for point in path[1:-1]:
                if math.dist(point, kept[-1]) >= step:
                    kept.append(point)
            kept.append(path[-1])
            left -= len(kept)
            lines.append(f'<polyline points="{" ".join(at(x, y) for x, y in kept)}"/>')
        if lines:
            shapes.append(f'<g stroke="{color}"{opacity}>{"".join(lines)}</g>')
        if dots:
            shapes.append(f'<g fill="{color}"{opacity}>{"".join(dots)}</g>')
    size_w = SIZE if width >= height else max(1, round(SIZE * width / height))
    size_h = SIZE if height >= width else max(1, round(SIZE * height / width))
    box = f"{x0 - margin:.{digits}f} {-(y1 + margin):.{digits}f} {width:.{digits}f} {height:.{digits}f}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size_w}" height="{size_h}" viewBox="{box}">'
        f'<g fill="none" stroke-width="{stroke:.{digits + 1}f}" stroke-linecap="round" stroke-linejoin="round">{"".join(shapes)}</g>'
        "</svg>"
    )
