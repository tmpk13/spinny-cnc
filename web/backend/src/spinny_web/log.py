"""The backend's logs: what happened to the link, the runs and the probing,
and every line that went over the wire.

Messages shown on the page are gone with the page; the log keeps them,
with the link's own events and the machine's own messages, in a file in
the runtime directory that rotates so it never fills the disk. The wire
log beside it holds every line sent and received with the time to the
millisecond, status polls included, so a machine that stops answering
leaves behind what it said last and what was sent to it. The page can
read the tail of either.
"""

from __future__ import annotations

import logging
import logging.handlers
from collections import deque
from pathlib import Path

LOGGER = "spinny_web"
WIRE_LOGGER = "spinny_web.wire"
LOG_FILE = "spinny.log"
WIRE_FILE = "wire.log"
# The names the API and the page know the files by.
FILES = {"spinny": LOG_FILE, "wire": WIRE_FILE}
# The files turn over at these sizes, keeping a few old ones. Wire lines
# go by at tens a second while a job streams and the polls run, so its
# files are larger: the set holds the last hours.
MAX_BYTES = 1_000_000
BACKUPS = 3
WIRE_MAX_BYTES = 8_000_000
WIRE_BACKUPS = 4
FORMAT = "%(asctime)s %(levelname)s %(message)s"
WIRE_FORMAT = "%(asctime)s.%(msecs)03d %(message)s"
LEVELS = ("debug", "info", "warning", "error")

log = logging.getLogger(LOGGER)
wire = logging.getLogger(WIRE_LOGGER)


def setup(root: Path, to_stderr: bool = True, level: str = "info") -> Path:
    """Logs to `root/spinny.log` (and stderr) and the wire to
    `root/wire.log`, once per process. Returns the log file's path."""
    path = root / LOG_FILE
    logger = logging.getLogger(LOGGER)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.propagate = False
    wire_logger = logging.getLogger(WIRE_LOGGER)
    wire_logger.setLevel(logging.INFO)
    # Its lines are the wire's, not the log's: they stay in their own file.
    wire_logger.propagate = False
    if getattr(logger, "_spinny_path", None) == path:
        return path
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    for handler in list(wire_logger.handlers):
        wire_logger.removeHandler(handler)
    formatter = logging.Formatter(FORMAT, datefmt="%Y-%m-%d %H:%M:%S")
    try:
        root.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
        wire_handler = logging.handlers.RotatingFileHandler(
            root / WIRE_FILE, maxBytes=WIRE_MAX_BYTES, backupCount=WIRE_BACKUPS, encoding="utf-8"
        )
        wire_handler.setFormatter(logging.Formatter(WIRE_FORMAT, datefmt="%Y-%m-%d %H:%M:%S"))
        wire_logger.addHandler(wire_handler)
    except OSError:
        pass
    if to_stderr:
        stream = logging.StreamHandler()
        stream.setFormatter(formatter)
        logger.addHandler(stream)
    logger._spinny_path = path  # type: ignore[attr-defined]
    return path


def wire_line(direction: str, text: str, poll: bool = False) -> None:
    """One line over the wire: `tx` or `rx`, as `tx-poll` or `rx-poll` when
    it is the link's own status poll or the report that answers it."""
    wire.info("%s%s %s", direction, "-poll" if poll else "", text)


def wire_note(text: str) -> None:
    """What the link saw around the lines: opened, closed, a banner, a
    message, so the wire log reads on its own."""
    wire.info("-- %s", text)


def path_for(root: Path, name: str) -> Path | None:
    """The file behind a log's name (`spinny`, `wire`), or None."""
    file = FILES.get(name)
    return root / file if file else None


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
