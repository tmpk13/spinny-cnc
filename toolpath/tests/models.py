"""Made up 3D models for the tests: closed meshes of voxels written as a
binary STL, so a pocket's walls are truly vertical and its floor flat."""

from __future__ import annotations

import struct
from collections.abc import Callable
from pathlib import Path

# Each face of a voxel: the neighbor it borders and its corners,
# counterclockwise seen from outside.
FACES = (
    ((-1, 0, 0), ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0))),
    ((1, 0, 0), ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1))),
    ((0, -1, 0), ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1))),
    ((0, 1, 0), ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0))),
    ((0, 0, -1), ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0))),
    ((0, 0, 1), ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1))),
)


def voxel_triangles(n: tuple[int, int, int], size: float, filled: Callable[[int, int, int], bool]) -> list[tuple]:
    def inside(i: int, j: int, k: int) -> bool:
        return 0 <= i < n[0] and 0 <= j < n[1] and 0 <= k < n[2] and filled(i, j, k)

    triangles = []
    for i in range(n[0]):
        for j in range(n[1]):
            for k in range(n[2]):
                if not inside(i, j, k):
                    continue
                for (di, dj, dk), corners in FACES:
                    if inside(i + di, j + dj, k + dk):
                        continue
                    v = [((i + c[0]) * size, (j + c[1]) * size, (k + c[2]) * size) for c in corners]
                    triangles.append((v[0], v[1], v[2]))
                    triangles.append((v[0], v[2], v[3]))
    return triangles


def write_stl(path: Path, triangles: list[tuple]) -> Path:
    out = bytearray(80)
    out += struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<3f", 0.0, 0.0, 0.0)
        for vertex in tri:
            out += struct.pack("<3f", *vertex)
        out += b"\0\0"
    path.write_bytes(bytes(out))
    return path


def plate(path: Path) -> Path:
    """A 30 x 20 x 6 mm plate: a 10 x 8 pocket 3 deep at x 5..15, y 6..14,
    a 4 x 4 hole through at x 20..24, y 8..12, and the far 4 mm of it
    stepped down 2."""

    def filled(i: int, j: int, k: int) -> bool:
        pocket = 10 <= i < 30 and 12 <= j < 28 and k >= 6
        hole = 40 <= i < 48 and 16 <= j < 24
        shoulder = i >= 52 and k >= 8
        return not (pocket or hole or shoulder)

    return write_stl(path, voxel_triangles((60, 40, 12), 0.5, filled))


def block(path: Path, x: float, y: float, z: float) -> Path:
    """A plain x by y by z box."""
    cube = voxel_triangles((1, 1, 1), 1.0, lambda *_: True)
    return write_stl(path, [tuple((v[0] * x, v[1] * y, v[2] * z) for v in tri) for tri in cube])
