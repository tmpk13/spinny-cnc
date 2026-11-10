"""Placing a board's parts on another machine: one whose controller takes
the G-code OpenPnP's GcodeDriver sends (Marlin, Smoothieware,
RepRapFirmware, Grbl), a line at a time, each answered `ok`.

A device profile (`pnp/*.toml`) says how to talk to that machine: its
port, the words of its dialect (the move word and axis letters, the
vacuum's on and off, the wait for the moves queued, a dwell, home and
stop), the heights it works at and its feeders. Where the board lies on
the machine is fitted from reference parts whose places were read off it
(one gives a shift, with a typed turn; two or more a turn and a shift).

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

Every place on the device is a place of the nozzle's tip turned to 0:
the head's X and Y with the tip over that point. The program here is the
plan as it stands before the run; the run (`placer.py`) changes it where
a camera or the vacuum sensor says otherwise.
"""

from __future__ import annotations

import math
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from spinny_laser.align import Fit, fit_rigid, turn

from .files import write_whole
from .kinematics import num

ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
AXIS = re.compile(r"^[A-Z]$")
# A G-code line as a profile may give it: printable, one line.
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


class DeviceError(ValueError):
    """A profile that does not read, or a plan that cannot be made."""


class NotFound(LookupError):
    """No device profile of that id."""


def check_id(device_id: str) -> str:
    if not ID_PATTERN.match(device_id):
        raise DeviceError(f"{device_id!r} is not a device id: lower case letters, digits, - and _, starting with a letter or digit, at most 64")
    return device_id


@dataclass(frozen=True)
class Feeder:
    id: str
    # Words a part's value and footprint must all hold, any case.
    match: str
    # The first part's place, X Y Z, and the step from one part to the next:
    # along a strip, or with `columns` from column to column of a tray,
    # `row_pitch` from row to row.
    at: tuple[float, float, float]
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
    # Marks on the feeder (a hole, a dot) where the profile puts them,
    # found with the top camera before the first pick from it in a run:
    # its places follow them, shifted by one and turned as well by two.
    marks: tuple[tuple[float, float], ...] = ()
    mark: str = "dark"

    def holds(self, value: str, footprint: str) -> bool:
        hay = f"{value} {footprint}".lower()
        return all(word in hay for word in self.match.lower().split())

    def place_of(self, index: int) -> tuple[float, float, float]:
        if self.columns > 0:
            column, row = index % self.columns, index // self.columns
            return (
                self.at[0] + column * self.pitch[0] + row * self.row_pitch[0],
                self.at[1] + column * self.pitch[1] + row * self.row_pitch[1],
                self.at[2],
            )
        return (self.at[0] + index * self.pitch[0], self.at[1] + index * self.pitch[1], self.at[2])


@dataclass(frozen=True)
class Vacuum:
    """The vacuum sensor: the line that reads it, the pattern whose group
    is the reading in the answer, and the readings with a part held and
    with the nozzle empty."""

    read: str
    pattern: str
    part_on: tuple[float, float]
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
    """The camera on the device's head looking down: the height the head
    stands at for it to see the board sharp (None keeps the safe height),
    where its picture's center is from the nozzle's tip as the head's
    design has it (a first guess; the measured one wins), the shade of a
    fiducial, and how far from where it is expected a fiducial, mark or
    part in a pocket is looked for, mm."""

    z: float | None = None
    offset: tuple[float, float] | None = None
    fiducial: str = "bright"
    within: float = 2.0


