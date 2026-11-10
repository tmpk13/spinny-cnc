"""Files written whole, so that a reader never sees half of one."""

from __future__ import annotations

import os
import secrets
from pathlib import Path


def write_whole(path: Path, data: str | bytes) -> None:
    """The text (as UTF-8) or the bytes written as the file all at once:
    into a temporary of its own beside it, then moved over it, so a reader
    never sees half a file and two writers at once each move a whole one,
    the last one staying. A failure takes the temporary away with it. The
    folder is the caller's to make."""
    temporary = path.with_name(f"{path.name}.{secrets.token_hex(4)}.tmp")
    try:
        if isinstance(data, bytes):
            temporary.write_bytes(data)
        else:
            temporary.write_text(data, encoding="utf-8")
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise
