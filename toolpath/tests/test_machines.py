"""Machine files: the TOML schema onto the firmware's settings."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from spinny_laser import machine, machines
from spinny_laser.controls import KINDS, default_controls_by_kind, kind_id
from spinny_laser.machines import FIRMWARE_DEFAULTS, MachineError, cli_defaults, controls_file, current, default_controls, load, load_all, matches, matching, parse

REPO = Path(__file__).resolve().parents[2]
SHIPPED = REPO / "machines"
FIXTURE = Path(__file__).parent / "data" / "default-controls.json"


def test_the_defaults_cover_every_setting_once():
    assert len(FIRMWARE_DEFAULTS) == 52
    assert machines.FLAGS <= set(FIRMWARE_DEFAULTS) and machines.INTEGERS <= set(FIRMWARE_DEFAULTS)
    for name in machines.FLAGS | machines.INTEGERS:
        assert isinstance(FIRMWARE_DEFAULTS[name], int)


def test_an_empty_file_is_the_firmware_at_its_defaults():
    found = parse("", "bare")
    assert found.settings == FIRMWARE_DEFAULTS
    assert (found.id, found.name, found.description, found.kinematics, found.tool, found.focus) == ("bare", "bare", "", "polar", "laser", False)
    assert found.host == {}


def test_the_shipped_files_load_and_say_what_they_are():
    found, problems = load_all(SHIPPED)
    assert problems == []
    assert [m.id for m in found] == ["cartesian-laser", "cartesian-mill", "polar-laser-focus", "polar-laser"]
    by_id = {m.id: m for m in found}
    assert by_id["polar-laser"].settings == FIRMWARE_DEFAULTS
    assert by_id["polar-laser-focus"].focus and by_id["polar-laser-focus"].settings["h_axis"] == 1
    laser = by_id["cartesian-laser"]
    assert (laser.kinematics, laser.tool, laser.settings["cartesian"], laser.settings["z_max"]) == ("cartesian", "laser", 1, 30.0)
    mill = by_id["cartesian-mill"]
    assert (mill.kinematics, mill.tool, mill.focus) == ("cartesian", "spindle", True)
    assert mill.settings["spindle"] == 1 and mill.settings["h_axis"] == 1
    assert mill.host == {"tolerance": 0.005, "clearance": 2.0, "spinup": 2.0}
    assert mill.summary() == {
        "id": "cartesian-mill", "name": "Cartesian mill",
        "description": "X/Y machine with a spindle on the output and the focus axis as depth",
        "kinematics": "cartesian", "tool": "spindle", "focus": True,
    }
    # The slide's travel is the user's measurement, so the shipped value is
    # not the oracle: the document carries whatever the file says.
    assert mill.document()["settings"]["z_max"] == mill.settings["z_max"] > 0
    # Wired as a three axis mill: rail on X, table on E, slide on Y, depth on Z.
    assert mill.settings["sockets"] == 1423 and mill.settings["tmc_a_ma"] == 0
    assert {m.settings["sockets"] for m in found if m.id != "cartesian-mill"} == {1234}


def test_sockets_are_named_per_axis():
    swapped = parse('[rail]\nsocket = "Y"\n[table]\nsocket = "X"\n', "rig")
    assert swapped.settings["sockets"] == 2134
    assert parse("", "rig").settings["sockets"] == 1234


FULL = """
name = "Test rig"
description = "every key"
kinematics = "cartesian"
tool = "spindle"

[rail]
steps_per_mm = 800
max_rate = 1200
accel = 75
jerk = 2.5
jog_rate = 900
limit = 60
invert = true
current_ma = 700
microsteps = 16

[table]
steps_per_deg = 888.8889
max_rate = 1080
accel = 40
jerk = 7.5
jog_rate = 720
invert = true
current_ma = 650
microsteps = 32

[slide]
steps_per_mm = 640
max_rate = 900
accel = 25.5
jerk = 1.5
jog_rate = 100
limit = 8
current_ma = 500
microsteps = 8

[focus]
fitted = true
steps_per_mm = 1600
max_rate = 300
accel = 20
jerk = 0.5
jog_rate = 150
invert = true
current_ma = 450
microsteps = 64

