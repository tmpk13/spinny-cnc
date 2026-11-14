"""What a camera routine found, held for the operator to keep or discard
before anything takes it: Find mark's and Measure offset's offset, scale
and roll, the fiducials Find fiducials found, a corner Corner by edges
took, the features Center features centered.

A routine asked to confirm (the page asks unless told not to; the API's
default and the Auto tab's tools keep at once) holds what it found in its
camera's `Findings` instead of keeping it, with words saying what it is
and marks for the page to draw over the picture: a spot in the picture's
px, straight edges and their corner, points on the machine with a label.
Keep runs what the routine would have run; Discard drops it, kept nowhere.
A camera holds one finding: a newer one takes the place of one not
answered. Keep waits while a routine of the same camera is under way,
since keeping its settings then would change them under it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Finding:
    """A routine's result waiting for an answer: what kind (`offset`,
    `fiducials`, `corner`, `features`), what it says in words, the marks
    the page draws of it (`spot`, `lines`, `corner`, `size`, `points`), and
    what keeping it does, which answers the words to say of it."""

    kind: str
    text: str
    keep: Callable[[], str]
    marks: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "text": self.text, **self.marks}


class Findings:
    """One camera's finding waiting to be kept or discarded."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.finding: Finding | None = None

    def hold(self, finding: Finding) -> None:
        """Holds `finding` in place of any not answered."""
        with self._lock:
            self.finding = finding

    def state(self) -> dict | None:
        finding = self.finding
        return finding.to_dict() if finding is not None else None

    def answer(self, keep: bool, busy: bool = False) -> str | None:
        """Keeps the finding (the words keeping it says) or drops it (None).
        A ValueError with none waiting, or for Keep while `busy` (a routine
        of the camera under way), when it stays waiting."""
        with self._lock:
            finding = self.finding
            if finding is None:
                raise ValueError("nothing found waits to be kept or discarded")
            if keep and busy:
                raise ValueError("a routine of this camera is under way: keep what was found once it ends, or discard it")
            self.finding = None
        return finding.keep() if keep else None
