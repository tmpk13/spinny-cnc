"""The TOML files the page edits, one kind to a directory: machine files
(`machines/`, a G-code machine's among them) and CAM profiles (`cam/`).

Each kind is read afresh on every call so an edit by hand shows at once,
saved whole only once its text parses (a text that does not leaves the
file as it was), changed a value at a time with its comments kept, made
new and removed. A kind gives its id check, its parse and its words; the
rest is here once.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from spinny_laser.cam import set_value

from .files import write_whole


class TomlStore:
    """The `*.toml` files of one kind in one directory, by id (the stem).

    A kind sets `noun` (in a missing file's message), `error` (what its
    parse raises, and what a failed write is raised as) and `missing` (the
    error for an id with no file), and gives `check_id` and `parse`.
    """

    noun = "file"
    error: type[Exception] = ValueError
    missing: type[Exception] = LookupError

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        # Writes take turns: a patch reads the file, changes a line and
        # writes it whole, and a write in between would be lost under it.
        self._writing = threading.RLock()
        # Each file as last parsed, by the time it was written.
        self._parsed: dict[str, tuple[int, Any]] = {}

    # --- what a kind gives ---------------------------------------------------------

    def check_id(self, item_id: str) -> None:
        raise NotImplementedError

    def parse(self, text: str, item_id: str, where: str | None = None) -> Any:
        """The file's text read as its kind; `error` naming the key for anything amiss."""
        raise NotImplementedError

    def describe(self, parsed: Any) -> dict:
        """What a file read as, for the page."""
        return parsed.document()

    # --- the files ---------------------------------------------------------------------

    def path(self, item_id: str) -> Path:
        self.check_id(item_id)
        return self.directory / f"{item_id}.toml"

    def paths(self) -> list[Path]:
        """Every file of the kind, by name, byte by byte."""
        if not self.directory.is_dir():
            return []
        return sorted(self.directory.glob("*.toml"))

    def text(self, item_id: str) -> str:
        path = self.path(item_id)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise self.missing(f"no {self.noun} {item_id!r}") from None
        except OSError as exc:
            raise self.error(f"{path}: {exc.strerror or exc}") from exc

    def get(self, item_id: str) -> Any:
        """The file parsed, kept until it is written again: a state that asks
        for it on every change it publishes reads it once."""
        path = self.path(item_id)
        try:
            stamp = path.stat().st_mtime_ns
        except FileNotFoundError:
            raise self.missing(f"no {self.noun} {item_id!r}") from None
        except OSError as exc:
            raise self.error(f"{path}: {exc.strerror or exc}") from exc
        cached = self._parsed.get(item_id)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        parsed = self.parse(self.text(item_id), item_id)
        self._parsed[item_id] = (stamp, parsed)
        return parsed

    def read_all(self) -> tuple[list[Any], list[tuple[str, str]]]:
        """Every file that parses, and for each that does not its id and
        what is wrong, so one bad file does not hide the others."""
        parsed: list[Any] = []
        problems: list[tuple[str, str]] = []
        for path in self.paths():
            try:
                parsed.append(self.parse(path.read_text(encoding="utf-8"), path.stem, str(path)))
            except (OSError, UnicodeDecodeError) as exc:
                problems.append((path.stem, f"{path}: {getattr(exc, 'strerror', None) or exc}"))
            except self.error as exc:
                problems.append((path.stem, str(exc)))
        return parsed, problems

    def document(self, item_id: str) -> dict:
        text = self.text(item_id)
        return {"document": self.describe(self.parse(text, item_id)), "text": text}

    def check(self, item_id: str, text: str) -> dict:
        """What a text would read as, and what is wrong with it, without writing it."""
        self.check_id(item_id)
        try:
            return {"document": self.describe(self.parse(text, item_id)), "problems": []}
        except self.error as exc:
            return {"document": None, "problems": [str(exc)]}

    def save(self, item_id: str, text: str) -> dict:
        """Writes the text as the file once it parses; a text that does not
        leaves the file as it was."""
        path = self.path(item_id)
        parsed = self.parse(text, item_id)
        if not text.endswith("\n"):
            text += "\n"
        try:
            with self._writing:
                self.directory.mkdir(parents=True, exist_ok=True)
                # Through a temporary of its own: two saves at once each move
                # a whole file, where a shared one left the second without its own.
                write_whole(path, text)
        except OSError as exc:
            raise self.error(f"cannot write {path}: {exc.strerror or exc}") from exc
        return {"document": self.describe(parsed), "text": text}

    def patch(self, item_id: str, path: list, value) -> dict:
        """One value changed in the file's text, comments and all, then saved
        whole once it parses; `None` takes the key out."""
        with self._writing:
            return self.save(item_id, set_value(self.text(item_id), tuple(path), value))

    def create(self, item_id: str, text: str) -> dict:
        """A new file; refused when one of that id is there."""
        with self._writing:
            if self.path(item_id).exists():
                raise self.error(f"a {self.noun} {item_id!r} is there already")
            return self.save(item_id, text)

    def remove(self, item_id: str) -> None:
        path = self.path(item_id)
        try:
            with self._writing:
                path.unlink()
        except FileNotFoundError:
            raise self.missing(f"no {self.noun} {item_id!r}") from None
        except OSError as exc:
            raise self.error(f"cannot remove {path}: {exc.strerror or exc}") from exc
        self._parsed.pop(item_id, None)
