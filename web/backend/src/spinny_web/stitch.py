"""Stitching a head camera's pictures into one map of what lay under it: a
camera model (pcbv's radial lens, the picture's scale and roll, the
machine's axes out of square), the seams between overlapping pictures
measured by phase correlation, a least-squares adjustment of the pictures
or of the camera from those seams, and the mosaic itself.

Frames and conventions:

- A picture's pixels: x right, y down, pixel centers at whole numbers; its
  center is (width / 2, height / 2), as pcbv counts it.
- The lens is pcbv's: a raw pixel d corrects to
  u = c + (d - c) (1 + k1 rho^2 + k2 rho^4), rho = |d - c| / half the
  picture's diagonal, the point a pinhole camera would have put there.
- The machine frame is the head's X and Y as the machine counts them, mm.
  A point seen at corrected pixel offset (dx, dy) from the center of a
  picture taken with the head at H lies at H + A (u, v), where u is dx (its
  negative when the picture is mirrored), v is -dy (y turned up), and A is
  the camera's 2 by 2 map in mm a pixel. For a camera rolled by `roll`
  (as camera.picture_to_machine takes it) with `mm_per_px`, on axes whose
  Y leans `skew` degrees toward +X: A = K^-1 mm_per_px R(roll), K the
  machine's axes in a square frame, [[1, sin skew], [0, cos skew]].
- The square frame: K applied to machine places, the frame in which a
  rigid board stays rigid (X kept, Y made square to it).
- A mosaic is a raster over machine places: column i at x0 + i step,
  row j at y1 - j step (rows go down the picture as Y goes down), so the
  board reads as KiCad draws it when the truth maps (x, -y) to the head.
- Scale that changes: a picture plane not parallel to the board (the
  camera's tilt) changes the scale across each picture; a board whose
  surface lies nearer the camera in places (a relief: tilted against the
  head's travel, or bowed) shows those places larger in every picture,
  so overlapping pictures disagree there in proportion to how far apart
  they were taken (parallax). Both are fitted from the seams. On a
  LumenPnP's top camera over a 100 mm board the relief spanned 2% of the
  scale and was, after the lens, the largest error of a mosaic; a part's
  top above the board shows the same parallax.

Everything here works on numpy arrays of luma; nothing reads a file.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np

from .pictures import phase_shift

Point = tuple[float, float]

# A window shows too little to register when its correlation peak is under
# this (pictures.phase_shift's measure, 0 to 1).
MIN_PEAK = 0.12
# A window registers only when this share of it holds edges (pictures'
# busy share at full size: luma steps over 30 of 255 between neighbors).
MIN_BUSY = 0.02
# Shifts found beyond this many px are failed registrations, not seams.
MAX_SHIFT_PX = 12.0


# --- the camera -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Camera:
    """A head camera's pixels against the machine's places: the picture's
    size (px), `axes` the row-major 2 by 2 map from a corrected pixel
    offset (u right, v up, mirror undone) to machine mm, the lens terms
    k1 and k2 (pcbv's), whether the picture is mirrored, and `tilt` (per
    px along u and v): a picture plane not parallel to the board's makes
    the scale change across the picture, a corrected offset d reaching
    A d / (1 + tilt . d)."""

    width: int
    height: int
    axes: tuple[float, float, float, float]
    k1: float = 0.0
    k2: float = 0.0
    mirror: bool = False
    tilt: tuple[float, float] = (0.0, 0.0)

    @classmethod
    def measured(cls, width: int, height: int, mm_per_px: float, roll: float, mirror: bool = False, skew: float = 0.0,
                 k1: float = 0.0, k2: float = 0.0, aspect: float = 1.0) -> Camera:
        """A camera from the numbers a measure gives: mm a pixel, roll
        (degrees), mirror, the machine's axes out of square (`skew`, degrees
        the Y axis leans toward +X: 90 minus the angle between X and Y), the
        lens, and `aspect`, mm a pixel along the picture's y over along its
        x."""
        r = math.radians(roll)
        c, s = math.cos(r), math.sin(r)
        rot = np.array([[c, -s], [s, c]]) @ np.diag([mm_per_px, mm_per_px * aspect])
        a = np.linalg.inv(square_axes(skew)) @ rot
        return cls(width, height, tuple(float(v) for v in a.ravel()), k1, k2, mirror)

    @property
    def matrix(self) -> np.ndarray:
        return np.array(self.axes, dtype=np.float64).reshape(2, 2)

    @property
    def center(self) -> Point:
        return (self.width / 2.0, self.height / 2.0)

    @property
    def radius(self) -> float:
        return math.hypot(self.width / 2.0, self.height / 2.0)

    def with_lens(self, k1: float, k2: float = 0.0) -> Camera:
        return replace(self, k1=float(k1), k2=float(k2))

    def undistort(self, px, py) -> tuple[np.ndarray, np.ndarray]:
        """Raw pixels to the pinhole pixels pcbv's lens correction gives."""
        cx, cy = self.center
        dx, dy = np.asarray(px, dtype=np.float64) - cx, np.asarray(py, dtype=np.float64) - cy
        rho2 = (dx * dx + dy * dy) / (self.radius * self.radius)
        gain = 1.0 + self.k1 * rho2 + self.k2 * rho2 * rho2
        return cx + dx * gain, cy + dy * gain

    def distort(self, ux, uy) -> tuple[np.ndarray, np.ndarray]:
        """Pinhole pixels back to raw ones: undistort's inverse, by Newton's
        method on the radius (the correction is radial)."""
        cx, cy = self.center
        dx, dy = np.asarray(ux, dtype=np.float64) - cx, np.asarray(uy, dtype=np.float64) - cy
        if self.k1 == 0.0 and self.k2 == 0.0:
            return cx + dx, cy + dy
        target = np.hypot(dx, dy) / self.radius
        r = target.copy()
        for _ in range(8):
            r2 = r * r
            f = r * (1.0 + self.k1 * r2 + self.k2 * r2 * r2) - target
            slope = 1.0 + 3.0 * self.k1 * r2 + 5.0 * self.k2 * r2 * r2
            r = r - f / slope
        with np.errstate(invalid="ignore", divide="ignore"):
            ratio = np.where(target > 0.0, r / np.where(target > 0.0, target, 1.0), 1.0)
        return cx + dx * ratio, cy + dy * ratio

    def offset_of(self, px, py) -> tuple[np.ndarray, np.ndarray]:
        """Raw pixels as machine displacements (mm) from the place the
        picture's center sees."""
        ux, uy = self.undistort(px, py)
        cx, cy = self.center
        u = ux - cx
        if self.mirror:
            u = -u
        v = -(uy - cy)
        a = self.axes
        scale = 1.0 / (1.0 + self.tilt[0] * u + self.tilt[1] * v)
        return (a[0] * u + a[1] * v) * scale, (a[2] * u + a[3] * v) * scale

    def pixel_of(self, mx, my) -> tuple[np.ndarray, np.ndarray]:
        """Machine displacements from the center's place as raw pixels:
        offset_of's inverse."""
        inv = np.linalg.inv(self.matrix)
        mx, my = np.asarray(mx, dtype=np.float64), np.asarray(my, dtype=np.float64)
        u = inv[0, 0] * mx + inv[0, 1] * my
        v = inv[1, 0] * mx + inv[1, 1] * my
        # A d = m (1 + t.d): with q = A^-1 m, d = q / (1 - t.q).
        scale = 1.0 / (1.0 - self.tilt[0] * u - self.tilt[1] * v)
        u, v = u * scale, v * scale
        cx, cy = self.center
        if self.mirror:
            u = -u
        return self.distort(cx + u, cy - v)

    def describe(self) -> dict:
        """The camera map's numbers as a measure names them: mm a pixel
        along the picture's x and y, roll (degrees), the machine's axes'
        skew (degrees, Y leaning toward +X), the lens, and the tilt as the
        scale's change from the picture's center to its right and top
        edges (fractions)."""
        a = self.matrix
        col_x, col_y = a[:, 0], a[:, 1]

        # A = K^-1 s R D: in the square frame (K A) the picture's two axes
        # are perpendicular, which fixes the skew; bisection finds it.
        def perpendicularity(e: float) -> float:
            k = square_axes(e)
            return float((k @ col_x) @ (k @ col_y))

        lo, hi = -5.0, 5.0
        for _ in range(80):
            mid = (lo + hi) / 2.0
            if perpendicularity(lo) * perpendicularity(mid) <= 0.0:
                hi = mid
            else:
                lo = mid
        skew = (lo + hi) / 2.0
        k = square_axes(skew)
        p, q = k @ col_x, k @ col_y
        roll = math.degrees(math.atan2(p[1], p[0]))
        return {
            "mm_per_px_x": float(np.hypot(*p)),
            "mm_per_px_y": float(np.hypot(*q)),
            "roll": roll % 360.0,
            "skew_deg": skew,
            "k1": self.k1,
            "k2": self.k2,
            "tilt_x": -self.tilt[0] * self.width / 2.0,
            "tilt_y": -self.tilt[1] * self.height / 2.0,
        }