@dataclass(frozen=True)
class Device:
    """A device profile, read and checked."""

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
    pick: str
    place: str
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

    def summary(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description, "url": self.url, "feeders": len(self.feeders)}

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
            "safe_z": self.safe_z,
            "place_z": self.place_z,
            "discard": list(self.discard) if self.discard is not None else None,
            "pick_tries": self.pick_tries,
            "camera_z": self.camera_z,
            "max_offset": self.max_offset,
            "max_turn": self.max_turn,
            "size_tolerance": self.size_tolerance,
            "vacuum": (
                {
                    "read": vacuum.read,
                    "pattern": vacuum.pattern,
                    "part_on": list(vacuum.part_on),
                    "part_off": list(vacuum.part_off) if vacuum.part_off is not None else None,
                }
                if vacuum is not None
                else None
            ),
            "top": (
                {"z": top.z, "offset": list(top.offset) if top.offset is not None else None, "fiducial": top.fiducial, "within": top.within}
                if top is not None
                else None
            ),
            "feeders": [
                {
                    "id": f.id,
                    "match": f.match,
                    "at": list(f.at),
                    "pitch": list(f.pitch),
                    "count": f.count,
                    "columns": f.columns,
                    "rotation": f.rotation,
                    "vision": f.vision,
                    "size": list(f.size) if f.size is not None else None,
                    "pocket": f.pocket,
                    "marks": [list(mark) for mark in f.marks],
                    "mark": f.mark,
                }
                for f in self.feeders
            ],
        }


class _Reader:
    """Typed reads out of the parsed tables, each error naming the file and the key."""

    def __init__(self, where: str) -> None:
        self.where = where

    def fail(self, section: str | None, key: str, what: str) -> DeviceError:
        place = f"[{section}] {key}" if section else key
        return DeviceError(f"{self.where}: {place} {what}")

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


