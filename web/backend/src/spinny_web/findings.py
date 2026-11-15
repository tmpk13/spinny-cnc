"""The log of what the cameras' routines found and applied.

A routine's result is applied at once, never held back for the operator
to keep, and recorded as an entry of this log: when, which camera
(`head`, `up`, `top`), what kind of result (`offset`, `picture`,
`fiducials`, `corner`, `features`, `nozzle`, `runout`, or `undo`), its
words, every parameter it changed with its value before and after, the
marks the page draws of it over the picture (`spot`, a spot in the
picture's px as a routine's; `lines`, `corner` and `size`, straight edges
and their corner in the px of a picture `size` big; `points`, points on
the camera's machine frame with a label), and whether it can still be
undone (`undoable`, and `why` not).

Undo writes the values before back and is itself an entry, whose own undo
applies the values again. It is refused (UndoRefused) once the entry is
undone, while a routine of its camera is under way (writing then would
change the settings under it), when the entry changed another G-code
machine's settings than the one placed with now, and when any parameter
no longer holds the value the entry left (it changed since).

Where a parameter lives is a target the backend names when it starts: a
reader of the target's values by name, a writer of some of them, the
G-code machine they belong to (None for the backend's own), and how each
is called in words. The backend's targets: `head`, `up` and `top`, the
cameras' settings; `up place`, the bottom camera's place on the G-code
machine; `references`, the board's references on it, by job. A change is
data (target, name, before, after), so its undo outlasts the backend. A
result that does more than set values (a corner the board's look holds,
the Align marks) also gives an undo of its own, a callable held while this
backend runs: such an entry cannot be undone after a restart, and says so.

A routine records through its camera's view of the log (`Findings`):

    said = camera.findings.keep("offset", words, {"offset": found, "roll": roll}, marks={"spot": spot.to_dict()})

writes the patch through the camera's own target (another with
`target=`), recording each value it changed with its value before; and

    before = camera.findings.read("references")
    ...  # the routine changes them its own way
    said = camera.findings.apply("fiducials", words, changes=camera.findings.since(before, "references"), marks=..., undo=...)

records a result the routine applied itself: the values that differ from
`before` (read before it applied them), plus, with `undo`, a callable that
takes back what is no value of a target (raising UndoRefused when it
cannot). Both answer the words to say of the result (its message).

The log keeps its newest MAX_ENTRIES entries in a JSON file, written whole
at every change.
"""

from __future__ import annotations

import datetime
import json
import logging
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .files import write_whole

log = logging.getLogger("spinny_web.findings")

# Entries the file keeps at most; the oldest go first.
MAX_ENTRIES = 500
# Entries of each camera a published state lists, newest first.
LISTED = 50
VERSION = 1
CAMERAS = ("head", "up", "top")
# How an entry can be undone: by its changes alone (`data`), by those and
# a callable this backend run holds (`held`), or not at all (`none`).
DATA, HELD, NONE = "data", "held", "none"
# The cameras' settings and places in words, with their units.
LABELS = {
    "offset": "offset, mm", "roll": "roll, degrees", "mm_per_px": "mm a pixel", "mirror": "mirrored",
    "position": "place, mm", "runout": "runout, mm", "height": "height, mm",
}


def label_of(name: str) -> str:
    """A parameter's name in words: LABELS, else its name with spaces."""
    return LABELS.get(name, name.replace("_", " "))


class UndoRefused(Exception):
    """An undo that cannot be made now, with why."""


def plain(value: Any) -> Any:
    """A value as JSON gives it back: tuples as lists, keys as strings."""
    return json.loads(json.dumps(value))


