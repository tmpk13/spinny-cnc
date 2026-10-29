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
which must happen with the head at rest. A part from a feeder marked for
the up camera is looked at over it between its pick and its place, which
moves to where the part's center lands on its place: the offset seen
turns with the nozzle as the part is turned to its angle.
"""

from __future__ import annotations

import math
import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from spinny_laser.align import Fit, fit_rigid

ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
AXIS = re.compile(r"^[A-Z]$")
# A G-code line as a profile may give it: printable, one line.
LINE = re.compile(r"^[\x20-\x7e]*$")
BAUDS = (1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000)
COORD_LIMIT = 10000.0
FEED_LIMIT = 100000.0


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

    def summary(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description, "url": self.url, "feeders": len(self.feeders)}

    def document(self) -> dict:
        return {
            **self.summary(),
            "baud": self.baud,
            "wait_ms": self.wait_ms,
            "timeout": self.timeout,
            "axes": list(self.axes),
            "safe_z": self.safe_z,
            "place_z": self.place_z,
            "camera_z": self.camera_z,
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
    read.done(gcode, "gcode", {"init", "end", "move", "x", "y", "z", "rotation", "wait", "pick", "place", "dwell", "home", "position", "stop"})

    motion = read.table(top, "motion")
    feed_xy = read.number(motion, "feed_xy", "motion", 6000.0, 1.0, FEED_LIMIT)
    feed_z = read.number(motion, "feed_z", "motion", 1200.0, 1.0, FEED_LIMIT)
    safe_z = read.number(motion, "safe_z", "motion", None)
    place_z = read.number(motion, "place_z", "motion", None)
    pick_dwell_ms = read.integer(motion, "pick_dwell_ms", "motion", 200, 0, 60000)
    place_dwell_ms = read.integer(motion, "place_dwell_ms", "motion", 150, 0, 60000)
    read.done(motion, "motion", {"feed_xy", "feed_z", "safe_z", "place_z", "pick_dwell_ms", "place_dwell_ms"})

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
            )
        )
        read.done(table, section, {"id", "match", "at", "pitch", "count", "columns", "row_pitch", "rotation", "place_z", "feed", "vision"})
    camera = read.table(top, "camera")
    camera_z = read.number(camera, "z", "camera", None) if "z" in camera else None
    read.done(camera, "camera", {"z"})
    read.done(top, None, {"name", "description", "port", "gcode", "motion", "feeder", "camera"})
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
    )


class DeviceStore:
    """The device profiles in one directory, read afresh on every call so an
    edit by hand shows at once; saved all or nothing after a parse."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)

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
        return parse(self.text(device_id), device_id)

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
            temporary = path.with_name(path.name + ".tmp")
            temporary.write_text(text, encoding="utf-8")
            os.replace(temporary, path)
        except OSError as exc:
            raise DeviceError(f"cannot write {path}: {exc.strerror or exc}") from exc
        return {"document": device.document(), "text": text}


# --- the program -------------------------------------------------------------------


def num(value: float, decimals: int = 3) -> str:
    """A plain decimal with the zeros after its point dropped, and no negative zero."""
    text = f"{value:.{decimals}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def wrap(degrees: float) -> float:
    """An angle in (-180, 180]."""
    turned = math.fmod(degrees, 360.0)
    if turned <= -180.0:
        turned += 360.0
    elif turned > 180.0:
        turned -= 360.0
    return turned


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


@dataclass
class Block:
    """One part: the feeder it comes from and which of its parts, the lines
    that pick it and the ones that place it, and what the place lines are
    made from, so a look at the part can make them again where its
    center lands."""

    ref: str
    feeder: str
    index: int
    pick: list[str]
    place: list[str]
    target: tuple[float, float] = (0.0, 0.0)
    turn: float = 0.0
    place_z: float = 0.0
    vision: bool = False

    @property
    def lines(self) -> list[str]:
        return [*self.pick, *([VISION_NOTE] if self.vision else []), *self.place]


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
        return {
            "parts": [{"ref": block.ref, "feeder": block.feeder, "index": block.index, "vision": block.vision} for block in self.blocks],
            "skipped": self.skipped,
            "fit": self.fit.to_dict(),
            "lines": sum(1 for line in self.text().splitlines() if code_of(line)),
            "text": self.text(),
        }


def code_of(line: str) -> str:
    """A line as it goes out: its comment and the space around it taken off."""
    return line.split(";", 1)[0].strip()


