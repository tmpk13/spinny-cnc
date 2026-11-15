"""The log of results the cameras' routines applied: each recorded with its
values before and after, undone from them, refused when they changed
since, kept across a restart."""

from __future__ import annotations

import json

import pytest

from spinny_web import findings as findings_module
from spinny_web.findings import FindingsLog, Target, UndoRefused


def settings_target(values: dict, machine: list | None = None) -> Target:
    """A target over a plain dict, None taking a key away; `machine` holds the machine it belongs to."""

    def write(patch: dict) -> None:
        for key, value in patch.items():
            if value is None:
                values.pop(key, None)
            else:
                values[key] = value

    return Target(read=lambda: dict(values), write=write, machine=(lambda: machine[0]) if machine is not None else (lambda: None), label=lambda name: f"the {name}")


def test_a_kept_patch_is_applied_at_once_and_recorded_with_its_values_before_and_after(tmp_path):
    told: list[int] = []
    store = {"roll": 180.0, "mm_per_px": 0.0, "offset": [1.0, 2.0]}
    log = FindingsLog(tmp_path / "findings.json", changed=lambda entry: told.append(entry.id))
    top = log.camera("top", settings_target(store))
    said = top.keep("picture", "roll and scale measured", {"roll": 180.38, "mm_per_px": 0.01597, "offset": (1.0, 2.0)}, marks={"spot": {"dx": 1.5}})
    assert said == "roll and scale measured"
    assert store["roll"] == 180.38 and store["mm_per_px"] == 0.01597
    entry = top.newest()
    assert entry is not None and told == [entry["id"]]
    # The offset was written the same as it was: no change of it is recorded.
    assert [(c["name"], c["before"], c["after"], c["label"]) for c in entry["changes"]] == [
        ("roll", 180.0, 180.38, "the roll"), ("mm_per_px", 0.0, 0.01597, "the mm_per_px"),
    ]
    assert entry["kind"] == "picture" and entry["camera"] == "top" and entry["marks"] == {"spot": {"dx": 1.5}}
    assert entry["undoable"] is True and entry["why"] is None and entry["time"]


def test_undo_writes_the_values_back_is_logged_and_its_own_undo_applies_them_again(tmp_path):
    store = {"roll": 180.0}
    log = FindingsLog(tmp_path / "findings.json")
    head = log.camera("head", settings_target(store))
    head.keep("offset", "offset measured", {"roll": 180.5})
    first = head.newest()["id"]
    undone = log.undo(first)
    assert store["roll"] == 180.0
    assert undone.kind == "undo" and undone.undoes == first and undone.text == "undone: offset measured"
    assert [(c.before, c.after) for c in undone.changes] == [(180.5, 180.0)]
    listed = {entry["id"]: entry for entry in log.entries("head")}
    assert listed[first]["undone_by"] == undone.id and listed[first]["undoable"] is False and "undone already" in listed[first]["why"]
    with pytest.raises(UndoRefused, match="undone already"):
        log.undo(first)
    # The undo's own undo applies the values again.
    log.undo(undone.id)
    assert store["roll"] == 180.5
    with pytest.raises(LookupError):
        log.undo(999)


def test_undo_is_refused_when_a_value_changed_since_or_a_routine_runs(tmp_path):
    store = {"roll": 0.0}
    busy = [False]
    log = FindingsLog(None)
    top = log.camera("top", settings_target(store), busy=lambda: busy[0])
    top.keep("picture", "roll measured", {"roll": 1.5})
    entry_id = top.newest()["id"]
    store["roll"] = 2.0
    assert top.newest()["undoable"] is False and "the roll is 2 now, not 1.5: it changed since" in top.newest()["why"]
    with pytest.raises(UndoRefused, match="it changed since"):
        log.undo(entry_id)
    assert store["roll"] == 2.0
    store["roll"] = 1.5 + 1e-12
    busy[0] = True
    with pytest.raises(UndoRefused, match="routine of the top camera is under way"):
        log.undo(entry_id)
    busy[0] = False
    log.undo(entry_id)
    assert store["roll"] == 0.0


