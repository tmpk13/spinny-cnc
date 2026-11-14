"""A release's machine files merged into the operator's copies: a value
only the release changed taken, one the operator changed kept, keys and
tables the release added put in with their own lines, an array of tables
as one value, two-way where what a copy was made from is not known; and
the offers made of them, taken or left through the API."""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.machines import MachineStore
from spinny_web.shipped import MergeError, layout, merge, offers, remember_all

BASE = """# A machine as shipped.
name = "Rig"
controller = "gcode"

[port]
url = ""
baud = 115200            # a USB CDC port takes any

[gcode]
init = [
    "G21",
    "G90",
]
pick = "M106"

[motion]
safe_z = 5
place_z = -1             # the tip on the board

[[controls.axes]]
axis = "r"
letter = "X"

[[controls.axes]]
axis = "z"
letter = "Y"
"""


def edit(text: str, old: str, new: str) -> str:
    assert old in text, old
    return text.replace(old, new)


def test_a_table_and_its_keys_are_found_with_values_over_several_lines():
    tables = layout(BASE)
    assert [(table.path, table.array) for table in tables] == [
        ((), False), (("port",), False), (("gcode",), False), (("motion",), False), (("controls", "axes"), True), (("controls", "axes"), True),
    ]
    gcode = tables[2]
    lines = BASE.split("\n")
    first, end = gcode.keys["init"]
    assert lines[first] == "init = [" and lines[end - 1] == "]"
    assert lines[gcode.keys["pick"][0]] == 'pick = "M106"'


def test_a_value_only_the_release_changed_is_taken_and_one_the_operator_changed_kept():
    shipped = edit(BASE, "safe_z = 5", "safe_z = 31.5")
    shipped = edit(shipped, "baud = 115200            # a USB CDC port takes any", "baud = 250000            # the release's")
    local = edit(BASE, "place_z = -1             # the tip on the board", "place_z = 14             # measured")
    merged = merge(BASE, shipped, local)
    data = tomllib.loads(merged.text)
    assert data["motion"] == {"safe_z": 31.5, "place_z": 14}
    assert data["port"]["baud"] == 250000
    # The operator's lines and comments stay where the release changed nothing.
    assert "place_z = 14             # measured" in merged.text and merged.text.startswith("# A machine as shipped.")
    assert merged.changes == ["[port] baud: 115200 to 250000", "[motion] safe_z: 5 to 31.5"]


def test_a_value_both_changed_stays_the_operators_and_is_listed():
    shipped = edit(BASE, "safe_z = 5", "safe_z = 31.5")
    local = edit(BASE, "safe_z = 5", "safe_z = 30")
    merged = merge(BASE, shipped, local)
    assert tomllib.loads(merged.text)["motion"]["safe_z"] == 30
    assert merged.text == local
    assert merged.changes == ["[motion] safe_z: yours kept, 30; the release has 31.5"]


def test_keys_and_tables_the_release_added_go_in_with_their_own_lines():
    shipped = edit(BASE, 'pick = "M106"\n', 'pick = "M106"\n# The motors, for the jog panel.\nmotors_on = "M17"\n')
    shipped = edit(shipped, "[[controls.axes]]\naxis = \"r\"", "# The bottom camera.\n[up_camera]\nposition = [61.92, 219.82]\nz = 4.0\n\n[[controls.axes]]\naxis = \"r\"")
    local = edit(BASE, "safe_z = 5", "safe_z = 6")
    merged = merge(BASE, shipped, local)
    data = tomllib.loads(merged.text)
    assert data["gcode"]["motors_on"] == "M17" and data["up_camera"] == {"position": [61.92, 219.82], "z": 4.0} and data["motion"]["safe_z"] == 6
    assert "# The motors, for the jog panel.\nmotors_on = \"M17\"" in merged.text
    assert "# The bottom camera.\n[up_camera]\nposition = [61.92, 219.82]\nz = 4.0" in merged.text
    assert merged.changes == ['[gcode] motors_on = "M17" added', "[up_camera] position = [61.92, 219.82] added", "[up_camera] z = 4.0 added"]