def parse(text: str, device_id: str, where: str | None = None) -> Device:
    """A device profile from its TOML text; DeviceError naming the key for anything amiss."""
    where = where or f"{device_id}.toml"
    check_id(device_id)
    try:
        top = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise DeviceError(f"{where}: {exc}") from None
    read = _Reader(where)
    name = read.text(top, "name", None, device_id)
    description = read.text(top, "description", None, "")
    port = read.table(top, "port")
    url = read.text(port, "url", "port", "")
    baud = read.integer(port, "baud", "port", 115200, 1200, 2000000)
    if baud not in BAUDS:
        raise read.fail("port", "baud", f"must be one of {', '.join(str(b) for b in BAUDS)}")
    wait_ms = read.integer(port, "wait_ms", "port", 2000, 0, 30000)
    timeout = read.number(port, "timeout", "port", 60.0, 1.0, 600.0)
    read.done(port, "port", {"url", "baud", "wait_ms", "timeout"})

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
    pick = read.text(gcode, "pick", "gcode", "M106")
    place = read.text(gcode, "place", "gcode", "M107")
    if not pick or not place:
        raise read.fail("gcode", "pick" if not pick else "place", "must name the vacuum's command")
    dwell = read.text(gcode, "dwell", "gcode", "G4 P{ms}")
    if dwell and "{ms}" not in dwell and "{s}" not in dwell:
        raise read.fail("gcode", "dwell", "must hold {ms} or {s} for the time, or be empty for none")
    home = read.text(gcode, "home", "gcode", "G28")
    position = read.text(gcode, "position", "gcode", "M114")
    stop = read.text(gcode, "stop", "gcode", "M410")
    rotation_cw = read.flag(gcode, "rotation_cw", "gcode", False)
    read.done(
        gcode, "gcode", {"init", "end", "move", "x", "y", "z", "rotation", "rotation_cw", "wait", "pick", "place", "dwell", "home", "position", "stop"}
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
    read.done(motion, "motion", {"feed_xy", "feed_z", "safe_z", "place_z", "pick_dwell_ms", "place_dwell_ms", "discard", "pick_tries"})

    vacuum = None
    sensor = read.table(top, "vacuum")
    if sensor:
        read_line = read.text(sensor, "read", "vacuum", "")
        if not read_line:
            raise read.fail("vacuum", "read", "must name the line that reads the vacuum sensor")
        pattern = read.text(sensor, "pattern", "vacuum", DEFAULT_VACUUM_PATTERN, line=False)
        pattern = JAVA_GROUP.sub("(?P<", pattern)
        try:
            groups = re.compile(pattern).groups
        except re.error as exc:
            raise read.fail("vacuum", "pattern", f"is not a regular expression: {exc}") from None
        if groups < 1:
            raise read.fail("vacuum", "pattern", "must hold a group, ( ), around the reading")
        part_on = read.span(sensor, "part_on", "vacuum")
        if part_on is None:
            raise read.fail("vacuum", "part_on", "is needed: the low and high reading with a part held")
        vacuum = Vacuum(read=read_line, pattern=pattern, part_on=part_on, part_off=read.span(sensor, "part_off", "vacuum"))
        read.done(sensor, "vacuum", {"read", "pattern", "part_on", "part_off"})

    top_camera = None
    looking = read.table(top, "top_camera")
    if looking:
        top_camera = TopCameraProfile(
            z=read.number(looking, "z", "top_camera", None) if "z" in looking else None,
            offset=read.point(looking, "offset", "top_camera", 2, None) if "offset" in looking else None,
            fiducial=read.shade(looking, "fiducial", "top_camera", "bright"),
            within=read.number(looking, "within", "top_camera", 2.0, 0.1, 50.0),
        )
        read.done(looking, "top_camera", {"z", "offset", "fiducial", "within"})

    tables = top.get("feeder", [])
    if not isinstance(tables, list) or not all(isinstance(item, dict) for item in tables):
        raise read.fail(None, "feeder", "must be an array of tables ([[feeder]])")
    feeders: list[Feeder] = []
    for number, table in enumerate(tables, start=1):
        section = f"feeder {number}"
        feeder_id = read.text(table, "id", section, "")
        if not ID_PATTERN.match(feeder_id):
            raise read.fail(section, "id", "must be lower case letters, digits, - and _, starting with a letter or digit")
        if any(other.id == feeder_id for other in feeders):
            raise read.fail(section, "id", f"{feeder_id!r} is another feeder's too")
        match = read.text(table, "match", section, "")
        if not match:
            raise read.fail(section, "match", "must hold the words of a part's value or footprint")
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
            raise read.fail(section, "pocket" if pocket is not None else "marks", "looks with the top camera: add a [top_camera] section")
        feeders.append(
            Feeder(
                id=feeder_id,
                match=match,
                at=read.point(table, "at", section, 3, None),
                pitch=read.point(table, "pitch", section, 2, (0.0, 0.0)),
                count=count,
                columns=columns,
                row_pitch=read.point(table, "row_pitch", section, 2, (0.0, 0.0)),
                rotation=read.number(table, "rotation", section, 0.0, -360.0, 360.0),
                place_z=place_z_of,
                feed=read.lines(table, "feed", section, (), one=True),
                vision=read.flag(table, "vision", section, False),
                size=size,
                pocket=pocket,
                marks=marks,
                mark=read.shade(table, "mark", section, "dark"),
            )
        )
        read.done(
            table,
            section,
            {"id", "match", "at", "pitch", "count", "columns", "row_pitch", "rotation", "place_z", "feed", "vision", "size", "pocket", "marks", "mark"},
        )
    camera = read.table(top, "camera")
    camera_z = read.number(camera, "z", "camera", None) if "z" in camera else None
    max_offset = read.number(camera, "max_offset", "camera", 1.0, 0.01, 20.0)
    max_turn = read.number(camera, "max_turn", "camera", 15.0, 0.1, 45.0)
    size_tolerance = read.number(camera, "size_tolerance", "camera", 0.3, 0.0, 1.0)
    read.done(camera, "camera", {"z", "max_offset", "max_turn", "size_tolerance"})
    read.done(top, None, {"name", "description", "port", "gcode", "motion", "vacuum", "top_camera", "feeder", "camera"})
    return Device(
        id=device_id,
        name=name or device_id,
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
    )


class DeviceStore:
    """The device profiles in one directory, read afresh on every call so an
    edit by hand shows at once; saved all or nothing after a parse."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        # Each profile as last parsed, by the time its file was written: the
        # device's state asks for it on every change it publishes.
        self._parsed: dict[str, tuple[int, Device]] = {}

    def list(self) -> dict:
        devices, problems = [], []
        for path in sorted(self.directory.glob("*.toml")):
            device_id = path.stem
            try:
                devices.append(parse(path.read_text(encoding="utf-8"), device_id, path.name).summary())
            except (DeviceError, OSError, UnicodeDecodeError) as exc:
                problems.append({"id": device_id, "problem": str(exc)})
        return {"devices": devices, "problems": problems}

    def path(self, device_id: str) -> Path:
        return self.directory / f"{check_id(device_id)}.toml"

    def text(self, device_id: str) -> str:
        path = self.path(device_id)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise NotFound(f"no device profile {device_id!r}") from None
        except OSError as exc:
            raise DeviceError(f"{path}: {exc.strerror or exc}") from exc

    def get(self, device_id: str) -> Device:
        path = self.path(device_id)
        try:
            stamp = path.stat().st_mtime_ns
        except FileNotFoundError:
            raise NotFound(f"no device profile {device_id!r}") from None
        except OSError as exc:
            raise DeviceError(f"{path}: {exc.strerror or exc}") from exc
        cached = self._parsed.get(device_id)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        device = parse(self.text(device_id), device_id)
        self._parsed[device_id] = (stamp, device)
        return device

    def document(self, device_id: str) -> dict:
        text = self.text(device_id)
        return {"document": parse(text, device_id).document(), "text": text}

    def check(self, device_id: str, text: str) -> dict:
        try:
            return {"document": parse(text, device_id).document(), "problems": []}
        except DeviceError as exc:
            return {"document": None, "problems": [str(exc)]}

    def save(self, device_id: str, text: str) -> dict:
        path = self.path(device_id)
        device = parse(text, device_id)
        if not text.endswith("\n"):
            text += "\n"
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            # Through a temporary of its own: two saves at once each move a
            # whole file, where a shared one left the second without its own.
            write_whole(path, text)
        except OSError as exc:
            raise DeviceError(f"cannot write {path}: {exc.strerror or exc}") from exc
        return {"document": device.document(), "text": text}


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
    """Where the board lies on the device: the job frame's points taken to
    the device's, from reference parts whose places were read off it."""
    if not references:
        raise DeviceError("the board has no reference on the device: put the nozzle over a part's place and press Here")
    try:
        return fit_rigid(references, angle if len(references) == 1 else None)
    except ValueError as exc:
        raise DeviceError(str(exc)) from exc


VISION_NOTE = "; looked at over the up camera: placed where its center lands"
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
    on the device there, `turn` the nozzle's turn from the feeder's angle
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


def dwell_line(device: Device, ms: int) -> list[str]:
    if ms <= 0 or not device.dwell:
        return []
    return [device.dwell.replace("{ms}", str(ms)).replace("{s}", num(ms / 1000.0))]


def move_z(device: Device, z: float) -> str:
    """The nozzle to the height `z`, at the Z feed."""
    return f"{device.move} {device.axes[2]}{num(z)} F{num(device.feed_z, 0)}"


def move_xy(device: Device, point: tuple[float, float] | None, degrees: float | None = None) -> str:
    """A move at the X/Y feed: the head over `point` when given, the nozzle
    turned to `degrees` (counterclockwise from above) when given."""
    words = [device.move]
    if point is not None:
        words += [f"{device.axes[0]}{num(point[0])}", f"{device.axes[1]}{num(point[1])}"]
    if degrees is not None:
        words.append(device.angle_word(degrees))
    words.append(f"F{num(device.feed_xy, 0)}")
    return " ".join(words)


def safe_line(device: Device) -> str:
    return move_z(device, device.safe_z)


def pick_label(part: dict, feeder: Feeder, index: int) -> str:
    """What the comment before a pick says: the part, its value, and which
    of the feeder's parts it is, counted from 1."""
    return f"{part['ref']} {part.get('value', '')} from {feeder.id} #{index + 1}"


def pick_lines(device: Device, feeder: Feeder, label: str, point: tuple[float, float, float]) -> list[str]:
    """The lines that take a part from its pocket: a comment saying which,
    the feeder's own lines, up to the safe height, over the pocket with the
    nozzle turned to 0, down, the vacuum on, and back up."""
    return [
        f"; {label}".rstrip(),
        *feeder.feed,
        safe_line(device),
        move_xy(device, (point[0], point[1]), 0.0),
        move_z(device, point[2]),
        *([device.wait] if device.wait else []),
        device.pick,
        *dwell_line(device, device.pick_dwell_ms),
        safe_line(device),
    ]


def check_lines(device: Device, held: bool) -> list[str]:
    """The vacuum sensor read with the head at rest: after a pick, a part
    should be held; after a place, the nozzle should be empty (read only
    when the profile says what empty reads)."""
    vacuum = device.vacuum
    if vacuum is None:
        return []
    span = vacuum.part_on if held else vacuum.part_off
    if span is None:
        return []
    what = "a part held" if held else "an empty nozzle"
    return [*([device.wait] if device.wait else []), f"{vacuum.read} ; vacuum: {what} reads {num(span[0])} to {num(span[1])}"]


def place_lines(device: Device, point: tuple[float, float], turn: float, place_z: float) -> list[str]:
    """The lines that put a held part down: across at the safe height,
    turned to its angle, down, the vacuum off, and back up."""
    return [
        move_xy(device, point, turn),
        move_z(device, place_z),
        *([device.wait] if device.wait else []),
        device.place,
        *dwell_line(device, device.place_dwell_ms),
        safe_line(device),
    ]


def feeder_for(device: Device, part: dict) -> Feeder | None:
    return next((f for f in device.feeders if f.holds(str(part.get("value", "")), str(part.get("footprint", "")))), None)


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
    device: Device,
    parts: list[dict],
    fit: Fit,
    taken: dict[str, int],
    refs: list[str] | None = None,
    title: str = "",
    vision_ready: bool = False,
    runout: tuple[float, float] = (0.0, 0.0),
) -> Plan:
    """The placement program for a board job's parts on the device.

    `parts` are the job's components (job frame), `fit` takes them to the
    device, `taken` is how many parts each feeder has given already, and
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
        feeder = feeder_for(device, part)
        if feeder is None:
            skipped.append({"ref": ref, "reason": "no feeder holds it"})
            continue
        if feeder.vision and not vision_ready:
            skipped.append({"ref": ref, "reason": f"feeder {feeder.id} wants the up camera: center the nozzle over it first"})
            continue
        index = given.get(feeder.id, 0)
        if feeder.count > 0 and index >= feeder.count:
            skipped.append({"ref": ref, "reason": f"feeder {feeder.id} is empty"})
            continue
        given[feeder.id] = index + 1
        qx, qy = fit.apply((float(part["x"]), float(part["y"])))
        angle = wrap(float(part.get("rotation", 0.0)) + fit.rotation)
        turn = wrap(angle - feeder.rotation)
        place_z = feeder.place_z if feeder.place_z is not None else device.place_z
        pick = pick_lines(device, feeder, pick_label(part, feeder, index), feeder.place_of(index if feeder.count > 0 else 0))
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
                place=place_lines(device, (qx + shift[0], qy + shift[1]), turn, place_z),
                target=(qx, qy),
                turn=turn,
                place_z=place_z,
                vision=feeder.vision,
                check=check_lines(device, held=True),
                release=check_lines(device, held=False),
                angle=angle,
                size=expected_size(feeder, part),
            )
        )
    head = [f"; {title or 'placement'} on {device.name}: {len(blocks)} parts", *device.init]
    tail = [*([device.wait] if device.wait else []), *device.end]
    return Plan(head=head, blocks=blocks, tail=tail, skipped=skipped, fit=fit)


def board_goto(device: Device, fit: Fit, part: dict) -> list[str]:
    """The nozzle up to the safe height and over a part's place on the device."""
    return [safe_line(device), move_xy(device, fit.apply((float(part["x"]), float(part["y"]))))]


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
