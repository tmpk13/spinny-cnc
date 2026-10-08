"""Machine files for the page: the files in `machines/` listed, read,
checked, saved and removed. The parse is `spinny_laser.machines`; this is
the directory around it."""

from __future__ import annotations

import os
from pathlib import Path

from spinny_laser import machines as machine_files
from spinny_laser.machines import Machine, MachineError

from .cam import NotFound


class MachineStore:
    """The files in one directory, read afresh on every call so an edit by
    hand shows at once; saved all or nothing after a parse."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)

    def list(self) -> tuple[list[Machine], list[dict]]:
        """Every `*.toml` that reads as a machine, and for each that does
        not its id and what is wrong, so the page can open it to mend it."""
        machines: list[Machine] = []
        problems: list[dict] = []
        if not self.directory.is_dir():
            return machines, problems
        for path in sorted(self.directory.glob("*.toml")):
            try:
                machines.append(machine_files.load(path))
            except MachineError as exc:
                problems.append({"id": path.stem, "problem": str(exc)})
        return machines, problems

    def path(self, machine_id: str) -> Path:
        machine_files.check_id(machine_id)
        return self.directory / f"{machine_id}.toml"

    def text(self, machine_id: str) -> str:
        path = self.path(machine_id)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise NotFound(f"no machine file {machine_id!r}") from None
        except OSError as exc:
            raise MachineError(f"{path}: {exc.strerror or exc}") from exc

    def _read(self, machine_id: str, text: str) -> dict:
        try:
            return {"document": machine_files.parse(text, machine_id, f"{machine_id}.toml").document(), "problems": []}
        except MachineError as exc:
            return {"document": None, "problems": [str(exc)]}

    def document(self, machine_id: str) -> dict:
        """The file as written with what it reads as; a file that does not
        read still comes with its text, and the problem, so it can be mended."""
        text = self.text(machine_id)
        return {**self._read(machine_id, text), "text": text}

    def check(self, machine_id: str, text: str) -> dict:
        """What a text would read as, and what is wrong with it, without writing it."""
        self.path(machine_id)
        return self._read(machine_id, text)

    def save(self, machine_id: str, text: str) -> dict:
        """Writes the text as the file, once it reads as a machine; a text
        that does not leaves the file as it was."""
        path = self.path(machine_id)
        machine = machine_files.parse(text, machine_id, f"{machine_id}.toml")
        if not text.endswith("\n"):
            text += "\n"
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + ".tmp")
            temporary.write_text(text, encoding="utf-8")
            os.replace(temporary, path)
        except OSError as exc:
            raise MachineError(f"cannot write {path}: {exc.strerror or exc}") from exc
        return {"document": machine.document(), "problems": [], "text": text}

    def remove(self, machine_id: str) -> None:
        path = self.path(machine_id)
        try:
            path.unlink()
        except FileNotFoundError:
            raise NotFound(f"no machine file {machine_id!r}") from None
        except OSError as exc:
            raise MachineError(f"cannot remove {path}: {exc.strerror or exc}") from exc
