"""The virtual pick and place machine's two cameras: pictures drawn from
where its head is, served as a ustreamer serves a camera, so pcbv reads
them as it reads a Raspberry Pi's: `/snapshot` answers one JPEG, `/state`
the picture's size.

The bottom camera sits under the bed looking up: with N1's turning axis
over its place the axis is the picture's center. It sees the nozzle's
tip as a dark disk on the bright window, and a part on the nozzle as a
dark body over it. The top camera rides on the head, its picture's center
`offset` from N1's tip; it sees the bed (bright), the mark the offset is
measured from (a dark disk), each board laid on the bed (dark, with its
fiducials bright) and the parts let go (dark). With the ring light off
both pictures are dim.

Each camera is placed a little off what the machine file says (a scale,
a roll, the bottom camera mirrored, its place and the top camera's offset
a few tenths of a millimeter out) so that centering the nozzle and
measuring the offset have something to find.

pcbv decodes only JPEG from an HTTP camera, and this backend has no image
library, so `jpeg` writes baseline grayscale JPEG itself: every 8 by 8
block whose pixels are all one shade (most of a drawn picture) is a lone
DC term, and only the blocks an edge crosses go through the DCT. Its
Huffman tables are flat (every DC size 4 bits, every AC symbol 8), which
any decoder reads; the file is a little larger than an optimized one.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING

from .virtual_pnp import Point, VirtualMarlin, to_picture, turn

if TYPE_CHECKING:
    from .openpnp import GcodeMachine

WIDTH, HEIGHT = 640, 480
FPS = 10
# Shades with the ring light on, and how much of each the room light leaves with it off.
BRIGHT, DARK, BOARD, COPPER, PART = 205, 40, 70, 230, 25
DIM = 0.3
# N1's tip as the bottom camera sees it, mm across.
TIP = 0.5
# The mark the top camera's offset is measured from, mm across.
MARK = 1.0
# The homing fiducial on the bed, mm across: OpenPnP's calibration fiducials are 1 mm.
HOME_FIDUCIAL = 1.0
# Where a board's edge lies when its file draws none: this far out of its parts, mm.
BOARD_MARGIN = 3.0
# How far off the machine file the cameras sit, so the routines have
# something to measure: the bottom camera's place, the top camera's offset (mm).
BOTTOM_ERROR = (0.42, -0.31)
TOP_ERROR = (0.37, -0.28)
# How far N1's tip runs off its turning axis, mm.
RUNOUT = (0.03, -0.02)
# The tip is down on a part or the board at or below this far under the safe height, mm.
TOUCH_DEPTH = 15.0


# --- drawing -----------------------------------------------------------------------------


def fill_polygon(raster: bytearray, width: int, height: int, points: list[Point], shade: int) -> None:
    """A convex polygon (picture px) drawn into a gray raster, each pixel
    row sampled at its middle and the pixels at a row's ends blended by
    how much of them it covers."""
    if len(points) < 3:
        return
    ys = [p[1] for p in points]
    first_row = max(0, math.floor(min(ys)))
    last_row = min(height - 1, math.ceil(max(ys)))
    edges = list(zip(points, points[1:] + points[:1]))
    for row in range(first_row, last_row + 1):
        middle = row + 0.5
        xs = [x1 + (middle - y1) * (x2 - x1) / (y2 - y1) for (x1, y1), (x2, y2) in edges if (y1 <= middle < y2) or (y2 <= middle < y1)]
        if len(xs) < 2:
            continue
        left, right = max(min(xs), 0.0), min(max(xs), float(width))
        if right <= left:
            continue
        base = row * width
        first, last = int(left), int(right)

        def blend(column: int, cover: float) -> None:
            if 0 <= column < width and cover > 0.0:
                at = base + column
                raster[at] = round(raster[at] * (1.0 - cover) + shade * cover)

        if first == last:
            blend(first, right - left)
            continue
        blend(first, first + 1 - left)
        if last > first + 1:
            raster[base + first + 1 : base + last] = bytes([shade]) * (last - first - 1)
        blend(last, right - last)


def disk(center: Point, radius: float, sides: int = 48) -> list[Point]:
    """A circle as a polygon of `sides` corners."""
    return [(center[0] + radius * math.cos(2 * math.pi * i / sides), center[1] + radius * math.sin(2 * math.pi * i / sides)) for i in range(sides)]


def rectangle(center: Point, size: tuple[float, float], angle: float) -> list[Point]:
    """A rectangle's corners: `size` long and wide, its long side along `angle` degrees."""
    half_l, half_w = size[0] / 2.0, size[1] / 2.0
    return [
        (center[0] + dx, center[1] + dy)
        for dx, dy in (turn(corner, angle) for corner in ((half_l, half_w), (-half_l, half_w), (-half_l, -half_w), (half_l, -half_w)))
    ]


