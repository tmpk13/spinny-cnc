"""Measuring camera pictures by their pixels: how much a picture shows
(its share of strong edges), how far one picture is shifted against
another (phase correlation), and the camera's map from head moves to
picture shifts (scale, roll, mirror) fitted to a grid of such shifts.

The pictures come from pcbv as luma, a byte a pixel (`frame` with format
gray), so the backend needs no image decoder.

A round pattern's center (round_edge): where one camera looks into another
across the machine, the circle that fits the strongest round edge in the
picture, averaged over a few pictures (average_gray).

How busy a picture is: the share of its pixels, at most BUSY_WIDTH px wide,
where the luma changes by more than BUSY_CONTRAST between neighbors. On a
LumenPnP's top camera over a populated, blue masked board and its bed
(1280x720 at 0.016 mm a pixel, 276 pictures labelled by the board's place
found) pictures over the board read 0.05 to 0.30 (1 in 126 under 0.03),
pictures of the bed, its holder and feeders' tapes 0 to 0.06 (88 in 100
under 0.03): a picture under EMPTY_BUSY shows no board worth looking for,
and only one at BOARD_BUSY or more is worth pcbv's time on a scan of the
whole bed.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, replace

import numpy as np

# The width pictures are shrunk to for the busy share, px at most, and the
# luma step between neighbors (of 255) that counts as an edge.
BUSY_WIDTH = 320
BUSY_CONTRAST = 30.0
# Under this share a picture is empty; at this share or more a scan of the
# whole bed asks pcbv about it.
EMPTY_BUSY = 0.025
BOARD_BUSY = 0.06


def gray_array(reply: dict, data: bytes) -> np.ndarray:
    """A `frame` reply of format gray as a height by width array of
    luma; a ValueError when the bytes do not fill the size it says."""
    width, height = reply.get("width"), reply.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise ValueError("the picture's size is missing")
    if reply.get("format") != "gray":
        raise ValueError("pcbv sent a JPEG, not luma: it needs pcb-vision bf6c52b or later")
    if len(data) != width * height:
        raise ValueError(f"the picture holds {len(data)} bytes, not {width} by {height}")
    return np.frombuffer(data, dtype=np.uint8).reshape(height, width)


def fresh_gray(client, since: float, width: int | None, stopped=None, limit: float = 3.0) -> tuple[np.ndarray, dict]:
    """The camera's newest picture as luma (pictures.gray_array), taken
    `since` (time.monotonic()) or later: frames from before are asked
    again, for at most `limit` seconds; a ValueError when none comes, or
    `stopped` says to stop. pcbv tells each frame's age, from which its
    capture is told on this clock."""
    deadline = time.monotonic() + limit
    while True:
        if stopped is not None and stopped():
            raise ValueError("stopped")
        asked = time.monotonic()
        reply, data = client.gray(width)
        age = reply.get("age_ms")
        captured = asked - float(age) / 1000.0 if isinstance(age, (int, float)) else asked
        if captured >= since:
            return gray_array(reply, data), reply
        if time.monotonic() >= deadline:
            raise ValueError("the camera gave no new picture: is it still running?")
        time.sleep(min(0.03, max(0.0, since - captured)))


def busy_share(gray: np.ndarray, contrast: float = BUSY_CONTRAST) -> float:
    """The share of a picture's pixels where the luma changes by more than
    `contrast` to the next pixel right and down (both steps together)."""
    g = np.asarray(gray, dtype=np.float32)
    if g.ndim != 2 or g.shape[0] < 2 or g.shape[1] < 2:
        return 0.0
    gx = np.diff(g, axis=1)[:-1, :]
    gy = np.diff(g, axis=0)[:, :-1]
    return float((np.hypot(gx, gy) > contrast).mean())


def phase_shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float, float]:
    """How far picture `b` is shifted against picture `a` (a feature at x
    in `a` lies at x plus the shift in `b`), px right and down, to a tenth
    of a pixel or better on a textured picture, and the correlation's peak
    (0 to 1: under about 0.05 the pictures share little). Both pictures
    are windowed so their borders do not correlate."""
    fa_img = np.asarray(a, dtype=np.float64)
    fb_img = np.asarray(b, dtype=np.float64)
    if fa_img.shape != fb_img.shape or fa_img.ndim != 2:
        raise ValueError("the two pictures must be of one size")
    h, w = fa_img.shape
    window = np.outer(np.hanning(h), np.hanning(w))
    fa = np.fft.fft2((fa_img - fa_img.mean()) * window)
    fb = np.fft.fft2((fb_img - fb_img.mean()) * window)
    cross = fb * np.conj(fa)
    # Whitened by the square root of its magnitude, not the whole: fully
    # whitened, the frequencies a soft picture hardly holds weigh as much
    # as the rest and their noise pulled a 0.4 px shift to 0.1.
    cross /= np.sqrt(np.abs(cross)) + 1e-12
    surface = np.fft.ifft2(cross).real
    iy, ix = np.unravel_index(int(np.argmax(surface)), surface.shape)
    # The peak over the most it could reach, all frequencies in step: 1 for
    # two pictures one shifted copy of the other.
    peak = float(surface[iy, ix] / max(float(np.abs(cross).mean()), 1e-12))
    coarse_y = iy - h if iy > h / 2.0 else iy
    coarse_x = ix - w if ix > w / 2.0 else ix
    # The whole pixel peak refined by the correlation itself evaluated on a
    # finer grid about it (an upsampled inverse DFT, as Guizar-Sicairos et
    # al. do): a parabola through three pixels of so narrow a peak pulls the
    # shift toward the whole pixel, 0.2 px of a 12.3 px shift.
    dy, dx = float(coarse_y), float(coarse_x)
    for span, factor in ((1.0, 10), (0.1, 100)):
        dy, dx = _refine(cross, dy, dx, span, factor)
    return dx, dy, peak


def _refine(cross: np.ndarray, center_y: float, center_x: float, span: float, factor: int) -> tuple[float, float]:
    """Where the inverse DFT of `cross` peaks within `span` px of a place,
    evaluated every 1/`factor` px: the band limited correlation between
    its samples."""
    h, w = cross.shape
    offsets = np.arange(-span, span + 0.5 / factor, 1.0 / factor)
    ys = center_y + offsets
    xs = center_x + offsets
    rows = np.exp(2j * np.pi * np.outer(ys, np.fft.fftfreq(h)))
    columns = np.exp(2j * np.pi * np.outer(np.fft.fftfreq(w), xs))
    surface = (rows @ cross @ columns).real
    iy, ix = np.unravel_index(int(np.argmax(surface)), surface.shape)
    return float(ys[iy]), float(xs[ix])


@dataclass
class CameraMap:
    """A camera's picture against the head's moves: mm a pixel along the
    machine's X and Y (of the picture the shifts were measured in), the
    roll and mirror as camera.picture_to_machine takes them, how far from
    square the machine's axes show (degrees, 0 for square), and how well
    the moves fit (px rms, and the worst)."""

    mm_per_px_x: float
    mm_per_px_y: float
    roll: float
    mirror: bool
    skew_deg: float
    rms_px: float
    worst_px: float

    @property
    def mm_per_px(self) -> float:
        return math.sqrt(self.mm_per_px_x * self.mm_per_px_y)

    def to_dict(self) -> dict:
        return {
            "mm_per_px": round(self.mm_per_px, 7),
            "mm_per_px_x": round(self.mm_per_px_x, 7),
            "mm_per_px_y": round(self.mm_per_px_y, 7),
            "roll": round(self.roll, 4),
            "mirror": self.mirror,
            "skew_deg": round(self.skew_deg, 4),
            "rms_px": round(self.rms_px, 4),
            "worst_px": round(self.worst_px, 4),
        }


def fit_camera(moves: list[tuple[float, float]], shifts: list[tuple[float, float]]) -> CameraMap:
    """The camera's map from head moves (mm along the machine's X and Y,
    from where the first picture was taken) and the shifts the pictures
    showed against the first (px, right and down; phase_shift's). The head
    moving by m moves the scene by -m, so picture_to_machine(shift) is -m:
    the shifts are A m, A fitted by least squares, and -F A is the turn
    by -roll over the scale, F the picture's y turned over (and its x too
    when mirrored, which A's determinant tells). A ValueError for moves
    that do not span both axes."""
    m = np.asarray(moves, dtype=np.float64)
    s = np.asarray(shifts, dtype=np.float64)
    if m.shape != s.shape or m.ndim != 2 or m.shape[1] != 2 or len(m) < 2:
        raise ValueError("a move and a shift for each picture, two pictures at least")
    if np.linalg.matrix_rank(m, tol=1e-6) < 2:
        raise ValueError("the head's moves must go along both axes")
    solved, *_ = np.linalg.lstsq(m, s, rcond=None)
    a = solved.T
    mirror = bool(np.linalg.det(a) > 0.0)
    flip = np.array([[-1.0 if mirror else 1.0, 0.0], [0.0, -1.0]])
    b = -flip @ a
    # b's columns: the picture's frame (mirror undone, y up) seen per mm
    # of head X and of head Y; each is the scale's inverse long.
    x_px, y_px = float(np.hypot(*b[:, 0])), float(np.hypot(*b[:, 1]))
    if x_px <= 0.0 or y_px <= 0.0:
        raise ValueError("the pictures did not move with the head")
    # b is R(-roll) / scale: its first column (cos roll, -sin roll).
    roll = math.degrees(math.atan2(-b[1, 0], b[0, 0]))
    # Square axes show their columns 90 degrees apart, counterclockwise.
    between = math.degrees(math.atan2(b[1, 1], b[0, 1]) - math.atan2(b[1, 0], b[0, 0]))
    skew = (between - 90.0 + 180.0) % 360.0 - 180.0
    residual = s - m @ solved
    errors = np.hypot(residual[:, 0], residual[:, 1])
    return CameraMap(1.0 / x_px, 1.0 / y_px, roll, mirror, skew, float(math.sqrt(float((errors ** 2).mean()))), float(errors.max()))


# The lens from the same pictures: tiles of the first picture, LENS_TILE
# share of its width on a side and half a tile apart, followed into each
# picture after a head move (phase_shift). A tile flatter than
# LENS_MIN_STD (luma) or whose correlation peaks under LENS_MIN_PEAK is
# left out, as is the worst LENS_DROP share of the fit's residuals. A
# radial lens bends the local shift with the tile's distance from the
# picture's center; a lens whose term does not lower the residual by
# LENS_GAIN is no lens worth keeping.
LENS_TILE = 0.075
LENS_MIN_STD = 6.0
LENS_MIN_PEAK = 0.1
LENS_DROP = 0.05
LENS_GAIN = 0.9


@dataclass
class LensFit:
    """A camera's radial lens from the head's moves: k1 as pcbv takes it
    (u = c + (d - c)(1 + k1 rho^2), rho the distance from the center over
    the half diagonal; positive for a barrel lens, whose corners pcbv moves
    out), how far the lens moves a corner of the picture (px of the size
    measured, toward the center when positive), the tile shifts' residual
    without and with it (px of the size measured), and the tiles used."""

    k1: float
    corner_px: float
    rms_px: float
    rms_lens_px: float
    tiles: int
    # Each picture's shift at the picture's center, the lens taken out
    # (px of the size measured): the scale pcbv sees once it undoes the
    # lens; None for a picture without tiles enough.
    centers: list = field(default_factory=list)

    @property
    def worth(self) -> bool:
        return self.tiles >= 20 and self.rms_lens_px < LENS_GAIN * self.rms_px

    def to_dict(self) -> dict:
        return {
            "k1": round(self.k1, 5), "corner_px": round(self.corner_px, 3), "rms_px": round(self.rms_px, 4),
            "rms_lens_px": round(self.rms_lens_px, 4), "tiles": self.tiles, "worth": self.worth,
        }


def tile_shifts(a: np.ndarray, b: np.ndarray, at_a: np.ndarray, at_b: np.ndarray, size: int) -> list[tuple[float, float, float, bool]]:
    """phase_shift for many tiles at once: the `size` px square tiles of
    picture `a` centered at `at_a` (x, y rows) against those of `b` at
    `at_b`, all transformed together, each shift refined by a parabola
    through its peak's neighbors (a tenth of a pixel; thousands of tiles
    average it out); with each its peak and whether either tile is flatter
    than LENS_MIN_STD."""
    half = size // 2
    rows_a = at_a[:, 1][:, None] + np.arange(-half, half)[None, :]
    cols_a = at_a[:, 0][:, None] + np.arange(-half, half)[None, :]
    rows_b = at_b[:, 1][:, None] + np.arange(-half, half)[None, :]
    cols_b = at_b[:, 0][:, None] + np.arange(-half, half)[None, :]
    ta = a[rows_a[:, :, None], cols_a[:, None, :]]
    tb = b[rows_b[:, :, None], cols_b[:, None, :]]
    flat = (ta.std(axis=(1, 2)) < LENS_MIN_STD) | (tb.std(axis=(1, 2)) < LENS_MIN_STD)
    window = np.outer(np.hanning(size), np.hanning(size))[None, :, :]
    fa = np.fft.fft2((ta - ta.mean(axis=(1, 2), keepdims=True)) * window)
    fb = np.fft.fft2((tb - tb.mean(axis=(1, 2), keepdims=True)) * window)
    cross = fb * np.conj(fa)
    cross /= np.sqrt(np.abs(cross)) + 1e-12
    surface = np.fft.ifft2(cross).real
    flat_index = surface.reshape(len(surface), -1).argmax(axis=1)
    iy, ix = np.unravel_index(flat_index, (size, size))
    n = np.arange(len(surface))
    top = surface[n, iy, ix]
    peak = top / np.maximum(np.abs(cross).mean(axis=(1, 2)), 1e-12)

    def sub(minus: np.ndarray, plus: np.ndarray) -> np.ndarray:
        bend = minus - 2.0 * top + plus
        return np.where(np.abs(bend) < 1e-12, 0.0, 0.5 * (minus - plus) / np.where(np.abs(bend) < 1e-12, 1.0, bend))

    dy = iy + sub(surface[n, (iy - 1) % size, ix], surface[n, (iy + 1) % size, ix])
    dx = ix + sub(surface[n, iy, (ix - 1) % size], surface[n, iy, (ix + 1) % size])
    dy = np.where(dy > size / 2.0, dy - size, dy)
    dx = np.where(dx > size / 2.0, dx - size, dx)
    return [(float(x), float(y), float(p), bool(f)) for x, y, p, f in zip(dx, dy, peak, flat)]


def fit_lens(
    first: np.ndarray, pictures: list[np.ndarray], shifts: list[tuple[float, float]], full: tuple[float, float] | None = None,
    origin: tuple[float, float] = (0.0, 0.0),
) -> LensFit | None:
    """The radial lens the head's moves show: each picture's tiles' shifts
    against the first fitted as one translation per picture (`shifts`, the
    whole pictures' shifts, start it) plus one radial term shared by all.
    The pictures may be a crop of the picture the lens is for: `full` is
    that picture's width and height and `origin` the crop's top left in
    it (px, at the pictures' scale). In the picture's frame, normalized by
    the half diagonal, a point p shows at D(p) = p (1 + k |p|^2); a
    translation t moves a tile at x by t + k (|x + t|^2 (x + t) - |x|^2 x),
    linear in t and k once the term's t is the whole picture's shift. pcbv
    takes the inverse, k1 = -k to first order. None without tiles enough."""
    a = np.asarray(first, dtype=np.float64)
    h, w = a.shape
    fw, fh = full if full is not None else (float(w), float(h))
    center = np.array([fw / 2.0, fh / 2.0])
    norm = math.hypot(fw / 2.0, fh / 2.0)
    size = max(16, int(round(LENS_TILE * fw / 2.0)) * 2)
    half = size // 2
    rows: list[tuple[int, float, float, float, float]] = []
    places = [(tx, ty) for ty in range(half + 2, h - half - 2, half) for tx in range(half + 2, w - half - 2, half)]
    for index, (picture, (sx, sy)) in enumerate(zip(pictures, shifts)):
        b = np.asarray(picture, dtype=np.float64)
        if b.shape != a.shape:
            continue
        pairs = []
        for tx, ty in places:
            qx, qy = int(round(tx + sx)), int(round(ty + sy))
            if half + 2 <= qx < w - half - 2 and half + 2 <= qy < h - half - 2:
                pairs.append((tx, ty, qx, qy))
        if not pairs:
            continue
        here = np.asarray(pairs, dtype=np.int64)
        found = tile_shifts(a, b, here[:, 0:2], here[:, 2:4], size)
        for (tx, ty, qx, qy), (dx, dy, peak, flat) in zip(pairs, found):
            if flat or peak < LENS_MIN_PEAK:
                continue
            rows.append((index, tx + origin[0], ty + origin[1], qx - tx + dx, qy - ty + dy))
    if len(rows) < 20:
        return None
    data = np.asarray(rows, dtype=np.float64)
    pairs = sorted({int(i) for i in data[:, 0]})
    column = {pair: n for n, pair in enumerate(pairs)}
    x = (data[:, 1:3] - center) / norm
    observed = data[:, 3:5].reshape(-1)
    translations = {pair: np.asarray(shifts[pair], dtype=np.float64) / norm for pair in pairs}

    cols = np.array([column[int(i)] for i in data[:, 0]])
    count = np.arange(len(data))

    def system(with_lens: bool) -> np.ndarray:
        matrix = np.zeros((2 * len(data), 2 * len(pairs) + (1 if with_lens else 0)))
        matrix[2 * count, 2 * cols] = 1.0
        matrix[2 * count + 1, 2 * cols + 1] = 1.0
        if with_lens:
            t = np.array([translations[pairs[c]] for c in cols])
            moved = x + t
            bend = (moved * moved).sum(axis=1)[:, None] * moved - (x * x).sum(axis=1)[:, None] * x
            matrix[2 * count, -1] = bend[:, 0] * norm
            matrix[2 * count + 1, -1] = bend[:, 1] * norm
        return matrix

    keep = np.ones(len(observed), dtype=bool)
    solution = np.zeros(2 * len(pairs) + 1)
    for _ in range(2):
        matrix = system(True)
        solution, *_ = np.linalg.lstsq(matrix[keep], observed[keep], rcond=None)
        # The translations fitted stand in the lens' term for the next round.
        for pair, n in column.items():
            translations[pair] = solution[2 * n:2 * n + 2] / norm
        residual = np.abs(observed - matrix @ solution)
        # Both components of a tile go or stay together.
        worst = np.maximum(residual[0::2], residual[1::2])
        keep = np.repeat(worst <= np.quantile(worst, 1.0 - LENS_DROP), 2)
    matrix = system(True)
    solution, *_ = np.linalg.lstsq(matrix[keep], observed[keep], rcond=None)
    rms_lens = float(np.sqrt(np.mean((observed[keep] - matrix[keep] @ solution) ** 2)))
    plain = matrix[:, :-1]
    flat, *_ = np.linalg.lstsq(plain[keep], observed[keep], rcond=None)
    rms = float(np.sqrt(np.mean((observed[keep] - plain[keep] @ flat) ** 2)))
    k = float(solution[-1])
    centers = [
        (float(solution[2 * column[n]]), float(solution[2 * column[n] + 1])) if n in column else None for n in range(len(pictures))
    ]
    return LensFit(-k, -k * norm, rms, rms_lens, int(keep.sum() // 2), centers)



# --- a round pattern's center ------------------------------------------------
#
# A camera looking into another one across the machine (the top camera down
# into the bottom camera, far out of focus) sees soft concentric rings: the
# other camera's ring light, its lens and the lens' barrel. The picture
# compared with itself turned half round, and the point its gradients all
# point at, both mix those rings, which lie at different depths and so shift
# by different amounts as the head moves; a ring wider than the picture is
# cut by its top and bottom edges as well, and that cut reads as symmetry
# about the picture's middle row. On a LumenPnP's top camera over its bottom
# camera (2026-11-19, 10 head places within 2 mm) the half turn followed the
# head along Y to 12 px rms, the gradients' meeting point to 2 px, a circle
# fitted to the ring light's inner edge alone to 0.9 px. That circle moved
# 0.5 to 0.8 px from one picture to the next with the head still: the
# pictures of a look are averaged (average_gray).
#
# The rays of ROUND_RAYS cross every radius about a first center; the edge
# taken is the radius where the luma climbs (or falls) most steadily round
# the circle, counting rays that leave the picture as nothing there, so a
# ring mostly outside the picture is passed over; each ray's edge is then
# the steepest place within ROUND_BAND of that radius, and a circle is
# fitted to them, twice.

ROUND_RAYS = 360
# Of the measured picture, px: the smoothing before the edges are found,
# and the least radius looked at as a share of the picture's height.
ROUND_SMOOTH = 1.5
ROUND_INNER = 0.04
ROUND_BAND = 0.12
# An edge that fewer rays than this find, or that climbs less than
# ROUND_MIN_STEEPNESS luma a px averaged round its circle, is no circle to
# go by (the LumenPnP's ring light: about 6); a ray's edge weaker than
# ROUND_WEAK of the circle's is left out, as is one further from the
# fitted circle than ROUND_OUTLIER times the rms (and at least
# ROUND_OUTLIER_PX px).
ROUND_MIN_RAYS = 40
ROUND_MIN_STEEPNESS = 0.5
ROUND_WEAK = 0.25
ROUND_OUTLIER = 3.0
ROUND_OUTLIER_PX = 1.0


@dataclass
class RoundEdge:
    """A circle fitted to a picture's strongest round edge: its center, px
    right and down from the picture's center (pcbv's spot's dx and dy), its
    radius, the edge's points' rms from it (px), how many rays found the
    edge, and how steep the edge is (luma a px, averaged round it)."""

    dx: float
    dy: float
    radius: float
    rms: float
    rays: int
    steepness: float

    def scaled(self, factor: float) -> RoundEdge:
        """The same circle in a picture `factor` times as wide."""
        return replace(self, dx=self.dx * factor, dy=self.dy * factor, radius=self.radius * factor, rms=self.rms * factor)

    def to_dict(self) -> dict:
        return {
            "dx": round(self.dx, 3),
            "dy": round(self.dy, 3),
            "radius": round(self.radius, 2),
            "rms": round(self.rms, 3),
            "rays": self.rays,
            "steepness": round(self.steepness, 2),
        }


def smooth(gray: np.ndarray, sigma: float) -> np.ndarray:
    """The picture blurred by a Gaussian of `sigma` px, its edges held."""
    g = np.asarray(gray, dtype=np.float64)
    if sigma <= 0.0:
        return g
    reach = max(1, int(math.ceil(3.0 * sigma)))
    kernel = np.exp(-0.5 * (np.arange(-reach, reach + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(g, reach, mode="edge")
    rows = sum(kernel[i] * padded[:, i:i + g.shape[1]] for i in range(kernel.size))
    return sum(kernel[i] * rows[i:i + g.shape[0], :] for i in range(kernel.size))


def _bilinear(g: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """The picture at continuous places (pixel i spans i to i + 1, its center
    at i + 0.5), NaN outside the pixels' centers."""
    h, w = g.shape
    x = xs - 0.5
    y = ys - 0.5
    inside = (x >= 0.0) & (x <= w - 1.0) & (y >= 0.0) & (y <= h - 1.0)
    x0 = np.clip(np.floor(x).astype(int), 0, w - 2)
    y0 = np.clip(np.floor(y).astype(int), 0, h - 2)
    fx = np.clip(x - x0, 0.0, 1.0)
    fy = np.clip(y - y0, 0.0, 1.0)
    value = (
        g[y0, x0] * (1.0 - fx) * (1.0 - fy) + g[y0, x0 + 1] * fx * (1.0 - fy)
        + g[y0 + 1, x0] * (1.0 - fx) * fy + g[y0 + 1, x0 + 1] * fx * fy
    )
    return np.where(inside, value, np.nan)


def gradient_center(gray: np.ndarray) -> tuple[float, float]:
    """The point the picture's gradients point at most nearly (each one's
    line weighted by its steepness squared over its distance from their
    centroid, Parthasarathy's radial symmetry center), in continuous px
    from the picture's top left: a first center for round_edge."""
    g = np.asarray(gray, dtype=np.float64)
    h, w = g.shape
    a, b, c, d = g[:-1, :-1], g[:-1, 1:], g[1:, :-1], g[1:, 1:]
    gx = ((b - a) + (d - c)) / 2.0
    gy = ((c - a) + (d - b)) / 2.0
    ys, xs = np.mgrid[1:h, 1:w].astype(np.float64)
    steep = gx * gx + gy * gy
    total = float(steep.sum())
    if total <= 0.0:
        return w / 2.0, h / 2.0
    length = np.sqrt(steep) + 1e-12
    nx, ny = -gy / length, gx / length
    cx, cy = float((steep * xs).sum() / total), float((steep * ys).sum() / total)
    weight = steep / np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2 + 1.0)
    a11, a12, a22 = (weight * nx * nx).sum(), (weight * nx * ny).sum(), (weight * ny * ny).sum()
    along = nx * xs + ny * ys
    b1, b2 = (weight * nx * along).sum(), (weight * ny * along).sum()
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-12:
        return cx, cy
    return float((a22 * b1 - a12 * b2) / det), float((a11 * b2 - a12 * b1) / det)


def _circle(points: np.ndarray) -> tuple[float, float, float, np.ndarray]:
    """The circle through points by least squares on its equation (Kasa's
    fit): its center, its radius and each point's distance from it less
    the radius."""
    mx, my = points.mean(axis=0)
    u, v = points[:, 0] - mx, points[:, 1] - my
    suu, svv, suv = (u * u).sum(), (v * v).sum(), (u * v).sum()
    rhs_u = 0.5 * ((u * u * u).sum() + (u * v * v).sum())
    rhs_v = 0.5 * ((v * v * v).sum() + (v * u * u).sum())
    det = suu * svv - suv * suv
    if abs(det) < 1e-9:
        raise ValueError("the edge's points lie on a line")
    uc = (rhs_u * svv - rhs_v * suv) / det
    vc = (rhs_v * suu - rhs_u * suv) / det
    radius = math.sqrt(uc * uc + vc * vc + (suu + svv) / len(points))
    cx, cy = uc + mx, vc + my
    return cx, cy, radius, np.hypot(points[:, 0] - cx, points[:, 1] - cy) - radius


def round_edge(gray: np.ndarray, near: tuple[float, float] | None = None) -> RoundEdge | None:
    """The circle of the picture's strongest round edge (see above), about
    `near` (continuous px from the top left; the gradients' meeting point
    by default); None when no edge goes round far enough to fit."""
    g = smooth(gray, ROUND_SMOOTH)
    h, w = g.shape
    cx, cy = near if near is not None else gradient_center(g)
    angles = np.linspace(0.0, 2.0 * math.pi, ROUND_RAYS, endpoint=False)
    cos, sin = np.cos(angles)[:, None], np.sin(angles)[:, None]
    found: RoundEdge | None = None
    for _ in range(2):
        radii = np.arange(ROUND_INNER * h, math.hypot(w, h) / 2.0, 0.5)
        values = _bilinear(g, cx + radii[None, :] * cos, cy + radii[None, :] * sin)
        slope = np.gradient(values, 0.5, axis=1)
        # Round the circle at each radius, rays outside the picture adding
        # nothing: an edge most rays cross the same way stands out.
        steady = np.nan_to_num(slope).sum(axis=0) / ROUND_RAYS
        best = int(np.argmax(np.abs(steady)))
        sign = 1.0 if steady[best] >= 0.0 else -1.0
        strength = abs(float(steady[best]))
        if strength < ROUND_MIN_STEEPNESS:
            return found
        band = np.abs(radii - radii[best]) <= ROUND_BAND * radii[best]
        span = np.flatnonzero(band)
        lo, hi = int(span[0]), int(span[-1]) + 1
        within = sign * slope[:, lo:hi]
        whole = ~np.isnan(within).any(axis=1)
        points: list[tuple[float, float]] = []
        for ray in np.flatnonzero(whole):
            row = within[ray]
            i = int(np.argmax(row))
            # The steepest place away from the band's ends, on a ray whose
            # edge is about as steep as the circle's.
            if i == 0 or i == row.size - 1 or row[i] < ROUND_WEAK * strength:
                continue
            below, peak, above = row[i - 1], row[i], row[i + 1]
            bend = below - 2.0 * peak + above
            shift = 0.5 * (below - above) / bend if bend < 0.0 else 0.0
            r = radii[lo + i] + 0.5 * shift
            points.append((cx + r * float(cos[ray, 0]), cy + r * float(sin[ray, 0])))
        if len(points) < ROUND_MIN_RAYS:
            return found
        array = np.asarray(points)
        fx, fy, radius, off = _circle(array)
        rms = float(np.sqrt(np.mean(off * off)))
        keep = np.abs(off) <= max(ROUND_OUTLIER * rms, ROUND_OUTLIER_PX)
        if keep.sum() >= ROUND_MIN_RAYS and not keep.all():
            fx, fy, radius, off = _circle(array[keep])
            rms = float(np.sqrt(np.mean(off * off)))
        cx, cy = fx, fy
        found = RoundEdge(dx=cx - w / 2.0, dy=cy - h / 2.0, radius=radius, rms=rms, rays=int(keep.sum()), steepness=strength)
    return found


def average_gray(client, count: int, since: float, width: int | None, stopped=None, limit: float = 3.0) -> tuple[np.ndarray, dict]:
    """The mean of `count` of the camera's pictures as luma, each a frame of
    its own taken `since` (time.monotonic()) or later (fresh_gray's), and
    the last one's reply. pcbv numbers its frames; one told twice is asked
    again."""
    total: np.ndarray | None = None
    taken = 0
    last = None
    reply: dict = {}
    deadline = time.monotonic() + limit + count * 0.2
    while taken < count:
        gray, reply = fresh_gray(client, since, width, stopped, limit)
        number = reply.get("frame")
        if number is not None and number == last:
            if time.monotonic() > deadline:
                raise ValueError("the camera gave no new picture: is it still running?")
            time.sleep(0.01)
            continue
        last = number
        total = gray.astype(np.float64) if total is None else total + gray
        taken += 1
    return total / float(count), reply
