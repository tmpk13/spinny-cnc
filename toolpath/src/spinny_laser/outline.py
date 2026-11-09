"""A board's outline as a cut: its pieces joined into loops, a bit kept off
the board, and what lies inside the board's edge cut before the edge.

KiCad plots every line and arc of Edge.Cuts as a stroke of its own, and an
outline taken from a DXF comes the same way, so the profile arrives as
pieces with no closed shape among them. Joined where their ends meet
(`clear.chains`), a cutout is a loop inside the board's loop, and it is
cut first (`order.inner_first`), while the board around it still holds.

A beam cuts on the line: its kerf is a tenth of a millimeter. A bit is a
millimeter or more across, and with its middle on the line half of it
would come off the board all round and off the side of every cutout. For
a bit the board is the area the loops enclose, even-odd, so a cutout is a
hole in it; that area is grown by the bit's radius, which moves the edge
out and every cutout's side in, and the bit's middle runs round what it
grew to. A cutout narrower than the bit closes up and is not cut. A piece
that joins no loop has no inside to keep to and is cut on its line, as a
router cuts a lone line on Edge.Cuts: a slot the bit's width.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from laser_sweep import geom, isolate

from . import clear
from .order import depths, inner_first, is_closed

Point = tuple[float, float]
Polyline = list[Point]


@dataclass
class Cut:
    # What to cut, in cutting order.
    paths: list[Polyline]
    # How many of the paths are pieces that join no loop, cut on their line.
    loose: int = 0
    # Cutouts too narrow for the bit, as drawn; not among the paths.
    narrow: list[Polyline] = field(default_factory=list)


def cut(outline: list[Polyline], radius: float = 0.0) -> Cut:
    """The outline's pieces joined into loops and put in cutting order;
    with a `radius` above 0, a bit's, the loops moved that far off the
    board: out from its edge and into its cutouts."""
    joined = clear.chains([list(path) for path in outline])
    if radius <= 0.0:
        return Cut(inner_first(joined))
    loops = [path for path in joined if is_closed(path)]
    loose = [path for path in joined if not is_closed(path)]
    # A loop inside an odd number of others is a cutout; one the bit cannot
    # go round inside closes when the board is grown.
    narrow = [
        loop
        for loop, depth in zip(loops, depths(loops))
        if depth % 2 == 1 and not geom.offset([loop[:-1]], -radius)
    ]
    grown = geom.offset(clear.even_odd([loop[:-1] for loop in loops]), radius) if loops else []
    paths = [isolate.as_loop(contour) for contour in grown if len(contour) >= 3]
    return Cut(inner_first(paths + loose), loose=len(loose), narrow=narrow)
