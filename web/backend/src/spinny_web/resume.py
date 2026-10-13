"""The resume record: how far the last run got and the plan it was made from.

The runner writes it as a job streams, so a host that dies with the job
half done, or a controller that goes quiet and is powered down, leaves
behind what a later session needs to pick the job up: the job, the line
count, where the plan began and how it followed the board. One file in
the runtime directory holds the record of the last run only.
"""

from __future__ import annotations

import json
from pathlib import Path


class ResumeStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._record: dict | None = None
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict) and isinstance(data.get("job"), str):
            self._record = data

    def get(self) -> dict | None:
        self._load()
        return dict(self._record) if self._record is not None else None

    def put(self, record: dict) -> None:
        self._loaded = True
        self._record = dict(record)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(self._record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            tmp.replace(self.path)
        except (OSError, ValueError):
            # The record is in force for this process; a host that cannot
            # write its runtime directory has bigger problems, reported
            # where the config is saved.
            pass

    def clear(self) -> None:
        self._loaded = True
        self._record = None
        try:
            self.path.unlink()
        except OSError:
            pass
