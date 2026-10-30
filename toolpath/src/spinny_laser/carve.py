"""The 3D kernel: `spinny-carve`, the Rust program in `carve/` that slices a
model and makes the toolpaths of its rough, waterline and parallel
operations. It is run once per job with one JSON request on its input and
answers one JSON document; this module finds it and runs it.

The program is looked for as SPINNY_CARVE names it, then in the repository's
`carve/target` (the build changed last, debug or release), then on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

ENV = "SPINNY_CARVE"
NAME = "spinny-carve"
REPO = Path(__file__).resolve().parents[3]
# A plan of a big mesh with fine passes takes a while; past this it is
# taken as stuck.
TIMEOUT = 900.0

# How the tool gets to a point, the fourth number of each move.
RAPID, FEED, PLUNGE = 0, 1, 2


class CarveError(ValueError):
    """The kernel is missing, or refused the request."""


def find() -> Path | None:
    named = os.environ.get(ENV, "").strip()
    if named:
        path = Path(named)
        return path if path.is_file() else None
    built = [REPO / "carve" / "target" / profile / NAME for profile in ("debug", "release")]
    present = [path for path in built if path.is_file()]
    if present:
        return max(present, key=lambda path: path.stat().st_mtime)
    found = shutil.which(NAME)
    return Path(found) if found else None


def run(request: dict, timeout: float = TIMEOUT) -> dict:
    """The kernel's answer to one request; a CarveError says what went
    wrong, the kernel's own words when it refused."""
    binary = find()
    if binary is None:
        raise CarveError(f"the 3D kernel {NAME} is not built: run `mise run build-carve` (cargo build in carve/), or name it with {ENV}")
    try:
        done = subprocess.run([str(binary)], input=json.dumps(request), capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise CarveError(f"the 3D kernel took more than {timeout:.0f} s; try a coarser tolerance or fewer operations") from None
    except OSError as exc:
        raise CarveError(f"cannot run {binary}: {exc.strerror or exc}") from exc
    try:
        answer = json.loads(done.stdout)
    except json.JSONDecodeError:
        tail = (done.stderr or done.stdout or "").strip()[-400:]
        raise CarveError(f"the 3D kernel stopped without an answer (exit {done.returncode}): {tail}") from None
    if not isinstance(answer, dict):
        raise CarveError("the 3D kernel's answer is not a document")
    if "error" in answer:
        raise CarveError(str(answer["error"]))
    return answer
