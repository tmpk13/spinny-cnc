"""Machine files: the TOML schema onto the firmware's settings."""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from spinny_laser import machine, machines
from spinny_laser.machines import FIRMWARE_DEFAULTS, MachineError, cli_defaults, current, load, load_all, matches, parse

REPO = Path(__file__).resolve().parents[2]
SHIPPED = REPO / "machines"


def test_the_defaults_cover_every_setting_once():
    assert len(FIRMWARE_DEFAULTS) == 46
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
    assert mill.document()["settings"]["z_max"] == 30.0


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

[output]
pwm_hz = 1000
s_max = 255
s_min = 10
invert = true
test_ms = 7000

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
