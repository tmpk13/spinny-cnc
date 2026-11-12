"""Placing a board's parts with a G-code machine: one whose own controller
takes the G-code OpenPnP's GcodeDriver sends (Marlin, Smoothieware,
RepRapFirmware, Grbl), a line at a time, each answered `ok`.

Its machine file (`machines/*.toml` with `controller = "gcode"`) says how
to talk to it: its port and the words that find the port, the words of its
dialect (the move word and axis letters, the vacuum's on and off, the wait
for the moves queued, a dwell, home, stop and the motors), the heights it
works at, its cameras and its feeders. `spinny_laser.machines` reads the
file's name, controls and kind and keeps these tables; `machine_of` reads
them. Where the board lies on the machine is fitted from reference parts
whose places were read off it (one gives a shift, with a typed turn; two
or more a turn and a shift).

A placement program picks each part from the first feeder whose words
its value and footprint all hold, at the feeder's next place (along a
strip, or row by row in a tray), and puts it on its place on the
machine, turned from the feeder's angle to its own. `ok` after a move
means queued, so the wait command goes out before every vacuum switch,
which must happen with the head at rest. With a vacuum sensor the
reading after each pick says whether a part came along, and after each
place whether it let go. A part from a feeder marked for the up camera
is looked at over it between its pick and its place, turned to the angle
it is placed at, and placed where its center lands, its angle corrected.
A nozzle whose tip runs out of true as it turns is placed where its tip
is at that angle.

Every place on the machine is a place of the nozzle's tip turned to 0:
the head's X and Y with the tip over that point. The program here is the
plan as it stands before the run; the run (`placer.py`) changes it where
a camera or the vacuum sensor says otherwise.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from spinny_laser import machines as machine_files
from spinny_laser.align import Fit, fit_rigid, turn
from spinny_laser.machines import GCODE, Machine, MachineError, is_id

from .feederbus import HEADER_FIELDS, BusProfile, check_id as check_bus_id, slot_place
from .kinematics import num

AXIS = re.compile(r"^[A-Z]$")
# A G-code line as a machine file may give it: printable, one line.
LINE = re.compile(r"^[\x20-\x7e]*$")
BAUDS = (1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000)
COORD_LIMIT = 10000.0
FEED_LIMIT = 100000.0
SHADES = ("dark", "bright")
# Marlin's answer to M105 carries a sensor read through a thermistor
# input as `T:12.34`.
DEFAULT_VACUUM_PATTERN = r"T:\s*(-?[0-9]+(?:\.[0-9]+)?)"
# OpenPnP's regular expressions name their group the Java way, (?<Value>...).
JAVA_GROUP = re.compile(r"\(\?<(?![=!])")


class PlanError(ValueError):
    """A plan that cannot be made: a board with no reference, a feeder whose place is not known."""


@dataclass(frozen=True)
class Feeder:
    id: str
    # Words a part's value and footprint must all hold, any case.
    match: str
    # The first part's place, X Y Z, and the step from one part to the next:
    # along a strip, or with `columns` from column to column of a tray,
    # `row_pitch` from row to row. None for a feeder on the bus whose slot
    # is found when a run starts.
    at: tuple[float, float, float] | None
    pitch: tuple[float, float] = (0.0, 0.0)
    # Parts in it; 0 for one that presents every part at `at`.
    count: int = 0
    columns: int = 0
    row_pitch: tuple[float, float] = (0.0, 0.0)
    # The parts' angle as they sit in it, degrees.
    rotation: float = 0.0
    place_z: float | None = None
    # Lines sent before each pick, for a feeder that is told to advance.
    feed: tuple[str, ...] = ()
    # Each part is looked at over the up camera before it is placed.
    vision: bool = False
    # The part's length and width as the cameras see it, mm; None takes
    # its footprint's body from the board file.
    size: tuple[float, float] | None = None
    # The shade of a part in its pocket to the top camera, which then
    # looks at each pocket before its pick; None picks at the place.
    pocket: str | None = None
    # Marks on the feeder (a hole, a dot) where the file puts them,
    # found with the top camera before the first pick from it in a run:
    # its places follow them, shifted by one and turned as well by two.
    marks: tuple[tuple[float, float], ...] = ()
    mark: str = "dark"
    # How far from the up camera's center its parts are looked for, mm;
    # None takes the machine's [up_camera] crop.
    crop: float | None = None
    # The parts it holds by their references, which outdo the words: an
    # OpenPnP job names each placement's part, so its import knows them.
    refs: tuple[str, ...] = ()
    # A feeder on the machine's bus: its id there, its address (its slot;
    # None until found by its id), its pick place from the slot's place,
    # and how far its tape moves on per part, mm.
    bus_id: str | None = None
    slot: int | None = None
    offset: tuple[float, float, float] = (0.0, 0.0, 0.0)
    advance: float = 4.0

    def holds(self, value: str, footprint: str, ref: str = "") -> bool:
        if self.refs:
            return ref in self.refs
        hay = f"{value} {footprint}".lower()
        return all(word in hay for word in self.match.lower().split())

    def place_of(self, index: int) -> tuple[float, float, float]:
        if self.at is None:
            raise PlanError(f"feeder {self.id}'s place is not known: its slot is found on the feeder bus when a run starts")
        if self.columns > 0:
            column, row = index % self.columns, index // self.columns
            return (
                self.at[0] + column * self.pitch[0] + row * self.row_pitch[0],
                self.at[1] + column * self.pitch[1] + row * self.row_pitch[1],
                self.at[2],
            )
        return (self.at[0] + index * self.pitch[0], self.at[1] + index * self.pitch[1], self.at[2])


@dataclass(frozen=True)
class Slot:
    """Where the feeder at a bus address presents its part: the head's
    place with the nozzle over the slot's point, and the slot's angle."""

    address: int
    at: tuple[float, float, float]
    rotation: float = 0.0


@dataclass(frozen=True)
class Vacuum:
    """The vacuum sensor: the lines that read it (the reading is in the
    last one's answer), the pattern whose group is the reading, and the
    readings with a part held and with the nozzle empty; a sensor with
    neither is only read by hand, for finding them."""

    read: tuple[str, ...]
    pattern: str
    part_on: tuple[float, float] | None = None
    part_off: tuple[float, float] | None = None

    def reading(self, reply: list[str]) -> float | None:
        """The reading in an answer to the read line, or None."""
        regex = re.compile(self.pattern)
        for line in reply:
            found = regex.search(line)
            if found is None:
                continue
            named = found.groupdict()
            text = next((value for key, value in named.items() if key.lower() == "value"), None) if named else None
            if text is None:
                text = found.group(1)
            try:
                value = float(text)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                return value
        return None


@dataclass(frozen=True)
class TopCameraProfile:
    """The camera on the machine's head looking down: the height the head
    stands at for it to see the board sharp (None keeps the safe height),
    where its picture's center is from the nozzle's tip as the head's
    design has it (a first guess; the measured one wins), the shade of a
    fiducial, and how far from where it is expected a fiducial, mark or
    part in a pocket is looked for, mm. `home_fiducial` is a fiducial
    fixed on the machine's bed (OpenPnP's head homing fiducial), as the
    nozzle's place over it: Home by fiducial looks for it with this camera
    and declares where the head is from where it is seen."""

    z: float | None = None
    offset: tuple[float, float] | None = None
    fiducial: str = "bright"
    within: float = 2.0
    home_fiducial: tuple[float, float] | None = None


@dataclass(frozen=True)
class GcodeMachine:
    """A G-code machine's file, read and checked: its own tables, with the
    name, description and controls `spinny_laser.machines` read."""

    id: str
    name: str
    description: str
    url: str
    baud: int
    # How long a board that resets when its port opens is given before the
    # first line, ms, and how long a line may take to be answered, s.
    wait_ms: int
    timeout: float
    init: tuple[str, ...]
    end: tuple[str, ...]
    move: str
    axes: tuple[str, str, str, str]
    wait: str
    # The vacuum on (a pump and a valve may take a line each) and off.
    pick: tuple[str, ...]
    place: tuple[str, ...]
    dwell: str
    home: str
    position: str
    stop: str
    feed_xy: float
    feed_z: float
    safe_z: float
    place_z: float
    pick_dwell_ms: int
    place_dwell_ms: int
    feeders: tuple[Feeder, ...] = field(default_factory=tuple)
    # The height the nozzle tip is seen sharp at over the up camera, when
    # the camera sits on this machine; None keeps the safe height.
    camera_z: float | None = None
    # A positive turn of the rotation axis turns the nozzle clockwise seen
    # from above, so every angle goes out with its sign changed.
    rotation_cw: bool = False
    # Where a part that failed a check is let go, X Y Z; None puts it back
    # in the pocket it came from.
    discard: tuple[float, float, float] | None = None
    # Pockets tried for one part (an empty one, a pick the vacuum or the up
    # camera found wanting) before the part is left out.
    pick_tries: int = 3
    vacuum: Vacuum | None = None
    # What the up camera lets by: a part's center this far from the
    # nozzle's, mm, its angle this far from the one expected, degrees, and
    # its length and width this fraction off the ones expected (0 checks
    # no size).
    max_offset: float = 1.0
    max_turn: float = 15.0
    size_tolerance: float = 0.3
    top: TopCameraProfile | None = None
    # The lights the cameras need, on and off; the cameras' routines turn
    # them on first.
    light_on: tuple[str, ...] = ()
    light_off: tuple[str, ...] = ()
    # Where the up camera is on this machine as designed: the head's place
    # with the nozzle over its picture's center, a first guess that
    # centering the nozzle replaces.
    camera_position: tuple[float, float] | None = None
    # A jog that takes the nozzle from over the up camera (within this
    # many mm of its place) to farther than that, with the nozzle off the
    # safe height, goes up to the safe height first; None never lifts a
    # jog. Small jogs over the lens, to center the nozzle by hand, stay
    # at the height they are at.
    leave: float | None = None
    # Where the head waits out of the way, at the safe height.
    park: tuple[float, float] | None = None
    # How far from the up camera's picture center a part is looked for, mm;
    # None looks as far as pcbv does by default (a third of the height).
    crop: float | None = None
    # The bus smart feeders are on, and where each address's feeder sits.
    bus: BusProfile | None = None
    slots: tuple[Slot, ...] = ()
    # Words a port's USB names hold (product, maker, description, any case)
    # that make it this machine's port.
    match: tuple[str, ...] = ()
    # The motors switched on and off by the jog panel; empty for no button.
    motors_on: str = ""
    motors_off: str = ""
    # The page's controls, as spinny_laser.controls lays them out.
    controls: dict = field(default_factory=dict)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "url": self.url,
            "match": list(self.match),
            "feeders": len(self.feeders),
        }

    def claims(self, url: str, names: str = "") -> bool:
        """The port at `url` is this machine's: its url is the file's, or the
        port's USB names (`names`) hold one of the file's words."""
        if self.url and url == self.url:
            return True
        hay = names.lower()
        return bool(hay) and any(word.lower() in hay for word in self.match)

    def angle_word(self, degrees: float) -> str:
        """An angle of the nozzle, counterclockwise from above, as the
        rotation axis's value: the sign changed for an axis that turns
        clockwise."""
        return f"{self.axes[3]}{num(-degrees if self.rotation_cw else degrees)}"

    def document(self) -> dict:
        vacuum = self.vacuum
        top = self.top
        return {
            **self.summary(),
            "baud": self.baud,
            "wait_ms": self.wait_ms,
            "timeout": self.timeout,
            "axes": list(self.axes),
            "rotation_cw": self.rotation_cw,
            "feed_xy": self.feed_xy,
            "feed_z": self.feed_z,
            "safe_z": self.safe_z,
            "place_z": self.place_z,
            "pick_dwell_ms": self.pick_dwell_ms,
            "place_dwell_ms": self.place_dwell_ms,
            "park": list(self.park) if self.park is not None else None,
            "camera_position": list(self.camera_position) if self.camera_position is not None else None,
            "light": bool(self.light_on),
            "discard": list(self.discard) if self.discard is not None else None,
            "pick_tries": self.pick_tries,
            "camera_z": self.camera_z,
            "leave": self.leave,
            "crop": self.crop,
            "bus": self.bus is not None,
            "slots": [{"address": slot.address, "at": list(slot.at), "rotation": slot.rotation} for slot in self.slots],
            "max_offset": self.max_offset,
            "max_turn": self.max_turn,
            "size_tolerance": self.size_tolerance,
            "vacuum": (
                {
                    "read": list(vacuum.read),
                    "pattern": vacuum.pattern,
                    "part_on": list(vacuum.part_on) if vacuum.part_on is not None else None,
                    "part_off": list(vacuum.part_off) if vacuum.part_off is not None else None,
                }
                if vacuum is not None
                else None
            ),
            "top": (
                {
                    "z": top.z,
                    "offset": list(top.offset) if top.offset is not None else None,
                    "fiducial": top.fiducial,
                    "within": top.within,
                    "home_fiducial": list(top.home_fiducial) if top.home_fiducial is not None else None,
                }
                if top is not None
                else None
            ),
            "feeders": [
                {
                    "id": f.id,
                    "match": f.match,
                    "at": list(f.at) if f.at is not None else None,
                    "pitch": list(f.pitch),
                    "count": f.count,
                    "columns": f.columns,
                    "rotation": f.rotation,
                    "vision": f.vision,
                    "size": list(f.size) if f.size is not None else None,
                    "pocket": f.pocket,
                    "marks": [list(mark) for mark in f.marks],
                    "mark": f.mark,
                    "crop": f.crop,
                    "refs": list(f.refs),
                    "bus_id": f.bus_id,
                    "slot": f.slot,
                    "advance": f.advance,
                }
                for f in self.feeders
            ],
        }


class _Reader:
    """Typed reads out of the parsed tables, each error naming the file and the key."""

    def __init__(self, where: str) -> None:
        self.where = where

    def fail(self, section: str | None, key: str, what: str) -> MachineError:
        place = f"[{section}] {key}" if section else key
        return MachineError(f"{self.where}: {place} {what}")

    def table(self, top: dict, name: str) -> dict:
        value = top.get(name, {})
        if not isinstance(value, dict):
            raise self.fail(None, name, "must be a table")
        return value

    def text(self, table: dict, key: str, section: str | None, default: str, line: bool = True) -> str:
        value = table.get(key, default)
        if not isinstance(value, str):
            raise self.fail(section, key, "must be a string")
        if line and not LINE.match(value):
            raise self.fail(section, key, "must be one line of printable ASCII")
        return value.strip()

    def lines(self, table: dict, key: str, section: str, default: tuple[str, ...], one: bool = False) -> tuple[str, ...]:
        value = table.get(key, list(default))
        if one and isinstance(value, str):
            value = [value]
        if not isinstance(value, list) or not all(isinstance(item, str) and LINE.match(item) for item in value):
            raise self.fail(section, key, f"must be {'a line, or ' if one else ''}a list of lines of printable ASCII")
        return tuple(item.strip() for item in value if item.strip())

    def number(self, table: dict, key: str, section: str, default: float | None, low: float = -COORD_LIMIT, high: float = COORD_LIMIT) -> float:
        if key not in table:
            if default is None:
                raise self.fail(section, key, "is needed")
            return default
        value = table[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not (low <= value <= high):
            raise self.fail(section, key, f"must be a number from {low:g} to {high:g}")
        return float(value)

    def integer(self, table: dict, key: str, section: str, default: int, low: int, high: int) -> int:
        value = table.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not (low <= value <= high):
            raise self.fail(section, key, f"must be a whole number from {low} to {high}")
        return value

    def point(self, table: dict, key: str, section: str, size: int, default: tuple | None) -> tuple:
        if key not in table:
            if default is None:
                raise self.fail(section, key, "is needed")
            return default
        value = table[key]
        if (
            not isinstance(value, list)
            or len(value) != size
            or not all(not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and abs(v) <= COORD_LIMIT for v in value)
        ):
            raise self.fail(section, key, f"must be {size} numbers within {COORD_LIMIT:g}")
        return tuple(float(v) for v in value)

    def flag(self, table: dict, key: str, section: str, default: bool) -> bool:
        value = table.get(key, default)
        if not isinstance(value, bool):
            raise self.fail(section, key, "must be true or false")
        return value

    def shade(self, table: dict, key: str, section: str, default: str) -> str:
        value = table.get(key, default)
        if value not in SHADES:
            raise self.fail(section, key, "must be dark or bright")
        return value

    def optional_shade(self, table: dict, key: str, section: str) -> str | None:
        return self.shade(table, key, section, "dark") if key in table else None

    def span(self, table: dict, key: str, section: str) -> tuple[float, float] | None:
        """Two numbers, the low one first, or None when left out."""
        if key not in table:
            return None
        low, high = self.point(table, key, section, 2, None)
        if low > high:
            raise self.fail(section, key, "must be the low reading, then the high one")
        return (low, high)

    def places(self, table: dict, key: str, section: str, most: int) -> tuple[tuple[float, float], ...]:
        value = table.get(key, [])
        if (
            not isinstance(value, list)
            or len(value) > most
            or not all(
                isinstance(item, list)
                and len(item) == 2
                and all(not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and abs(v) <= COORD_LIMIT for v in item)
                for item in value
            )
        ):
            raise self.fail(section, key, f"must be a list of at most {most} places, each [X, Y]")
        return tuple((float(item[0]), float(item[1])) for item in value)

    def done(self, table: dict, section: str | None, known: set[str]) -> None:
        unknown = sorted(set(table) - known)
        if unknown:
            raise self.fail(section, unknown[0], "is not a key here")


def parse(text: str, machine_id: str, where: str | None = None) -> GcodeMachine:
    """A G-code machine file from its TOML text; MachineError naming the key for anything amiss."""
    where = where or f"{machine_id}.toml"
    return machine_of(machine_files.parse(text, machine_id, where), where)


def machine_of(machine: Machine, where: str | None = None) -> GcodeMachine:
    """A G-code machine's own tables read off its machine file as
    `spinny_laser.machines` read it; MachineError for a file of this
    project's firmware, or a key amiss."""
    where = where or f"{machine.id}.toml"
    if machine.controller != GCODE:
        raise MachineError(f'{where}: is not a G-code machine: its controller is {machine.controller}, not "gcode"')
    top = machine.gcode
    read = _Reader(where)
    name = machine.name
    description = machine.description
    port = read.table(top, "port")
    url = read.text(port, "url", "port", "")
    port_words = read.lines(port, "match", "port", (), one=True)
    baud = read.integer(port, "baud", "port", 115200, 1200, 2000000)
    if baud not in BAUDS:
        raise read.fail("port", "baud", f"must be one of {', '.join(str(b) for b in BAUDS)}")
    wait_ms = read.integer(port, "wait_ms", "port", 2000, 0, 30000)
    timeout = read.number(port, "timeout", "port", 60.0, 1.0, 600.0)
    read.done(port, "port", {"url", "match", "baud", "wait_ms", "timeout"})

    gcode = read.table(top, "gcode")
    init = read.lines(gcode, "init", "gcode", ("G21", "G90"))
    end = read.lines(gcode, "end", "gcode", ())
    move = read.text(gcode, "move", "gcode", "G0")
    if not move:
        raise read.fail("gcode", "move", "must name the move word")
    axes = (
        read.text(gcode, "x", "gcode", "X"),
        read.text(gcode, "y", "gcode", "Y"),
        read.text(gcode, "z", "gcode", "Z"),
        read.text(gcode, "rotation", "gcode", "A"),
    )
    for key, letter in zip(("x", "y", "z", "rotation"), axes):
        if not AXIS.match(letter) or letter == "F":
            raise read.fail("gcode", key, "must be one capital letter, not F")
    if len(set(axes)) != 4:
        raise read.fail("gcode", "rotation", "the four axis letters must differ")
    wait = read.text(gcode, "wait", "gcode", "M400")
    pick = read.lines(gcode, "pick", "gcode", ("M106",), one=True)
    place = read.lines(gcode, "place", "gcode", ("M107",), one=True)
    if not pick or not place:
        raise read.fail("gcode", "pick" if not pick else "place", "must name the vacuum's command")
    light_on = read.lines(gcode, "light_on", "gcode", (), one=True)
    light_off = read.lines(gcode, "light_off", "gcode", (), one=True)
    dwell = read.text(gcode, "dwell", "gcode", "G4 P{ms}")
    if dwell and "{ms}" not in dwell and "{s}" not in dwell:
        raise read.fail("gcode", "dwell", "must hold {ms} or {s} for the time, or be empty for none")
    home = read.text(gcode, "home", "gcode", "G28")
    position = read.text(gcode, "position", "gcode", "M114")
    stop = read.text(gcode, "stop", "gcode", "M410")
    motors_on = read.text(gcode, "motors_on", "gcode", "M17")
    motors_off = read.text(gcode, "motors_off", "gcode", "M18")
    rotation_cw = read.flag(gcode, "rotation_cw", "gcode", False)
    read.done(
        gcode,
        "gcode",
        {
            "init", "end", "move", "x", "y", "z", "rotation", "rotation_cw", "wait", "pick", "place", "dwell", "home", "position", "stop",
            "motors_on", "motors_off", "light_on", "light_off",
        },
    )

    motion = read.table(top, "motion")
    feed_xy = read.number(motion, "feed_xy", "motion", 6000.0, 1.0, FEED_LIMIT)
    feed_z = read.number(motion, "feed_z", "motion", 1200.0, 1.0, FEED_LIMIT)
    safe_z = read.number(motion, "safe_z", "motion", None)
    place_z = read.number(motion, "place_z", "motion", None)
    pick_dwell_ms = read.integer(motion, "pick_dwell_ms", "motion", 200, 0, 60000)
    place_dwell_ms = read.integer(motion, "place_dwell_ms", "motion", 150, 0, 60000)
    discard = read.point(motion, "discard", "motion", 3, None) if "discard" in motion else None
    pick_tries = read.integer(motion, "pick_tries", "motion", 3, 1, 20)
    park = read.point(motion, "park", "motion", 2, None) if "park" in motion else None
    read.done(motion, "motion", {"feed_xy", "feed_z", "safe_z", "place_z", "pick_dwell_ms", "place_dwell_ms", "discard", "pick_tries", "park"})

    vacuum = None
    sensor = read.table(top, "vacuum")
    if sensor:
        read_lines = read.lines(sensor, "read", "vacuum", (), one=True)
        if not read_lines:
            raise read.fail("vacuum", "read", "must name the line, or lines, that read the vacuum sensor")
        pattern = read.text(sensor, "pattern", "vacuum", DEFAULT_VACUUM_PATTERN, line=False)
        pattern = JAVA_GROUP.sub("(?P<", pattern)
        try:
            groups = re.compile(pattern).groups
        except re.error as exc:
            raise read.fail("vacuum", "pattern", f"is not a regular expression: {exc}") from None
        if groups < 1:
            raise read.fail("vacuum", "pattern", "must hold a group, ( ), around the reading")
        vacuum = Vacuum(
            read=read_lines, pattern=pattern, part_on=read.span(sensor, "part_on", "vacuum"), part_off=read.span(sensor, "part_off", "vacuum")
        )
        read.done(sensor, "vacuum", {"read", "pattern", "part_on", "part_off"})

    top_camera = None
    looking = read.table(top, "top_camera")
    if looking:
        top_camera = TopCameraProfile(
            z=read.number(looking, "z", "top_camera", None) if "z" in looking else None,
            offset=read.point(looking, "offset", "top_camera", 2, None) if "offset" in looking else None,
            fiducial=read.shade(looking, "fiducial", "top_camera", "bright"),
            within=read.number(looking, "within", "top_camera", 2.0, 0.1, 50.0),
            home_fiducial=read.point(looking, "home_fiducial", "top_camera", 2, None) if "home_fiducial" in looking else None,
        )
        read.done(looking, "top_camera", {"z", "offset", "fiducial", "within", "home_fiducial"})

    bus = None
    wire = read.table(top, "bus")
    if wire:
        defaults = BusProfile()
        header = read.lines(wire, "header", "bus", HEADER_FIELDS)
        if not header or len(set(header)) != len(header) or any(name not in HEADER_FIELDS for name in header):
            raise read.fail("bus", "header", f"must name each of its bytes once, from {', '.join(HEADER_FIELDS)}")
        send = read.text(wire, "send", "bus", defaults.send)
        if "{packet}" not in send:
            raise read.fail("bus", "send", "must hold {packet}, where the packet's hex goes")
        reply = JAVA_GROUP.sub("(?P<", read.text(wire, "reply", "bus", defaults.reply, line=False))
        try:
            groups = re.compile(reply).groups
        except re.error as exc:
            raise read.fail("bus", "reply", f"is not a regular expression: {exc}") from None
        if groups < 1:
            raise read.fail("bus", "reply", "must hold a group, ( ), around the answer's hex")
        codes = {
            name: read.integer(wire, name, "bus", getattr(defaults, name), 0, 255)
            for name in ("get_id", "init", "feed", "status", "find", "ok", "wrong_id", "unreachable", "uninitialized", "busy")
        }
        bus = BusProfile(
            send=send,
            reply=reply,
            header=header,
            host=read.integer(wire, "host", "bus", defaults.host, 0, 255),
            broadcast=read.integer(wire, "broadcast", "bus", defaults.broadcast, 0, 255),
            tries=read.integer(wire, "tries", "bus", defaults.tries, 1, 10),
            max_address=read.integer(wire, "max_address", "bus", defaults.max_address, 1, 254),
            poll_ms=read.integer(wire, "poll_ms", "bus", defaults.poll_ms, 10, 5000),
            **codes,
        )
        read.done(wire, "bus", {"send", "reply", "header", "host", "broadcast", "tries", "max_address", "poll_ms", *codes})
    slot_tables = top.get("slot", [])
    if not isinstance(slot_tables, list) or not all(isinstance(item, dict) for item in slot_tables):
        raise read.fail(None, "slot", "must be an array of tables ([[slot]])")
    slots: list[Slot] = []
    for number, table in enumerate(slot_tables, start=1):
        section = f"slot {number}"
        if bus is None:
            raise read.fail(section, "address", "is a feeder bus's slot: add a [bus] table")
        address = read.integer(table, "address", section, 0, 1, 254)
        if any(other.address == address for other in slots):
            raise read.fail(section, "address", f"{address} is another slot's too")
        slots.append(Slot(address=address, at=read.point(table, "at", section, 3, None), rotation=read.number(table, "rotation", section, 0.0, -360.0, 360.0)))
        read.done(table, section, {"address", "at", "rotation"})

    tables = top.get("feeder", [])
    if not isinstance(tables, list) or not all(isinstance(item, dict) for item in tables):
        raise read.fail(None, "feeder", "must be an array of tables ([[feeder]])")
    feeders: list[Feeder] = []
    for number, table in enumerate(tables, start=1):
        section = f"feeder {number}"
        feeder_id = read.text(table, "id", section, "")
        if not is_id(feeder_id):
            raise read.fail(section, "id", "must be lower case letters, digits, - and _, starting with a letter or digit")
        if any(other.id == feeder_id for other in feeders):
            raise read.fail(section, "id", f"{feeder_id!r} is another feeder's too")
        match = read.text(table, "match", section, "")
        refs = read.lines(table, "refs", section, ())
        if not match and not refs:
            raise read.fail(section, "match", "must hold the words of a part's value or footprint (or give refs)")
        place_z_of = read.number(table, "place_z", section, None) if "place_z" in table else None
        count = read.integer(table, "count", section, 0, 0, 100000)
        columns = read.integer(table, "columns", section, 0, 0, 10000)
        if columns > 0 and count == 0:
            raise read.fail(section, "columns", "makes a tray, which needs its count of parts")
        if "row_pitch" in table and columns == 0:
            raise read.fail(section, "row_pitch", "is for a tray: give its columns too")
        size = None
        if "size" in table:
            size = read.point(table, "size", section, 2, None)
            if not all(0.0 < value <= 200.0 for value in size):
                raise read.fail(section, "size", "must be a length and a width over 0, at most 200 mm")
        pocket = read.optional_shade(table, "pocket", section)
        marks = read.places(table, "marks", section, 2)
        if (pocket is not None or marks) and top_camera is None:
            raise read.fail(section, "pocket" if pocket is not None else "marks", "looks with the top camera: add a [top_camera] table")
        rotation = read.number(table, "rotation", section, 0.0, -360.0, 360.0)
        bus_id = None
        slot = None
        offset = (0.0, 0.0, 0.0)
        advance = 4.0
        if "bus_id" in table:
            if bus is None:
                raise read.fail(section, "bus_id", "is a feeder on the bus: add a [bus] table")
            try:
                bus_id = check_bus_id(read.text(table, "bus_id", section, ""))
            except ValueError as exc:
                raise read.fail(section, "bus_id", f"must be the feeder's id: {exc}") from None
            if "at" in table or count or columns:
                raise read.fail(section, "at" if "at" in table else "count", "is not for a feeder on the bus: its slot gives its place, and it presents every part there")
            if "slot" in table:
                slot = read.integer(table, "slot", section, 0, 1, 254)
                if not any(entry.address == slot for entry in slots):
                    raise read.fail(section, "slot", f"{slot} has no [[slot]] with its place")
            offset = read.point(table, "offset", section, 3, (0.0, 0.0, 0.0))
            advance = read.number(table, "advance", section, 4.0, 0.1, 25.5)
        else:
            for key in ("slot", "offset", "advance"):
                if key in table:
                    raise read.fail(section, key, "is for a feeder on the bus: give its bus_id")
        if bus_id is not None:
            placed = next((entry for entry in slots if entry.address == slot), None)
            at = slot_place(placed.at, placed.rotation, offset) if placed is not None else None
            rotation = rotation + (placed.rotation if placed is not None else 0.0)
        else:
            at = read.point(table, "at", section, 3, None)
        feeders.append(
            Feeder(
                id=feeder_id,
                match=match,
                at=at,
                pitch=read.point(table, "pitch", section, 2, (0.0, 0.0)),
                count=count,
                columns=columns,
                row_pitch=read.point(table, "row_pitch", section, 2, (0.0, 0.0)),
                rotation=rotation,
                place_z=place_z_of,
                feed=read.lines(table, "feed", section, (), one=True),
                vision=read.flag(table, "vision", section, False),
                size=size,
                pocket=pocket,
                marks=marks,
                mark=read.shade(table, "mark", section, "dark"),
                crop=read.number(table, "crop", section, None, 0.1, 100.0) if "crop" in table else None,
                refs=refs,
                bus_id=bus_id,
                slot=slot,
                offset=offset,
                advance=advance,
            )
        )
        read.done(
            table,
            section,
            {
                "id", "match", "refs", "at", "pitch", "count", "columns", "row_pitch", "rotation", "place_z", "feed", "vision", "size",
                "pocket", "marks", "mark", "crop", "bus_id", "slot", "offset", "advance",
            },
        )
    camera = read.table(top, "up_camera")
    camera_z = read.number(camera, "z", "up_camera", None) if "z" in camera else None
    camera_position = read.point(camera, "position", "up_camera", 2, None) if "position" in camera else None
    crop = read.number(camera, "crop", "up_camera", None, 0.1, 100.0) if "crop" in camera else None
    max_offset = read.number(camera, "max_offset", "up_camera", 1.0, 0.01, 20.0)
    max_turn = read.number(camera, "max_turn", "up_camera", 15.0, 0.1, 45.0)
    size_tolerance = read.number(camera, "size_tolerance", "up_camera", 0.3, 0.0, 1.0)
    leave = read.number(camera, "leave", "up_camera", None, 0.0, 1000.0) if "leave" in camera else None
    read.done(camera, "up_camera", {"z", "position", "crop", "max_offset", "max_turn", "size_tolerance", "leave"})
    return GcodeMachine(
        id=machine.id,
        name=name or machine.id,
        description=description,
        url=url,
        baud=baud,
        wait_ms=wait_ms,
        timeout=timeout,
        init=init,
        end=end,
        move=move,
        axes=axes,
        wait=wait,
        pick=pick,
        place=place,
        dwell=dwell,
        home=home,
        position=position,
        stop=stop,
        feed_xy=feed_xy,
        feed_z=feed_z,
        safe_z=safe_z,
        place_z=place_z,
        pick_dwell_ms=pick_dwell_ms,
        place_dwell_ms=place_dwell_ms,
        feeders=tuple(feeders),
        camera_z=camera_z,
        rotation_cw=rotation_cw,
        discard=discard,
        pick_tries=pick_tries,
        vacuum=vacuum,
        max_offset=max_offset,
        max_turn=max_turn,
        size_tolerance=size_tolerance,
        top=top_camera,
        light_on=light_on,
        light_off=light_off,
        camera_position=camera_position,
        leave=leave,
        park=park,
        crop=crop,
        bus=bus,
        slots=tuple(slots),
        match=port_words,
        motors_on=motors_on,
        motors_off=motors_off,
        controls=machine.controls,
    )


