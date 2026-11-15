"""Checking a board after placing from camera pictures, with no learned
model: each front-side part's crop (from a stitched mosaic or the one
picture that sees it nearest its center, stitch.py) compared with the
KiCad layout and with a golden crop of the same part from another picture.

Three checks per part:

- present or missing: how well the crop matches the golden crop over the
  part's courtyard (normalized cross-correlation), and, without a golden,
  how well it matches the layout's bare pads (a missing part leaves its
  pads bare, a placed one covers their inner ends with its body);
- offset: where the crop's part region lies against the golden's, by
  phase correlation, mm;
- turn: which quarter turn of the crop matches the golden best, then the
  small angle about it.

A crop is taken in the part's own frame: KiCad's footprint frame (x right,
y down) at the part's angle 0, centered on the footprint's origin, so a
crop of a correctly placed part looks the same whatever its turn on the
board. Board points reach the machine through a map like a survey's
truth: head = R(turn) (x, -y) + shift, or any 2 by 2 matrix in place of
R(turn).

The layout drawn as a bare board shows it (pads bright, holes dark,
layout_raster) also registers the board itself against a mosaic, which
makes the mosaic a measured map of where the board lies.

For tests without real defects the module also makes synthetic ones: a
part drawn from its layout (a dark body on its pads, bright terminals, a
cathode band or a pin 1 dot), or a real part cut out of a crop, pasted
into a picture's crop turned, shifted or left out, and pads painted over
with bare board.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import numpy as np

from .pictures import phase_shift
from .stitch import phase_shift_near

Point = tuple[float, float]
Polygon = list[Point]

# The classes of parts the checks are graded by.
PASSIVE = "passive"
POLARIZED = "polarized"
IC = "ic"
OTHER = "other"
# References whose footprints are not parts placed by the machine: test
# points, fiducials, the board's own outline, cell holders, connectors
# and jumpers.
NOT_PLACED = re.compile(r"^(TP|FID|PCB|B\d|J|JP|MH|H\d|NT|LOGO|REF)", re.IGNORECASE)
# Around a part's courtyard a crop shows this much board, mm: enough board
# around the part to align a crop with its golden before the part is
# compared.
CROP_MARGIN = 1.0


@dataclass
class Part:
    """A footprint as the checks need it: KiCad's board frame (mm, y down)
    and angle (degrees, counterclockwise as drawn), its pads' outlines in
    its own frame with their names and the side each shows on (front,
    back, or both for a through-hole pad), its drilled holes' outlines
    (plated or not; a hole shows dark), whether each pad has its own
    opening in the solder mask and the mask openings the footprint draws
    apart from its pads (a pad without its own opening shows only where
    one of those lies over it), its fabrication drawing's box
    and its courtyard's box in its own frame (x0, y0, x1, y1), and its
    class."""

    ref: str
    value: str
    footprint: str
    side: str
    x: float
    y: float
    rotation: float
    kind: str
    pads: list[Polygon] = field(default_factory=list)
    pad_names: list[str] = field(default_factory=list)
    pad_sides: list[str] = field(default_factory=list)
    holes: list[Polygon] = field(default_factory=list)
    pad_open: list[bool] = field(default_factory=list)
    openings: list[Polygon] = field(default_factory=list)
    body: tuple[float, float, float, float] | None = None
    courtyard: tuple[float, float, float, float] | None = None
    dnp: bool = False

    @property
    def extent(self) -> tuple[float, float, float, float]:
        """The box in its own frame a check looks at: the courtyard, else
        the pads' and body's box."""
        if self.courtyard is not None:
            return self.courtyard
        xs = [p[0] for pad in self.pads for p in pad]
        ys = [p[1] for pad in self.pads for p in pad]
        if self.body is not None:
            xs += [self.body[0], self.body[2]]
            ys += [self.body[1], self.body[3]]
        if not xs:
            return (-0.5, -0.5, 0.5, 0.5)
        return (min(xs), min(ys), max(xs), max(ys))


_TOKEN = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+')
# A round pad is drawn with this many sides.
ROUND_SIDES = 24


def parse_sexp(text: str) -> list:
    """A KiCad file's s-expression as nested lists of strings, quotes taken
    off; a ValueError when the parentheses do not pair up. (The same
    reading as pnp.parse_sexp, kept here so the checks do not pull in the
    machine side of the backend.)"""
    stack: list[list] = [[]]
    for match in _TOKEN.finditer(text):
        token = match.group(0)
        if token == "(":
            stack.append([])
        elif token == ")":
            if len(stack) == 1:
                raise ValueError("a ')' with no '(' before it")
            done = stack.pop()
            stack[-1].append(done)
        elif token.startswith('"'):
            stack[-1].append(re.sub(r"\\(.)", r"\1", token[1:-1]))
        else:
            stack[-1].append(token)
    if len(stack) != 1:
        raise ValueError("a '(' that is never closed")
    return stack[0]


def _child(node: list, name: str) -> list | None:
    for item in node:
        if isinstance(item, list) and item and item[0] == name:
            return item
    return None


def hole_outline(node: list, footprint_angle: float) -> Polygon | None:
    """A pad's drilled hole in its footprint's own frame: a circle or an
    oval slot (KiCad's `(drill D)` or `(drill oval W H)`), moved by the
    drill's offset and turned with the pad; None for a pad with no hole."""
    drill = _child(node, "drill")
    if drill is None or len(drill) < 2:
        return None
    words = [w for w in drill[1:] if isinstance(w, str)]
    if words and words[0] == "oval":
        width = _num(words[1] if len(words) > 1 else 0)
        height = _num(words[2] if len(words) > 2 else width)
    else:
        width = height = _num(words[0] if words else 0)
    if width <= 0.0:
        return None
    offset = _child(drill, "offset") or ["offset", "0", "0"]
    ox, oy = _num(offset[1] if len(offset) > 1 else 0), _num(offset[2] if len(offset) > 2 else 0)
    shape = ["pad", "", "", "oval", ["at", str(ox), str(oy), "0"], ["size", str(width), str(height)]]
    outline = pad_outline(shape, 0.0)
    at = _child(node, "at") or ["at", "0", "0"]
    x, y = _num(at[1] if len(at) > 1 else 0), _num(at[2] if len(at) > 2 else 0)
    own = _num(at[3] if len(at) > 3 else 0) - footprint_angle
    return [(x + px, y + py) for px, py in (screen_turn(p, own) for p in outline)]


def pad_outline(node: list, footprint_angle: float) -> Polygon:
    """A pad's outline in its footprint's own frame (KiCad's, y down): a
    circle as a polygon, an oval as two half circles joined, any other
    shape (rectangles, rounded ones, trapezoids, custom pads) as its size's
    rectangle; turned by the pad's own angle, which is the angle the board
    file keeps less its footprint's."""
    at = _child(node, "at") or ["at", "0", "0"]
    size = _child(node, "size") or ["size", "0", "0"]
    shape = node[3] if len(node) > 3 and isinstance(node[3], str) else "rect"
    x, y = _num(at[1] if len(at) > 1 else 0), _num(at[2] if len(at) > 2 else 0)
    width, height = _num(size[1] if len(size) > 1 else 0), _num(size[2] if len(size) > 2 else 0)
    own = _num(at[3] if len(at) > 3 else 0) - footprint_angle
    if shape == "circle" or (shape == "oval" and abs(width - height) < 1e-9):
        points = [(width / 2.0 * math.cos(t), width / 2.0 * math.sin(t)) for t in np.linspace(0.0, 2.0 * math.pi, ROUND_SIDES, endpoint=False)]
    elif shape == "oval":
        long, short = max(width, height), min(width, height)
        reach = (long - short) / 2.0
        half = ROUND_SIDES // 2
        ends = []
        for side in (1.0, -1.0):
            for k in range(half + 1):
                t = math.pi * k / half - math.pi / 2.0 + (0.0 if side > 0 else math.pi)
                ends.append((side * reach + short / 2.0 * math.cos(t), short / 2.0 * math.sin(t)))
        points = ends if width >= height else [(-py, px) for px, py in ends]
    else:
        points = [(-width / 2.0, -height / 2.0), (width / 2.0, -height / 2.0), (width / 2.0, height / 2.0), (-width / 2.0, height / 2.0)]
    return [(x + px, y + py) for px, py in (screen_turn(p, own) for p in points)]


def _num(value, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def screen_turn(point: Point, degrees: float) -> Point:
    """A point of a footprint's own frame (KiCad, y down) turned as KiCad
    turns the footprint: counterclockwise as drawn on the screen."""
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return (point[0] * c + point[1] * s, -point[0] * s + point[1] * c)


def kind_of(ref: str, footprint: str, pads: int) -> str:
    """A part's class: a two-pad resistor, capacitor, inductor or fuse is a
    passive; a diode or LED is polarized; a transistor or an integrated
    circuit (three pads or more) an IC; anything else other."""
    letters = re.match(r"[A-Za-z]+", ref)
    prefix = letters.group(0).upper() if letters else ""
    name = footprint.lower()
    if NOT_PLACED.match(ref):
        return OTHER
    if prefix in ("D", "LED") or "led" in name or "diode" in name:
        return POLARIZED
    if prefix in ("R", "C", "L", "F", "FB") and pads == 2:
        return PASSIVE
    if prefix in ("U", "Q", "IC", "Y") and pads >= 3:
        return IC
    return OTHER


def _box(points: list[Point]) -> tuple[float, float, float, float] | None:
    if len(points) < 2:
        return None
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    if max(xs) - min(xs) <= 0.0 or max(ys) - min(ys) <= 0.0:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _drawing_points(item: list) -> list[Point]:
    points = []
    for key in ("start", "end", "mid"):
        found = _child(item, key)
        if found is not None and len(found) >= 3:
            points.append((_num(found[1]), _num(found[2])))
    center = _child(item, "center")
    if center is not None and len(center) >= 3 and item[0] == "fp_circle" and points:
        cx, cy = _num(center[1]), _num(center[2])
        radius = math.dist((cx, cy), points[-1])
        points = [(cx - radius, cy - radius), (cx + radius, cy + radius)]
    pts = _child(item, "pts")
    if pts is not None:
        points += [(_num(xy[1]), _num(xy[2])) for xy in pts[1:] if isinstance(xy, list) and len(xy) >= 3 and xy[0] == "xy"]
    return points


def parts_of(text: str) -> list[Part]:
    """Every footprint of a .kicad_pcb text with a reference, its pads on
    its own side's copper (through-hole pads count on both), and the boxes
    of its fabrication drawing and courtyard."""
    tree = parse_sexp(text)
    root = tree[0] if tree and isinstance(tree[0], list) else tree
    found = []
    for node in root:
        if not (isinstance(node, list) and node and node[0] in ("footprint", "module")):
            continue
        ref = value = ""
        for item in node:
            if isinstance(item, list) and len(item) >= 3 and isinstance(item[1], str) and isinstance(item[2], str):
                key = (item[0], item[1].lower())
                if key in (("property", "reference"), ("fp_text", "reference")):
                    ref = item[2]
                elif key in (("property", "value"), ("fp_text", "value")):
                    value = item[2]
        if not ref:
            continue
        at = _child(node, "at") or ["at", "0", "0"]
        angle = _num(at[3] if len(at) > 3 else 0)
        layer = _child(node, "layer")
        side = "back" if layer is not None and len(layer) > 1 and str(layer[1]).startswith("B.") else "front"
        copper = "B.Cu" if side == "back" else "F.Cu"
        attr = _child(node, "attr") or []
        flags = {w for w in attr[1:] if isinstance(w, str)}
        mask = "B.Mask" if side == "back" else "F.Mask"
        pads, names, sides, holes, opened = [], [], [], [], []
        for item in node:
            if not (isinstance(item, list) and item and item[0] == "pad"):
                continue
            kind = item[2] if len(item) > 2 and isinstance(item[2], str) else ""
            layers = _child(item, "layers") or []
            if kind in ("thru_hole", "np_thru_hole"):
                hole = hole_outline(item, angle)
                if hole is not None:
                    holes.append(hole)
            if kind == "np_thru_hole" or not ({copper, "*.Cu"} & set(layers[1:])):
                continue
            pads.append(pad_outline(item, angle))
            names.append(str(item[1]) if len(item) > 1 else "")
            sides.append("both" if "*.Cu" in layers[1:] or kind == "thru_hole" else side)
            opened.append(bool({mask, "*.Mask"} & set(layers[1:])))
        fab, court, openings = [], [], []
        for item in node:
            if not (isinstance(item, list) and item and item[0] in ("fp_line", "fp_rect", "fp_poly", "fp_circle", "fp_arc")):
                continue
            lay = _child(item, "layer")
            name = lay[1] if lay is not None and len(lay) > 1 else ""
            if name in ("F.Fab", "B.Fab"):
                fab += _drawing_points(item)
            elif name in ("F.CrtYd", "B.CrtYd"):
                court += _drawing_points(item)
            elif name == mask and item[0] in ("fp_rect", "fp_poly"):
                points = _drawing_points(item)
                if item[0] == "fp_rect" and len(points) >= 2:
                    (x0, y0), (x1, y1) = points[0], points[1]
                    points = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
                if len(points) >= 3:
                    openings.append(points)
        name = node[1] if len(node) > 1 and isinstance(node[1], str) else ""
        found.append(Part(
            ref=ref, value=value, footprint=name, side=side, x=_num(at[1] if len(at) > 1 else 0), y=_num(at[2] if len(at) > 2 else 0),
            rotation=angle % 360.0, kind=kind_of(ref, name, len(pads)), pads=pads, pad_names=names, pad_sides=sides, holes=holes, pad_open=opened, openings=openings, body=_box(fab),
            courtyard=_box(court),
            dnp="dnp" in flags,
        ))
    return found


def placed(part: Part, polygon: Polygon) -> Polygon:
    """A polygon of a part's own frame in KiCad's board frame."""
    return [(part.x + q[0], part.y + q[1]) for q in (screen_turn(p, part.rotation) for p in polygon)]


def board_pads(parts: list[Part], side: str = "front", opened: bool | None = None) -> list[Polygon]:
    """The copper pads one side of the board shows, in KiCad's board frame:
    its own footprints' surface pads and every through-hole pad; only
    those with their own mask opening (`opened` True) or only those
    without (False), when asked."""
    out = []
    for part in parts:
        for k, (pad, shows) in enumerate(zip(part.pads, part.pad_sides)):
            if shows not in (side, "both"):
                continue
            if opened is not None and k < len(part.pad_open) and part.pad_open[k] != opened:
                continue
            out.append(placed(part, pad))
    return out


def board_openings(parts: list[Part], side: str = "front") -> list[Polygon]:
    """The mask openings footprints on one side draw apart from their pads,
    in KiCad's board frame."""
    return [placed(part, opening) for part in parts if part.side == side for opening in part.openings]


def board_holes(parts: list[Part]) -> list[Polygon]:
    """Every drilled hole of the board in KiCad's board frame: holes go
    through, so both sides show them."""
    return [placed(part, hole) for part in parts for hole in part.holes]


def layout_raster(pads: list[Polygon], holes: list[Polygon], x0: float, y0: float, step: float, shape: tuple[int, int],
                  blur: float = 1.0, covered: list[Polygon] | None = None, openings: list[Polygon] | None = None) -> np.ndarray:
    """The layout as a camera over a bare board sees it, 1 for bare pad
    copper, 0 for the mask, -1 for a hole: the open pads' cover, and the
    `covered` pads' where `openings` lie over them, less the holes';
    blurred `blur` px like the optics."""
    out = raster(pads, x0, y0, step, shape, supersample=3)
    if covered and openings:
        out = np.maximum(out, raster(covered, x0, y0, step, shape, supersample=3) * raster(openings, x0, y0, step, shape, supersample=3))
    out = out - raster(holes, x0, y0, step, shape, supersample=3)
    return gaussian_blur(out, blur)


# --- board to machine -------------------------------------------------------------------------


@dataclass(frozen=True)
class BoardMap:
    """KiCad board points to machine places: head = A (x, -y) + shift, A a
    2 by 2 matrix (a turn for a survey's truth)."""

    matrix: tuple[float, float, float, float]
    shift: Point

    @classmethod
    def truth(cls, turn_deg: float, shift: Point) -> BoardMap:
        r = math.radians(turn_deg)
        c, s = math.cos(r), math.sin(r)
        return cls((c, -s, s, c), (float(shift[0]), float(shift[1])))

    def apply(self, x, y) -> tuple[np.ndarray, np.ndarray]:
        a = self.matrix
        x = np.asarray(x, dtype=np.float64)
        y = -np.asarray(y, dtype=np.float64)
        return a[0] * x + a[1] * y + self.shift[0], a[2] * x + a[3] * y + self.shift[1]

    def then(self, matrix: np.ndarray, shift: Point) -> BoardMap:
        """This map followed by machine' = matrix machine + shift."""
        m = np.asarray(matrix, dtype=np.float64) @ np.array(self.matrix).reshape(2, 2)
        t = np.asarray(matrix, dtype=np.float64) @ np.array(self.shift) + np.asarray(shift, dtype=np.float64)
        return BoardMap(tuple(float(v) for v in m.ravel()), (float(t[0]), float(t[1])))


def part_grid(part: Part, board: BoardMap, size: int, step: float, offset: Point = (0.0, 0.0)) -> tuple[np.ndarray, np.ndarray]:
    """Machine places of a square crop `size` px across at `step` mm a px in
    the part's own frame (x right, y down, centered on its origin moved by
    `offset` mm of its frame)."""
    k = (np.arange(size, dtype=np.float64) - (size - 1) / 2.0) * step
    u, v = np.meshgrid(k + offset[0], k + offset[1])
    r = math.radians(part.rotation)
    c, s = math.cos(r), math.sin(r)
    bx = part.x + u * c + v * s
    by = part.y - u * s + v * c
    return board.apply(bx, by)


def crop_size(part: Part, step: float, margin: float = CROP_MARGIN) -> int:
    """The side of a part's square crop, px: its extent's longer side and
    a margin each way, made even."""
    x0, y0, x1, y1 = part.extent
    reach = 2.0 * max(abs(x0), abs(x1), abs(y0), abs(y1)) + 2.0 * margin
    n = int(math.ceil(reach / step))
    return n + (n % 2)


# --- rasters ----------------------------------------------------------------------------------


def inside(polygon: Polygon, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """Which points lie inside a polygon (even-odd rule)."""
    result = np.zeros(np.shape(px), dtype=bool)
    n = len(polygon)
    for k in range(n):
        x1, y1 = polygon[k]
        x2, y2 = polygon[(k + 1) % n]
        if y1 == y2:
            continue
        crosses = (y1 > py) != (y2 > py)
        at = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
        result ^= crosses & (px < at)
    return result


def raster(polygons: list[Polygon], x0: float, y0: float, step: float, shape: tuple[int, int], supersample: int = 4) -> np.ndarray:
    """The share of each pixel the polygons cover, 0 to 1: pixel (row r,
    column c) centered at (x0 + c step, y0 + r step) of the polygons'
    frame, `supersample` by `supersample` points a pixel."""
    rows, cols = shape
    out = np.zeros(shape, dtype=np.float32)
    offsets = (np.arange(supersample) + 0.5) / supersample - 0.5
    for poly in polygons:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        c0 = max(0, int(math.floor((min(xs) - x0) / step)))
        c1 = min(cols, int(math.ceil((max(xs) - x0) / step)) + 1)
        r0 = max(0, int(math.floor((min(ys) - y0) / step)))
        r1 = min(rows, int(math.ceil((max(ys) - y0) / step)) + 1)
        if c1 <= c0 or r1 <= r0:
            continue
        cc, rr = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
        cover = np.zeros(cc.shape, dtype=np.float32)
        for oy in offsets:
            for ox in offsets:
                cover += inside(poly, x0 + (cc + ox) * step, y0 + (rr + oy) * step)
        out[r0:r1, c0:c1] = np.maximum(out[r0:r1, c0:c1], cover / (supersample * supersample))
    return out


def own_raster(part: Part, polygons: list[Polygon], size: int, step: float) -> np.ndarray:
    """Polygons of a part's own frame drawn on its crop's raster."""
    half = (size - 1) / 2.0 * step
    return raster(polygons, -half, -half, step, (size, size))


def box_polygon(box: tuple[float, float, float, float]) -> Polygon:
    x0, y0, x1, y1 = box
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def gaussian_blur(image: np.ndarray, sigma: float) -> np.ndarray:
    """A Gaussian blur of `sigma` px, edges by reflection."""
    if sigma <= 0.0:
        return np.asarray(image, dtype=np.float32)
    radius = max(1, int(math.ceil(3.0 * sigma)))
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    k /= k.sum()
    out = np.asarray(image, dtype=np.float64)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode="reflect")
        out = sum(k[i] * np.take(padded, np.arange(i, i + out.shape[axis]), axis=axis) for i in range(len(k)))
    return out.astype(np.float32)


# --- comparisons ------------------------------------------------------------------------------


def ncc(a: np.ndarray, b: np.ndarray, mask: np.ndarray | None = None) -> float:
    """Normalized cross-correlation of two crops over a mask (all of them
    without one): 1 for the same picture up to brightness and contrast."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    m = np.ones(a.shape, dtype=bool) if mask is None else np.asarray(mask, dtype=bool)
    m = m & np.isfinite(a) & np.isfinite(b)
    if m.sum() < 4:
        return math.nan
    x, y = a[m] - a[m].mean(), b[m] - b[m].mean()
    den = math.sqrt(float((x * x).sum() * (y * y).sum()))
    return float((x * y).sum() / den) if den > 0.0 else 0.0


def rotate(image: np.ndarray, degrees: float, fill: float = math.nan) -> np.ndarray:
    """A square crop turned counterclockwise as seen (y down) about its
    center, bilinear; `fill` where nothing reaches."""
    img = np.asarray(image, dtype=np.float32)
    n = img.shape[0]
    c = (n - 1) / 2.0
    r = math.radians(degrees)
    cs, sn = math.cos(r), math.sin(r)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    # Turning the picture counterclockwise as seen with y down: a point of
    # the result at (x, y) comes from the source turned clockwise back.
    sx = c + (xx - c) * cs - (yy - c) * sn
    sy = c + (xx - c) * sn + (yy - c) * cs
    ok = (sx >= 0) & (sy >= 0) & (sx <= n - 1) & (sy <= n - 1)
    x0 = np.clip(np.floor(sx).astype(int), 0, n - 2)
    y0 = np.clip(np.floor(sy).astype(int), 0, n - 2)
    fx, fy = sx - x0, sy - y0
    out = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
           + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)
    return np.where(ok, out, fill).astype(np.float32)


def shift_image(image: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """A crop moved dx px right and dy px down, bilinear, edges repeated."""
    img = np.asarray(image, dtype=np.float32)
    h, w = img.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    sx = np.clip(xx - dx, 0, w - 1.000001)
    sy = np.clip(yy - dy, 0, h - 1.000001)
    x0, y0 = np.floor(sx).astype(int), np.floor(sy).astype(int)
    fx, fy = sx - x0, sy - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy).astype(np.float32)


@dataclass
class Verdict:
    """What one comparison of a part's crop with its golden says: the
    correlation over the part's region with the golden (and with the
    layout's bare pads, when given), the board's shift between the crops
    (mm, the part's frame: x right, y down; from the board around the
    part, when a context is given), the part's offset against the golden
    once the board is aligned (mm, same frame) and the correlation peak
    it was read at, the part's quarter turn that matched best (0, 90, 180
    or 270 degrees counterclockwise as seen) and the correlation of each
    (in that order), and the small angle the part lies turned about it
    (degrees, counterclockwise as seen)."""

    golden_ncc: float
    pads_ncc: float
    board: Point
    offset: Point
    peak: float
    quarter: int
    quarters: tuple[float, float, float, float]
    angle: float

    @property
    def offset_mm(self) -> float:
        return math.hypot(*self.offset)


def region_mask(part: Part, size: int, step: float, grow: float = 0.15) -> np.ndarray:
    """The part's region on its crop: its courtyard (else its pads' and
    body's box) grown by `grow` mm, square to the crop's center so a
    quarter turn keeps it."""
    x0, y0, x1, y1 = part.extent
    reach_x = max(abs(x0), abs(x1)) + grow
    reach_y = max(abs(y0), abs(y1)) + grow
    k = (np.arange(size) - (size - 1) / 2.0) * step
    u, v = np.meshgrid(k, k)
    straight = (np.abs(u) <= reach_x) & (np.abs(v) <= reach_y)
    turned = (np.abs(u) <= reach_y) & (np.abs(v) <= reach_x)
    return straight | turned


def body_mask(part: Part, size: int, step: float, grow: float = 0.1) -> np.ndarray:
    """Where the part's body lies on its crop, its fabrication box grown by
    `grow` mm, together with the same box turned a quarter, so a quarter
    turn of the crop keeps it: the part itself, with less of the pads
    beside it than the courtyard holds (bright pads look alike whether a
    part covers their inner ends or not)."""
    x0, y0, x1, y1 = body_box(part)
    reach_x = max(abs(x0), abs(x1)) + grow
    reach_y = max(abs(y0), abs(y1)) + grow
    k = (np.arange(size) - (size - 1) / 2.0) * step
    u, v = np.meshgrid(k, k)
    return ((np.abs(u) <= reach_x) & (np.abs(v) <= reach_y)) | ((np.abs(u) <= reach_y) & (np.abs(v) <= reach_x))


def region_mask_box(region: np.ndarray, grow: int) -> np.ndarray:
    """A mask grown by `grow` px each way (a square dilation), for the
    board around a part: everything outside the grown region."""
    m = np.asarray(region, dtype=bool)
    out = m.copy()
    for axis in (0, 1):
        grown = out.copy()
        for k in range(1, grow + 1):
            grown |= np.roll(out, k, axis=axis) | np.roll(out, -k, axis=axis)
        out = grown
    return out


def size_limit(crop: np.ndarray) -> float:
    """The largest shift a crop's correlation is followed to, px: a quarter
    of its side."""
    return 0.25 * min(np.shape(crop))


def locate(test: np.ndarray, golden: np.ndarray, weight: np.ndarray, rounds: int = 3, reach: float | None = None) -> tuple[float, float, float]:
    """How far the test crop's content lies from the golden's, px right and
    down, and the correlation's peak: both weighted by `weight` (0 to 1)
    about their means, phase correlated (the peak sought within `reach`
    px when given), and the test moved back by what was found and read
    again (a windowed correlation reads a shift short, stitch.register
    says why)."""
    t = np.asarray(test, dtype=np.float32)
    g = np.asarray(golden, dtype=np.float32)
    use = weight > 0.5
    mt, mg = float(np.nanmean(t[use])), float(np.nanmean(g[use]))
    a = (np.nan_to_num(g, nan=mg) - mg) * weight
    filled = np.nan_to_num(t, nan=mt) - mt
    dx = dy = peak = 0.0
    for _ in range(rounds):
        moved = shift_image(filled, -dx, -dy) if (dx or dy) else filled
        if reach is None:
            ex, ey, peak = phase_shift(a, moved * weight)
        else:
            ex, ey, peak = phase_shift_near(a, moved * weight, max(1.0, reach - math.hypot(dx, dy)))
        dx, dy = dx + ex, dy + ey
        if math.hypot(ex, ey) < 0.02 or math.hypot(dx, dy) > size_limit(t):
            break
    return dx, dy, peak


def compare(test: np.ndarray, golden: np.ndarray, mask: np.ndarray, step: float, pads: np.ndarray | None = None,
            context: np.ndarray | None = None, span: float = 8.0, fine: float = 1.0, reach: float | None = None,
            pads_mask: np.ndarray | None = None) -> Verdict:
    """A part's crop against its golden crop (both square, in the part's
    own frame, the same size). With a `context` mask (the board around
    the part) the test is first moved to align the board with the
    golden's. Then over `mask` (the part's region): the correlation with
    the golden and with `pads` (the layout's pads drawn on the crop); the
    part's offset by phase correlation; the quarter turn whose undoing
    matches best; and the small angle about it, searched every `fine`
    degrees within `span` and refined by a parabola. `reach` (mm) bounds
    the shifts sought; `pads_mask` is where the bare pads are compared
    (`mask` without it)."""
    t = np.asarray(test, dtype=np.float32)
    g = np.asarray(golden, dtype=np.float32)
    bx = by = 0.0
    if context is not None:
        bx, by, _ = locate(t, g, gaussian_blur(context.astype(np.float32), 3.0), reach=None if reach is None else reach / step)
        if math.hypot(bx, by) <= size_limit(t):
            t = shift_image(np.nan_to_num(t, nan=float(np.nanmean(t))), -bx, -by)
        else:
            bx = by = 0.0
    golden_ncc = ncc(t, g, mask)
    pads_ncc = ncc(t, pads, mask if pads_mask is None else pads_mask) if pads is not None else math.nan
    dx, dy, peak = locate(t, g, gaussian_blur(mask.astype(np.float32), 4.0), reach=None if reach is None else reach / step)
    # np.rot90(crop, k) turns it k quarters counterclockwise as seen (rows
    # down): a part turned q quarters is undone by k = -q.
    quarters = tuple(ncc(np.rot90(t, -q % 4), g, mask) for q in range(4))
    best = int(np.nanargmax(quarters))
    base = np.rot90(t, -best % 4)
    angles = np.arange(-span, span + fine / 2.0, fine)
    scores = np.array([ncc(rotate(base, a_), g, mask) if a_ != 0.0 else quarters[best] for a_ in angles])
    k = int(np.nanargmax(scores))
    undo = float(angles[k])
    if 0 < k < len(angles) - 1:
        y0, y1, y2 = scores[k - 1], scores[k], scores[k + 1]
        den = y0 - 2.0 * y1 + y2
        if den < 0.0:
            undo += fine * 0.5 * (y0 - y2) / den
    return Verdict(golden_ncc, pads_ncc, (bx * step, by * step), (dx * step, dy * step), peak, 90 * best, quarters, -undo)


# --- synthetic parts and defects --------------------------------------------------------------


# Luma (of 255) of a synthetic part's body by class and of its metal ends.
BODY_LUMA = {PASSIVE: 40.0, POLARIZED: 35.0, IC: 30.0, OTHER: 40.0}
CAPACITOR_LUMA = 120.0
METAL_LUMA = 200.0
MARK_LUMA = 160.0


def sprite(part: Part, size: int, step: float, blur: float = 1.2) -> tuple[np.ndarray, np.ndarray]:
    """A synthetic part on its crop's raster (own frame, angle 0): luma and
    cover (0 to 1). The body is the fabrication drawing's box (else the
    pads' box shrunk); a two-pad part has metal ends over its pads; a
    many-pad part has metal leads where its pads reach past the body; a
    diode a cathode band at pad 1's end; an IC a pin 1 dot. Blurred by
    `blur` px like the camera's optics."""
    body = part.body
    if body is None:
        xs = [p[0] for pad in part.pads for p in pad]
        ys = [p[1] for pad in part.pads for p in pad]
        body = (min(xs) * 0.8, min(ys) * 0.8, max(xs) * 0.8, max(ys) * 0.8) if xs else (-0.4, -0.4, 0.4, 0.4)
    bx0, by0, bx1, by1 = body
    long_x = (bx1 - bx0) >= (by1 - by0)
    base = CAPACITOR_LUMA if part.ref.upper().startswith("C") else BODY_LUMA.get(part.kind, 40.0)
    body_cover = own_raster(part, [box_polygon(body)], size, step)
    luma = np.full((size, size), base, dtype=np.float32)
    metal = np.zeros((size, size), dtype=np.float32)
    if len(part.pads) == 2:
        # End caps: the outer fifth of the body's length at each end.
        cap = 0.2 * ((bx1 - bx0) if long_x else (by1 - by0))
        ends = ([(bx0, by0, bx0 + cap, by1), (bx1 - cap, by0, bx1, by1)] if long_x
                else [(bx0, by0, bx1, by0 + cap), (bx0, by1 - cap, bx1, by1)])
        metal = own_raster(part, [box_polygon(e) for e in ends], size, step)
    else:
        pads = own_raster(part, part.pads, size, step)
        metal = np.clip(pads - body_cover, 0.0, 1.0)
    cover = np.clip(body_cover + metal, 0.0, 1.0)
    luma = luma * (1.0 - metal) + METAL_LUMA * metal
    mark = np.zeros((size, size), dtype=np.float32)
    first = part.pad_names.index("1") if "1" in part.pad_names else None
    if first is not None and part.kind in (POLARIZED, IC):
        px = float(np.mean([p[0] for p in part.pads[first]]))
        py = float(np.mean([p[1] for p in part.pads[first]]))
        if part.kind == POLARIZED:
            band = 0.15 * ((bx1 - bx0) if long_x else (by1 - by0))
            if long_x:
                x = bx0 + 0.25 * (bx1 - bx0) if px < 0 else bx1 - 0.25 * (bx1 - bx0)
                mark = own_raster(part, [box_polygon((x - band / 2, by0, x + band / 2, by1))], size, step)
            else:
                y = by0 + 0.25 * (by1 - by0) if py < 0 else by1 - 0.25 * (by1 - by0)
                mark = own_raster(part, [box_polygon((bx0, y - band / 2, bx1, y + band / 2))], size, step)
        else:
            # A dot inside the body toward pad 1's corner.
            r = 0.12 * min(bx1 - bx0, by1 - by0)
            cx = bx0 + 2.0 * r if px < 0 else bx1 - 2.0 * r
            cy = by0 + 2.0 * r if py < 0 else by1 - 2.0 * r
            dot = [(cx + r * math.cos(t), cy + r * math.sin(t)) for t in np.linspace(0, 2 * math.pi, 16, endpoint=False)]
            mark = own_raster(part, [dot], size, step)
        mark = mark * body_cover
        luma = luma * (1.0 - mark) + MARK_LUMA * mark
    return gaussian_blur(luma * cover, blur) / np.maximum(gaussian_blur(cover, blur), 1e-6), gaussian_blur(cover, blur)


def paste(view: np.ndarray, luma: np.ndarray, cover: np.ndarray, shading: float = 1.0, dx: float = 0.0, dy: float = 0.0,
          degrees: float = 0.0, noise: float = 0.0, rng: np.random.Generator | None = None) -> np.ndarray:
    """A synthetic part pasted into a crop: its luma scaled by `shading`
    (the crop's light against the pictures' usual), turned `degrees`
    counterclockwise as seen about the crop's center, moved dx, dy px, and
    `noise` (luma sd) added where it covers."""
    lum, cov = luma, cover
    if degrees:
        lum = rotate(lum, degrees, fill=0.0)
        cov = rotate(cov, degrees, fill=0.0)
    if dx or dy:
        lum = shift_image(lum, dx, dy)
        cov = shift_image(cov, dx, dy)
    out = np.asarray(view, dtype=np.float32) * (1.0 - cov) + lum * shading * cov
    if noise and rng is not None:
        out = out + rng.normal(0.0, noise, out.shape).astype(np.float32) * (cov > 0.05)
    return out


def bare(view: np.ndarray, pads: np.ndarray, region: np.ndarray, noise: float = 0.0, rng: np.random.Generator | None = None) -> np.ndarray:
    """A crop with its pads painted over by the board around them: each
    pad pixel takes the median of the region's pixels no pad covers."""
    v = np.asarray(view, dtype=np.float32)
    free = region & (gaussian_blur(pads, 2.0) < 0.02) & np.isfinite(v)
    fill = float(np.median(v[free])) if free.any() else float(np.nanmedian(v))
    # Grown past the pads' edges, which the optics blur into the board.
    grown = np.maximum(np.clip(gaussian_blur(pads, 1.5) * 3.0, 0.0, 1.0), (pads > 0.5).astype(np.float32))
    out = v * (1.0 - grown) + fill * grown
    if noise and rng is not None:
        out = out + rng.normal(0.0, noise, out.shape).astype(np.float32) * (grown > 0.05)
    return out


def body_box(part: Part) -> tuple[float, float, float, float]:
    """A part's body in its own frame: its fabrication drawing's box, else
    its pads' box."""
    if part.body is not None:
        return part.body
    xs = [p[0] for pad in part.pads for p in pad]
    ys = [p[1] for pad in part.pads for p in pad]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else (-0.5, -0.5, 0.5, 0.5)


def cutout(view: np.ndarray, part: Part, size: int, step: float, grow: float = 0.1, feather: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """A real part as a crop shows it, to paste elsewhere: the crop's luma
    and a cover of its body's box grown by `grow` mm, feathered `feather`
    px."""
    x0, y0, x1, y1 = body_box(part)
    cover = own_raster(part, [box_polygon((x0 - grow, y0 - grow, x1 + grow, y1 + grow))], size, step)
    return np.asarray(view, dtype=np.float32), gaussian_blur(cover, feather)


def under(view: np.ndarray, cover: np.ndarray, pads: np.ndarray, pad_level: float, board_level: float) -> np.ndarray:
    """A crop with what `cover` covers replaced by the layout's bare pads:
    `pads` (0 to 1, the layout drawn on the crop) at `pad_level` luma on
    the mask at `board_level`."""
    bare_pads = board_level + np.asarray(pads, dtype=np.float32) * (pad_level - board_level)
    c = np.clip(np.asarray(cover, dtype=np.float32), 0.0, 1.0)
    return np.asarray(view, dtype=np.float32) * (1.0 - c) + bare_pads * c


def body_gap(part: Part, size: int, step: float, clear: float = 2.0) -> np.ndarray:
    """Where a placed part's body shows and a bare footprint shows only
    its mask: the body's box less the pads (and `clear` px about them,
    which the optics blur), on the part's crop."""
    box = own_raster(part, [box_polygon(body_box(part))], size, step) > 0.5
    pads = own_raster(part, part.pads, size, step)
    return box & (gaussian_blur(pads, clear) < 0.05)


def gap_luma(crop: np.ndarray, gap: np.ndarray) -> float:
    """The median luma of a crop where `gap` says (body_gap). On the
    LumenPnP's top camera a placed 0603 part's body read 60 to 108 there
    and a bare footprint's blue mask 15 to 61 (5th to 95th percentile):
    a threshold under the darkest placed part found 91% of bare
    footprints with no placed part called missing, where correlating the
    crop with a golden or with the bare pads found under half. The blue
    share of the colors, b / (r + g + b), separated them better still
    (0.52 to 0.68 against 0.70 to 0.96: 96% found)."""
    values = np.asarray(crop, dtype=np.float32)[np.asarray(gap, dtype=bool)]
    values = values[np.isfinite(values)]
    return float(np.median(values)) if values.size else math.nan
