"""A drawing in an ASCII DXF file as board paths in millimeters, one set
of paths a layer, the way a job takes an SVG's paths a stroke color.

Read: LINE; LWPOLYLINE and POLYLINE, their bulges as arcs; ARC; CIRCLE;
ELLIPSE; SPLINE, its curve flattened, or the line through its fit points
when it gives no control points; and INSERT of a block, scaled, turned,
in rows and columns and nested, a block's entities on layer 0 taking the
insert's layer. Curves are flattened to chords within a tolerance of the
curve. An entity's own coordinate system (an extrusion other than +Z, as
a mirrored entity has) is honored, and the drawing is seen from above:
heights are dropped. The header's $INSUNITS gives the unit, millimeters
when it gives none. Lines whose ends meet are joined into paths
(`clear.chains`), a path that comes back to its start closed on it.

Text, hatches, dimensions, points, meshes and faces cut nothing and are
left out, as are the entities of a layer switched off or frozen,
invisible ones and those in paper space. A binary DXF is refused: every
CAD program writes the text form too.

The page's in-page mock has a twin of this reader (src/mock/dxf.ts),
checked against what this one reads from the fixtures in
tests/data/dxf (`mise run dxf-fixture`).
"""

from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .clear import chains

Point = tuple[float, float]
Polyline = list[Point]
# A 2D affine map (a, b, c, d, e, f): (x, y) to (a x + c y + e, b x + d y + f).
Matrix = tuple[float, float, float, float, float, float]

IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

# How a binary DXF begins.
BINARY_SENTINEL = "AutoCAD Binary DXF"
BYTE_ORDER_MARK = chr(0xFEFF)
LINE_END = re.compile(r"\r\n|\r|\n")
# What a code or a value is padded with.
BLANKS = " \t\f\v"
# A group code, and a number as a DXF writes one.
WHOLE = re.compile(r"[+-]?[0-9]+")
REAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")

# Millimeters a unit for each $INSUNITS code; 0 (no unit) is taken as mm.
UNITS_MM: dict[int, float] = {
    0: 1.0,
    1: 25.4,
    2: 304.8,
    3: 1_609_344.0,
    4: 1.0,
    5: 10.0,
    6: 1000.0,
    7: 1_000_000.0,
    8: 25.4e-6,
    9: 0.0254,
    10: 914.4,
    11: 1e-7,
    12: 1e-6,
    13: 1e-3,
    14: 100.0,
    15: 10_000.0,
    16: 100_000.0,
    17: 1e12,
    18: 1.495978707e14,
    19: 9.4607304725808e18,
    20: 3.0856775814913673e19,
}

# Blocks inserted in blocks this deep at most.
MAX_NESTING = 16
# Chords a curve is cut into at most, and at least one every eighth of a turn.
MAX_STEPS = 10_000
MIN_STEP = math.pi / 4
# A spline's spans are halved at most this deep while flattening.
SPLINE_DEPTH = 12
# What a layer is when an entity names none.
DEFAULT_LAYER = "0"


class DxfError(ValueError):
    """The file is not an ASCII DXF drawing this reader takes."""


@dataclass
class Layer:
    name: str
    paths: list[Polyline] = field(default_factory=list)


@dataclass
class Drawing:
    """The layers that draw something, in the order they first draw, and
    the millimeters a drawing unit."""

    layers: list[Layer]
    unit_mm: float


# --- the file as group codes and values --------------------------------------------


def decode(data: bytes) -> str:
    """The text of a DXF file: UTF-8 as a DXF of 2007 on is, and an older
    one's code page read the same way, its odd characters replaced (only
    names can hold them). A binary DXF is refused."""
    if data.startswith(BINARY_SENTINEL.encode("ascii")):
        raise DxfError("a binary DXF: save the drawing as an ASCII DXF")
    return data.decode("utf-8", errors="replace")


def _pairs(text: str) -> list[tuple[int, str]]:
    """The file's lines two at a time: a group code and its value. Lines
    end at CR, LF or both, and nothing else, as the page's twin splits
    them."""
    if text.startswith(BYTE_ORDER_MARK):
        text = text[1:]
    if text.startswith(BINARY_SENTINEL):
        raise DxfError("a binary DXF: save the drawing as an ASCII DXF")
    lines = LINE_END.split(text)
    pairs: list[tuple[int, str]] = []
    for index in range(0, len(lines) - 1, 2):
        code = lines[index].strip(BLANKS)
        if not WHOLE.fullmatch(code):
            raise DxfError(f"not an ASCII DXF: line {index + 1} should be a group code, not {code[:20]!r}")
        pairs.append((int(code), lines[index + 1].strip(BLANKS)))
    return pairs