# --- the program -------------------------------------------------------------------


def wrap(degrees: float, period: float = 360.0) -> float:
    """An angle in (-period/2, period/2]: in (-180, 180] by default, and
    in (-45, 45] with a period of 90, a rectangle's turn, which a quarter
    turn leaves as it was."""
    half = period / 2.0
    left = math.fmod(degrees, period)
    if left <= -half:
        left += period
    elif left > half:
        left -= period
    return left


def board_fit(references: list[tuple[tuple[float, float], tuple[float, float]]], angle: float | None) -> Fit:
    """Where the board lies on the machine: the job frame's points taken to
    the machine's, from reference parts whose places were read off it."""
    if not references:
        raise PlanError("the board has no reference on the machine: put the nozzle over a part's place and press Here")
    try:
        return fit_rigid(references, angle if len(references) == 1 else None)
    except ValueError as exc:
        raise PlanError(str(exc)) from exc


VISION_NOTE = "; looked at over the bottom camera: placed where its center lands"
POCKET_NOTE = "; the top camera looks at the pocket first: picked where the part is"
MARKS_NOTE = "; the feeder's marks are found with the top camera first: its places follow them"


def tip_shift(runout: tuple[float, float], degrees: float) -> tuple[float, float]:
    """How far the head moves to keep the nozzle's tip on a point as the
    nozzle turns from 0 to `degrees`: the tip sits `runout` off the turning
    axis at 0, and that offset turns with the nozzle."""
    swung = turn(runout, degrees)
    return (runout[0] - swung[0], runout[1] - swung[1])


