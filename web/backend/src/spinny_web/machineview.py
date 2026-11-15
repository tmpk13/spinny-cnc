"""What the PNP tab's Machine view draws of a machine besides its file: a
picture of the machine and a 3D model of it (an STL file), each added by
the operator and kept per machine file under the backend's data folder
(`machine-views/<machine id>/`, beside config.json: var/ in a checkout,
the installed home's own folder otherwise), with `view.json` saying what
is kept: each file's name as added, its media type, its size, a version
that grows with every change (the page asks for the file by it, so a
browser never shows an older one from its cache) and the box on the
machine it is drawn stretched over (x0, y0, x1, y1, mm; None draws a
picture over the machine's travel and a model at its own coordinates).

A picture is PNG, JPEG, WebP or GIF, told by its first bytes (an SVG could
carry a script, so none is taken); a model is a binary or ASCII STL, its
triangles counted. The page draws the model itself, from above.
"""

from __future__ import annotations

import json
import math
import shutil
import struct
import threading
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from spinny_laser.machines import MachineError, check_id

from .files import write_whole

KINDS = ("picture", "model")
MAX_PICTURE = 16 * 1024 * 1024
MAX_MODEL = 64 * 1024 * 1024
MAX_NAME = 200
# A box's numbers are kept within this many mm, as a machine file's places.
COORD_LIMIT = 10000.0
STL_HEADER = 80


class ViewError(ValueError):
    """A file or a box the view does not take, in words for the page."""


def picture_type(data: bytes) -> tuple[str, str]:
    """A picture's file ending and media type from its first bytes; ViewError for anything else."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif", "image/gif"
    raise ViewError("a picture must be a PNG, JPEG, WebP or GIF file")


def stl_triangles(data: bytes) -> int:
    """The triangles an STL file holds, binary or ASCII; ViewError for a
    file that is neither. A binary file is its 80 byte header, a count and
    50 bytes a triangle, so its length says which it is (an ASCII file may
    start with `solid` too, and some binary ones do)."""
    if len(data) >= STL_HEADER + 4:
        (count,) = struct.unpack_from("<I", data, STL_HEADER)
        if count > 0 and len(data) == STL_HEADER + 4 + 50 * count:
            return count
    head = data[:1024].lstrip().lower()
    if head.startswith(b"solid"):
        count = data.count(b"facet normal")
        if count > 0 and data.count(b"vertex") >= 3 * count:
            return count
    raise ViewError("a model must be an STL file, binary or ASCII, with at least one triangle")


def checked_box(box: list | None) -> list[float] | None:
    """A box to draw over, x0 y0 x1 y1 with x0 below x1 and y0 below y1; None keeps the default."""
    if box is None:
        return None
    if (
        not isinstance(box, list)
        or len(box) != 4
        or not all(not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and abs(v) <= COORD_LIMIT for v in box)
    ):
        raise ViewError(f"a box must be 4 numbers within {COORD_LIMIT:g}: x0, y0, x1, y1")
    x0, y0, x1, y1 = (float(v) for v in box)
    if not (x0 < x1 and y0 < y1):
        raise ViewError("a box must be x0, y0, x1, y1 with x0 below x1 and y0 below y1")
    return [x0, y0, x1, y1]


class MachineViewStore:
    """The pictures and models of the machines, a folder each under `directory`."""

    def __init__(self, directory: Path, exists: Callable[[str], bool] = lambda machine_id: True) -> None:
        self.directory = Path(directory)
        # Whether a machine file of the id is there: a file is added only for one.
        self.exists = exists
        self._lock = threading.Lock()

    def _folder(self, machine_id: str) -> Path:
        try:
            check_id(machine_id)
        except MachineError as exc:
            raise ViewError(str(exc)) from None
        return self.directory / machine_id

    def _kept(self, folder: Path) -> dict:
        try:
            kept = json.loads((folder / "view.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return kept if isinstance(kept, dict) else {}

    def _write(self, folder: Path, kept: dict) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        write_whole(folder / "view.json", json.dumps(kept, indent=2) + "\n")

    def state(self, machine_id: str) -> dict:
        """What is kept for the machine, for the page: each kind's name,
        media type, size, version and box, or None when none is added."""
        folder = self._folder(machine_id)
        kept = self._kept(folder)
        out: dict = {"machine": machine_id}
        for kind in KINDS:
            entry = kept.get(kind)
            if isinstance(entry, dict) and (folder / str(entry.get("file", ""))).is_file():
                out[kind] = {key: entry.get(key) for key in ("name", "type", "bytes", "version", "box", "triangles") if key in entry}
            else:
                out[kind] = None
        return out

    def put(self, machine_id: str, kind: str, name: str, data: bytes) -> dict:
        """Keeps an added picture or model in place of the one before (its box kept)."""
        if kind not in KINDS:
            raise ViewError(f"{kind!r} is not a picture or a model")
        folder = self._folder(machine_id)
        if not self.exists(machine_id):
            raise LookupError(f"no machine file {machine_id!r}")
        limit = MAX_PICTURE if kind == "picture" else MAX_MODEL
        if len(data) > limit:
            raise ViewError(f"the {kind} is over {limit >> 20} MB")
        if kind == "picture":
            ending, media = picture_type(data)
            extra: dict = {}
        else:
            ending, media = "stl", "model/stl"
            extra = {"triangles": stl_triangles(data)}
        with self._lock:
            kept = self._kept(folder)
            before = kept.get(kind) if isinstance(kept.get(kind), dict) else {}
            folder.mkdir(parents=True, exist_ok=True)
            file = f"{kind}.{ending}"
            write_whole(folder / file, data)
            old = before.get("file")
            if isinstance(old, str) and old != file:
                (folder / Path(old).name).unlink(missing_ok=True)
            kept[kind] = {
                "file": file,
                "name": (Path(name).name or file)[:MAX_NAME],
                "type": media,
                "bytes": len(data),
                "version": int(before.get("version", 0)) + 1 if isinstance(before.get("version", 0), int) else 1,
                "box": before.get("box"),
                **extra,
            }
            self._write(folder, kept)
        return self.state(machine_id)

    def place(self, machine_id: str, kind: str, box: list | None) -> dict:
        """The box a picture or model is drawn over; None for the default."""
        if kind not in KINDS:
            raise ViewError(f"{kind!r} is not a picture or a model")
        folder = self._folder(machine_id)
        box = checked_box(box)
        with self._lock:
            kept = self._kept(folder)
            entry = kept.get(kind)
            if not isinstance(entry, dict):
                raise LookupError(f"no {kind} added for {machine_id}")
            entry["box"] = box
            entry["version"] = int(entry.get("version", 0)) + 1 if isinstance(entry.get("version", 0), int) else 1
            self._write(folder, kept)
        return self.state(machine_id)

    def remove(self, machine_id: str, kind: str) -> dict:
        """Takes a picture or model away."""
        if kind not in KINDS:
            raise ViewError(f"{kind!r} is not a picture or a model")
        folder = self._folder(machine_id)
        with self._lock:
            kept = self._kept(folder)
            entry = kept.pop(kind, None)
            if isinstance(entry, dict) and isinstance(entry.get("file"), str):
                (folder / Path(entry["file"]).name).unlink(missing_ok=True)
            if kept:
                self._write(folder, kept)
            elif folder.is_dir():
                shutil.rmtree(folder, ignore_errors=True)
        return self.state(machine_id)

    def read(self, machine_id: str, kind: str) -> tuple[bytes, str]:
        """A kept file's bytes and media type; LookupError with none."""
        if kind not in KINDS:
            raise ViewError(f"{kind!r} is not a picture or a model")
        folder = self._folder(machine_id)
        entry = self._kept(folder).get(kind)
        if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
            raise LookupError(f"no {kind} added for {machine_id}")
        try:
            return (folder / Path(entry["file"]).name).read_bytes(), str(entry.get("type") or "application/octet-stream")
        except FileNotFoundError:
            raise LookupError(f"no {kind} added for {machine_id}") from None


