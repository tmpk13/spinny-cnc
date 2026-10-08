"""The page's controls, as a machine file describes them.

`[controls]` in a machine file says what the page draws for jogging and
reading the position: a board X/Y pad, a feed field, a Center button, and
one control per joint shown, with its letter and label, its step choices,
its button labels, whether the feed applies to it, a goto field, a zero
button with its hint, two keys, and a note. What a file leaves out comes
from the defaults for its kinematics, tool and focus axis, so a file that
says nothing gets the controls the page always drew for that machine.

    [controls]
    pad = true                  # a board X/Y pad, on the arrow keys
    pad_steps = [0.1, 1, 10]    # mm; an axis without steps of its own uses the pad's
    pad_step = 1
    feed = true                 # a feed field for the pad and the axes that take it
    center = { r = 0 }          # where Center sends the joints; left out: no button
    [[controls.axes]]           # one per joint shown, in this order
    axis = "r"                  # r, a, z or h (h needs [focus] fitted)
    letter = "R"                # in the readout and in "Set R=0 here"
    label = "Radius"
    steps = [0.1, 1, 10]        # left out: the pad's step; a is in degrees, the rest in mm
    step = 1                    # left out: the middle one
    buttons = ["Radius -", "Radius +"]
    place = "buttons"           # buttons: beside the pad; frame: its own block
    feed = true
    goto = true
    zero = true
    zero_hint = "..."
    keys = []                   # two key names for minus and plus
    note = ""                   # under the title of a framed control

The joint letters and their units are the firmware's: `a` is in degrees,
`r`, `z` and `h` in millimeters.
"""

from __future__ import annotations

import math

JOINTS = ("r", "a", "z", "h")
PAD_KEYS = ("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown")
CANCEL_KEY = "Escape"
MAX_STEPS = 8
STEP_MAX = 1.0e4
LETTER_MAX = 3


def default_controls(kinematics: str, tool: str, focus: bool) -> dict:
    """The controls for a machine that describes none: the polar laser's
    pad, radius and turn buttons and cross slide frame, with the slide as
    the Y axis when cartesian, and the focus axis as a frame of its own when
    one is fitted, called the depth axis with a spindle."""
    cartesian = kinematics == "cartesian"
    milling = tool == "spindle"
    axes = [
        _axis("r", "R", "Radius", None, ["Radius -", "Radius +"], feed=True, goto=True,
              zero_hint="The beam must be over the rotation axis."),
        # The table is left alone under a cartesian cut, so no goto field there.
        _axis("a", "A", "Table", [1, 10, 90], ["Turn -", "Turn +"], feed=True, goto=not cartesian,
              zero_hint=""),
    ]
    if cartesian:
        axes.append(_axis(
            "z", "Z", "Cross slide (Y)", None, ["Z-", "Z+"], feed=True, goto=True,
            zero_hint="Y is measured from here: over the rotation axis, board X/Y is where a polar job puts it.",
            note="Y axis: moves across the rail, which is X; steps and feed as the rail's",
        ))
    else:
        # The cross slide is set from a measured centering burn, so its steps
        # are the small corrections that reading calls for.
        axes.append(_axis(
            "z", "Z", "Cross slide", [0.05, 0.1, 0.5], ["Z-", "Z+"], feed=False, goto=False,
            zero_hint="The rail is over the axis when the centering lines meet at a point.",
            note="Setup only: carries the rail across the rotation axis",
        ))
    if focus:
        # Fine steps to find focus by eye, a coarse one to clear the board.
        if milling:
            axes.append(_axis(
                "h", "H", "Depth axis", [0.05, 0.1, 1], ["Down", "Up"], feed=False, goto=False,
                zero_hint="Touch the tool to the copper first: a milled cut without a height map goes down from H 0."
                " A height map probed before keeps its heights in the old numbers, so a run follows it"
                " only after Touch off here again (probe again for another board).",
                note="Raises and lowers the tool; up is positive, H 0 is the board's surface",
            ))
        else:
            axes.append(_axis(
                "h", "H", "Focus axis", [0.05, 0.1, 1], ["Down", "Up"], feed=False, goto=False,
                zero_hint="A height map probed before keeps its heights in the old numbers, so a run follows it"
                " only after Focus here again (probe again for another board).",
                note="Raises and lowers the head; up is positive",
            ))
    return {
        "pad": True,
        "pad_steps": [0.1, 1.0, 10.0],
        "pad_step": 1.0,
        "feed": True,
        # The rotation axis: R 0 on the polar machine, where the slide is
        # parked over it; on a cartesian machine the slide is Y, so Z 0 too.
        "center": {"r": 0.0, "z": 0.0} if cartesian else {"r": 0.0},
        "axes": axes,
    }


