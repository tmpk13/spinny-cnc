"""The machine files a release ships, and the operator's copies of them.

A release carries its machine files inside its package (spinny_web/
defaults/machines); its first start copies them into the operator's
machines directory, which from then on is the operator's: nothing writes
it unasked. A later release may ship a file changed (a key added, a value
corrected) or a file the operator does not have yet, so each such file is
offered: the operator's copy with the release's changes merged into it,
what changes listed, and the two texts' difference, to take or to leave.

The merge is three-way where it can be. What each copy was made from (the
file as shipped when it was copied in, or when the operator last took or
left a release's) is kept beside the runtime files (`var/shipped/
machines`). A value only the release changed becomes the release's; a
value the operator changed stays the operator's, also when the release
changed it too (listed, for the operator to look at); a key the release
added is added, and one it took out goes unless the operator changed it.
Without that record (a copy made by a release that kept none) the merge is
two-way: what the release adds is added, every value of the operator's
stays, and the ones that differ are listed.

The text kept is the operator's: a line changes only where its value does,
and a key or a table the release adds goes in with the release's own lines
for it, its comments with them. An array of tables ([[feeder]],
[[controls.axes]]) counts as one value: the release's tables take the
operator's place only where the operator left them as shipped.
"""

from __future__ import annotations

import difflib
import json
import re
import shutil
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

HEADER = re.compile(r"^\s*(\[\[?)\s*([A-Za-z0-9_.\-]+)\s*\]\]?\s*(#.*)?$")
KEY = re.compile(r"^\s*([A-Za-z0-9_\-]+)\s*=")
# A value no file has: a key left out, as against a key with a value.
MISSING = object()


@dataclass
class Table:
    """Where one table of a TOML text is: its path, whether it is one of an
    array of tables, its lines (from its leading comments, or its header,
    to the line before the next table's leading comments), its header's
    line (None for the top), and each key's lines, a value over several
    lines counted whole."""

    path: tuple[str, ...]
    array: bool
    start: int
    header: int | None
    end: int
    keys: dict[str, tuple[int, int]] = field(default_factory=dict)

    def last_key_end(self) -> int:
        """The line after the table's last key, or after its header."""
        ends = [end for _, end in self.keys.values()]
        if ends:
            return max(ends)
        return self.header + 1 if self.header is not None else 0


def _depth(text: str) -> int:
    """How many brackets (arrays, inline tables) a piece of a line opens
    and leaves open, strings and the comment passed over."""
    depth = 0
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if quote is not None:
            if char == "\\" and quote == '"':
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#":
            break
        elif char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        index += 1
    return depth


def layout(text: str) -> list[Table]:
    """The tables of a TOML text, the top first, with their keys' lines."""
    lines = text.split("\n")
    tables = [Table((), False, 0, None, len(lines))]
    depth = 0
    open_key: tuple[Table, str, int] | None = None
    for index, line in enumerate(lines):
        if depth > 0:
            depth += _depth(line)
            if depth <= 0 and open_key is not None:
                table, name, first = open_key
                table.keys[name] = (first, index + 1)
                open_key = None
                depth = 0
            continue
        header = HEADER.match(line)
        if header:
            previous = tables[-1]
            # The comment lines just above a header lead its table.
            start = index
            while start > previous.last_key_end() and start > (previous.header + 1 if previous.header is not None else 0) and lines[start - 1].lstrip().startswith("#"):
                start -= 1
            previous.end = start
            tables.append(Table(tuple(header.group(2).split(".")), header.group(1) == "[[", start, index, len(lines)))
            continue
        key = KEY.match(line)
        if key:
            opened = _depth(line[key.end():])
            if opened > 0:
                depth = opened
                open_key = (tables[-1], key.group(1), index)
            else:
                tables[-1].keys[key.group(1)] = (index, index + 1)
    return tables


def _plain(tables: list[Table], path: tuple[str, ...]) -> Table | None:
    """The plain table at `path` (the top for ()), or None."""
    return next((table for table in tables if table.path == path and not table.array), None)


def _units(data: dict, path: tuple[str, ...], plain: set[tuple[str, ...]], arrays: set[tuple[str, ...]]) -> dict[tuple, object]:
    """Each value of a text read by tomllib, by (table path, key); an array
    of tables whole, by (its path, None). A table with a header, or one
    holding one, is gone into; an inline table is a value."""
    found: dict[tuple, object] = {}
    for key, value in data.items():
        sub = path + (key,)
        if sub in arrays and isinstance(value, list):
            found[(sub, None)] = value
        elif isinstance(value, dict) and any(head[: len(sub)] == sub for head in plain | arrays):
            found.update(_units(value, sub, plain, arrays))
        else:
            found[(path, key)] = value
    return found