# --- JPEG ----------------------------------------------------------------------------------


def _zigzag() -> list[int]:
    """The block's indexes (row * 8 + column) in JPEG's zigzag order."""
    order = []
    for total in range(15):
        rows = range(min(total, 7), max(0, total - 7) - 1, -1) if total % 2 == 0 else range(max(0, total - 7), min(total, 7) + 1)
        order.extend(row * 8 + (total - row) for row in rows)
    return order


ZIGZAG = _zigzag()
# cos((2x + 1) u pi / 16) with the DCT's scale for u, halved: a block's
# coefficient (u, v) is the sum over x, y of f * C[x][u] * C[y][v].
COS = [[(math.sqrt(0.5) if u == 0 else 1.0) * math.cos((2 * x + 1) * u * math.pi / 16.0) / 2.0 for u in range(8)] for x in range(8)]
# The AC symbols, (zeros before << 4) | size, in the order of their 8-bit codes: end of block, sixteen zeros, then the rest.
AC_SYMBOLS = [0x00, 0xF0] + [(run << 4) | size for run in range(16) for size in range(1, 11)]
AC_CODE = {symbol: index for index, symbol in enumerate(AC_SYMBOLS)}


def _size(value: int) -> int:
    return abs(value).bit_length()


class _Bits:
    def __init__(self) -> None:
        self.out = bytearray()
        self.acc = 0
        self.count = 0

    def put(self, value: int, length: int) -> None:
        if length == 0:
            return
        self.acc = (self.acc << length) | (value & ((1 << length) - 1))
        self.count += length
        while self.count >= 8:
            self.count -= 8
            byte = (self.acc >> self.count) & 0xFF
            self.out.append(byte)
            if byte == 0xFF:
                self.out.append(0x00)
        self.acc &= (1 << self.count) - 1

    def number(self, value: int) -> None:
        """A coefficient's bits after its size: itself, or less one when negative."""
        size = _size(value)
        self.put(value if value >= 0 else value + (1 << size) - 1, size)

    def end(self) -> bytes:
        if self.count:
            self.put((1 << (8 - self.count)) - 1, 8 - self.count)
        return bytes(self.out)


def _dct(block: list[int]) -> list[int]:
    """The block's coefficients (row-major, v * 8 + u) from its 64 pixels less 128, rounded."""
    rows = [[sum(block[y * 8 + x] * COS[x][u] for x in range(8)) for u in range(8)] for y in range(8)]
    return [round(sum(rows[y][u] * COS[y][v] for y in range(8))) for v in range(8) for u in range(8)]


def jpeg(raster: bytes | bytearray, width: int, height: int) -> bytes:
    """A gray raster as a baseline JPEG, quantized by 1 (the pictures are
    drawn, so nothing is gained by throwing detail away). `width` and
    `height` are multiples of 8."""
    if width % 8 or height % 8 or len(raster) != width * height:
        raise ValueError("a picture's sides must be multiples of 8 and its raster that size")
    bits = _Bits()
    previous = 0
    flat = {shade: bytes([shade]) * 8 for shade in range(256)}
    cache: dict[bytes, list[int]] = {}
    for top in range(0, height, 8):
        for left in range(0, width, 8):
            starts = [(top + y) * width + left for y in range(8)]
            first = raster[starts[0]]
            if all(raster[start : start + 8] == flat[first] for start in starts):
                coefficients = None
                dc = 8 * (first - 128)
            else:
                key = b"".join(raster[start : start + 8] for start in starts)
                coefficients = cache.get(key)
                if coefficients is None:
                    coefficients = [max(-1023, min(1023, value)) for value in _dct([pixel - 128 for pixel in key])]
                    cache[key] = coefficients
                dc = coefficients[0]
            dc = max(-1023, min(1023, dc))
            difference = dc - previous
            previous = dc
            bits.put(_size(difference), 4)
            bits.number(difference)
            if coefficients is None:
                bits.put(AC_CODE[0x00], 8)
                continue
            zeros = 0
            for index in ZIGZAG[1:]:
                value = coefficients[index]
                if value == 0:
                    zeros += 1
                    continue
                while zeros > 15:
                    bits.put(AC_CODE[0xF0], 8)
                    zeros -= 16
                bits.put(AC_CODE[(zeros << 4) | _size(value)], 8)
                bits.number(value)
                zeros = 0
            if zeros:
                bits.put(AC_CODE[0x00], 8)
    data = bits.end()

    def segment(marker: int, body: bytes) -> bytes:
        return bytes([0xFF, marker]) + (len(body) + 2).to_bytes(2, "big") + body

    dc_table = bytes([0x00]) + bytes([0, 0, 0, 12] + [0] * 12) + bytes(range(12))
    ac_table = bytes([0x10]) + bytes([0] * 7 + [len(AC_SYMBOLS)] + [0] * 8) + bytes(AC_SYMBOLS)
    return b"".join(
        [
            b"\xff\xd8",
            segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"),
            segment(0xDB, bytes([0x00]) + bytes([1] * 64)),
            segment(0xC0, bytes([8]) + height.to_bytes(2, "big") + width.to_bytes(2, "big") + bytes([1, 1, 0x11, 0])),
            segment(0xC4, dc_table + ac_table),
            segment(0xDA, bytes([1, 1, 0x00, 0, 63, 0])),
            data,
            b"\xff\xd9",
        ]
    )