def _real(kind: str, code: int, value: str) -> float:
    """A value as a number, in the one form a DXF writes them."""
    if not REAL.fullmatch(value):
        raise DxfError(f"{kind}: group {code} should be a number, not {value[:20]!r}")
    number = float(value)
    if not math.isfinite(number):
        raise DxfError(f"{kind}: group {code} is not a finite number")
    return number


@dataclass
class _Entity:
    kind: str
    pairs: list[tuple[int, str]]

    def text(self, code: int, default: str = "") -> str:
        for c, value in self.pairs:
            if c == code:
                return value
        return default

    def number(self, code: int, default: float = 0.0) -> float:
        for c, value in self.pairs:
            if c == code:
                return _real(self.kind, code, value)
        return default

    def whole(self, code: int, default: int = 0) -> int:
        """A whole number's value, as a flag or a count is written; one
        written with a fraction is taken to its whole part."""
        return math.trunc(self.number(code, float(default)))

    def numbers(self, code: int) -> list[float]:
        return [_real(self.kind, code, value) for c, value in self.pairs if c == code]

    def normal(self) -> tuple[float, float, float]:
        return (self.number(210, 0.0), self.number(220, 0.0), self.number(230, 1.0))


def _entities(pairs: list[tuple[int, str]]) -> list[_Entity]:
    """The entities of a section, each from its 0 group to the next."""
    out: list[_Entity] = []
    for code, value in pairs:
        if code == 0:
            out.append(_Entity(value, []))
        elif out:
            out[-1].pairs.append((code, value))
    return out


def _sections(pairs: list[tuple[int, str]]) -> dict[str, list[tuple[int, str]]]:
    sections: dict[str, list[tuple[int, str]]] = {}
    index = 0
    while index < len(pairs):
        code, value = pairs[index]
        if code == 0 and value == "EOF":
            break
        if code == 0 and value == "SECTION":
            name = pairs[index + 1][1] if index + 1 < len(pairs) and pairs[index + 1][0] == 2 else ""
            end = index + 2
            while end < len(pairs) and pairs[end] != (0, "ENDSEC"):
                end += 1
            sections[name] = pairs[index + 2 : end]
            index = end + 1
        else:
            index += 1
    return sections


def _unit_mm(header: list[tuple[int, str]]) -> float:
    for index, (code, value) in enumerate(header):
        if code == 9 and value == "$INSUNITS":
            for c, v in header[index + 1 :]:
                if c == 9:
                    break
                if c == 70:
                    unit = math.trunc(_real("$INSUNITS", c, v))
                    if unit not in UNITS_MM:
                        raise DxfError(f"$INSUNITS {unit} is no unit this reader knows")
                    return UNITS_MM[unit]
    return 1.0


def _hidden_layers(tables: list[tuple[int, str]]) -> set[str]:
    """The layers switched off (a negative color) or frozen."""
    hidden: set[str] = set()
    for entity in _entities(tables):
        if entity.kind != "LAYER":
            continue
        name = entity.text(2)
        flags = entity.whole(70)
        color = entity.number(62, 7.0)
        if name and (flags & 1 or color < 0):
            hidden.add(name)
    return hidden


@dataclass
class _Block:
    base: Point
    entities: list[_Entity]


def _blocks(section: list[tuple[int, str]]) -> dict[str, _Block]:
    blocks: dict[str, _Block] = {}
    current: _Block | None = None
    for entity in _entities(section):
        if entity.kind == "BLOCK":
            current = _Block((entity.number(10), entity.number(20)), [])
            # An external reference's entities are in another file.
            if not entity.whole(70) & 4:
                blocks[entity.text(2).upper()] = current
        elif entity.kind == "ENDBLK":
            current = None
        elif current is not None:
            current.entities.append(entity)
    return blocks


# --- geometry ----------------------------------------------------------------------


def _multiply(m: Matrix, n: Matrix) -> Matrix:
    """m after n."""
    a, b, c, d, e, f = m
    p, q, r, s, t, u = n
    return (a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f)