@dataclass
class Block:
    """One part: the feeder it comes from and which of its parts, the lines
    that pick it, read the vacuum with it held, place it and read the
    vacuum once it let go, and what the place lines are made from, so a
    look at the part can make them again where its center lands. `target`
    is the place with the tip turned to 0 over it, `angle` the part's angle
    on the machine there, `turn` the nozzle's turn from the feeder's angle
    to it, and `size` the length and width the up camera should see, when
    known."""

    ref: str
    feeder: str
    index: int
    pick: list[str]
    place: list[str]
    target: tuple[float, float] = (0.0, 0.0)
    turn: float = 0.0
    place_z: float = 0.0
    vision: bool = False
    check: list[str] = field(default_factory=list)
    release: list[str] = field(default_factory=list)
    angle: float = 0.0
    size: tuple[float, float] | None = None
    # How far from the up camera's center the part is looked for, mm.
    crop: float | None = None

    @property
    def lines(self) -> list[str]:
        return [*self.pick, *self.check, *([VISION_NOTE] if self.vision else []), *self.place, *self.release]


@dataclass
class Plan:
    head: list[str]
    blocks: list[Block]
    tail: list[str]
    skipped: list[dict]
    fit: Fit

    def text(self) -> str:
        lines = list(self.head)
        for block in self.blocks:
            lines.extend(block.lines)
        lines.extend(self.tail)
        return "\n".join(lines) + "\n"

    def summary(self) -> dict:
        text = self.text()
        return {
            "parts": [{"ref": block.ref, "feeder": block.feeder, "index": block.index, "vision": block.vision} for block in self.blocks],
            "skipped": self.skipped,
            "fit": self.fit.to_dict(),
            "lines": count_code(text.splitlines()),
            "text": text,
        }


