"""Machine files for the page: the files in `machines/` listed, read,
checked, saved and removed. The parse is `spinny_laser.machines`; this is
the directory around it."""

from __future__ import annotations

from spinny_laser import machines as machine_files
from spinny_laser.machines import Machine, MachineError

from .cam import NotFound
from .stores import TomlStore


class MachineStore(TomlStore):
    """The machine files in one directory. A file that does not read still
    comes with its text and its problem, so it can be mended."""

    noun = "machine file"
    error = MachineError
    missing = NotFound

    def check_id(self, item_id: str) -> None:
        machine_files.check_id(item_id)

    def parse(self, text: str, item_id: str, where: str | None = None) -> Machine:
        return machine_files.parse(text, item_id, where or f"{item_id}.toml")

    def list(self) -> tuple[list[Machine], list[dict]]:
        """Every `*.toml` that reads as a machine, and for each that does
        not its id and what is wrong, so the page can open it to mend it."""
        machines, problems = self.read_all()
        return machines, [{"id": item_id, "problem": problem} for item_id, problem in problems]

    def document(self, machine_id: str) -> dict:
        """The file as written with what it reads as; a file that does not
        read still comes with its text, and the problem, so it can be mended."""
        text = self.text(machine_id)
        return {**self.check(machine_id, text), "text": text}

    def save(self, machine_id: str, text: str) -> dict:
        return {**super().save(machine_id, text), "problems": []}
