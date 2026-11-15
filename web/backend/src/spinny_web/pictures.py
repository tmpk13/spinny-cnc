"""Measuring camera pictures by their pixels: how much a picture shows
(its share of strong edges), how far one picture is shifted against
another (phase correlation), and the camera's map from head moves to
picture shifts (scale, roll, mirror) fitted to a grid of such shifts.

The pictures come from pcbv as luma, a byte a pixel (`frame` with format
gray), so the backend needs no image decoder.

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
from dataclasses import dataclass, field

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