def code_of(line: str) -> str:
    """A line as it goes out: its comment and the space around it taken off."""
    return line.split(";", 1)[0].strip()


def count_code(lines: list[str]) -> int:
    """How many of the lines go out: those that are more than a comment."""
    return sum(1 for line in lines if code_of(line))


def dwell_line(machine: GcodeMachine, ms: int) -> list[str]:
    if ms <= 0 or not machine.dwell:
        return []
    return [machine.dwell.replace("{ms}", str(ms)).replace("{s}", num(ms / 1000.0))]


def move_z(machine: GcodeMachine, z: float) -> str:
    """The nozzle to the height `z`, at the Z feed."""
    return f"{machine.move} {machine.axes[2]}{num(z)} F{num(machine.feed_z, 0)}"


def move_xy(machine: GcodeMachine, point: tuple[float, float] | None, degrees: float | None = None) -> str:
    """A move at the X/Y feed: the head over `point` when given, the nozzle
    turned to `degrees` (counterclockwise from above) when given."""
    words = [machine.move]
    if point is not None:
        words += [f"{machine.axes[0]}{num(point[0])}", f"{machine.axes[1]}{num(point[1])}"]
    if degrees is not None:
        words.append(machine.angle_word(degrees))
    words.append(f"F{num(machine.feed_xy, 0)}")
    return " ".join(words)