def _where(unit: tuple) -> str:
    path, key = unit
    if key is None:
        return f"[[{'.'.join(path)}]]"
    return f"[{'.'.join(path)}] {key}" if path else key


def _shown(value: object) -> str:
    if value is MISSING:
        return "left out"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)) and len(json.dumps(value)) > 60:
        return f"{json.dumps(value)[:57]}..."
    return json.dumps(value)


class MergeError(ValueError):
    """A merge whose text does not come out as the values it should hold."""


@dataclass
class Merged:
    text: str
    # One line per change made or value kept against the release.
    changes: list[str]


def merge(base: str | None, shipped: str, local: str) -> Merged:
    """The operator's text with the release's changes merged in, as the
    module says; `base` is what the copy was made from, None for not known
    (a two-way merge). MergeError (a ValueError) for a text that does not
    read, or a merge that would not come out right."""
    try:
        shipped_data = tomllib.loads(shipped)
        local_data = tomllib.loads(local)
        base_data = tomllib.loads(base) if base is not None else None
    except tomllib.TOMLDecodeError as exc:
        raise MergeError(f"a text does not read as TOML: {exc}") from exc
    shapes = [layout(text) for text in (shipped, local, base or "")]
    plain = {table.path for tables in shapes for table in tables if not table.array and table.path}
    arrays = {table.path for tables in shapes for table in tables if table.array}
    shipped_units = _units(shipped_data, (), plain, arrays)
    local_units = _units(local_data, (), plain, arrays)
    base_units = _units(base_data, (), plain, arrays) if base_data is not None else None
    # The release's order first, so a table it adds gets its keys in order.
    order = list(shipped_units) + [unit for unit in local_units if unit not in shipped_units]
    if base_units is not None:
        order += [unit for unit in base_units if unit not in shipped_units and unit not in local_units]
    text = local
    changes: list[str] = []
    expected: dict[tuple, object] = {}
    for unit in order:
        theirs = shipped_units.get(unit, MISSING)
        mine = local_units.get(unit, MISSING)
        if base_units is not None:
            was = base_units.get(unit, MISSING)
            if theirs == was or mine == theirs:
                continue
            if mine != was:
                changes.append(f"{_where(unit)}: yours kept, {_shown(mine)}; the release has {_shown(theirs)}")
                continue
        else:
            if theirs is MISSING or mine == theirs:
                continue
            if mine is not MISSING:
                changes.append(f"{_where(unit)}: yours kept, {_shown(mine)}; the release has {_shown(theirs)}")
                continue
        text = _take(text, shipped, unit, theirs is MISSING)
        expected[unit] = theirs
        if unit[1] is None:
            changes.append(f"{_where(unit)}: the release's tables")
        elif theirs is MISSING:
            changes.append(f"{_where(unit)} taken out, as the release did")
        elif mine is MISSING:
            changes.append(f"{_where(unit)} = {_shown(theirs)} added")
        else:
            changes.append(f"{_where(unit)}: {_shown(mine)} to {_shown(theirs)}")
    _check(text, expected, local_units, plain, arrays)
    return Merged(text, changes)


def _check(text: str, expected: dict[tuple, object], local_units: dict[tuple, object], plain: set, arrays: set) -> None:
    """The merged text reads, holds every value taken from the release, and
    every value of the operator's kept."""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise MergeError(f"the merge does not read as TOML: {exc}") from exc
    shape = layout(text)
    merged = _units(data, (), plain | {table.path for table in shape if not table.array and table.path}, arrays | {table.path for table in shape if table.array})
    for unit, value in expected.items():
        if merged.get(unit, MISSING) != value:
            raise MergeError(f"{_where(unit)} did not take the release's value")
    for unit, value in local_units.items():
        if unit not in expected and merged.get(unit, MISSING) != value:
            raise MergeError(f"{_where(unit)} did not keep yours")


def _lines_with_comments(lines: list[str], first: int, end: int, floor: int) -> list[str]:
    """A key's lines with the comment lines just above it, down to `floor`."""
    start = first
    while start > floor and lines[start - 1].lstrip().startswith("#"):
        start -= 1
    return lines[start:end]