def same(a: Any, b: Any) -> bool:
    """Whether two JSON values are the same, numbers within rounding."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b if isinstance(a, bool) and isinstance(b, bool) else False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if not (math.isfinite(a) and math.isfinite(b)):
            return a == b
        return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[key], b[key]) for key in a)
    return a == b


@dataclass
class Target:
    """Where parameters live: `read` gives every value by name, `write`
    takes some (None takes one back to none), `machine` names the G-code
    machine they belong to now (None for the backend's own), `label` says
    a parameter's name in words."""

    read: Callable[[], dict]
    write: Callable[[dict], None]
    machine: Callable[[], str | None] = lambda: None
    label: Callable[[str], str] = label_of


@dataclass
class Change:
    """A parameter a result changed: where it lives, its name and how it
    is called, its value before and after."""

    target: str
    name: str
    before: Any
    after: Any
    label: str = ""

    def to_dict(self) -> dict:
        return {"target": self.target, "name": self.name, "label": self.label or self.name, "before": self.before, "after": self.after}

    @staticmethod
    def of(data: dict) -> Change:
        return Change(str(data.get("target", "")), str(data.get("name", "")), data.get("before"), data.get("after"), str(data.get("label") or ""))


@dataclass
class Entry:
    id: int
    time: str
    camera: str
    kind: str
    text: str
    changes: list[Change] = field(default_factory=list)
    marks: dict = field(default_factory=dict)
    # The G-code machine whose settings it changed, else None.
    machine: str | None = None
    # How it can be undone (DATA, HELD, NONE).
    undo: str = DATA
    # The entry this one undid, and the entry that undid this one.
    undoes: int | None = None
    undone_by: int | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "time": self.time, "camera": self.camera, "kind": self.kind, "text": self.text,
            "changes": [change.to_dict() for change in self.changes], "marks": self.marks, "machine": self.machine,
            "undo": self.undo, "undoes": self.undoes, "undone_by": self.undone_by,
        }

    @staticmethod
    def of(data: dict) -> Entry | None:
        try:
            return Entry(
                id=int(data["id"]), time=str(data.get("time", "")), camera=str(data.get("camera", "")), kind=str(data.get("kind", "")),
                text=str(data.get("text", "")), changes=[Change.of(item) for item in data.get("changes", []) if isinstance(item, dict)],
                marks=data.get("marks") if isinstance(data.get("marks"), dict) else {},
                machine=data.get("machine") if isinstance(data.get("machine"), str) else None,
                undo=data.get("undo") if data.get("undo") in (DATA, HELD, NONE) else NONE,
                undoes=int(data["undoes"]) if isinstance(data.get("undoes"), int) else None,
                undone_by=int(data["undone_by"]) if isinstance(data.get("undone_by"), int) else None,
            )
        except (KeyError, TypeError, ValueError):
            return None


def shown(value: Any) -> str:
    """A parameter's value in a few words, for the reason an undo is refused."""
    if value is None:
        return "none"
    if isinstance(value, float):
        return f"{value:.6g}"
    if isinstance(value, list) and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
        return ", ".join(f"{item:.6g}" for item in value)
    if isinstance(value, list):
        return f"{len(value)} entries"
    return str(value)


