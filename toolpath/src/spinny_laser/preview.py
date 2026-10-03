"""SVG preview: the board as it sits on the table, with the rotation axis marked."""

from __future__ import annotations

import math

from .polar import Point

MARGIN = 2.0


def render(
    copper: list,
    groups: list,
    outline: list | None = None,
    spot: float = 0.1,
    min_radius: float = 0.5,
    bridges: list | None = None,
    ring_step: float | None = None,
) -> str:
    """Board coordinates are polar coordinates here: the axis is the origin."""
    reach = _reach(copper, groups, outline or [])
    half = reach + MARGIN
    size = 2.0 * half

    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        "<!-- spinny-iso preview: the rotation axis is at the center -->",
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size:.3f}mm"'
        f' height="{size:.3f}mm" viewBox="0 0 {size:.3f} {size:.3f}" version="1.1">',
        f'<rect x="0" y="0" width="{size:.3f}" height="{size:.3f}" fill="#ffffff"/>',
        # Board Y points up, SVG Y points down.
        f'<g transform="translate({half:.3f},{half:.3f}) scale(1,-1)"'
        ' fill="none" stroke-linecap="round" stroke-linejoin="round">',
    ]

    step = ring_step or _ring_step(reach)
    parts.append('<g stroke="#d8d8d8" stroke-width="0.05">')
    ring = step
    while ring <= reach + 1e-9:
        parts.append(f'<circle cx="0" cy="0" r="{ring:.3f}"/>')
        ring += step
    parts.append("</g>")

    if copper:
        data = " ".join(_closed(contour) for contour in copper)
        parts.append(
            f'<path d="{data}" fill="#c8a165" fill-rule="evenodd" stroke="none"/>'
        )

    parts.append(f'<g stroke="#b0b0b0" stroke-width="{spot / 4.0:.4f}"'
                 f' stroke-dasharray="{spot * 4:.3f},{spot * 4:.3f}">')
    parts.extend(f'<path d="{d}"/>' for d in _travel(groups))
    parts.append("</g>")

    colors = ["#c02020", "#204090", "#207040", "#806000"]
    for index, (label, paths) in enumerate(groups):
        color = colors[min(index, len(colors) - 1)]
        parts.append(f'<g stroke="{color}" stroke-width="{spot:.4f}" opacity="0.8">')
        parts.append(f"<!-- {label} -->")
        parts.extend(f'<path d="{_open(path)}"/>' for path in paths)
        parts.append("</g>")

    if outline:
        parts.append(f'<g stroke="#404040" stroke-width="{spot / 2.0:.4f}">')
        parts.extend(f'<path d="{_open(path)}"/>' for path in outline)
        parts.append("</g>")

    for bridge in bridges or []:
        x, y = bridge.at
        radius = max(0.5, spot * 4)
        parts.append(
            f'<circle cx="{x:.3f}" cy="{y:.3f}" r="{radius:.3f}"'
            f' stroke="#e07000" stroke-width="{spot / 2.0:.4f}"/>'
        )

    # The axis, and the radius inside which the table has to spin fastest.
    parts.append('<g stroke="#e07000" stroke-width="0.08">')
    parts.append(f'<circle cx="0" cy="0" r="{min_radius:.3f}" stroke-dasharray="0.3,0.2"/>')
    parts.append('<path d="M -1 0 L 1 0 M 0 -1 L 0 1"/>')
    parts.append("</g>")
    # The rail: +X is where the beam sits.
    parts.append(
        f'<path d="M 0 0 L {reach:.3f} 0" stroke="#e07000" stroke-width="0.05"'
        ' stroke-dasharray="1,0.5"/>'
    )

    parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def _reach(copper, groups, outline) -> float:
    reach = 1.0
    for contour in copper:
        reach = max(reach, max(math.hypot(x, y) for x, y in contour))
    for _, paths in groups:
        for path in paths:
            reach = max(reach, max(math.hypot(x, y) for x, y in path))
    for path in outline:
        reach = max(reach, max(math.hypot(x, y) for x, y in path))
    return reach


def _ring_step(reach: float) -> float:
    for step in (1.0, 2.0, 5.0, 10.0, 20.0, 50.0):
        if reach / step <= 12:
            return step
    return 100.0


def _travel(groups) -> list[str]:
    segments: list[str] = []
    position: Point | None = None
    for _, paths in groups:
        for path in paths:
            if position is not None:
                segments.append(
                    f"M {position[0]:.4f} {position[1]:.4f}"
                    f" L {path[0][0]:.4f} {path[0][1]:.4f}"
                )
            position = path[-1]
    return segments


def _open(path) -> str:
    head = f"M {path[0][0]:.4f} {path[0][1]:.4f}"
    rest = " ".join(f"L {x:.4f} {y:.4f}" for x, y in path[1:])
    return f"{head} {rest}".strip()


def _closed(contour) -> str:
    return _open(contour) + " Z"