class ViewBoxBody(BaseModel):
    # x0, y0, x1, y1 on the machine, mm; null draws it at its default.
    box: list[float] | None = None


def _guarded(call):
    try:
        return call()
    except ViewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'\"")) from exc


def add_routes(app: FastAPI, store: MachineViewStore) -> None:
    """The view's routes, put on the app itself: FastAPI 0.142 keeps the routes
    of an included router out of `app.routes`, where the check of the
    routes the Auto tools may call looks for every route."""

    @app.get("/api/machines/{machine_id}/view")
    def machine_view(machine_id: str):
        return _guarded(lambda: store.state(machine_id))

    @app.put("/api/machines/{machine_id}/view/{kind}")
    async def put_machine_view(machine_id: str, kind: str, file: UploadFile = File(...)):
        limit = MAX_PICTURE if kind == "picture" else MAX_MODEL
        chunks: list[bytes] = []
        size = 0
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > limit:
                raise HTTPException(status_code=413, detail=f"the {kind} is over {limit >> 20} MB")
            chunks.append(chunk)
        data = b"".join(chunks)
        return _guarded(lambda: store.put(machine_id, kind, file.filename or "", data))

    @app.get("/api/machines/{machine_id}/view/{kind}")
    def machine_view_file(machine_id: str, kind: str):
        data, media = _guarded(lambda: store.read(machine_id, kind))
        # The page asks by version, so a kept answer is never stale.
        return Response(content=data, media_type=media, headers={"Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff"})

    @app.put("/api/machines/{machine_id}/view/{kind}/box")
    def place_machine_view(machine_id: str, kind: str, body: ViewBoxBody):
        return _guarded(lambda: store.place(machine_id, kind, body.box))

    @app.delete("/api/machines/{machine_id}/view/{kind}")
    def remove_machine_view(machine_id: str, kind: str):
        return _guarded(lambda: store.remove(machine_id, kind))