class FindingsLog:
    """Every camera's results applied, newest last, kept in `path` (None:
    kept in memory only). `changed` hears of every new entry and every
    undo, to tell the page."""

    def __init__(self, path: Path | None = None, changed: Callable[[Entry], None] | None = None) -> None:
        self.path = path
        self._changed = changed
        self._lock = threading.Lock()
        # One undo at a time: its checks and its writes are one step.
        self._undo_lock = threading.Lock()
        self._targets: dict[str, Target] = {}
        # Whether a routine of a camera is under way, by camera.
        self._busy: dict[str, Callable[[], bool]] = {}
        # The callable undos of this backend run's entries, by id.
        self._held: dict[int, Callable[[], None]] = {}
        self._entries: list[Entry] = self._load()
        self._next = max((entry.id for entry in self._entries), default=0) + 1

    def _load(self) -> list[Entry]:
        if self.path is None:
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as exc:
            log.warning("findings: %s not read: %s", self.path, exc)
            return []
        items = data.get("entries", []) if isinstance(data, dict) else []
        entries = [entry for entry in (Entry.of(item) for item in items if isinstance(item, dict)) if entry is not None]
        return entries[-MAX_ENTRIES:]

    def _save(self) -> None:
        """Writes the log whole; the caller holds the lock."""
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_whole(self.path, json.dumps({"version": VERSION, "entries": [entry.to_dict() for entry in self._entries]}, indent=1))
        except OSError as exc:
            log.warning("findings: %s not written: %s", self.path, exc)

    # --- what the backend tells it ------------------------------------------------

    def target(self, name: str, target: Target) -> None:
        """Names where parameters live (a later one of the same name replaces it)."""
        self._targets[name] = target

    def camera(self, name: str, own: Target | None = None, busy: Callable[[], bool] | None = None) -> Findings:
        """One camera's view of the log; `own` is its settings' target (of
        the camera's name), `busy` says whether a routine of it is under way."""
        if own is not None:
            self.target(name, own)
        if busy is not None:
            self._busy[name] = busy
        return Findings(self, name)

    def _target(self, name: str) -> Target:
        target = self._targets.get(name)
        if target is None:
            raise KeyError(f"no target {name!r} for the findings log")
        return target

    # --- recording -----------------------------------------------------------------

    def read(self, target: str) -> dict:
        """The target's values now, as JSON gives them back."""
        return plain(self._target(target).read())

    def since(self, target: str, before: dict, names: tuple[str, ...] | None = None) -> list[Change]:
        """The target's values that differ now from `before` (what `read`
        gave before they were applied), of `names` only when given."""
        after = self.read(target)
        label = self._targets[target].label
        keys = names if names is not None else tuple(dict.fromkeys([*before, *after]))
        return [
            Change(target, key, before.get(key), after.get(key), label(key))
            for key in keys
            if not same(before.get(key), after.get(key))
        ]

    def keep(self, camera: str, kind: str, words: str, patch: dict, target: str | None = None, marks: dict | None = None, undo: Callable[[], None] | None = None) -> str:
        """Writes `patch` through `target` (the camera's own by default),
        then records it: each value it changed, before and after."""
        name = target or camera
        before = self.read(name)
        self._target(name).write(patch)
        return self.apply(camera, kind, words, self.since(name, before, tuple(patch)), marks, undo)

    def apply(self, camera: str, kind: str, words: str, changes: list[Change] | tuple = (), marks: dict | None = None, undo: Callable[[], None] | None = None) -> str:
        """Records a result applied: its changes, marks and own undo; the words to say of it."""
        changes = list(changes)
        machines = [self._targets[change.target].machine() for change in changes if change.target in self._targets]
        machine = next((name for name in machines if name is not None), None)
        how = HELD if undo is not None else DATA if changes else NONE
        entry = self._add(Entry(0, "", camera, kind, words, changes, plain(marks or {}), machine, how), undo)
        log.info("findings: %s %s %d: %s", camera, kind, entry.id, words)
        return words

    def _add(self, entry: Entry, undo: Callable[[], None] | None = None, undid: Entry | None = None) -> Entry:
        with self._lock:
            entry.id = self._next
            self._next += 1
            entry.time = datetime.datetime.now().isoformat(timespec="seconds")
            self._entries.append(entry)
            if undid is not None:
                undid.undone_by = entry.id
            if undo is not None:
                self._held[entry.id] = undo
            gone = self._entries[:-MAX_ENTRIES]
            del self._entries[:-MAX_ENTRIES]
            for old in gone:
                self._held.pop(old.id, None)
            self._save()
        if self._changed is not None:
            try:
                self._changed(entry)
            except Exception as exc:  # the page hearing late is no failure of the result
                log.warning("findings: telling of entry %d failed: %r", entry.id, exc)
        return entry

    # --- undo ------------------------------------------------------------------------

    def entry(self, entry_id: int) -> Entry:
        with self._lock:
            found = next((entry for entry in self._entries if entry.id == entry_id), None)
        if found is None:
            raise LookupError(f"no entry {entry_id} in the camera log of changes")
        return found

    def _refusal(self, entry: Entry, values: dict[str, dict] | None = None) -> str | None:
        """Why the entry cannot be undone now, or None. `values` are the
        targets' values now by target (read as needed when not given)."""
        if entry.undone_by is not None:
            return f"undone already (entry {entry.undone_by})"
        if entry.undo == NONE:
            if entry.undoes is not None:
                return "an undo of what only that run of the backend could undo: run the routine again to apply it again"
            return "it changed nothing"
        if entry.undo == HELD and entry.id not in self._held:
            return "applied before the backend started again: what it changed besides its settings can no longer be undone"
        for change in entry.changes:
            target = self._targets.get(change.target)
            if target is None:
                return f"{change.label or change.name} lives where this backend keeps nothing"
            if entry.machine is not None and target.machine() != entry.machine:
                return f"applied on {entry.machine}: undo it with that machine the one placed with"
            now = values.get(change.target) if values is not None and change.target in values else None
            if now is None:
                try:
                    now = plain(target.read())
                except Exception as exc:
                    return f"{change.label or change.name} cannot be read now: {exc}"
                if values is not None:
                    values[change.target] = now
            if not same(now.get(change.name), change.after):
                return f"{change.label or change.name} is {shown(now.get(change.name))} now, not {shown(change.after)}: it changed since"
        return None

    def undo(self, entry_id: int) -> Entry:
        """Takes the entry back: its own undo first (it may refuse), then
        each value as it was before; the undo's entry. UndoRefused says why
        not, LookupError for no such entry."""
        with self._undo_lock:
            entry = self.entry(entry_id)
            busy = self._busy.get(entry.camera)
            if busy is not None and busy():
                raise UndoRefused(f"a routine of the {entry.camera} camera is under way: undo once it ends")
            refused = self._refusal(entry)
            if refused is not None:
                raise UndoRefused(f"entry {entry.id} cannot be undone: {refused}")
            own = self._held.get(entry.id)
            if own is not None:
                try:
                    own()
                except ValueError as exc:
                    raise UndoRefused(f"entry {entry.id} cannot be undone: {exc}") from exc
            by_target: dict[str, dict] = {}
            for change in entry.changes:
                by_target.setdefault(change.target, {})[change.name] = change.before
            for name, values in by_target.items():
                self._targets[name].write(values)
            reverse = [Change(change.target, change.name, change.after, change.before, change.label) for change in entry.changes]
            how = DATA if entry.undo == DATA and reverse else NONE
            undone = self._add(Entry(0, "", entry.camera, "undo", f"undone: {entry.text}", reverse, {}, entry.machine, how, undoes=entry.id), undid=entry)
            log.info("findings: entry %d undone by %d", entry.id, undone.id)
            return undone

    # --- what the page reads ------------------------------------------------------------

    def _dict(self, entry: Entry, values: dict[str, dict]) -> dict:
        refused = self._refusal(entry, values)
        return {**entry.to_dict(), "undoable": refused is None, "why": refused}

    def entries(self, camera: str | None = None, limit: int = MAX_ENTRIES) -> list[dict]:
        """The entries newest first, of one camera when given, each saying
        whether it can be undone now and why not."""
        with self._lock:
            chosen = [entry for entry in reversed(self._entries) if camera is None or entry.camera == camera][:max(0, limit)]
        values: dict[str, dict] = {}
        return [self._dict(entry, values) for entry in chosen]

    def count(self, camera: str | None = None) -> int:
        """How many entries the log holds, of one camera when given."""
        with self._lock:
            return sum(1 for entry in self._entries if camera is None or entry.camera == camera)

    def newest(self, camera: str) -> dict | None:
        """The camera's newest entry as `entries` gives it, None with none."""
        listed = self.entries(camera, 1)
        return listed[0] if listed else None

    def state(self) -> dict:
        """Each camera's newest LISTED entries, newest first, and how many the log holds."""
        values: dict[str, dict] = {}
        merged: list[Entry] = []
        with self._lock:
            count = len(self._entries)
            for camera in CAMERAS:
                merged.extend([entry for entry in reversed(self._entries) if entry.camera == camera][:LISTED])
        merged.sort(key=lambda entry: entry.id, reverse=True)
        return {"entries": [self._dict(entry, values) for entry in merged], "count": count}


class Findings:
    """One camera's view of the log: what its routines record through."""

    def __init__(self, log_: FindingsLog, camera: str) -> None:
        self.log = log_
        self.camera = camera

    def read(self, target: str | None = None) -> dict:
        """A target's values now (the camera's own settings by default)."""
        return self.log.read(target or self.camera)

    def since(self, before: dict, target: str | None = None, names: tuple[str, ...] | None = None) -> list[Change]:
        """What changed in a target since `before` (what `read` gave)."""
        return self.log.since(target or self.camera, before, names)

    def keep(self, kind: str, words: str, patch: dict, marks: dict | None = None, target: str | None = None, undo: Callable[[], None] | None = None) -> str:
        """Writes `patch` (through the camera's own target by default) and records it; the words."""
        return self.log.keep(self.camera, kind, words, patch, target, marks, undo)

    def apply(self, kind: str, words: str, changes: list[Change] | tuple = (), marks: dict | None = None, undo: Callable[[], None] | None = None) -> str:
        """Records a result the routine applied itself; the words."""
        return self.log.apply(self.camera, kind, words, changes, marks, undo)

    def newest(self) -> dict | None:
        return self.log.newest(self.camera)