def square_axes(skew: float) -> np.ndarray:
    """K: machine places to the square frame, for a Y axis leaning `skew`
    degrees toward +X."""
    e = math.radians(skew)
    return np.array([[1.0, math.sin(e)], [0.0, math.cos(e)]])


# --- sampling ---------------------------------------------------------------------------------


def bilinear(image: np.ndarray, px, py) -> np.ndarray:
    """The picture's luma at fractional pixels, bilinear; NaN outside it."""
    img = np.asarray(image, dtype=np.float32)
    h, w = img.shape
    px = np.asarray(px, dtype=np.float64)
    py = np.asarray(py, dtype=np.float64)
    inside = (px >= 0.0) & (py >= 0.0) & (px <= w - 1) & (py <= h - 1)
    x = np.clip(px, 0.0, w - 1.000001)
    y = np.clip(py, 0.0, h - 1.000001)
    x0 = np.floor(x).astype(np.intp)
    y0 = np.floor(y).astype(np.intp)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    top = img[y0, x0] * (1.0 - fx) + img[y0, x0 + 1] * fx
    bottom = img[y0 + 1, x0] * (1.0 - fx) + img[y0 + 1, x0 + 1] * fx
    out = top * (1.0 - fy) + bottom * fy
    return np.where(inside, out, np.nan).astype(np.float32)