def safe_line(machine: GcodeMachine) -> str:
    return move_z(machine, machine.safe_z)


def lifts_leaving(machine: GcodeMachine, here: dict[str, float], target: dict[str, float], camera: tuple[float, float] | None) -> bool:
    """Whether a jog from `here` to `target` (the controller's x, y, z)
    goes up to the safe height first: the file asks for it ([up_camera]
    leave), the up camera's place is known, the nozzle is off the safe
    height and within `leave` mm of that place, and the jog ends farther
    than that from it."""
    if machine.leave is None or camera is None or ("x" not in target and "y" not in target):
        return False
    z = here.get("z")
    if z is None or abs(z - machine.safe_z) <= 1e-6 or "z" in target:
        return False
    if "x" not in here or "y" not in here:
        return False
    start = math.hypot(here["x"] - camera[0], here["y"] - camera[1])
    end = math.hypot(target.get("x", here["x"]) - camera[0], target.get("y", here["y"]) - camera[1])
    return start <= machine.leave + 1e-9 and end > machine.leave + 1e-9


AXIS_NAMES = ("x", "y", "z", "rotation")


def move_line(machine: GcodeMachine, target: dict[str, float], feed: float | None = None) -> str:
    """One move to the controller's own values in `target` (x, y, z, and the
    rotation as the controller counts it, not turned for rotation_cw), at
    `feed`, else at the Z feed for a height alone and the X/Y feed for
    anything else."""
    words = [machine.move]
    for name, letter in zip(AXIS_NAMES, machine.axes):
        if name in target:
            words.append(f"{letter}{num(target[name])}")
    if feed is None:
        feed = machine.feed_z if set(target) == {"z"} else machine.feed_xy
    words.append(f"F{num(feed, 0)}")
    return " ".join(words)


