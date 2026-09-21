"""Test paths: the repository's own test helpers sit two levels up."""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
for extra in (HERE, REPO / "tests"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))
