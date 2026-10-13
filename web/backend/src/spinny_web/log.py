"""The backend's log: what happened to the link, the runs and the probing.

Messages shown on the page are gone with the page; the log keeps them,
with the link's own events, in a file in the runtime directory that
rotates so it never fills the disk. The page can read the tail of it.
"""

from __future__ import annotations

import logging
import logging.handlers
from collections import deque
from pathlib import Path

LOGGER = "spinny_web"
LOG_FILE = "spinny.log"
# The file turns over at this size, keeping a few old ones.
MAX_BYTES = 1_000_000
BACKUPS = 3
FORMAT = "%(asctime)s %(levelname)s %(message)s"

log = logging.getLogger(LOGGER)


def setup(root: Path, to_stderr: bool = True) -> Path:
    """Logs to `root/spinny.log` (and stderr), once per process. Returns the
    file's path."""
    path = root / LOG_FILE
    logger = logging.getLogger(LOGGER)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if getattr(logger, "_spinny_path", None) == path:
        return path
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    formatter = logging.Formatter(FORMAT, datefmt="%Y-%m-%d %H:%M:%S")
    try:
        root.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except OSError:
        pass
    if to_stderr:
        stream = logging.StreamHandler()
        stream.setFormatter(formatter)
        logger.addHandler(stream)
    logger._spinny_path = path  # type: ignore[attr-defined]
    return path


def tail(path: Path, lines: int = 200) -> list[str]:
    """The last `lines` lines of the log file, oldest first."""
    lines = max(1, min(int(lines), 5000))
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            kept: deque[str] = deque(maxlen=lines)
            for line in handle:
                kept.append(line.rstrip("\n"))
    except OSError:
        return []
    return list(kept)