def goto_lines(machine: GcodeMachine, here: dict[str, float], want: dict[str, float], feed: float | None = None) -> list[str]:
    """The lines that take the head from `here` to `want` (x, y, z and the
    rotation, as the controller counts them; an axis left out stays where
    it is). Only a move across, X or Y changing, goes up to the safe height
    first, from either side of it (on a seesaw Z a height above it lowers
    the other nozzle); the turn goes with the move across, and the height
    comes last, so a nozzle goes down only over where it is going. `feed`
    is for the move across; the height goes at the Z feed."""
    across = {name: want[name] for name in ("x", "y") if name in want and (name not in here or abs(want[name] - here[name]) > 1e-6)}
    lines: list[str] = []
    z = here.get("z")
    if across:
        if z is None or abs(z - machine.safe_z) > 1e-6:
            lines.append(safe_line(machine))
            z = machine.safe_z
        flat = dict(across)
        if "rotation" in want:
            flat["rotation"] = want["rotation"]
        lines.append(move_line(machine, flat, feed))
    elif "rotation" in want:
        lines.append(move_line(machine, {"rotation": want["rotation"]}, feed))
    if "z" in want and (z is None or abs(want["z"] - z) > 1e-6):
        lines.append(move_line(machine, {"z": want["z"]}))
    return lines


