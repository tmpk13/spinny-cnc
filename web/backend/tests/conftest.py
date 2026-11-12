"""Test paths: this suite's helpers, and the toolpath suite's machine model."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
for extra in (HERE, REPO / "toolpath" / "tests"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))


@pytest.fixture(autouse=True)
def pictures_at_once(monkeypatch):
    """A look takes the fakes' picture at once: they show the head where it
    is the moment it is asked, so the wait for a picture taken after the
    head came to rest is left out; the tests of that wait set it."""
    monkeypatch.setattr("spinny_web.camera.SETTLE_SECONDS", 0.0)


@pytest.fixture
def log_records(caplog):
    """The backend's log records. Its logger does not propagate once the
    log is set up, so caplog's handler is put on it directly."""
    logger = logging.getLogger("spinny_web")
    logger.addHandler(caplog.handler)
    level = logger.level
    logger.setLevel(logging.DEBUG)
    try:
        yield caplog
    finally:
        logger.removeHandler(caplog.handler)
        logger.setLevel(level)