def _take(text: str, shipped: str, unit: tuple, remove: bool) -> str:
    """The text with one unit as the release has it: a key changed, added
    with its own lines, or taken out; an array of tables replaced."""
    path, key = unit
    lines = text.split("\n")
    tables = layout(text)
    source = shipped.split("\n")
    shipped_tables = layout(shipped)
    if key is None:
        mine = [table for table in tables if table.array and table.path == path]
        theirs = [table for table in shipped_tables if table.array and table.path == path]
        block = [line for table in theirs for line in source[table.start:table.end]]
        if not mine:
            while lines and lines[-1] == "":
                lines.pop()
            return "\n".join(lines + [""] + block)
        at = mine[0].start
        for table in reversed(mine):
            del lines[table.start:table.end]
        lines[at:at] = block
        return "\n".join(lines)
    table = _plain(tables, path)
    if remove:
        if table is None or key not in table.keys:
            raise MergeError(f"{_where(unit)} is not a line of its own in your file")
        first, end = table.keys[key]
        del lines[first:end]
        return "\n".join(lines)
    giver = _plain(shipped_tables, path)
    if giver is None or key not in giver.keys:
        # A dotted key, or a table written inline, has no line of its own.
        raise MergeError(f"{_where(unit)} is not a line of its own in the release's file")
    first, end = giver.keys[key]
    if table is not None and key in table.keys:
        mine_first, mine_end = table.keys[key]
        lines[mine_first:mine_end] = source[first:end]
        return "\n".join(lines)
    floor = max((stop for name, (_, stop) in giver.keys.items() if stop <= first), default=giver.header + 1 if giver.header is not None else 0)
    added = _lines_with_comments(source, first, end, floor)
    if table is not None:
        at = table.last_key_end()
        lines[at:at] = added
        return "\n".join(lines)
    # A table the operator's text does not have: its header from the
    # release's file, with the comments leading it, at the end.
    head = source[giver.start:giver.header + 1] if giver.header is not None else []
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines + [""] + head + added + [""])


@dataclass
class Offer:
    """A shipped file offered against the operator's: `new` (no copy yet),
    `merged` (the copy with the release's changes), or `problem` (it could
    not be merged: why is said). `text` is what taking it writes."""

    id: str
    name: str
    status: str
    changes: list[str]
    text: str
    diff: str
    problem: str | None = None
    # Whether what the copy was made from is known: the merge was three-way.
    known: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _name(text: str, machine_id: str) -> str:
    try:
        name = tomllib.loads(text).get("name")
    except tomllib.TOMLDecodeError:
        return machine_id
    return name if isinstance(name, str) and name else machine_id


def offers(shipped_dir: Path, base_dir: Path, machines_dir: Path, check: Callable[[str, str], object]) -> list[Offer]:
    """Each file the release ships with something for the operator: a file
    the operator has no copy of, or a copy the release's changes would
    change. `check(text, id)` reads a merged text as a machine file,
    raising for one the backend would refuse."""
    found: list[Offer] = []
    if not shipped_dir.is_dir():
        return found
    for path in sorted(shipped_dir.glob("*.toml")):
        machine_id = path.stem
        shipped = path.read_text(encoding="utf-8")
        base_path = base_dir / path.name
        base = base_path.read_text(encoding="utf-8") if base_path.is_file() else None
        if base == shipped:
            # Taken or left since: nothing new from this release.
            continue
        local_path = machines_dir / path.name
        if not local_path.is_file():
            found.append(Offer(machine_id, _name(shipped, machine_id), "new", ["a file this release adds"], shipped, _diff("", shipped, machine_id)))
            continue
        local = local_path.read_text(encoding="utf-8")
        try:
            merged = merge(base, shipped, local)
            if merged.text == local:
                if not merged.changes:
                    continue
                # Only values of the operator's kept against the release:
                # said, with nothing to write.
            check(merged.text, machine_id)
        except ValueError as exc:
            found.append(Offer(machine_id, _name(local, machine_id), "problem", [], shipped, _diff(local, shipped, machine_id), str(exc), base is not None))
            continue
        found.append(Offer(machine_id, _name(local, machine_id), "merged", merged.changes, merged.text, _diff(local, merged.text, machine_id), None, base is not None))
    return found


def _diff(before: str, after: str, machine_id: str) -> str:
    return "".join(
        difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True), f"{machine_id}.toml (yours)", f"{machine_id}.toml (merged)", n=1)
    )


def remember(shipped_dir: Path, base_dir: Path, machine_id: str) -> None:
    """Keeps the release's file as what the operator's copy is now made from."""
    base_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(shipped_dir / f"{machine_id}.toml", base_dir / f"{machine_id}.toml")


def remember_all(shipped_dir: Path, base_dir: Path) -> None:
    """Keeps every file the release ships as what the copies are made from:
    for the first start, which copies them all in."""
    for path in sorted(shipped_dir.glob("*.toml")) if shipped_dir.is_dir() else []:
        remember(shipped_dir, base_dir, path.stem)
