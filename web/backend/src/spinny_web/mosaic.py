"""The pictures of a camera's full scan of a board, kept for the page to lay
side by side as a mosaic: each picture's JPEG and where it lay on the
machine (the machine point under its center, its roll and mirror, its scale
per pixel of the picture kept), so the page places every one where the head
was when it was taken. One scan per camera is kept, the newest, while the
backend runs.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

Point = tuple[float, float]

# The width the pictures are kept at, px: a scan of a few dozen stops stays
# a few megabytes, and the page shows them small.
WIDTH = 640
QUALITY = 75


@dataclass
class Tile:
    """One picture of a scan: where its center lay on the machine, its roll
    and mirror, its size as kept (px), mm per kept px, and the JPEG."""

    index: int
    center: Point
    roll: float
    mirror: bool
    width: int
    height: int
    mm_per_px: float
    jpeg: bytes
    taken: float = 0.0

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "center": [round(self.center[0], 4), round(self.center[1], 4)],
            "roll": round(self.roll, 4),
            "mirror": self.mirror,
            "width": self.width,
            "height": self.height,
            "mm_per_px": round(self.mm_per_px, 6),
        }


@dataclass
class Mosaic:
    """A scan's pictures: the job whose board was scanned, how the camera
    took them (`motion`: stop or fly), the tiles in the order taken, the
    place the scan found (the job's frame onto the machine's: turn, shift,
    middle), the job's outline's box in its frame, and a number that grows
    with every change, for the page to fetch again."""

    job: str | None = None
    motion: str = "stop"
    tiles: list[Tile] = field(default_factory=list)
    estimate: dict | None = None
    outline: list[float] | None = None
    version: int = 0
    started: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def begin(self, job: str, outline: list[float] | None, motion: str = "stop") -> None:
        with self._lock:
            self.job = job
            self.motion = motion
            self.tiles = []
            self.estimate = None
            self.outline = outline
            self.started = time.time()
            self.version += 1

    def add(self, client, center: Point, roll: float, mirror: bool, full_scale: float, full_width: float) -> Tile | None:
        """Keeps the picture `client` (pcbv) shows now as the next tile,
        placed at `center` with the camera's `roll` and `mirror`, its full
        size (`full_width` px) scale `full_scale` mm per px; None when no
        picture came."""
        try:
            reply, jpeg = client.frame(width=WIDTH, overlay=False, quality=QUALITY)
        except Exception:  # a picture never stops a scan
            return None
        width, height = reply.get("width"), reply.get("height")
        if not jpeg or not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
            return None
        return self.add_jpeg(jpeg, width, height, center, roll, mirror, full_scale, full_width)

    def add_jpeg(self, jpeg: bytes, width: int, height: int, center: Point, roll: float, mirror: bool, full_scale: float, full_width: float) -> Tile:
        """A tile from a JPEG `width` by `height` px already had: pcbv
        shrinks a picture by a whole factor, so each kept px is
        `full_width` / `width` full size ones."""
        factor = float(full_width) / float(width) if full_width > 0 else 1.0
        with self._lock:
            tile = Tile(len(self.tiles), center, roll, mirror, width, height, full_scale * factor, jpeg, time.time())
            self.tiles.append(tile)
            self.version += 1
            return tile

    def finish(self, estimate: dict | None) -> None:
        with self._lock:
            self.estimate = estimate
            self.version += 1

    def clear(self) -> None:
        with self._lock:
            self.job = None
            self.tiles = []
            self.estimate = None
            self.outline = None
            self.version += 1

    def summary(self) -> dict | None:
        """What the look's state says of the scan; None with none kept."""
        if self.job is None:
            return None
        return {"job": self.job, "pictures": len(self.tiles), "version": self.version, "motion": self.motion, "found": self.estimate is not None}

    def state(self) -> dict:
        with self._lock:
            return {
                "job": self.job,
                "motion": self.motion,
                "version": self.version,
                "started": self.started,
                "outline": self.outline,
                "estimate": self.estimate,
                "pictures": [tile.to_dict() for tile in self.tiles],
            }

    def picture(self, index: int) -> bytes | None:
        with self._lock:
            return self.tiles[index].jpeg if 0 <= index < len(self.tiles) else None