def pick_label(part: dict, feeder: Feeder, index: int) -> str:
    """What the comment before a pick says: the part, its value, and which
    of the feeder's parts it is, counted from 1."""
    return f"{part['ref']} {part.get('value', '')} from {feeder.id} #{index + 1}"


def pick_lines(machine: GcodeMachine, feeder: Feeder, label: str, point: tuple[float, float, float]) -> list[str]:
    """The lines that take a part from its pocket: a comment saying which,
    the feeder's own lines, up to the safe height, over the pocket with the
    nozzle turned to 0, down, the vacuum on, and back up."""
    advance = [f"; {feeder.id} advances {num(feeder.advance)} mm on the feeder bus"] if feeder.bus_id is not None else []
    return [
        f"; {label}".rstrip(),
        *advance,
        *feeder.feed,
        safe_line(machine),
        move_xy(machine, (point[0], point[1]), 0.0),
        move_z(machine, point[2]),
        *([machine.wait] if machine.wait else []),
        *machine.pick,
        *dwell_line(machine, machine.pick_dwell_ms),
        safe_line(machine),
    ]


def check_lines(machine: GcodeMachine, held: bool) -> list[str]:
    """The vacuum sensor read with the head at rest: after a pick, a part
    should be held; after a place, the nozzle should be empty (read only
    when the profile says what empty reads)."""
    vacuum = machine.vacuum
    if vacuum is None:
        return []
    span = vacuum.part_on if held else vacuum.part_off
    if span is None:
        return []
    what = "a part held" if held else "an empty nozzle"
    *first, last = vacuum.read
    return [*([machine.wait] if machine.wait else []), *first, f"{last} ; vacuum: {what} reads {num(span[0])} to {num(span[1])}"]


def place_lines(machine: GcodeMachine, point: tuple[float, float], turn: float, place_z: float) -> list[str]:
    """The lines that put a held part down: across at the safe height,
    turned to its angle, down, the vacuum off, and back up."""
    return [
        move_xy(machine, point, turn),
        move_z(machine, place_z),
        *([machine.wait] if machine.wait else []),
        *machine.place,
        *dwell_line(machine, machine.place_dwell_ms),
        safe_line(machine),
    ]