def dwell_line(device: Device, ms: int) -> list[str]:
    if ms <= 0 or not device.dwell:
        return []
    return [device.dwell.replace("{ms}", str(ms)).replace("{s}", num(ms / 1000.0))]


def place_lines(device: Device, point: tuple[float, float], turn: float, place_z: float) -> list[str]:
    """The lines that put a held part down: across at the safe height,
    turned to its angle, down, the vacuum off, and back up."""
    x, y, z, a = device.axes
    move = device.move
    return [
        f"{move} {x}{num(point[0])} {y}{num(point[1])} {a}{num(turn)} F{num(device.feed_xy, 0)}",
        f"{move} {z}{num(place_z)} F{num(device.feed_z, 0)}",
        *([device.wait] if device.wait else []),
        device.place,
        *dwell_line(device, device.place_dwell_ms),
        f"{move} {z}{num(device.safe_z)} F{num(device.feed_z, 0)}",
    ]


def plan(
    device: Device,
    parts: list[dict],
    fit: Fit,
    taken: dict[str, int],
    refs: list[str] | None = None,
    title: str = "",
    vision_ready: bool = False,
) -> Plan:
    """The placement program for a board job's parts on the device.

    `parts` are the job's components (job frame), `fit` takes them to the
    device, `taken` is how many parts each feeder has given already, and
    `refs` the parts to place, every one that can be by default. A part on
    the back, one not to be fitted, one no feeder holds (or whose feeder is
    empty), and one whose feeder wants the up camera while the nozzle has
    not been centered over it (`vision_ready`) is skipped, with why."""
    x, y, z, a = device.axes
    move = device.move
    given = dict(taken)
    blocks: list[Block] = []
    skipped: list[dict] = []
    wanted = set(refs) if refs is not None else None
    if wanted is not None:
        for missing in sorted(wanted - {part["ref"] for part in parts}):
            skipped.append({"ref": missing, "reason": "not a part of this job"})
    for part in parts:
        ref = part["ref"]
        if wanted is not None and ref not in wanted:
            continue
        if part.get("dnp"):
            skipped.append({"ref": ref, "reason": "not to be fitted (dnp)"})
            continue
        if part.get("side") == "back":
            skipped.append({"ref": ref, "reason": "on the back"})
            continue
        feeder = next((f for f in device.feeders if f.holds(str(part.get("value", "")), str(part.get("footprint", "")))), None)
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
        px, py, pz = feeder.place_of(index if feeder.count > 0 else 0)
        qx, qy = fit.apply((float(part["x"]), float(part["y"])))
        turn = wrap(float(part.get("rotation", 0.0)) + fit.rotation - feeder.rotation)
        place_z = feeder.place_z if feeder.place_z is not None else device.place_z
        pick = [f"; {ref} {part.get('value', '')} from {feeder.id} #{index + 1}".rstrip()]
        pick += list(feeder.feed)
        pick += [
            f"{move} {z}{num(device.safe_z)} F{num(device.feed_z, 0)}",
            f"{move} {x}{num(px)} {y}{num(py)} {a}0 F{num(device.feed_xy, 0)}",
            f"{move} {z}{num(pz)} F{num(device.feed_z, 0)}",
            *([device.wait] if device.wait else []),
            device.pick,
            *dwell_line(device, device.pick_dwell_ms),
            f"{move} {z}{num(device.safe_z)} F{num(device.feed_z, 0)}",
        ]
        blocks.append(
            Block(
                ref=ref,
                feeder=feeder.id,
                index=index,
                pick=pick,
                place=place_lines(device, (qx, qy), turn, place_z),
                target=(qx, qy),
                turn=turn,
                place_z=place_z,
                vision=feeder.vision,
            )
        )
    head = [f"; {title or 'placement'} on {device.name}: {len(blocks)} parts", *device.init]
    tail = [*([device.wait] if device.wait else []), *device.end]
    return Plan(head=head, blocks=blocks, tail=tail, skipped=skipped, fit=fit)


def board_goto(device: Device, fit: Fit, part: dict) -> list[str]:
    """The nozzle up to the safe height and over a part's place on the device."""
    x, y, z, _ = device.axes
    qx, qy = fit.apply((float(part["x"]), float(part["y"])))
    return [
        f"{device.move} {z}{num(device.safe_z)} F{num(device.feed_z, 0)}",
        f"{device.move} {x}{num(qx)} {y}{num(qy)} F{num(device.feed_xy, 0)}",
    ]


POSITION = re.compile(r"\b([XYZABCE]):\s*(-?\d+(?:\.\d+)?)")


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
