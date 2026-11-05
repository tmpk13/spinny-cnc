"""A layer cut on its lines: every stroke along its middle and every filled
shape round its edge, the beam's middle exactly on what is drawn.

Isolation burns round the ink of a layer, half a spot and more away from
it, which is right for copper and wrong for a drawing: a board's outline
on Edge.Cuts, a part's shape on a user layer or a silk screen to mark are
lines meant to be cut or burnt where they lie. A gerber draws a line as a
stroke of a round aperture along a centerline, and fills a pad, a region
or a TrueType glyph; the stroke is cut along that centerline and the fill
along its outline, so the kerf is centered on the line either way.

The pieces a plotter writes one by one (every side of a rectangle, every
segment of an arc) are joined where their ends meet, so the beam runs a
shape in one go; the paths are then taken in turn by the head's travel and
whatever lies inside a closed shape is cut before the shape, so a part's
holes are cut while the sheet still holds it.
"""

from __future__ import annotations

from laser_sweep.gerber import Draw, Image

from . import clear
from . import order as cut_order

Point = tuple[float, float]
Polyline = list[Point]


def drawn_lines(image: Image) -> list[Polyline]:
    """Every line of the layer as drawn: a stroke's centerline, and each
    contour of a fill closed on its first point. A stroke that erases (clear
    polarity) draws nothing and is left out; a fill's every contour is an
    edge, a hole's included."""
    lines: list[Polyline] = []
    for figure in image.figures:
        if isinstance(figure, Draw):
            if figure.dark and len(figure.points) >= 2:
                lines.append([(float(x), float(y)) for x, y in figure.points])
            continue
        for _, contour in figure.parts:
            points = [(float(x), float(y)) for x, y in contour]
            if len(points) >= 2:
                lines.append(points + [points[0]])
    return lines


def ordered(lines: list[Polyline], pace: float = clear.DEFAULT_PACE, start: Point = (0.0, 0.0)) -> list[Polyline]:
    """The lines joined where their ends meet, taken by the head's travel
    from `start` (`pace` mm of rail to a degree of table, as a clearing's
    strokes are), with whatever lies inside a closed shape before it."""
    joined = clear.chains(lines)
    travelled = clear.by_travel(joined, pace, start)
    return cut_order.inner_first(travelled)