def _apply(m: Matrix, x: float, y: float) -> Point:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _norm(m: Matrix) -> float:
    """The most the map stretches a length: its larger singular value."""
    a, b, c, d, _, _ = m
    t = a * a + b * b + c * c + d * d
    det = a * d - b * c
    return math.sqrt((t + math.sqrt(max(0.0, t * t - 4.0 * det * det))) / 2.0)


def _ocs(normal: tuple[float, float, float]) -> Matrix:
    """An entity's own coordinate system to the drawing's, seen from above:
    the arbitrary axis algorithm of the DXF reference, heights dropped."""
    nx, ny, nz = normal
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length == 0.0 or (nx == 0.0 and ny == 0.0 and nz > 0.0):
        return IDENTITY
    nx, ny, nz = nx / length, ny / length, nz / length
    if abs(nx) < 1.0 / 64.0 and abs(ny) < 1.0 / 64.0:
        # The world Y axis across the normal.
        ax = (nz, 0.0, -nx)
    else:
        # The world Z axis across the normal.
        ax = (-ny, nx, 0.0)
    a_len = math.sqrt(ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2])
    ax = (ax[0] / a_len, ax[1] / a_len, ax[2] / a_len)
    ay = (ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0])
    a_len = math.sqrt(ay[0] * ay[0] + ay[1] * ay[1] + ay[2] * ay[2])
    ay = (ay[0] / a_len, ay[1] / a_len, ay[2] / a_len)
    return (ax[0], ax[1], ay[0], ay[1], 0.0, 0.0)


def _steps(radius: float, sweep: float, tolerance: float) -> int:
    """Chords an arc of `radius` through `sweep` radians is cut into: each
    sagging at most `tolerance` off the arc, one at least every eighth of
    a turn."""
    sweep = abs(sweep)
    least = math.ceil(sweep / MIN_STEP - 1e-9)
    if radius > tolerance:
        steps = math.ceil(sweep / (2.0 * math.acos(1.0 - tolerance / radius)) - 1e-9)
    else:
        steps = least
    return max(1, least, min(MAX_STEPS, steps))


def _arc(cx: float, cy: float, radius: float, start: float, sweep: float, tolerance: float) -> Polyline:
    """Points along an arc from `start` through `sweep` radians,
    counterclockwise for a positive sweep."""
    n = _steps(radius, sweep, tolerance)
    return [(cx + radius * math.cos(start + sweep * k / n), cy + radius * math.sin(start + sweep * k / n)) for k in range(n + 1)]


def _bulge(p0: Point, p1: Point, bulge: float, tolerance: float) -> Polyline:
    """The points after `p0` up to `p1` along a polyline segment: the arc
    a bulge gives (the tangent of a quarter of its angle, positive
    counterclockwise), or `p1` alone for a straight one."""
    dx = p1[0] - p0[0]
    dy = p1[1] - p0[1]
    chord = math.sqrt(dx * dx + dy * dy)
    if bulge == 0.0 or chord == 0.0:
        return [p1]
    sweep = 4.0 * math.atan(bulge)
    radius = chord * (1.0 + bulge * bulge) / (4.0 * abs(bulge))
    # The center sits off the chord's middle, to its left for a bulge
    # under a half turn counterclockwise.
    along = (1.0 - bulge * bulge) / (4.0 * bulge)
    cx = (p0[0] + p1[0]) / 2.0 - dy * along
    cy = (p0[1] + p1[1]) / 2.0 + dx * along
    start = math.atan2(p0[1] - cy, p0[0] - cx)
    points = _arc(cx, cy, radius, start, sweep, tolerance)[1:]
    points[-1] = p1
    return points


def _vertices(points: list[tuple[float, float, float]], closed: bool, tolerance: float) -> Polyline:
    """A polyline's vertices, each with the bulge of the segment after it."""
    if not points:
        return []
    out: Polyline = [(points[0][0], points[0][1])]
    for index in range(len(points) - 1):
        x0, y0, bulge = points[index]
        x1, y1, _ = points[index + 1]
        out.extend(_bulge((x0, y0), (x1, y1), bulge, tolerance))
    if closed and len(points) > 1:
        x0, y0, bulge = points[-1]
        out.extend(_bulge((x0, y0), (points[0][0], points[0][1]), bulge, tolerance))
    return out