def feeder_for(machine: GcodeMachine, part: dict) -> Feeder | None:
    """The feeder a part comes from: the first that names it among its
    refs, else the first whose words its value and footprint hold."""
    ref = str(part.get("ref", ""))
    named = next((f for f in machine.feeders if f.refs and ref in f.refs), None)
    if named is not None:
        return named
    return next((f for f in machine.feeders if not f.refs and f.holds(str(part.get("value", "")), str(part.get("footprint", "")))), None)


def expected_size(feeder: Feeder, part: dict) -> tuple[float, float] | None:
    """The length and width the up camera should see of a part: the
    feeder's size, else its footprint's body, longer side first."""
    if feeder.size is not None:
        return (max(feeder.size), min(feeder.size))
    body = part.get("body")
    if isinstance(body, (list, tuple)) and len(body) == 2 and all(isinstance(v, (int, float)) and v > 0 for v in body):
        return (float(max(body)), float(min(body)))
    return None


def plan(
    machine: GcodeMachine,
    parts: list[dict],
    fit: Fit,
    taken: dict[str, int],
    refs: list[str] | None = None,
    title: str = "",
    vision_ready: bool = False,
    runout: tuple[float, float] = (0.0, 0.0),
) -> Plan:
    """The placement program for a board job's parts on the machine.

    `parts` are the job's components (job frame), `fit` takes them to the
    machine, `taken` is how many parts each feeder has given already, and
    `refs` the parts to place, every one that can be by default. A part on
    the back, one not to be fitted, one no feeder holds (or whose feeder is
    empty), and one whose feeder wants the up camera while the nozzle has
    not been centered over it (`vision_ready`) is skipped, with why; a
    fiducial is not a part, and is named only when asked for. `runout` is
    the nozzle's tip off its turning axis at 0, the head moving to keep
    the tip on each place at the part's angle."""
    given = dict(taken)
    blocks: list[Block] = []
    skipped: list[dict] = []
    marked: set[str] = set()
    wanted = set(refs) if refs is not None else None
    if wanted is not None:
        for missing in sorted(wanted - {part["ref"] for part in parts}):
            skipped.append({"ref": missing, "reason": "not a part of this job"})
    for part in parts:
        ref = part["ref"]
        if wanted is not None and ref not in wanted:
            continue
        if part.get("fiducial"):
            if wanted is not None:
                skipped.append({"ref": ref, "reason": "a fiducial, not a part"})
            continue
        if part.get("dnp"):
            skipped.append({"ref": ref, "reason": "not to be fitted (dnp)"})
            continue
        if part.get("side") == "back":
            skipped.append({"ref": ref, "reason": "on the back"})
            continue
        feeder = feeder_for(machine, part)
        if feeder is None:
            skipped.append({"ref": ref, "reason": "no feeder holds it"})
            continue
        if feeder.vision and not vision_ready:
            skipped.append({"ref": ref, "reason": f"feeder {feeder.id} wants the bottom camera: center the nozzle over it first"})
            continue
        if feeder.at is None:
            skipped.append({"ref": ref, "reason": f"feeder {feeder.id}'s slot is not known: scan the feeder bus, or run, which finds it"})
            continue
        index = given.get(feeder.id, 0)
        if feeder.count > 0 and index >= feeder.count:
            skipped.append({"ref": ref, "reason": f"feeder {feeder.id} is empty"})
            continue
        given[feeder.id] = index + 1
        qx, qy = fit.apply((float(part["x"]), float(part["y"])))
        angle = wrap(float(part.get("rotation", 0.0)) + fit.rotation)
        turn = wrap(angle - feeder.rotation)
        place_z = feeder.place_z if feeder.place_z is not None else machine.place_z
        pick = pick_lines(machine, feeder, pick_label(part, feeder, index), feeder.place_of(index if feeder.count > 0 else 0))
        notes = []
        if feeder.marks and feeder.id not in marked:
            marked.add(feeder.id)
            notes.append(MARKS_NOTE)
        if feeder.pocket is not None:
            notes.append(POCKET_NOTE)
        shift = tip_shift(runout, turn)
        blocks.append(
            Block(
                ref=ref,
                feeder=feeder.id,
                index=index,
                pick=[pick[0], *notes, *pick[1:]],
                place=place_lines(machine, (qx + shift[0], qy + shift[1]), turn, place_z),
                target=(qx, qy),
                turn=turn,
                place_z=place_z,
                vision=feeder.vision,
                check=check_lines(machine, held=True),
                release=check_lines(machine, held=False),
                angle=angle,
                size=expected_size(feeder, part),
                crop=feeder.crop if feeder.crop is not None else machine.crop,
            )
        )
    head = [f"; {title or 'placement'} on {machine.name}: {len(blocks)} parts", *machine.init]
    tail = [*([machine.wait] if machine.wait else []), *machine.end]
    return Plan(head=head, blocks=blocks, tail=tail, skipped=skipped, fit=fit)


def board_goto(machine: GcodeMachine, fit: Fit, part: dict) -> list[str]:
    """The nozzle up to the safe height and over a part's place on the machine."""
    return [safe_line(machine), move_xy(machine, fit.apply((float(part["x"]), float(part["y"]))))]


POSITION = re.compile(r"\b([A-Z]):\s*(-?\d+(?:\.\d+)?)")


def read_position(lines: list[str], axes: tuple[str, str, str, str]) -> dict:
    """The position a reply reports (Marlin's and RepRapFirmware's `X:1.00
    Y:2.00 ... Count ...`, Smoothie's `ok C: X:1.0 ...`, Grbl's `MPos:`
    excepted), named x, y, z and rotation by the profile's letters; the
    figures after `Count` are steps, not millimeters."""
    found: dict[str, float] = {}
    for line in lines:
        head = line.split("Count", 1)[0]
        for letter, value in POSITION.findall(head):
            found.setdefault(letter, float(value))
    names = dict(zip(axes, ("x", "y", "z", "rotation")))
    return {names[letter]: value for letter, value in found.items() if letter in names}