# --- the world and its cameras ------------------------------------------------------------------


@dataclass
class Board:
    """A board on the bed: its outline and its fiducials (center, mm across), machine mm."""

    outline: list[Point]
    fiducials: list[tuple[Point, float]]


@dataclass
class Camera:
    """A camera's picture: its size, mm a pixel, how it is turned against
    the machine and whether it is mirrored."""

    name: str
    world: World
    scale: float
    roll: float
    mirror: bool
    width: int = WIDTH
    height: int = HEIGHT

    def to_px(self, mm: Point) -> Point:
        u, v = to_picture(mm, self.roll, self.mirror, self.scale)
        return (self.width / 2.0 + u, self.height / 2.0 + v)

    def shades(self) -> tuple[float, bytearray]:
        """How bright the light leaves the picture (1 lit, DIM not), and its raster filled with the ground."""
        machine = self.world.machine
        light = 1.0 if machine is None or machine.light > 0 else DIM
        return light, bytearray([round(BRIGHT * light)]) * (self.width * self.height)

    def draw(self, raster: bytearray, mm: list[Point], origin: Point, shade: int) -> None:
        fill_polygon(raster, self.width, self.height, [self.to_px((x - origin[0], y - origin[1])) for x, y in mm], shade)

    def picture(self) -> bytearray:
        raise NotImplementedError

    def snapshot(self) -> bytes:
        return jpeg(self.picture(), self.width, self.height)


@dataclass
class BottomCamera(Camera):
    """Under the bed, looking up: N1's turning axis over `place` is the picture's center."""

    place: Point = (0.0, 0.0)

    def picture(self) -> bytearray:
        light, raster = self.shades()
        machine = self.world.machine
        if machine is None:
            return raster
        at = machine.bed()
        self.draw(raster, disk(machine.tip(at), TIP / 2.0), self.place, round(DARK * light))
        part = machine.held_part(at)
        if part is not None:
            self.draw(raster, rectangle(part.center, part.size, part.angle), self.place, round(PART * light))
        return raster


@dataclass
class TopCamera(Camera):
    """On the head: its picture's center is `offset` from N1's tip."""

    offset: Point = (0.0, 0.0)

    def picture(self) -> bytearray:
        light, raster = self.shades()
        machine = self.world.machine
        if machine is None:
            return raster
        at = machine.bed()
        center = (at[0] + self.offset[0], at[1] + self.offset[1])
        reach = math.hypot(self.width, self.height) / 2.0 * self.scale

        def near(points: list[Point]) -> bool:
            return any(math.dist(point, center) < reach for point in points) or (
                min(p[0] for p in points) <= center[0] <= max(p[0] for p in points) and min(p[1] for p in points) <= center[1] <= max(p[1] for p in points)
            )

        for board in self.world.boards:
            if near(board.outline):
                self.draw(raster, board.outline, center, round(BOARD * light))
            for place, across in board.fiducials:
                if math.dist(place, center) < reach + across:
                    self.draw(raster, disk(place, across / 2.0), center, round(COPPER * light))
        if math.dist(self.world.mark, center) < reach + MARK:
            self.draw(raster, disk(self.world.mark, MARK / 2.0), center, round(DARK * light))
        fiducial = self.world.home_fiducial
        if fiducial is not None and math.dist(fiducial, center) < reach + HOME_FIDUCIAL:
            self.draw(raster, disk(fiducial, HOME_FIDUCIAL / 2.0), center, round(COPPER * light))
        for part in machine.lying:
            if math.dist(part.center, center) < reach + max(part.size):
                self.draw(raster, rectangle(part.center, part.size, part.angle), center, round(PART * light))
        return raster