def _nurbs(degree: int, knots: list[float], control: list[tuple[float, float, float]], u: float) -> Point:
    """The point of a NURBS curve at `u`, by de Boor's algorithm on its
    weighted control points."""
    n = len(control) - 1
    span = degree
    while span < n and knots[span + 1] <= u:
        span += 1
    d = [(control[j + span - degree][0] * control[j + span - degree][2], control[j + span - degree][1] * control[j + span - degree][2], control[j + span - degree][2]) for j in range(degree + 1)]
    for r in range(1, degree + 1):
        for j in range(degree, r - 1, -1):
            low = knots[j + span - degree]
            denominator = knots[j + 1 + span - r] - low
            alpha = 0.0 if denominator == 0.0 else (u - low) / denominator
            d[j] = (
                (1.0 - alpha) * d[j - 1][0] + alpha * d[j][0],
                (1.0 - alpha) * d[j - 1][1] + alpha * d[j][1],
                (1.0 - alpha) * d[j - 1][2] + alpha * d[j][2],
            )
    x, y, w = d[degree]
    return (x / w, y / w) if w != 0.0 else (x, y)


def _spline(entity: _Entity, tolerance: float) -> Polyline:
    """A spline's curve within the tolerance, or the line through its fit
    points when it gives no control points."""
    flags = entity.whole(70)
    degree = entity.whole(71, 3)
    xs = entity.numbers(10)
    ys = entity.numbers(20)
    control_points = list(zip(xs, ys))
    if len(control_points) < 2:
        fit = list(zip(entity.numbers(11), entity.numbers(21)))
        if len(fit) < 2:
            return []
        if flags & 1 and fit[0] != fit[-1]:
            fit.append(fit[0])
        return fit
    weights = entity.numbers(41)
    if len(weights) != len(control_points) or any(w <= 0.0 for w in weights):
        weights = [1.0] * len(control_points)
    control = [(x, y, w) for (x, y), w in zip(control_points, weights)]
    n = len(control) - 1
    degree = max(1, min(degree, n))
    knots = entity.numbers(40)
    if len(knots) != n + degree + 2 or any(b < a for a, b in zip(knots, knots[1:])):
        # A knot vector that does not fit the points: the clamped uniform one.
        inner = n - degree
        knots = [0.0] * (degree + 1) + [float(k) for k in range(1, inner + 1)] + [float(inner + 1)] * (degree + 1)
    low = knots[degree]
    high = knots[n + 1]
    breaks = [low] + [k for k in knots[degree + 1 : n + 1] if low < k < high] + [high]
    breaks = [b for index, b in enumerate(breaks) if index == 0 or b > breaks[index - 1]]

    def flatten(u0: float, p0: Point, u1: float, p1: Point, depth: int) -> Polyline:
        worst = 0.0
        for fraction in (0.25, 0.5, 0.75):
            q = _nurbs(degree, knots, control, u0 + (u1 - u0) * fraction)
            ex = q[0] - (p0[0] + (p1[0] - p0[0]) * fraction)
            ey = q[1] - (p0[1] + (p1[1] - p0[1]) * fraction)
            worst = max(worst, math.sqrt(ex * ex + ey * ey))
        if worst <= tolerance or depth >= SPLINE_DEPTH:
            return [p1]
        um = (u0 + u1) / 2.0
        pm = _nurbs(degree, knots, control, um)
        return flatten(u0, p0, um, pm, depth + 1) + flatten(um, pm, u1, p1, depth + 1)

    points: Polyline = [_nurbs(degree, knots, control, breaks[0])]
    for u0, u1 in zip(breaks, breaks[1:]):
        points.extend(flatten(u0, points[-1], u1, _nurbs(degree, knots, control, u1), 0))
    if flags & 1 and points[0] != points[-1]:
        points.append(points[0])
    return points


# --- reading -------------------------------------------------------------------------