[probe]
invert = true
brake_ms = 0
pin = 22

[output]
pwm_hz = 1000
s_max = 255
s_min = 10
invert = true
test_ms = 7000
pin = 23

[enable]
fitted = true
pin = 18
invert = true

[drivers]
enable_invert = true
idle_ms = 30000
step_us = 4
hold_pct = 30
stealth = false

[host]
tolerance = 0.01
clearance = 3
spinup = 1.5
"""


def test_every_key_lands_on_its_setting():
    found = parse(FULL, "rig")
    s = found.settings
    assert (found.name, found.description, found.kinematics, found.tool, found.focus) == ("Test rig", "every key", "cartesian", "spindle", True)
    assert (s["cartesian"], s["spindle"], s["h_axis"]) == (1, 1, 1)
    assert (s["r_steps"], s["r_rate"], s["r_accel"], s["r_jerk"], s["jog_r"], s["r_max"]) == (800, 1200, 75, 2.5, 900, 60)
    assert (s["tmc_r_ma"], s["tmc_r_micro"]) == (700, 16)
    assert (s["a_steps"], s["a_rate"], s["a_accel"], s["a_jerk"], s["jog_a"], s["tmc_a_ma"], s["tmc_a_micro"]) == (888.8889, 1080, 40, 7.5, 720, 650, 32)
    assert (s["z_steps"], s["z_rate"], s["z_accel"], s["z_jerk"], s["jog_z"], s["z_max"], s["tmc_z_ma"], s["tmc_z_micro"]) == (640, 900, 25.5, 1.5, 100, 8, 500, 8)
    assert (s["h_steps"], s["h_rate"], s["h_accel"], s["h_jerk"], s["jog_h"], s["tmc_h_ma"], s["tmc_h_micro"]) == (1600, 300, 20, 0.5, 150, 450, 64)
    # Rail, table and focus inverted: bits 0, 1 and 3; the slide is bit 2.
    assert s["dir_invert"] == 0b1011
    assert (s["probe_invert"], s["probe_ms"]) == (1, 0)
    assert (s["laser_hz"], s["s_max"], s["s_min"], s["laser_invert"], s["laser_ms"]) == (1000, 255, 10, 1, 7000)
    assert (s["en_invert"], s["idle_ms"], s["step_us"], s["tmc_hold_pct"], s["tmc_stealth"]) == (1, 30000, 4, 30, 0)
    assert (s["laser_pin"], s["probe_pin"], s["tool_out"], s["tool_pin"], s["tool_invert"]) == (23, 22, 1, 18, 1)
    assert found.host == {"tolerance": 0.01, "clearance": 3.0, "spinup": 1.5}
    assert set(s) == set(FIRMWARE_DEFAULTS)


@pytest.mark.parametrize(
    "text, said",
    [
        ("[rail]\nstep_per_mm = 1\n", "[rail] step_per_mm is not a key here"),
        ("[nope]\nx = 1\n", "nope is not a key here"),
        ("kinematics = \"spiral\"\n", "kinematics must be one of polar, cartesian"),
        ("tool = \"router\"\n", "tool must be one of laser, spindle"),
        ("name = 3\n", "name must be a string"),
        ("[rail]\ninvert = 1\n", "[rail] invert must be true or false"),
        ("[rail]\nmax_rate = \"fast\"\n", "[rail] max_rate must be a number"),
        ("[rail]\nmax_rate = 0\n", "[rail] max_rate must be above 0"),
        ("[rail]\nmax_rate = nan\n", "[rail] max_rate must be a number"),
        ("[rail]\nlimit = -1\n", "[rail] limit must be 0 or more"),
        ("[table]\nlimit = 5\n", "[table] limit is not a key here"),
        ("[table]\nfitted = true\n", "[table] fitted is not a key here"),
        ("[rail]\nmicrosteps = 3\n", "[rail] microsteps must be one of 1, 2, 4"),
        ("[rail]\ncurrent_ma = 2500\n", "[rail] current_ma must be 0 to 2000"),
        ("[rail]\ncurrent_ma = 1.5\n", "[rail] current_ma must be a whole number"),
        ("[probe]\nbrake_ms = 200\n", "[probe] brake_ms must be 0 to 160"),
        ("[output]\ns_min = 20\ns_max = 10\n", "[output] s_min is above s_max"),
        ("[output]\npwm_hz = 50\n", "[output] pwm_hz must be 100 to 100000"),
        ("[drivers]\nstep_us = 0\n", "[drivers] step_us must be 1 to 20"),
        ("[drivers]\nhold_pct = 101\n", "[drivers] hold_pct must be 0 to 100"),
        ("[host]\ntolerance = 0\n", "[host] tolerance must be above 0"),
        ("[host]\nclearance = 200\n", "[host] clearance must be above 0 and at most 100"),
        ("[host]\nfeed = 1\n", "[host] feed is not a key here"),
        ("rail = 5\n", "rail must be a table"),
        ('[slide]\nsocket = "Y"\n', "[slide] socket Y is the [table] socket too"),
        ('[focus]\nsocket = "W"\n', "[focus] socket must be one of X, Y, Z, E"),
        ("[focus]\nsocket = 4\n", "[focus] socket must be one of X, Y, Z, E"),
        ("[output]\npin = 11\n", "[output] pin 11 is a driver socket's or the driver UART's"),
        ("[probe]\npin = 30\n", "[probe] pin must be 0 to 29"),
        ("[probe]\npin = 9\n", "[probe] pin 9 is a driver socket's"),
        ("[enable]\npin = -1\n", "[enable] pin must be 0 to 29"),
        ("[enable]\nfitted = 1\n", "[enable] fitted must be true or false"),
        ("[probe]\npin = 20\n", "[probe] pin 20 (FAN3) is the [output] pin too"),
        ("[enable]\nfitted = true\npin = 20\n", "[enable] pin 20 (FAN3) is the [output] pin too"),
        ("[enable]\nfitted = true\npin = 25\n", "[enable] pin 25 (Z-STOP) is the [probe] pin too"),
        ("[rail\n", "rig:"),
    ],
)
def test_mistakes_are_named(text, said):
    with pytest.raises(MachineError) as caught:
        parse(text, "rig", "rig")
    assert said in str(caught.value)


def test_a_bad_file_is_reported_beside_the_good_ones(tmp_path):
    (tmp_path / "good.toml").write_text("name = \"Good\"\n", encoding="utf-8")
    (tmp_path / "bad.toml").write_text("[rail]\nmax_rate = -1\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("not a machine", encoding="utf-8")
    found, problems = load_all(tmp_path)
    assert [m.id for m in found] == ["good"] and found[0].name == "Good"
    assert len(problems) == 1 and "bad.toml" in problems[0] and "[rail] max_rate" in problems[0]
    assert load_all(tmp_path / "missing") == ([], [])
    with pytest.raises(MachineError):
        load(tmp_path / "missing.toml")


def test_the_live_settings_name_their_machine():
    found, _ = load_all(SHIPPED)
    assert current(found, FIRMWARE_DEFAULTS) == "polar-laser"
    assert matching(found, FIRMWARE_DEFAULTS).id == "polar-laser" and matching(found, {}) is None
    mill = next(m for m in found if m.id == "cartesian-mill")
    assert current(found, mill.settings) == "cartesian-mill"
    # As the firmware prints them: three decimals, ints for whole numbers.
    printed = {name: (round(value, 3) if isinstance(value, float) else value) for name, value in mill.settings.items()}
    printed["a_steps"] = 14222.222
    assert matches(mill, printed)
    assert current(found, {**FIRMWARE_DEFAULTS, "r_rate": 561}) is None
    assert current(found, {}) is None
    assert current(found, {**FIRMWARE_DEFAULTS, "r_rate": "560"}) is None


def test_the_gcode_tools_take_their_defaults_from_a_file(tmp_path):
    path = tmp_path / "rig.toml"
    path.write_text("[rail]\nmax_rate = 1500\n[table]\nmax_rate = 1080\n[output]\ns_max = 255\n[host]\ntolerance = 0.02\n", encoding="utf-8")
    rig = load(path)
    assert cli_defaults(rig) == {"rotary_max_rate": 1080.0, "rotary_rapid": 1080.0, "x_max_rate": 1500.0, "rapid_rate": 1500.0, "s_max": 255.0, "tolerance": 0.02}
    assert "tolerance" not in cli_defaults(parse("", "bare"))

    parser = argparse.ArgumentParser()
    machine.add_machine_arguments(parser)
    args = machine.parse_args(parser, [])
    assert (args.rotary_max_rate, args.x_max_rate, args.s_max, args.tolerance) == (3600.0, 3000.0, 1000.0, 0.005)
    args = machine.parse_args(parser, ["--machine", str(path)])
    assert (args.rotary_max_rate, args.rotary_rapid, args.x_max_rate, args.rapid_rate, args.s_max, args.tolerance) == (1080.0, 1080.0, 1500.0, 1500.0, 255.0, 0.02)
    # A flag given still wins over the file.
    args = machine.parse_args(parser, ["--machine", str(path), "--rotary-max-rate", "400"])
    assert (args.rotary_max_rate, args.x_max_rate) == (400.0, 1500.0)
    bad = tmp_path / "bad.toml"
    bad.write_text("[rail]\nmax_rate = -1\n", encoding="utf-8")
    with pytest.raises(SystemExit):
        machine.parse_args(parser, ["--machine", str(bad)])


# --- the page's controls -----------------------------------------------------


def test_the_controls_default_from_the_profile():
    polar = default_controls("polar", "laser", False)
    assert [axis["axis"] for axis in polar["axes"]] == ["r", "a", "z"]
    assert polar["pad"] and polar["feed"] and polar["pad_steps"] == [0.1, 1, 10] and polar["pad_step"] == 1
    assert polar["center"] == {"r": 0.0}
    rail, table, slide = polar["axes"]
    assert (rail["letter"], rail["label"], rail["steps"], rail["step"], rail["buttons"]) == ("R", "Radius", None, None, ["Radius -", "Radius +"])
    assert (table["steps"], table["step"], table["goto"]) == ([1, 10, 90], 10, True)
    assert (slide["label"], slide["steps"], slide["step"], slide["feed"], slide["goto"]) == ("Cross slide", [0.05, 0.1, 0.5], 0.1, False, False)
    assert all(axis["zero"] and axis["keys"] == [] for axis in polar["axes"])
    focus = default_controls("polar", "laser", True)
    assert [axis["axis"] for axis in focus["axes"]] == ["r", "a", "z", "h"]
    assert (focus["axes"][3]["label"], focus["axes"][3]["buttons"]) == ("Focus axis", ["Down", "Up"])
    mill = default_controls("cartesian", "spindle", True)
    assert mill["center"] == {"r": 0.0, "z": 0.0}
    assert [axis["goto"] for axis in mill["axes"]] == [True, False, True, False]
    slide_y = mill["axes"][2]
    assert (slide_y["label"], slide_y["steps"], slide_y["step"], slide_y["feed"]) == ("Cross slide (Y)", None, None, True)
    assert mill["axes"][3]["label"] == "Depth axis" and "Touch the tool" in mill["axes"][3]["zero_hint"]


def test_the_polar_laser_file_spells_out_the_default_controls():
    # The reference file, with a comment on each key; the other shipped
    # files say where they differ from the defaults for their kind.
    found, _ = load_all(SHIPPED)
    polar = next(m for m in found if m.id == "polar-laser")
    assert polar.controls == default_controls("polar", "laser", False)
    assert parse("", "bare").controls == default_controls("polar", "laser", False)
    assert parse("[controls]\n", "bare").controls == default_controls("polar", "laser", False)
    assert parse("[focus]\nfitted = true\n", "bare").controls == default_controls("polar", "laser", True)


def test_the_default_controls_fixture_is_current():
    # The page checks its copy of the defaults against the same file.
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture == default_controls_by_kind(), "the defaults changed: mise run controls-fixture"
    assert list(fixture) == [kind_id(*kind) for kind in KINDS] and len(fixture) == 8
    assert kind_id("cartesian", "spindle", True) == "cartesian-spindle-focus"


def test_the_controls_come_from_the_file_the_settings_are_else_the_one_for_the_machine():
    mill_a = parse("kinematics = \"cartesian\"\ntool = \"spindle\"\n[focus]\nfitted = true\n[controls]\npad = false\n", "mill-a")
    mill_b = parse("kinematics = \"cartesian\"\ntool = \"spindle\"\n[focus]\nfitted = true\n[rail]\nmax_rate = 700\n", "mill-b")
    polar = parse("", "polar")
    files = [polar, mill_a, mill_b]
    kind = ("cartesian", "spindle", True)
    # The file the settings are, whatever was loaded last.
    assert controls_file(files, mill_a.settings, *kind) is mill_a
    assert controls_file(files, mill_b.settings, *kind, loaded="mill-a") is mill_b
    # No file's settings: the file last loaded, when it is this kind of machine.
    changed = {**mill_a.settings, "r_rate": 999}
    assert controls_file(files, changed, *kind) is None
    assert controls_file(files, changed, *kind, loaded="mill-a") is mill_a
    assert controls_file(files, changed, *kind, loaded="mill-b") is mill_b
    assert controls_file(files, changed, *kind, loaded="polar") is None
    assert controls_file(files, changed, *kind, loaded="gone") is None
    # Nothing loaded: the one file for this kind of machine, if there is one.
    assert controls_file([polar, mill_a], changed, *kind) is mill_a
    assert controls_file(files, {}, "polar", "laser", False) is polar
    assert controls_file([mill_a, mill_b], {}, "polar", "laser", False) is None
    assert controls_file([], {}, "polar", "laser", False) is None


def test_a_controls_entry_fills_in_from_its_default():
    found = parse(
        "[focus]\nfitted = true\n[controls]\npad = false\n"
        "[[controls.axes]]\naxis = \"h\"\nlabel = \"Lift\"\nsteps = [0.5, 2]\nkeys = [\"PageDown\", \"PageUp\"]\n"
        "[[controls.axes]]\naxis = \"r\"\n",
        "rig",
    )
    controls = found.controls
    assert (controls["pad"], controls["pad_steps"], controls["pad_step"], controls["feed"]) == (False, [0.1, 1, 10], 1, True)
    # The default center keeps the joints the file lists.
    assert controls["center"] == {"r": 0.0}
    lift, rail = controls["axes"]
    assert (lift["axis"], lift["letter"], lift["label"], lift["steps"], lift["step"]) == ("h", "H", "Lift", [0.5, 2], 2.0)
    # Renamed without buttons: the letter's, not the default's words.
    assert lift["buttons"] == ["H-", "H+"] and lift["keys"] == ["PageDown", "PageUp"]
    assert lift["note"] == "Raises and lowers the head; up is positive" and lift["zero"] and not lift["feed"]
    assert rail == default_controls("polar", "laser", True)["axes"][0]
    assert found.document()["controls"] == controls

    # Other steps without a pick: the middle one; steps = [] is the pad's step.
    assert parse("[controls]\npad_steps = [0.2, 0.5, 2, 5]\n", "rig").controls["pad_step"] == 2
    table = parse("[controls]\n[[controls.axes]]\naxis = \"a\"\nsteps = []\nbuttons = [\"CCW\", \"CW\"]\n", "rig").controls["axes"][0]
    assert (table["steps"], table["step"], table["buttons"], table["label"]) == (None, None, ["CCW", "CW"], "Table")
    assert parse("[controls]\n[[controls.axes]]\naxis = \"a\"\nstep = 90\n", "rig").controls["axes"][0]["step"] == 90
    # The center is the file's when given, and none for an empty table.
    assert parse("[controls]\ncenter = { a = 90 }\n", "rig").controls["center"] == {"a": 90.0}
    assert parse("[controls]\ncenter = {}\n", "rig").controls["center"] is None
    # Axes without the rail: no default center.
    assert parse("[controls]\n[[controls.axes]]\naxis = \"a\"\n", "rig").controls["center"] is None


@pytest.mark.parametrize(
    "text, said",
    [
        ("[controls]\n[[controls.axes]]\nlabel = \"X\"\n", "[controls.axes] axis is missing"),
        ("[controls]\n[[controls.axes]]\naxis = \"x\"\n", "[controls.axes] axis must be one of r, a, z, h"),
        ("[controls]\n[[controls.axes]]\naxis = \"h\"\n", "[controls.axes] axis h is the focus axis, which [focus] fitted = false leaves out"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\n[[controls.axes]]\naxis = \"r\"\n", "[controls.axes] axis r is listed twice"),
        ("[controls]\n[[controls.axes]]\naxis = \"a\"\nstep = 5\n", "[controls.axes] step must be one of the steps: 1, 10, 90"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nsteps = [0, 1]\n", "[controls.axes] steps must be a list of 1 to 8 different numbers above 0"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nsteps = [1, 1]\n", "[controls.axes] steps must be a list of 1 to 8 different numbers"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nbuttons = [\"a\", \"b\", \"c\"]\n", "[controls.axes] buttons must be a list of 2 words"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nkeys = [\"a\"]\n", "[controls.axes] keys must be a list of 2 words or an empty list"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nkeys = [\"a\", \"a\"]\n", "[controls.axes] keys must name two different keys"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nkeys = [\"Escape\", \"a\"]\n", "[controls.axes] keys Escape is the cancel key"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nkeys = [\"ArrowUp\", \"a\"]\n", "[controls.axes] keys ArrowUp is the pad's while pad = true"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nletter = \"\"\n", "[controls.axes] letter must be 1 to 3 characters"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nlabel = \" \"\n", "[controls.axes] label must not be empty"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nnote = 5\n", "[controls.axes] note must be a string"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\ngoto = 1\n", "[controls.axes] goto must be true or false"),
        ("[controls]\n[[controls.axes]]\naxis = \"r\"\nspeed = 5\n", "[controls.axes] speed is not a key here"),
        ("[controls]\naxes = 5\n", "[controls] axes must be an array of tables"),
        ("[controls]\ncenter = 5\n", "[controls] center must be a table of joints"),
        ("[controls]\ncenter = { h = 0 }\n", "[controls] center names h, which the axes leave out"),
        ("[controls]\ncenter = { x = 0 }\n", "[controls] center names x, which is not one of r, a, z, h"),
        ("[controls]\ncenter = { r = \"here\" }\n", "[controls] center r must be a number"),
        ("[controls]\npad_step = 5\n", "[controls] pad_step must be one of the steps: 0.1, 1, 10"),
        ("[controls]\npad_steps = []\n", "[controls] pad_steps must be a list of 1 to 8"),
        ("[controls]\npad = 1\n", "[controls] pad must be true or false"),
        ("[controls]\nknob = 1\n", "[controls] knob is not a key here"),
        ("controls = 5\n", "controls must be a table"),
    ],
)
def test_control_mistakes_are_named(text, said):
    with pytest.raises(MachineError) as caught:
        parse(text, "rig", "rig")
    assert said in str(caught.value), str(caught.value)


def test_a_tool_output_pin_matters_only_when_it_is_fitted():
    # Left out of use, the output's pin may be anything, the laser's included.
    found = parse('[output]\npin = 17\n', "rig")
    assert (found.settings["laser_pin"], found.settings["tool_pin"], found.settings["tool_out"]) == (17, 17, 0)
    moved = parse('[output]\npin = 17\n[enable]\nfitted = true\npin = 23\ninvert = true\n', "rig")
    assert (moved.settings["tool_out"], moved.settings["tool_pin"], moved.settings["tool_invert"]) == (1, 23, 1)
    assert machines.check_id("my-mill_2") == "my-mill_2"
    for bad in ("My Mill", "", "a/b", "-x", "x" * 65):
        with pytest.raises(MachineError):
            machines.check_id(bad)


def test_an_older_file_may_still_say_where_a_control_went():
    found = parse('[controls]\n[[controls.axes]]\naxis = "r"\nplace = "frame"\n', "rig")
    assert "place" not in found.controls["axes"][0]
    assert all("place" not in axis for axis in default_controls("polar", "laser", True)["axes"])