def test_a_key_the_release_took_out_goes_unless_the_operator_changed_it():
    shipped = edit(BASE, 'pick = "M106"\n', "")
    assert "pick" not in tomllib.loads(merge(BASE, shipped, BASE).text)["gcode"]
    changed = edit(BASE, 'pick = "M106"', 'pick = "M106 P1"')
    merged = merge(BASE, shipped, changed)
    assert tomllib.loads(merged.text)["gcode"]["pick"] == "M106 P1"
    assert merged.changes == ['[gcode] pick: yours kept, "M106 P1"; the release has left out']


def test_a_value_over_several_lines_is_replaced_whole():
    shipped = edit(BASE, '    "G90",\n]', '    "G90",\n    "M204 T3500",\n]')
    merged = merge(BASE, shipped, BASE)
    assert tomllib.loads(merged.text)["gcode"]["init"] == ["G21", "G90", "M204 T3500"]
    assert merged.text == shipped


def test_an_array_of_tables_is_one_value_the_release_replaces_only_where_left_as_shipped():
    shipped = edit(BASE, 'letter = "Y"', 'letter = "Y"\nlabel = "Y"')
    merged = merge(BASE, shipped, BASE)
    assert tomllib.loads(merged.text)["controls"]["axes"][1] == {"axis": "z", "letter": "Y", "label": "Y"}
    assert merged.changes == ["[[controls.axes]]: the release's tables"]
    mine = edit(BASE, 'letter = "X"', 'letter = "R"')
    kept = merge(BASE, shipped, mine)
    assert kept.text == mine and kept.changes[0].startswith("[[controls.axes]]: yours kept")


def test_without_a_record_of_the_copy_what_the_release_adds_is_added_and_the_operators_values_kept():
    shipped = edit(BASE, 'pick = "M106"\n', 'pick = "M106"\nmotors_on = "M17"\n')
    shipped = edit(shipped, "safe_z = 5", "safe_z = 31.5")
    merged = merge(None, shipped, BASE)
    data = tomllib.loads(merged.text)
    assert data["gcode"]["motors_on"] == "M17" and data["motion"]["safe_z"] == 5
    assert merged.changes == ['[gcode] motors_on = "M17" added', "[motion] safe_z: yours kept, 5; the release has 31.5"]


def test_a_text_that_does_not_read_is_not_merged():
    with pytest.raises(MergeError):
        merge(BASE, BASE, "[port\n")


def check(text: str, machine_id: str) -> None:
    """A merged text read as the backend reads a machine file."""
    MachineStore(Path("unused")).parse(text, machine_id)


GCODE = """name = "Rig"
controller = "gcode"

[motion]
safe_z = 5
place_z = -1
"""


@pytest.fixture
def dirs(tmp_path):
    shipped, base, machines = tmp_path / "shipped", tmp_path / "var" / "shipped" / "machines", tmp_path / "machines"
    for each in (shipped, machines):
        each.mkdir(parents=True)
    return shipped, base, machines


def test_the_offers_a_release_makes(dirs):
    shipped, base, machines = dirs
    (shipped / "rig.toml").write_text(GCODE, encoding="utf-8")
    (shipped / "fresh.toml").write_text(GCODE.replace('"Rig"', '"Fresh"'), encoding="utf-8")
    (machines / "rig.toml").write_text(GCODE, encoding="utf-8")
    remember_all(shipped, base)
    (base / "fresh.toml").unlink()
    # The copy as shipped, the release the same: only the new file is offered.
    assert [(offer.id, offer.status) for offer in offers(shipped, base, machines, check)] == [("fresh", "new")]
    # The release changes a value, the operator another.
    (shipped / "rig.toml").write_text(GCODE.replace("safe_z = 5", "safe_z = 31.5"), encoding="utf-8")
    (machines / "rig.toml").write_text(GCODE.replace("place_z = -1", "place_z = 14"), encoding="utf-8")
    rig = next(offer for offer in offers(shipped, base, machines, check) if offer.id == "rig")
    assert rig.status == "merged" and rig.known and rig.changes == ["[motion] safe_z: 5 to 31.5"]
    assert tomllib.loads(rig.text)["motion"] == {"safe_z": 31.5, "place_z": 14}
    assert "-safe_z = 5\n+safe_z = 31.5\n" in rig.diff
    # A merge the backend would refuse is a problem, the release's file shown.
    (shipped / "rig.toml").write_text(GCODE.replace("safe_z = 5", "safe_z = 5\nfeed_xy = -3"), encoding="utf-8")
    rig = next(offer for offer in offers(shipped, base, machines, check) if offer.id == "rig")
    assert rig.status == "problem" and "feed_xy" in (rig.problem or "")