class _Reader:
    def __init__(self, blocks: dict[str, _Block], hidden: set[str], tolerance: float) -> None:
        self.blocks = blocks
        self.hidden = hidden
        self.tolerance = tolerance
        self.drawn: list[tuple[str, Polyline]] = []

    def walk(self, entities: list[_Entity], matrix: Matrix, inherited: str | None, inserting: tuple[str, ...]) -> None:
        index = 0
        while index < len(entities):
            entity = entities[index]
            index += 1
            if entity.kind == "POLYLINE":
                # Its vertices follow it as entities of their own, to SEQEND.
                vertices: list[_Entity] = []
                while index < len(entities) and entities[index].kind == "VERTEX":
                    vertices.append(entities[index])
                    index += 1
                self.polyline(entity, vertices, matrix, inherited)
                continue
            if entity.kind in ("VERTEX", "SEQEND", "ATTRIB"):
                continue
            layer = self.layer(entity, inherited)
            if layer is None:
                continue
            if entity.kind == "INSERT":
                self.insert(entity, matrix, layer, inserting)
            else:
                self.shape(entity, matrix, layer)

    def layer(self, entity: _Entity, inherited: str | None) -> str | None:
        """The layer the entity draws on, or None for one not drawn."""
        if entity.text(67) == "1" or entity.text(60) == "1":
            return None
        layer = entity.text(8, DEFAULT_LAYER) or DEFAULT_LAYER
        if layer == DEFAULT_LAYER and inherited is not None:
            layer = inherited
        return None if layer in self.hidden else layer

    def add(self, layer: str, points: Polyline, matrix: Matrix) -> None:
        if len(points) > 1:
            self.drawn.append((layer, [_apply(matrix, x, y) for x, y in points]))

    def local(self, matrix: Matrix) -> float:
        """The tolerance in the units of a map's source."""
        stretch = _norm(matrix)
        return self.tolerance / stretch if stretch > 0.0 else self.tolerance

    def shape(self, entity: _Entity, matrix: Matrix, layer: str) -> None:
        kind = entity.kind
        if kind == "LINE":
            self.add(layer, [(entity.number(10), entity.number(20)), (entity.number(11), entity.number(21))], matrix)
        elif kind in ("ARC", "CIRCLE"):
            m = _multiply(matrix, _ocs(entity.normal()))
            radius = entity.number(40)
            if radius <= 0.0:
                return
            cx, cy = entity.number(10), entity.number(20)
            if kind == "CIRCLE":
                points = _arc(cx, cy, radius, 0.0, 2.0 * math.pi, self.local(m))
                points[-1] = points[0]
            else:
                start = math.radians(entity.number(50))
                sweep = math.radians((entity.number(51) - entity.number(50)) % 360.0) or 2.0 * math.pi
                points = _arc(cx, cy, radius, start, sweep, self.local(m))
            self.add(layer, points, m)
        elif kind == "ELLIPSE":
            self.add(layer, self.ellipse(entity, matrix), matrix)
        elif kind == "LWPOLYLINE":
            m = _multiply(matrix, _ocs(entity.normal()))
            vertices: list[list[float]] = []
            for code, value in entity.pairs:
                if code == 10:
                    vertices.append([_real(kind, code, value), 0.0, 0.0])
                elif code == 20 and vertices:
                    vertices[-1][1] = _real(kind, code, value)
                elif code == 42 and vertices:
                    vertices[-1][2] = _real(kind, code, value)
            closed = bool(entity.whole(70) & 1)
            self.add(layer, _vertices([(x, y, b) for x, y, b in vertices], closed, self.local(m)), m)
        elif kind == "SPLINE":
            self.add(layer, _spline(entity, self.local(matrix)), matrix)

    def ellipse(self, entity: _Entity, matrix: Matrix) -> Polyline:
        cx, cy = entity.number(10), entity.number(20)
        mx, my, mz = entity.number(11), entity.number(21), entity.number(31)
        ratio = entity.number(40, 1.0)
        nx, ny, nz = entity.normal()
        length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        nx, ny, nz = nx / length, ny / length, nz / length
        # The minor axis: the normal across the major one, the ratio long.
        sx = ratio * (ny * mz - nz * my)
        sy = ratio * (nz * mx - nx * mz)
        major = math.sqrt(mx * mx + my * my + mz * mz)
        if major == 0.0:
            return []
        t0 = entity.number(41, 0.0)
        t1 = entity.number(42, 2.0 * math.pi)
        sweep = (t1 - t0) % (2.0 * math.pi) or 2.0 * math.pi
        # Within the tolerance of the circle of the major radius, which the
        # ellipse is that circle squeezed: chords sag no more on it.
        n = _steps(major, sweep, self.local(matrix))
        points = [
            (cx + mx * math.cos(t0 + sweep * k / n) + sx * math.sin(t0 + sweep * k / n), cy + my * math.cos(t0 + sweep * k / n) + sy * math.sin(t0 + sweep * k / n))
            for k in range(n + 1)
        ]
        if sweep == 2.0 * math.pi:
            points[-1] = points[0]
        return points

    def polyline(self, entity: _Entity, vertices: list[_Entity], matrix: Matrix, inherited: str | None) -> None:
        layer = self.layer(entity, inherited)
        flags = entity.whole(70)
        # A polygon mesh or a polyface mesh is a surface, not a line.
        if layer is None or flags & (16 | 64):
            return
        three_d = bool(flags & 8)
        m = matrix if three_d else _multiply(matrix, _ocs(entity.normal()))
        points = [
            (vertex.number(10), vertex.number(20), 0.0 if three_d else vertex.number(42))
            for vertex in vertices
            # A spline's frame of control points is not on the line.
            if not vertex.whole(70) & 16
        ]
        self.add(layer, _vertices(points, bool(flags & 1), self.local(m)), m)

    def insert(self, entity: _Entity, matrix: Matrix, layer: str, inserting: tuple[str, ...]) -> None:
        name = entity.text(2)
        block = self.blocks.get(name.upper())
        if block is None:
            return
        if name.upper() in inserting:
            raise DxfError(f"block {name!r} inserts itself")
        if len(inserting) >= MAX_NESTING:
            raise DxfError(f"blocks are nested more than {MAX_NESTING} deep")
        sx = entity.number(41, 1.0)
        sy = entity.number(42, 1.0)
        turn = math.radians(entity.number(50, 0.0))
        cos, sin = math.cos(turn), math.sin(turn)
        columns = max(1, entity.whole(70, 1))
        rows = max(1, entity.whole(71, 1))
        column_step = entity.number(44, 0.0)
        row_step = entity.number(45, 0.0)
        bx, by = block.base
        placed = _multiply(matrix, _ocs(entity.normal()))
        for row in range(rows):
            for column in range(columns):
                # Rows and columns run along the turned block's axes, their
                # steps not scaled.
                dx = column * column_step
                dy = row * row_step
                ix = entity.number(10) + cos * dx - sin * dy
                iy = entity.number(20) + sin * dx + cos * dy
                local: Matrix = (cos * sx, sin * sx, -sin * sy, cos * sy, 0.0, 0.0)
                local = _multiply(local, (1.0, 0.0, 0.0, 1.0, -bx, -by))
                local = _multiply((1.0, 0.0, 0.0, 1.0, ix, iy), local)
                self.walk(block.entities, _multiply(placed, local), layer, (*inserting, name.upper()))


