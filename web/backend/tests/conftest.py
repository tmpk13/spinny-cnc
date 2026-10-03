"""Test paths: this suite's helpers, and the toolpath suite's machine model."""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
for extra in (HERE, REPO / "toolpath" / "tests"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))
