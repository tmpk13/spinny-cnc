from __future__ import annotations

from pathlib import Path

import pytest

import json

from spinny_laser.machine_keys import KEYS, fixture, from_board, has_key, set_key, value_of
from spinny_laser.machines import FIRMWARE_DEFAULTS, MachineError, close, parse

SHIPPED = Path(__file__).resolve().parents[2] / "machines"
FILES = {path.stem: path.read_text(encoding="utf-8") for path in sorted(SHIPPED.glob("*.toml"))}


def settings_of(name: str) -> dict:
    return parse(FILES[name], name).settings


def test_every_firmware_setting_has_a_key():
    named = {key.setting for key in KEYS}
    # The tool's key holds the spindle and the dispenser flags at once.
    assert set(FIRMWARE_DEFAULTS) - named == {"dispenser"}


@pytest.mark.parametrize("name", sorted(FILES))
def test_a_file_read_from_the_board_it_describes_is_left_as_it_is(name):
    read = from_board(FILES[name], settings_of(name))
    assert read.changes == [] and read.left == []
    assert read.text == FILES[name]


@pytest.mark.parametrize(
    ("into", "board"),
    [("polar-laser", "k40"), ("k40", "polar-laser"), ("cartesian-mill", "polar-laser-focus"), ("cartesian-laser", "cartesian-mill"), ("cartesian-dispenser", "cartesian-dispenser")],
)
def test_a_file_read_from_another_machine_s_board_reads_as_that_machine(into, board):
    live = settings_of(board)
    read = from_board(FILES[into], live)
    assert read.left == []
    after = parse(read.text, "after").settings
    assert all(close(float(after[name]), float(value)) for name, value in live.items())
    # The comments of the keys it kept are there still.
    assert read.text.count("#") >= FILES[into].count("#") - 1


def test_a_scale_goes_in_the_key_the_section_uses_else_as_full_steps():
    live = dict(FIRMWARE_DEFAULTS, r_steps=800.0, tmc_r_micro=16, z_steps=1280.0, tmc_z_micro=32)
    read = from_board("[rail]\nsteps_per_mm = 10240\n[slide]\ninvert = false\n", live)
    assert "[rail] steps_per_mm = 800 (was 10240)" in read.changes
    assert "[slide] full_steps_per_mm = 40 (was 40)" in read.changes
    assert "[rail] microsteps = 16 (was 256)" in read.changes
    assert parse(read.text, "x").settings["z_steps"] == 1280.0
    assert read.left == []


def test_host_keys_are_read_only_where_the_file_names_them():
    text = "[host]\ntolerance = 0.005\n"
    read = from_board(text, dict(FIRMWARE_DEFAULTS), {"tolerance": 0.01, "clearance": 3.0, "travel": None})
    assert read.changes == ["[host] tolerance = 0.01 (was 0.005)"]
    assert "clearance" not in read.text


def test_a_board_with_another_tool_than_a_dispenser_s_file_is_refused():
    with pytest.raises(MachineError, match="change the tool and that section by hand"):
        from_board(FILES["polar-laser"], settings_of("cartesian-dispenser"))


def test_a_key_is_written_in_place_its_comment_kept_or_added_where_it_belongs():
    text = 'name = "x"\n\n[rail]\nmax_rate = 560              # mm/min\n\n[controls]\npad = true\n'
    assert set_key(text, "rail", "max_rate", 900.0) == 'name = "x"\n\n[rail]\nmax_rate = 900              # mm/min\n\n[controls]\npad = true\n'
    added = set_key(text, "rail", "accel", 75.5)
    assert added.split("\n")[3:5] == ["max_rate = 560              # mm/min", "accel = 75.5"]
    # A section the file lacks goes before [controls].
    probe = set_key(text, "probe", "pin", 26)
    assert probe.index("[probe]\npin = 26") < probe.index("[controls]")
    assert set_key(text, None, "kinematics", "cartesian").startswith('name = "x"\nkinematics = "cartesian"\n')
    assert has_key(probe, "probe", "pin") and not has_key(probe, "rail", "pin")
    # A '#' inside a string is not a comment.
    hint = '[c]\nhint = "a # b"   # note\n'
    assert set_key(hint, "c", "hint", "z") == '[c]\nhint = "z"       # note\n'


def test_values_read_per_key_from_settings():
    settings = dict(FIRMWARE_DEFAULTS, dir_invert=0b0101, sockets=1324, r_stop=2, cartesian=1, spindle=1)
    by = {(key.section, key.key): key for key in KEYS}
    assert value_of(by[("rail", "invert")], settings) is True
    assert value_of(by[("table", "invert")], settings) is False
    assert value_of(by[("slide", "invert")], settings) is True
    assert value_of(by[("table", "socket")], settings) == "Z"
    assert value_of(by[("rail", "endstop")], settings) == "max"
    assert value_of(by[(None, "kinematics")], settings) == "cartesian"
    assert value_of(by[(None, "tool")], settings) == "spindle"


def test_the_machine_keys_fixture_is_current():
    # The page checks its copy of the keys and its reading against the same file.
    written = json.loads((Path(__file__).parent / "data" / "machine-keys.json").read_text(encoding="utf-8"))
    assert written == json.loads(json.dumps(fixture())), "the keys or their reading changed: mise run keys-fixture"
    assert written["case"]["changes"] and written["case"]["left"] == []