def test_an_entry_of_another_machine_is_not_undone_on_this_one(tmp_path):
    store: dict = {}
    machine = ["lumenpnp"]
    log = FindingsLog(None)
    top = log.camera("top", settings_target(store, machine))
    top.keep("offset", "offset measured", {"offset": [30.0, -9.0]})
    entry = top.newest()
    assert entry["machine"] == "lumenpnp" and entry["changes"][0]["before"] is None
    machine[0] = "other"
    with pytest.raises(UndoRefused, match="applied on lumenpnp"):
        log.undo(entry["id"])
    machine[0] = "lumenpnp"
    log.undo(entry["id"])
    # The value it had was none: it is taken away again.
    assert "offset" not in store


def test_a_result_with_an_undo_of_its_own_runs_it_and_cannot_be_undone_after_a_restart(tmp_path):
    path = tmp_path / "findings.json"
    store = {"references": []}
    corners: list[str] = ["bottom left"]
    log = FindingsLog(path)
    view = log.camera("head", settings_target(store))
    before = view.read()
    store["references"] = [{"ref": "corner top right"}]
    corners.append("top right")

    def take_back() -> None:
        if corners[-1] != "top right":
            raise UndoRefused("the corner was taken again since")
        corners.pop()

    view.apply("corner", "top right corner found", changes=view.since(before), undo=take_back, marks={"points": [{"at": [1, 2], "label": "top right"}]})
    entry = view.newest()
    assert entry["undo"] == "held" and entry["undoable"] is True
    assert [(c["name"], c["before"], c["after"]) for c in entry["changes"]] == [("references", [], [{"ref": "corner top right"}])]
    # Read again by a new backend: the changes are there, the callable is not.
    again = FindingsLog(path)
    again.camera("head", settings_target(store))
    restored = again.newest("head")
    assert restored["id"] == entry["id"] and restored["marks"]["points"][0]["label"] == "top right"
    assert restored["undoable"] is False and "before the backend started again" in restored["why"]
    with pytest.raises(UndoRefused):
        again.undo(entry["id"])
    # In the run that applied it, its own undo goes first, then the values.
    undone = log.undo(entry["id"])
    assert corners == ["bottom left"] and store["references"] == []
    # What only that run could undo is not done again by undoing the undo.
    assert log.newest("head")["undoable"] is False and "run the routine again" in log.newest("head")["why"]
    with pytest.raises(UndoRefused):
        log.undo(undone.id)


def test_a_refusing_own_undo_leaves_every_value_as_it_is(tmp_path):
    store = {"roll": 0.0}
    log = FindingsLog(None)
    view = log.camera("head", settings_target(store))

    def refuse() -> None:
        raise ValueError("the marks changed since")

    view.keep("features", "features centered", {"roll": 1.0}, undo=refuse)
    with pytest.raises(UndoRefused, match="the marks changed since"):
        log.undo(view.newest()["id"])
    assert store["roll"] == 1.0 and view.newest()["undone_by"] is None


def test_the_log_keeps_its_newest_entries_and_lists_each_camera_s_newest(tmp_path, monkeypatch):
    monkeypatch.setattr(findings_module, "MAX_ENTRIES", 5)
    monkeypatch.setattr(findings_module, "LISTED", 2)
    path = tmp_path / "findings.json"
    log = FindingsLog(path)
    head = log.camera("head", settings_target({}))
    up = log.camera("up", settings_target({}))
    for index in range(4):
        head.apply("offset", f"head {index}")
    up.apply("nozzle", "up 0")
    head.apply("offset", "head 4")
    kept = json.loads(path.read_text())["entries"]
    assert [entry["text"] for entry in kept] == ["head 1", "head 2", "head 3", "up 0", "head 4"]
    # Nothing changed: nothing to undo.
    assert log.newest("up")["undoable"] is False and log.newest("up")["why"] == "it changed nothing"
    state = log.state()
    assert state["count"] == 5 and [entry["text"] for entry in state["entries"]] == ["head 4", "up 0", "head 3"]
    assert [entry["text"] for entry in log.entries("head", 2)] == ["head 4", "head 3"]
    # The ids go on counting up from the newest kept.
    again = FindingsLog(path)
    again.camera("head", settings_target({})).apply("offset", "head 5")
    assert again.newest("head")["id"] == kept[-1]["id"] + 1
    # A file that is no log is read as an empty one.
    path.write_text("not json")
    assert FindingsLog(path).entries() == []