def grid(center: Point, size: int, step: float) -> tuple[np.ndarray, np.ndarray]:
    """Machine places of a square raster `size` px across at `step` mm a
    px about `center`: column i right along +X, row j down along -Y."""
    k = (np.arange(size, dtype=np.float64) - (size - 1) / 2.0) * step
    gx, gy = np.meshgrid(center[0] + k, center[1] - k)
    return gx, gy


def render(image: np.ndarray, camera: Camera, head: Point, gx: np.ndarray, gy: np.ndarray, relief: Relief | None = None) -> np.ndarray:
    """What a picture taken with the head at `head` shows at machine places
    gx, gy (NaN where it does not reach), on a `relief` when given."""
    px, py = camera.pixel_of(*reach(gx, gy, head, relief))
    return bilinear(image, px, py)


def reach(gx, gy, head, relief: Relief | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Machine places as the displacements a picture taken at `head` shows
    them at: on a relief, (1 + r) times their distance from the head."""
    mx = np.asarray(gx, dtype=np.float64) - head[0]
    my = np.asarray(gy, dtype=np.float64) - head[1]
    if relief is None:
        return mx, my
    grow = 1.0 + relief.at(gx, gy)
    return mx * grow, my * grow


def flat_field(pictures: np.ndarray, blur: int = 41) -> np.ndarray:
    """A gain per pixel that evens out the light across the picture: the
    median of many pictures of different places, smoothed by a box `blur`
    px wide, as the median's level over it. Multiply a picture by it."""
    med = np.median(np.asarray(pictures, dtype=np.float32), axis=0)
    smooth = box_blur(med, blur)
    return (float(np.median(smooth)) / np.maximum(smooth, 1.0)).astype(np.float32)


def box_blur(image: np.ndarray, size: int) -> np.ndarray:
    """A box filter `size` px wide (odd), edges by reflection: two passes of
    running sums."""
    out = np.asarray(image, dtype=np.float64)
    half = size // 2
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (half + 1, half)
        padded = np.pad(out, pad, mode="reflect")
        sums = np.cumsum(padded, axis=axis)
        upper = np.take(sums, np.arange(size, sums.shape[axis]), axis=axis)
        lower = np.take(sums, np.arange(0, sums.shape[axis] - size), axis=axis)
        out = (upper - lower) / size
    return out.astype(np.float32)


def busy(values: np.ndarray, contrast: float = 30.0) -> float:
    """The share of a window's pixels where luma steps by more than
    `contrast` to the next pixel right and down."""
    g = np.asarray(values, dtype=np.float32)
    gx = np.diff(g, axis=1)[:-1, :]
    gy = np.diff(g, axis=0)[:, :-1]
    return float((np.hypot(gx, gy) > contrast).mean())


# --- seams ------------------------------------------------------------------------------------


@dataclass
class Window:
    """A square of the machine seen by two pictures, i and j: its center
    (machine mm), and once registered the seam there: where j puts what i
    shows, minus where i puts it (mm, machine X and Y), the correlation's
    peak and how busy the window is."""

    i: int
    j: int
    center: Point
    residual: Point = (math.nan, math.nan)
    peak: float = 0.0
    busy: float = 0.0

    @property
    def size_mm(self) -> float:
        return math.hypot(*self.residual)


def footprint(camera: Camera, head: Point, margin: float = 0.0) -> tuple[float, float, float, float]:
    """The machine box (x0, y0, x1, y1) a picture's raw corners span, shrunk
    by `margin` mm."""
    w, h = camera.width - 1, camera.height - 1
    xs = np.array([0.0, w, w, 0.0, w / 2.0, w / 2.0, 0.0, w])
    ys = np.array([0.0, 0.0, h, h, 0.0, h, h / 2.0, h / 2.0])
    mx, my = camera.offset_of(xs, ys)
    # The box inside the picture: the corners' second smallest and second
    # largest values keep it inside a slightly turned picture.
    sx, sy = np.sort(mx + head[0]), np.sort(my + head[1])
    return (sx[2] + margin, sy[2] + margin, sx[-3] - margin, sy[-3] - margin)


def overlap_windows(heads: np.ndarray, camera: Camera, size: int, step: float, stride: float) -> list[Window]:
    """Windows `size` px across (at `step` mm a px) laid every `stride` mm
    over each overlap of two pictures, each wholly inside both."""
    half = size * step / 2.0
    boxes = [footprint(camera, (float(h[0]), float(h[1])), half + 2.0 * step) for h in heads]
    windows: list[Window] = []
    for i in range(len(heads)):
        for j in range(i + 1, len(heads)):
            a, b = boxes[i], boxes[j]
            x0, y0 = max(a[0], b[0]), max(a[1], b[1])
            x1, y1 = min(a[2], b[2]), min(a[3], b[3])
            if x1 < x0 or y1 < y0:
                continue
            nx = int((x1 - x0) // stride) + 1
            ny = int((y1 - y0) // stride) + 1
            xs = x0 + (x1 - x0 - (nx - 1) * stride) / 2.0 + stride * np.arange(nx)
            ys = y0 + (y1 - y0 - (ny - 1) * stride) / 2.0 + stride * np.arange(ny)
            for y in ys:
                for x in xs:
                    windows.append(Window(i, j, (float(x), float(y))))
    return windows


def register(pictures, heads: np.ndarray, camera: Camera, windows: list[Window], size: int, step: float,
             shifts: np.ndarray | None = None, rounds: int = 5, skip_busy: float = 0.0, relief: Relief | None = None) -> list[Window]:
    """Each window rendered from both of its pictures (placed at their head
    places plus `shifts`, mm, when given) and phase correlated: the seam's
    residual, peak and busy share filled in, in place; returns the
    windows.

    A Hann windowed phase correlation reads a shift short, since the
    window itself does not move: by a third at 3 px in a 48 px window of
    soft texture, by 2% on a board's sharp pads at 48 px and not
    measurably at 160 px. So picture j's window is rendered again moved
    by the residual found and correlated again, up to `rounds` times,
    until what is left is under a hundredth of a pixel: at no shift the
    reading is unbiased.
    A window of picture i busy less than `skip_busy` is not correlated.
    Places lie on `relief` when given."""
    for w in windows:
        gx, gy = grid(w.center, size, step)
        hi = heads[w.i] + (shifts[w.i] if shifts is not None else 0.0)
        hj = heads[w.j] + (shifts[w.j] if shifts is not None else 0.0)
        a = render(pictures[w.i], camera, (float(hi[0]), float(hi[1])), gx, gy, relief)
        if np.isnan(a).any():
            w.residual, w.peak, w.busy = (math.nan, math.nan), 0.0, 0.0
            continue
        if skip_busy > 0.0 and busy(a) < skip_busy:
            w.residual, w.peak, w.busy = (math.nan, math.nan), 0.0, busy(a)
            continue
        rx = ry = 0.0
        peak = 0.0
        b = a
        for _ in range(max(1, rounds)):
            b = render(pictures[w.j], camera, (float(hj[0]), float(hj[1])), gx + rx, gy + ry, relief)
            if np.isnan(b).any():
                rx = ry = math.nan
                break
            dx, dy, peak = phase_shift(a, b)
            # A feature at window pixel p in a lies at p + (dx, dy) in b: j
            # puts it dx right (+X) and dy down (-Y) of where i puts it.
            rx += dx * step
            ry -= dy * step
            if math.hypot(dx, dy) < 0.01 or math.hypot(dx, dy) > MAX_SHIFT_PX:
                break
        if not math.isfinite(rx):
            w.residual, w.peak, w.busy = (math.nan, math.nan), 0.0, 0.0
            continue
        w.residual = (rx, ry)
        w.peak = peak
        w.busy = min(busy(a), busy(b))
    return windows


def good(windows: list[Window], min_peak: float = MIN_PEAK, min_busy: float = MIN_BUSY, max_mm: float | None = None) -> list[Window]:
    """The windows whose registration can be trusted: a clear peak, enough
    edges, and a residual inside `max_mm` when given."""
    kept = []
    for w in windows:
        if not math.isfinite(w.residual[0]) or w.peak < min_peak or w.busy < min_busy:
            continue
        if max_mm is not None and w.size_mm > max_mm:
            continue
        kept.append(w)
    return kept


def phase_shift_near(a: np.ndarray, b: np.ndarray, reach: float) -> tuple[float, float, float]:
    """pictures.phase_shift with the peak sought only within `reach` px of
    no shift: where a picture repeats (rows of pads at a pitch) the
    highest peak can be a neighbor's, and the place is known to well
    under a pitch. The same windowing, half whitening and upsampled
    refinement; the peak's height as phase_shift measures it."""
    fa_img = np.asarray(a, dtype=np.float64)
    fb_img = np.asarray(b, dtype=np.float64)
    if fa_img.shape != fb_img.shape or fa_img.ndim != 2:
        raise ValueError("the two pictures must be of one size")
    h, w = fa_img.shape
    window = np.outer(np.hanning(h), np.hanning(w))
    fa = np.fft.fft2((fa_img - fa_img.mean()) * window)
    fb = np.fft.fft2((fb_img - fb_img.mean()) * window)
    cross = fb * np.conj(fa)
    cross /= np.sqrt(np.abs(cross)) + 1e-12
    surface = np.fft.ifft2(cross).real
    ys = np.fft.fftfreq(h) * h
    xs = np.fft.fftfreq(w) * w
    near = (np.abs(ys)[:, None] <= reach) & (np.abs(xs)[None, :] <= reach)
    masked = np.where(near, surface, -np.inf)
    iy, ix = np.unravel_index(int(np.argmax(masked)), surface.shape)
    peak = float(surface[iy, ix] / max(float(np.abs(cross).mean()), 1e-12))
    dy, dx = float(ys[iy]), float(xs[ix])
    for span, factor in ((1.0, 10), (0.1, 100)):
        offsets = np.arange(-span, span + 0.5 / factor, 1.0 / factor)
        rows = np.exp(2j * np.pi * np.outer(dy + offsets, np.fft.fftfreq(h)))
        columns = np.exp(2j * np.pi * np.outer(np.fft.fftfreq(w), dx + offsets))
        fine = (rows @ cross @ columns).real
        ky, kx = np.unravel_index(int(np.argmax(fine)), fine.shape)
        dy, dx = float(dy + offsets[ky]), float(dx + offsets[kx])
    return dx, dy, peak


def spread(values) -> dict:
    """rms, 90th percentile, max and count of a set of non-negative sizes."""
    v = np.asarray(list(values), dtype=np.float64)
    if v.size == 0:
        return {"n": 0, "rms": math.nan, "p90": math.nan, "max": math.nan}
    return {"n": int(v.size), "rms": float(np.sqrt(np.mean(v * v))), "p90": float(np.percentile(v, 90)), "max": float(v.max())}


# --- adjustment -------------------------------------------------------------------------------


def adjust_shifts(count: int, windows: list[Window], fixed: int | None = None) -> np.ndarray:
    """Per-picture shifts (mm) that best close the seams: least squares of
    t_j - t_i = -residual over the windows, their mean held at zero (or
    picture `fixed` held still). Pictures no window touches stay at zero."""
    rows = len(windows)
    if rows == 0:
        return np.zeros((count, 2))
    a = np.zeros((rows + 1, count))
    for k, w in enumerate(windows):
        a[k, w.i] = -1.0
        a[k, w.j] = 1.0
    if fixed is None:
        a[rows, :] = 1.0
    else:
        a[rows, fixed] = 1.0
    out = np.zeros((count, 2))
    for axis in (0, 1):
        b = np.zeros(rows + 1)
        b[:rows] = [-w.residual[axis] for w in windows]
        out[:, axis] = np.linalg.lstsq(a, b, rcond=None)[0]
    return out


@dataclass
class Match:
    """One registered window as a pair of raw pixels showing one point:
    `pi` in picture i, `pj` in picture j, and the window's center
    (machine mm)."""

    i: int
    j: int
    pi: Point
    pj: Point
    place: Point = (0.0, 0.0)


def matches_of(windows: list[Window], heads: np.ndarray, camera: Camera, shifts: np.ndarray | None = None) -> list[Match]:
    """Registered windows as raw pixel pairs: the window's center as picture
    i shows it, and as picture j shows the same feature (the center moved
    by the residual). Pairs of raw pixels hold whatever model registered
    them only to the second order, so a camera can be fitted to them."""
    out = []
    for w in windows:
        si = shifts[w.i] if shifts is not None else np.zeros(2)
        sj = shifts[w.j] if shifts is not None else np.zeros(2)
        pix, piy = camera.pixel_of(w.center[0] - heads[w.i][0] - si[0], w.center[1] - heads[w.i][1] - si[1])
        x, y = w.center[0] + w.residual[0], w.center[1] + w.residual[1]
        pjx, pjy = camera.pixel_of(x - heads[w.j][0] - sj[0], y - heads[w.j][1] - sj[1])
        out.append(Match(w.i, w.j, (float(pix), float(piy)), (float(pjx), float(pjy)), w.center))
    return out


@dataclass
class Relief:
    """How much nearer the camera the surface lies than the plane the
    camera's scale holds for, over the machine: a grid of nodes `pitch` mm
    apart from (x0, y0), `values` (rows along Y, columns along X), each
    the share by which a point there shows larger (h / (W - h) for a
    height h at a working distance W), read between nodes bilinearly."""

    x0: float
    y0: float
    pitch: float
    values: np.ndarray

    @classmethod
    def over(cls, heads: np.ndarray, pitch: float, reach: float) -> Relief:
        """A flat relief over the head places and `reach` mm about them."""
        x0 = float(heads[:, 0].min()) - reach
        y0 = float(heads[:, 1].min()) - reach
        nx = int(math.ceil((float(heads[:, 0].max()) + reach - x0) / pitch)) + 1
        ny = int(math.ceil((float(heads[:, 1].max()) + reach - y0) / pitch)) + 1
        return cls(x0, y0, pitch, np.zeros((ny, nx)))

    def weights(self, x, y) -> tuple[np.ndarray, np.ndarray]:
        """The four nodes about each place (flat indices) and their weights."""
        ny, nx = self.values.shape
        fx = np.clip((np.asarray(x, dtype=np.float64) - self.x0) / self.pitch, 0.0, nx - 1.000001)
        fy = np.clip((np.asarray(y, dtype=np.float64) - self.y0) / self.pitch, 0.0, ny - 1.000001)
        ix, iy = np.floor(fx).astype(int), np.floor(fy).astype(int)
        ax, ay = fx - ix, fy - iy
        nodes = np.stack([iy * nx + ix, iy * nx + ix + 1, (iy + 1) * nx + ix, (iy + 1) * nx + ix + 1], axis=-1)
        w = np.stack([(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay], axis=-1)
        return nodes, w

    def at(self, x, y) -> np.ndarray:
        nodes, w = self.weights(x, y)
        return (self.values.ravel()[nodes] * w).sum(axis=-1)


@dataclass
class CameraFit:
    """A camera fitted to matched pixels: the camera, the backlash found
    (mm along X between pictures reached moving +X and moving -X, when
    asked for), per-picture shifts (when free), the relief (when asked
    for), and the seams it leaves (mm, one per match)."""

    camera: Camera
    backlash: float
    shifts: np.ndarray
    residuals: np.ndarray
    relief: Relief | None = None
    terms: dict = field(default_factory=dict)


def fit_camera(matches: list[Match], heads: np.ndarray, camera: Camera, free_axes: bool = True, free_lens: tuple[bool, bool] = (True, False),
               free_tilt: bool = False, directions: np.ndarray | None = None, free_shifts: bool = False, relief: Relief | None = None,
               smooth: float = 2.0, iterations: int = 10, robust: float | None = 0.05) -> CameraFit:
    """What best closes the seams of matched pixels, by Gauss-Newton: the
    camera's 2 by 2 map (`free_axes`), its lens terms k1 and k2 (as
    `free_lens` says) and tilt (`free_tilt`), a backlash along X (when
    `directions` gives each picture's last move along X, +1 or -1),
    per-picture shifts (`free_shifts`, their mean held at zero), and a
    relief (a grid given flat, its mean held at zero and its curvature
    damped by `smooth`). A point at relief r shows (1 + r) times as far
    from the picture's center as the camera's scale says. Matches whose
    seam stays over `robust` mm are weighed down (Huber) when given."""
    n = len(heads)
    names = (["a0", "a1", "a2", "a3"] if free_axes else []) + [name for name, free in zip(("k1", "k2"), free_lens) if free]
    names += ["t0", "t1"] if free_tilt else []

    def get(cam: Camera, name: str) -> float:
        if name[0] == "a":
            return cam.axes[int(name[1])]
        if name[0] == "t":
            return cam.tilt[int(name[1])]
        return getattr(cam, name)

    def camera_of(t: np.ndarray) -> Camera:
        values = dict(zip(names, (float(v) for v in t)))
        axes = tuple(values.get(f"a{k}", camera.axes[k]) for k in range(4))
        tilt = tuple(values.get(f"t{k}", camera.tilt[k]) for k in range(2))
        return replace(camera, axes=axes, tilt=tilt, k1=values.get("k1", camera.k1), k2=values.get("k2", camera.k2))

    theta = np.array([get(camera, name) for name in names], dtype=np.float64)
    scales = np.array([1e-4 if name[0] == "a" else 1e-8 if name[0] == "t" else 1e-4 for name in names])
    backlash = 0.0
    shifts = np.zeros((n, 2))
    surface = None if relief is None else Relief(relief.x0, relief.y0, relief.pitch, relief.values.astype(np.float64).copy())
    m = len(matches)
    ii = np.array([mt.i for mt in matches])
    jj = np.array([mt.j for mt in matches])
    pix = np.array([mt.pi[0] for mt in matches])
    piy = np.array([mt.pi[1] for mt in matches])
    pjx = np.array([mt.pj[0] for mt in matches])
    pjy = np.array([mt.pj[1] for mt in matches])
    place_x = np.array([mt.place[0] for mt in matches])
    place_y = np.array([mt.place[1] for mt in matches])
    dirs = np.zeros(n) if directions is None else np.asarray(directions, dtype=np.float64)
    nodes, node_w = (None, None) if surface is None else surface.weights(place_x, place_y)

    def offsets(t: np.ndarray):
        cam = camera_of(t)
        ax, ay = cam.offset_of(pix, piy)
        bx, by = cam.offset_of(pjx, pjy)
        return ax, ay, bx, by

    def seams(t: np.ndarray, bl: float, sh: np.ndarray, rel: np.ndarray | None) -> np.ndarray:
        ax, ay, bx, by = offsets(t)
        grow = 1.0 if rel is None else 1.0 + (rel.ravel()[nodes] * node_w).sum(axis=-1)
        hx = heads[:, 0] + sh[:, 0] + bl / 2.0 * dirs
        hy = heads[:, 1] + sh[:, 1]
        # Where j puts the point minus where i puts it.
        rx = (hx[jj] + bx / grow) - (hx[ii] + ax / grow)
        ry = (hy[jj] + by / grow) - (hy[ii] + ay / grow)
        return np.concatenate([rx, ry])

    weights = np.ones(2 * m)
    rel = None if surface is None else surface.values
    for _ in range(iterations):
        r = seams(theta, backlash, shifts, rel)
        if robust is not None:
            size = np.hypot(r[:m], r[m:])
            w = np.where(size > robust, robust / np.maximum(size, 1e-12), 1.0)
            weights = np.concatenate([w, w])
        columns = []
        for k in range(len(theta)):
            t2 = theta.copy()
            t2[k] += scales[k]
            columns.append((seams(t2, backlash, shifts, rel) - r) / scales[k])
        if directions is not None:
            columns.append(np.concatenate([(dirs[jj] - dirs[ii]) / 2.0, np.zeros(m)]))
        jac = np.array(columns).T if columns else np.zeros((2 * m, 0))
        blocks = [jac]
        if surface is not None:
            ax, ay, bx, by = offsets(theta)
            grow = 1.0 + (rel.ravel()[nodes] * node_w).sum(axis=-1)
            count = rel.size
            rj = np.zeros((2 * m, count))
            rows = np.arange(m)
            for c in range(4):
                np.add.at(rj, (rows, nodes[:, c]), -(bx - ax) / grow ** 2 * node_w[:, c])
                np.add.at(rj, (m + rows, nodes[:, c]), -(by - ay) / grow ** 2 * node_w[:, c])
            blocks.append(rj)
        if free_shifts:
            sj = np.zeros((2 * m, 2 * n))
            rows = np.arange(m)
            np.add.at(sj, (rows, 2 * jj), 1.0)
            np.add.at(sj, (rows, 2 * ii), -1.0)
            np.add.at(sj, (m + rows, 2 * jj + 1), 1.0)
            np.add.at(sj, (m + rows, 2 * ii + 1), -1.0)
            blocks.append(sj)
        jac = np.hstack(blocks)
        sw = np.sqrt(weights)
        lhs = [jac * sw[:, None]]
        rhs = [-r * sw]
        base = len(theta) + (1 if directions is not None else 0)
        if surface is not None:
            ny, nx = rel.shape
            count = rel.size
            # The relief's mean held at zero (a whole change of scale is the
            # camera's), its second differences damped.
            gauge = np.zeros((1, jac.shape[1]))
            gauge[0, base:base + count] = 100.0
            lhs.append(gauge)
            rhs.append(np.array([-100.0 * rel.sum()]))
            rows = []
            values = []
            flat = rel.ravel()
            for yy in range(ny):
                for xx in range(nx):
                    triples = []
                    if 1 <= xx <= nx - 2:
                        triples.append((yy * nx + xx - 1, yy * nx + xx, yy * nx + xx + 1))
                    if 1 <= yy <= ny - 2:
                        triples.append(((yy - 1) * nx + xx, yy * nx + xx, (yy + 1) * nx + xx))
                    for a_, b_, c_ in triples:
                        row = np.zeros(jac.shape[1])
                        row[base + a_] += smooth
                        row[base + b_] -= 2.0 * smooth
                        row[base + c_] += smooth
                        rows.append(row)
                        values.append(-smooth * (flat[a_] - 2.0 * flat[b_] + flat[c_]))
            if rows:
                lhs.append(np.array(rows))
                rhs.append(np.array(values))
            base += count
        if free_shifts:
            gauge = np.zeros((2, jac.shape[1]))
            gauge[0, base::2] = 1.0
            gauge[1, base + 1::2] = 1.0
            lhs.append(gauge)
            rhs.append(np.array([-shifts[:, 0].sum(), -shifts[:, 1].sum()]))
        delta = np.linalg.lstsq(np.vstack(lhs), np.concatenate(rhs), rcond=None)[0]
        k = len(theta)
        theta = theta + delta[:k]
        if directions is not None:
            backlash += float(delta[k])
            k += 1
        if surface is not None:
            rel = rel + delta[k:k + rel.size].reshape(rel.shape)
            k += rel.size
        if free_shifts:
            shifts = shifts + delta[k:].reshape(n, 2)
        if np.abs(delta).max() < 1e-12:
            break
    r = seams(theta, backlash, shifts, rel)
    cam = camera_of(theta)
    if surface is not None:
        surface.values = rel
    return CameraFit(cam, backlash, shifts, np.hypot(r[:m], r[m:]), surface, cam.describe())


# --- the mosaic -------------------------------------------------------------------------------


def tent(camera: Camera, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """A picture's weight at raw pixels for blending: highest at its center,
    falling to zero at its edges, so the nearest picture to a place leads."""
    wx = 1.0 - np.abs(px - (camera.width - 1) / 2.0) / ((camera.width - 1) / 2.0)
    wy = 1.0 - np.abs(py - (camera.height - 1) / 2.0) / ((camera.height - 1) / 2.0)
    return np.clip(wx, 0.0, 1.0) * np.clip(wy, 0.0, 1.0)


def sample(pictures, heads: np.ndarray, camera: Camera, gx: np.ndarray, gy: np.ndarray, shifts: np.ndarray | None = None,
           gain: np.ndarray | None = None, use: list[int] | None = None, nearest: bool = False, relief: Relief | None = None) -> np.ndarray:
    """The mosaic at any machine places gx, gy (arrays of one shape): what
    compose would show there, from the pictures whose footprint reaches
    the places' box."""
    gx = np.asarray(gx, dtype=np.float64)
    gy = np.asarray(gy, dtype=np.float64)
    lo_x, hi_x, lo_y, hi_y = float(gx.min()), float(gx.max()), float(gy.min()), float(gy.max())
    total = np.zeros(gx.shape)
    weight = np.zeros(gx.shape)
    best = np.full(gx.shape, -1.0)
    chosen = np.full(gx.shape, np.nan)
    for k in (range(len(heads)) if use is None else use):
        h = heads[k] + (shifts[k] if shifts is not None else 0.0)
        fx0, fy0, fx1, fy1 = footprint(camera, (float(h[0]), float(h[1])), -1.0)
        if fx1 < lo_x or fx0 > hi_x or fy1 < lo_y or fy0 > hi_y:
            continue
        px, py = camera.pixel_of(*reach(gx, gy, (float(h[0]), float(h[1])), relief))
        pic = pictures[k] if gain is None else np.asarray(pictures[k], dtype=np.float32) * gain
        values = bilinear(pic, px, py)
        w = np.where(np.isnan(values), 0.0, tent(camera, px, py))
        values = np.nan_to_num(values)
        if nearest:
            better = w > best
            best = np.where(better, w, best)
            chosen = np.where(better & (w > 0.0), values, chosen)
        else:
            total += w * values
            weight += w
    if nearest:
        return chosen
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(weight > 0.0, total / np.maximum(weight, 1e-12), np.nan)


def nearest_picture(heads: np.ndarray, camera: Camera, place: Point, shifts: np.ndarray | None = None, use: list[int] | None = None,
                    relief: Relief | None = None) -> int:
    """The picture whose center saw `place` (machine mm) nearest, by the
    tent weight blending uses; -1 when none reaches it."""
    best, chosen = 0.0, -1
    for k in (range(len(heads)) if use is None else use):
        h = heads[k] + (shifts[k] if shifts is not None else 0.0)
        px, py = camera.pixel_of(*reach(place[0], place[1], (float(h[0]), float(h[1])), relief))
        w = float(tent(camera, np.asarray(px), np.asarray(py)))
        if w > best:
            best, chosen = w, k
    return chosen


def compose(pictures, heads: np.ndarray, camera: Camera, box: tuple[float, float, float, float], step: float,
            shifts: np.ndarray | None = None, gain: np.ndarray | None = None, use: list[int] | None = None,
            nearest: bool = False, relief: Relief | None = None) -> np.ndarray:
    """The mosaic over machine box (x0, y0, x1, y1) at `step` mm a px: each
    picture placed at its head place (plus `shifts`), multiplied by `gain`
    (a flat field) when given, blended by tent weights, or the picture
    whose center is nearest when `nearest`; NaN where none reaches. `use`
    picks the pictures (all by default); places lie on `relief` when
    given."""
    x0, y0, x1, y1 = box
    cols = int(math.floor((x1 - x0) / step)) + 1
    rows = int(math.floor((y1 - y0) / step)) + 1
    xs = x0 + step * np.arange(cols)
    ys = y1 - step * np.arange(rows)
    total = np.zeros((rows, cols), dtype=np.float64)
    weight = np.zeros((rows, cols), dtype=np.float64)
    best = np.full((rows, cols), -1.0)
    chosen = np.full((rows, cols), np.nan)
    indices = range(len(heads)) if use is None else use
    for k in indices:
        h = heads[k] + (shifts[k] if shifts is not None else 0.0)
        fx0, fy0, fx1, fy1 = footprint(camera, (float(h[0]), float(h[1])), -1.0)
        c0 = max(0, int(math.floor((fx0 - x0) / step)))
        c1 = min(cols, int(math.ceil((fx1 - x0) / step)) + 1)
        r0 = max(0, int(math.floor((y1 - fy1) / step)))
        r1 = min(rows, int(math.ceil((y1 - fy0) / step)) + 1)
        if c1 <= c0 or r1 <= r0:
            continue
        gx, gy = np.meshgrid(xs[c0:c1], ys[r0:r1])
        px, py = camera.pixel_of(*reach(gx, gy, (float(h[0]), float(h[1])), relief))
        pic = pictures[k] if gain is None else np.asarray(pictures[k], dtype=np.float32) * gain
        values = bilinear(pic, px, py)
        w = tent(camera, px, py)
        w = np.where(np.isnan(values), 0.0, w)
        values = np.nan_to_num(values)
        if nearest:
            better = w > best[r0:r1, c0:c1]
            best[r0:r1, c0:c1] = np.where(better, w, best[r0:r1, c0:c1])
            chosen[r0:r1, c0:c1] = np.where(better & (w > 0.0), values, chosen[r0:r1, c0:c1])
        else:
            total[r0:r1, c0:c1] += w * values
            weight[r0:r1, c0:c1] += w
    if nearest:
        return chosen
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(weight > 0.0, total / np.maximum(weight, 1e-12), np.nan)