@dataclass
class World:
    """What the virtual machine's cameras see: the machine, the mark, the
    boards on the bed, and the two cameras as they truly sit."""

    mark: Point = (150.0, 150.0)
    # The bed's homing fiducial, bright, where the machine file says.
    home_fiducial: Point | None = None
    touch_z: float | None = None
    runout: Point = RUNOUT
    machine: VirtualMarlin | None = None
    boards: list[Board] = field(default_factory=list)
    bottom: BottomCamera = field(init=False)
    top: TopCamera = field(init=False)

    def __post_init__(self) -> None:
        self.bottom = BottomCamera(name="bottom", world=self, scale=0.02, roll=1.5, mirror=True)
        self.top = TopCamera(name="top", world=self, scale=0.03, roll=-0.8, mirror=False)

    @classmethod
    def from_machine(cls, machine: GcodeMachine, mark: Point = (150.0, 150.0)) -> World:
        """The cameras placed as the machine file says, each a little off."""
        safe = machine.safe_z if machine.safe_z is not None else 0.0
        world = cls(mark=mark, touch_z=safe - TOUCH_DEPTH)
        place = machine.camera_position or (0.0, 0.0)
        world.bottom.place = (place[0] + BOTTOM_ERROR[0], place[1] + BOTTOM_ERROR[1])
        offset = machine.top.offset if machine.top is not None and machine.top.offset is not None else (0.0, 0.0)
        world.top.offset = (offset[0] + TOP_ERROR[0], offset[1] + TOP_ERROR[1])
        world.home_fiducial = machine.top.home_fiducial if machine.top is not None else None
        return world

    def add_board(self, path: Path, at: Point, angle: float = 0.0) -> Board:
        """A .kicad_pcb laid on the bed with its origin at `at`, turned
        `angle` degrees: its Edge.Cuts box (or its parts' box and a margin)
        and its fiducials, KiCad's y down turned up."""
        from .pnp import _child, _points_of, footprints_of, parse_sexp

        text = path.read_text(encoding="utf-8", errors="replace")
        footprints = footprints_of(text)
        tree = parse_sexp(text)
        edge: list[Point] = []
        for item in tree[0][1:] if tree and isinstance(tree[0], list) else []:
            if isinstance(item, list) and item and str(item[0]).startswith("gr_"):
                layer = _child(item, "layer")
                if layer is not None and len(layer) > 1 and layer[1] == "Edge.Cuts":
                    # A circle's box is read as a footprint's circle is.
                    edge.extend(_points_of(["fp_circle" if item[0] == "gr_circle" else item[0], *item[1:]]))
        if not edge:
            spots = [(f.x, f.y) for f in footprints]
            if not spots:
                raise ValueError("no board edge and no parts to place it by")
            edge = [(min(x for x, _ in spots) - BOARD_MARGIN, min(y for _, y in spots) - BOARD_MARGIN), (max(x for x, _ in spots) + BOARD_MARGIN, max(y for _, y in spots) + BOARD_MARGIN)]
        low = (min(x for x, _ in edge), min(y for _, y in edge))
        high = (max(x for x, _ in edge), max(y for _, y in edge))

        def place(point: Point) -> Point:
            turned = turn((point[0], -point[1]), angle)
            return (at[0] + turned[0], at[1] + turned[1])

        outline = [place(corner) for corner in (low, (high[0], low[1]), high, (low[0], high[1]))]
        fiducials = [(place((f.x, f.y)), f.diameter or 1.0) for f in footprints if f.fiducial]
        board = Board(outline=outline, fiducials=fiducials)
        self.boards.append(board)
        return board


# --- serving ---------------------------------------------------------------------------------------


def handler_for(camera: Camera) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/snapshot":
                body, kind = camera.snapshot(), "image/jpeg"
            elif path == "/state":
                state = {
                    "ok": True,
                    "result": {"source": {"resolution": {"width": camera.width, "height": camera.height}, "online": True, "desired_fps": FPS}},
                }
                body, kind = json.dumps(state).encode(), "application/json"
            else:
                self.send_error(404, "the virtual camera serves /snapshot and /state")
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:
            pass

    return Handler


def serve_camera(camera: Camera, address: str) -> ThreadingHTTPServer:
    """Serves the camera's pictures at `host:port` on a thread of its own."""
    host, _, port = address.rpartition(":")
    server = ThreadingHTTPServer((host or "127.0.0.1", int(port)), handler_for(camera))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name=f"virtual-{camera.name}-camera", daemon=True).start()
    return server