def read(text: str, tolerance: float = 0.005) -> Drawing:
    """The drawing's paths in millimeters, its curves within `tolerance`
    mm, by layer; the layers that draw nothing are left out."""
    if not tolerance > 0.0:
        raise ValueError("tolerance must be > 0")
    pairs = _pairs(text)
    sections = _sections(pairs)
    if "ENTITIES" not in sections:
        raise DxfError("not a DXF drawing: it has no ENTITIES section")
    unit = _unit_mm(sections.get("HEADER", []))
    reader = _Reader(_blocks(sections.get("BLOCKS", [])), _hidden_layers(sections.get("TABLES", [])), tolerance)
    reader.walk(_entities(sections["ENTITIES"]), (unit, 0.0, 0.0, unit, 0.0, 0.0), None, ())
    layers: dict[str, Layer] = {}
    for name, points in reader.drawn:
        layers.setdefault(name, Layer(name)).paths.append(points)
    out: list[Layer] = []
    for layer in layers.values():
        paths = [path for path in chains(layer.paths) if any(point != path[0] for point in path)]
        if paths:
            out.append(Layer(layer.name, paths))
    return Drawing(out, unit)


def layer_label(name: str) -> str:
    """The label a layer's paths take in a job: its name after "layer"."""
    return f"layer {name}"


def read_file(path: Path, tolerance: float = 0.005) -> Drawing:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise DxfError(f"{path.name}: {exc.strerror or exc}") from exc
    return read(decode(data), tolerance)


# --- the page's twin ------------------------------------------------------------------

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "data" / "dxf"


def samples(tolerance: float = 0.005) -> dict:
    """What this reader makes of every fixture drawing, for the page's twin
    to be checked against."""
    out: dict = {}
    for path in sorted(FIXTURES.glob("*.dxf")):
        drawing = read_file(path, tolerance)
        out[path.name] = {
            "unit_mm": drawing.unit_mm,
            "layers": [{"name": layer.name, "paths": [[list(point) for point in path_] for path_ in layer.paths]} for layer in drawing.layers],
        }
    return {"tolerance": tolerance, "drawings": out}


if __name__ == "__main__":
    json.dump(samples(), sys.stdout, indent=1)
    sys.stdout.write("\n")