def _axis(axis: str, letter: str, label: str, steps: list | None, buttons: list, *,
          feed: bool, goto: bool, zero_hint: str, note: str = "") -> dict:
    return {
        "axis": axis,
        "letter": letter,
        "label": label,
        "steps": [float(step) for step in steps] if steps else None,
        "step": float(steps[len(steps) // 2]) if steps else None,
        "buttons": list(buttons),
        "feed": feed,
        "goto": goto,
        "zero": True,
        "zero_hint": zero_hint,
        "keys": [],
        "note": note,
    }


def parse_controls(reader, top: dict, kinematics: str, tool: str, focus: bool) -> dict:
    """The `[controls]` table of a parsed machine file, every key checked and
    the ones left out filled from the defaults for the machine. `reader`
    is the machine file's typed reader: its `table`, `flag` and `done` are
    used, and `fail` names the file and the key in every error."""
    defaults = default_controls(kinematics, tool, focus)
    table = reader.table(top, "controls")
    section = "controls"
    pad = reader.flag(table, "pad", defaults["pad"], section)
    pad_steps = _steps(reader, table, "pad_steps", section) if "pad_steps" in table else list(defaults["pad_steps"])
    if "pad_step" in table:
        pad_step = _step_in(reader, table, "pad_step", section, pad_steps)
    else:
        pad_step = defaults["pad_step"] if defaults["pad_step"] in pad_steps else pad_steps[len(pad_steps) // 2]
    controls = {
        "pad": pad,
        "pad_steps": pad_steps,
        "pad_step": pad_step,
        "feed": reader.flag(table, "feed", defaults["feed"], section),
    }

    by_joint = {axis["axis"]: axis for axis in defaults["axes"]}
    if "axes" in table:
        entries = table["axes"]
        if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
            raise reader.fail(section, "axes", "must be an array of tables, one [[controls.axes]] per joint")
        axes = [_axis_control(reader, dict(entry), by_joint, focus, pad, pad_steps) for entry in entries]
        seen: set[str] = set()
        for axis in axes:
            if axis["axis"] in seen:
                raise reader.fail("controls.axes", "axis", f"{axis['axis']} is listed twice")
            seen.add(axis["axis"])
    else:
        axes = [dict(axis) for axis in defaults["axes"]]
    controls["axes"] = axes
    listed = [axis["axis"] for axis in axes]

    if "center" in table:
        center = table["center"]
        if not isinstance(center, dict):
            raise reader.fail(section, "center", "must be a table of joints, like { r = 0 }")
        for joint, value in center.items():
            if joint not in JOINTS:
                raise reader.fail(section, "center", f"names {joint}, which is not one of r, a, z, h")
            if joint not in listed:
                raise reader.fail(section, "center", f"names {joint}, which the axes leave out")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise reader.fail(section, "center", f"{joint} must be a number")
        controls["center"] = {joint: float(value) for joint, value in center.items()} if center else None
    else:
        kept = {joint: value for joint, value in defaults["center"].items() if joint in listed}
        controls["center"] = kept or None
    reader.done(table, section, {"pad", "pad_steps", "pad_step", "feed", "center", "axes"})
    return controls


def _axis_control(reader, entry: dict, by_joint: dict, focus: bool, pad: bool, pad_steps: list) -> dict:
    section = "controls.axes"
    if "axis" not in entry:
        raise reader.fail(section, "axis", "is missing: each entry names its joint, one of r, a, z, h")
    axis = _text(reader, entry, "axis", section, "")
    if axis not in JOINTS:
        raise reader.fail(section, "axis", f"must be one of {', '.join(JOINTS)}")
    if axis == "h" and not focus:
        raise reader.fail(section, "axis", "h is the focus axis, which [focus] fitted = false leaves out")
    base = by_joint[axis]
    letter = _text(reader, entry, "letter", section, base["letter"])
    if not (1 <= len(letter) <= LETTER_MAX) or letter.strip() != letter:
        raise reader.fail(section, "letter", f"must be 1 to {LETTER_MAX} characters")
    label = _text(reader, entry, "label", section, base["label"])
    if not label.strip():
        raise reader.fail(section, "label", "must not be empty")

    if "steps" in entry:
        steps = _steps(reader, entry, "steps", section, empty_ok=True) or None
    else:
        steps = list(base["steps"]) if base["steps"] else None
    choices = steps if steps is not None else pad_steps
    if "step" in entry:
        step = _step_in(reader, entry, "step", section, choices)
    elif steps is None:
        step = None
    elif "steps" not in entry and base["step"] in steps:
        step = base["step"]
    else:
        step = steps[len(steps) // 2]

    if "buttons" in entry:
        buttons = _texts(reader, entry, "buttons", section, 2)
    elif "letter" in entry or "label" in entry:
        # Renamed: the default's words would name the old axis.
        buttons = [f"{letter}-", f"{letter}+"]
    else:
        buttons = list(base["buttons"])
    keys = _texts(reader, entry, "keys", section, 2, empty_ok=True) if "keys" in entry else list(base["keys"])
    if keys:
        if keys[0] == keys[1]:
            raise reader.fail(section, "keys", "must name two different keys")
        for key in keys:
            if key == CANCEL_KEY:
                raise reader.fail(section, "keys", f"{CANCEL_KEY} is the cancel key")
            if pad and key in PAD_KEYS:
                raise reader.fail(section, "keys", f"{key} is the pad's while pad = true")
    control = {
        "axis": axis,
        "letter": letter,
        "label": label,
        "steps": steps,
        "step": step,
        "buttons": buttons,
        "feed": reader.flag(entry, "feed", base["feed"], section),
        "goto": reader.flag(entry, "goto", base["goto"], section),
        "zero": reader.flag(entry, "zero", base["zero"], section),
        "zero_hint": _text(reader, entry, "zero_hint", section, base["zero_hint"]),
        "keys": keys,
        "note": _text(reader, entry, "note", section, base["note"]),
    }
    # Every control is a bar of its own now; `place`, which said whether an
    # older page drew it beside the pad or in a frame, is still taken.
    reader.done(entry, section, {"axis", "letter", "label", "steps", "step", "buttons", "place", "feed", "goto", "zero", "zero_hint", "keys", "note"})
    return control


def _text(reader, table: dict, key: str, section: str, default: str) -> str:
    value = table.get(key, default)
    if not isinstance(value, str):
        raise reader.fail(section, key, "must be a string")
    return value


def _texts(reader, table: dict, key: str, section: str, count: int, empty_ok: bool = False) -> list[str]:
    value = table[key]
    ok = isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)
    if not ok or not (len(value) == count or (empty_ok and len(value) == 0)):
        what = f"must be a list of {count} words" + (" or an empty list" if empty_ok else "")
        raise reader.fail(section, key, what)
    return list(value)


def _steps(reader, table: dict, key: str, section: str, empty_ok: bool = False) -> list[float]:
    value = table[key]
    ok = isinstance(value, list) and all(
        not isinstance(item, bool) and isinstance(item, (int, float)) and math.isfinite(item) and 0 < item <= STEP_MAX
        for item in value
    )
    steps = [float(item) for item in value] if ok else []
    if not ok or len(steps) > MAX_STEPS or len(set(steps)) != len(steps) or (not steps and not empty_ok):
        raise reader.fail(section, key, f"must be a list of 1 to {MAX_STEPS} different numbers above 0 and at most {STEP_MAX:g}")
    return steps


def _step_in(reader, table: dict, key: str, section: str, choices: list[float]) -> float:
    value = table[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise reader.fail(section, key, "must be a number")
    if float(value) not in choices:
        raise reader.fail(section, key, f"must be one of the steps: {', '.join(f'{choice:g}' for choice in choices)}")
    return float(value)
