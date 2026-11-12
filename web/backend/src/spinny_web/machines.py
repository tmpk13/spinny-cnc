"""Machine files for the page: the files in `machines/` listed, read,
checked, saved, changed a value at a time and removed. The parse is
`spinny_laser.machines`, and for a G-code machine its own tables are read
by `openpnp.machine_of` as well, so a file is checked whole either way;
this is the directory around it."""

from __future__ import annotations

import re

from spinny_laser import machines as machine_files
from spinny_laser.cam import set_value
from spinny_laser.machines import GCODE, Machine, MachineError

from .cam import NotFound
from .openpnp import GcodeMachine, machine_of
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
        where = where or f"{item_id}.toml"
        machine = machine_files.parse(text, item_id, where)
        if machine.controller == GCODE:
            # Its own tables are read now, so a file that saves is one a
            # connect can use.
            machine_of(machine, where)
        return machine

    def describe(self, parsed: Machine) -> dict:
        """The file as the page shows it; a G-code machine's with its own
        tables read (port, dialect, heights, cameras, feeders)."""
        document = parsed.document()
        if parsed.controller == GCODE:
            document["gcode"] = machine_of(parsed).document()
        return document

    def gcode(self, machine_id: str) -> GcodeMachine:
        """A G-code machine's file read; MachineError for one of this
        project's firmware."""
        return machine_of(self.get(machine_id))

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

    def patch(self, machine_id: str, path: list, value) -> dict:
        """One value of a file changed in its text, comments and all, and
        saved once the whole file reads. A plain table not in the file yet
        ([vacuum], [up_camera]) is added at its end; `None` takes the key
        out."""
        with self._writing:
            text = self.text(machine_id)
            table = path[:-1]
            if len(table) == 1 and isinstance(table[0], str) and value is not None:
                header = re.compile(rf"^\s*\[{re.escape(table[0])}\]\s*(#.*)?$", re.MULTILINE)
                if not header.search(text):
                    text = text.rstrip("\n") + f"\n\n[{table[0]}]\n"
            return self.save(machine_id, set_value(text, tuple(path), value))