@pytest.fixture
def client(tmp_path, dirs):
    shipped, base, machines = dirs
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "var" / "config.json", machines_dir=machines)
    backend.shipped_dir = shipped
    backend.shipped_base = base
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        client.dirs = dirs
        yield client


def test_an_offer_is_taken_or_left_through_the_api(client):
    shipped, base, machines = client.dirs
    (shipped / "rig.toml").write_text(GCODE, encoding="utf-8")
    (machines / "rig.toml").write_text(GCODE.replace("place_z = -1", "place_z = 14"), encoding="utf-8")
    remember_all(shipped, base)
    assert client.get("/api/update/machines").json() == {"shipped": True, "files": []}
    (shipped / "rig.toml").write_text(GCODE.replace("safe_z = 5", "safe_z = 31.5"), encoding="utf-8")
    (shipped / "fresh.toml").write_text(GCODE.replace('"Rig"', '"Fresh"'), encoding="utf-8")
    listed = client.get("/api/update/machines").json()
    assert [(entry["id"], entry["status"]) for entry in listed["files"]] == [("fresh", "new"), ("rig", "merged")]
    # Taken: the merged text written, and what the copy is made from kept.
    after = client.post("/api/update/machines/rig", json={"take": True})
    assert after.status_code == 200, after.text
    assert [entry["id"] for entry in after.json()["files"]] == ["fresh"]
    assert tomllib.loads((machines / "rig.toml").read_text())["motion"] == {"safe_z": 31.5, "place_z": 14}
    assert (base / "rig.toml").read_text() == (shipped / "rig.toml").read_text()
    # Left: the operator's directory as it was, not offered again.
    assert client.post("/api/update/machines/fresh", json={"take": False}).json()["files"] == []
    assert not (machines / "fresh.toml").exists()
    assert client.post("/api/update/machines/nope", json={"take": True}).status_code == 404


def test_a_shipped_file_of_the_repository_merges_into_a_copy_made_from_the_one_before():
    # The virtual LumenPnP's file gained its cameras' devices: a copy made
    # from the file before, its place_z measured, takes them and keeps it.
    shipped = (Path(__file__).resolve().parents[3] / "machines" / "virtual-pnp.toml").read_text(encoding="utf-8")
    base = "\n".join(line for line in shipped.split("\n") if not line.startswith(("device = ", "size = ", "# spinny-virtual-pnp's bottom camera", "# machine connects.")))
    assert base != shipped
    local = edit(base, "place_z = 14.0", "place_z = 13.2")
    merged = merge(base, shipped, local)
    data = tomllib.loads(merged.text)
    assert data["motion"]["place_z"] == 13.2
    assert data["up_camera"]["device"] == "http://127.0.0.1:2328/snapshot" and data["top_camera"]["device"] == "http://127.0.0.1:2329/snapshot"
    assert data["gcode"]["init"][2] == "M204 T3500" and len(data["slot"]) == 3
    check(merged.text, "virtual-pnp")
    assert sorted(merged.changes) == sorted([
        '[up_camera] device = "http://127.0.0.1:2328/snapshot" added', '[up_camera] size = "640x480" added',
        '[top_camera] device = "http://127.0.0.1:2329/snapshot" added', '[top_camera] size = "640x480" added',
    ])
