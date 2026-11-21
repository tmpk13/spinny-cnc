"""An xTool galvo laser's machine file read, and jobs written for it.

A machine file with `controller = "xtool"` (spinny_laser.machines keeps its
own tables as written) is read here into an `XtoolMachine`: where the
machine answers, which firmware the file has been tried with, the field the
mirrors reach, the laser sources and the lines a job file is made of. The
xTool lines are the file's, not this module's, so a dialect that changes
with a firmware is an edit of the file.

A job is handed to the machine whole (`xtool_link`), so `write` turns one
into the complete G-code file: the file's start lines with the source's
select line where the start lines say `{source}`, a travel and the cuts of
every path through `CartesianStreamer`'s plan, and the end lines. The job's
board millimeters are moved into the field (centered unless an offset is
given) and mirrored as the file says, and a point outside the field, or a
group the machine cannot run as asked, refuses the whole job before a line
is written.
"""

from __future__ import annotations

import math
import re
import string
from dataclasses import dataclass

from spinny_laser.machines import XTOOL, Machine, MachineError

from .jobs import Job
from .kinematics import LASER, CartesianStreamer, Rates

# The transports built, one per firmware generation (`xtool_link`): v1 is
# the F1's firmware before 40.51.020.04, G-code on a TCP port with JSON
# over HTTP beside it.
GENERATIONS = ("v1",)
# The port the F1 updates its firmware on (/upgrade_version,
# /package?action=burn). Nothing here talks to it, so a file may not name it.
FIRMWARE_PORT = 8087
# One line of printable ASCII: what a G-code line or a template may hold.
LINE = re.compile(r"^[ -~]*$")
# The placeholders each kind of template may hold: a travel says where, a
# cut where, how hard and how fast; a start line may be the source's line.
TRAVEL_FIELDS = frozenset({"x", "y"})
CUT_FIELDS = frozenset({"x", "y", "s", "f"})
SOURCE_LINE = "{source}"
# Coordinates are written to the micron.
DECIMALS = 3
# How far past the field's edge a point may fall and still count as on it:
# a coordinate's rounding, no more.
EDGE = 0.5 * 10.0**-DECIMALS


class XtoolJobError(ValueError):
    """A job the machine cannot run as asked: the message says which group and why."""


@dataclass(frozen=True)
class XtoolMachine:
    """An xTool galvo's own tables, read and checked."""

    id: str
    name: str
    # Where it answers: G-code lines on one port, JSON over HTTP on the
    # other, each request or line given `timeout` seconds; a job file is
    # handed over at `upload`, as `upload_as` (multipart, a form's `file`
    # field; body, the file as the request's body).
    host: str
    gcode_port: int
    http_port: int
    timeout: float
    upload: str
    upload_as: str
    # The firmware: the transport's generation, the packages tried with
    # this file, and the machine type its info must report ("" for any).
    generation: str
    tried: tuple[str, ...]
    machine_type: str
    # The field in mm, X and Y, which board axes are mirrored into it, and
    # how fast the spot crosses it dark (mm/min, for the estimate).
    size: tuple[float, float]
    flip_x: bool
    flip_y: bool
    travel_rate: float
    # The laser sources by name, each its select line; the first is the default.
    sources: dict[str, str]
    # The lines: the start (one of them `{source}`) and the end, written as
    # they are, and the templates of a travel and a cut; S at full power
    # and the fastest F a cut may ask for.
    start: tuple[str, ...]
    end: tuple[str, ...]
    travel: tuple[str, ...]
    cut: tuple[str, ...]
    s_max: float
    feed_max: float

    @property
    def source(self) -> str:
        """The source a job is cut with when none is asked for."""
        return next(iter(self.sources))

    def document(self) -> dict:
        return {
            "link": {
                "host": self.host,
                "gcode_port": self.gcode_port,
                "http_port": self.http_port,
                "timeout": self.timeout,
                "upload": self.upload,
                "upload_as": self.upload_as,
            },
            "firmware": {"generation": self.generation, "tried": list(self.tried), "machine_type": self.machine_type},
            "field": {"size": list(self.size), "flip_x": self.flip_x, "flip_y": self.flip_y, "travel_rate": self.travel_rate},
            "sources": dict(self.sources),
            "lines": {
                "start": list(self.start),
                "end": list(self.end),
                "travel": list(self.travel),
                "cut": list(self.cut),
                "s_max": self.s_max,
                "feed_max": self.feed_max,
            },
        }


def machine_of(machine: Machine, where: str | None = None) -> XtoolMachine:
    """An xTool galvo's own tables read off its machine file as
    `spinny_laser.machines` read it; MachineError for a file of another
    controller, or a key amiss."""
    where = where or f"{machine.id}.toml"
    if machine.controller != XTOOL:
        raise MachineError(f'{where}: is not an xTool galvo: its controller is {machine.controller}, not "xtool"')
    top = machine.xtool
    read = _Reader(where)

    link = read.table(top, "link")
    host = read.text(link, "host", "link", "201.234.3.1")
    if not host or any(c.isspace() for c in host) or "/" in host:
        raise read.fail("link", "host", "must be a host name or address, without a scheme or a path")
    gcode_port = read.port(link, "gcode_port", 8780)
    http_port = read.port(link, "http_port", 8080)
    if gcode_port == http_port:
        raise read.fail("link", "http_port", "must differ from gcode_port")
    timeout = read.number(link, "timeout", "link", 5.0, 0.5, 120.0)
    upload = read.text(link, "upload", "link", "/processing/upload")
    if not upload.startswith("/") or any(c.isspace() for c in upload):
        raise read.fail("link", "upload", "must be a path on the HTTP port, starting with /")
    upload_as = read.choice(link, "upload_as", "link", ("multipart", "body"), "multipart")
    read.done(link, "link", {"host", "gcode_port", "http_port", "timeout", "upload", "upload_as"})

    firmware = read.table(top, "firmware")
    generation = read.choice(firmware, "generation", "firmware", GENERATIONS, "v1")
    tried = read.lines(firmware, "tried", "firmware", ())
    if not tried:
        raise read.fail("firmware", "tried", "must list the firmware packages this file has been tried with (machineInfo's package_version)")
    machine_type = read.text(firmware, "machine_type", "firmware", "")
    read.done(firmware, "firmware", {"generation", "tried", "machine_type"})

    field = read.table(top, "field")
    size = read.pair(field, "size", "field")
    flip_x = read.flag(field, "flip_x", "field", False)
    flip_y = read.flag(field, "flip_y", "field", False)
    travel_rate = read.number(field, "travel_rate", "field", 180000.0, 1.0, 1.0e7)
    read.done(field, "field", {"size", "flip_x", "flip_y", "travel_rate"})

    sources_table = read.table(top, "sources")
    sources: dict[str, str] = {}
    for name, value in sources_table.items():
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name):
            raise read.fail("sources", name, "is not a source name: lower case letters, digits, - and _")
        if not isinstance(value, str) or not value.strip() or not LINE.match(value):
            raise read.fail("sources", name, "must be the source's select line, one line of printable ASCII")
        sources[name] = value.strip()
    if not sources:
        raise read.fail(None, "sources", "must name at least one source and its select line, as blue = \"M114 S1\"")

    lines = read.table(top, "lines")
    start = read.lines(lines, "start", "lines", ())
    if start.count(SOURCE_LINE) != 1:
        raise read.fail("lines", "start", f"must hold the line {SOURCE_LINE} once, where the source's select line goes")
    end = read.lines(lines, "end", "lines", ())
    travel = read.lines(lines, "travel", "lines", ())
    cut = read.lines(lines, "cut", "lines", ())
    read.templates(travel, "travel", TRAVEL_FIELDS, {"x", "y"})
    read.templates(cut, "cut", CUT_FIELDS, {"x", "y", "s", "f"})
    for key, written in (("start", start), ("end", end)):
        for line in written:
            if line != SOURCE_LINE and ("{" in line or "}" in line):
                raise read.fail("lines", key, f"{line!r} holds a brace: only the start's {SOURCE_LINE} line is filled in")
    s_max = read.number(lines, "s_max", "lines", 1000.0, 1.0, 1.0e6)
    feed_max = read.number(lines, "feed_max", "lines", 180000.0, 1.0, 1.0e7)
    read.done(lines, "lines", {"start", "end", "travel", "cut", "s_max", "feed_max"})

    return XtoolMachine(
        id=machine.id,
        name=machine.name,
        host=host,
        gcode_port=gcode_port,
        http_port=http_port,
        timeout=timeout,
        upload=upload,
        upload_as=upload_as,
        generation=generation,
        tried=tried,
        machine_type=machine_type,
        size=size,
        flip_x=flip_x,
        flip_y=flip_y,
        travel_rate=travel_rate,
        sources=sources,
        start=start,
        end=end,
        travel=travel,
        cut=cut,
        s_max=s_max,
        feed_max=feed_max,
    )


@dataclass(frozen=True)
class XtoolFile:
    """A job written for the machine: the text handed over, how many lines
    it is, what the plan says it takes, where it lands in the field
    (x0, y0, x1, y1 in the machine's coordinates), the offset that put it
    there (board mm added before mirroring) and the source it cuts with."""

    text: str
    lines: int
    seconds: float
    bounds: tuple[float, float, float, float]
    offset: tuple[float, float]
    source: str


def board_bounds(job: Job) -> tuple[float, float, float, float] | None:
    """The box around the paths a run cuts (enabled groups, paths of two or
    more points), in board mm; None for a job with nothing to cut."""
    xs: list[float] = []
    ys: list[float] = []
    for group in job.groups:
        if not group.enabled:
            continue
        for path in group.paths:
            if len(path) < 2:
                continue
            xs.extend(float(p[0]) for p in path)
            ys.extend(float(p[1]) for p in path)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def centered(job: Job, machine: XtoolMachine) -> tuple[float, float]:
    """The offset that puts the middle of the job's paths at the middle of
    the field, where a galvo is truest."""
    bounds = board_bounds(job)
    if bounds is None:
        raise XtoolJobError(f"{job.name} has nothing to cut: no enabled group has a path")
    x0, y0, x1, y1 = bounds
    return (machine.size[0] / 2.0 - (x0 + x1) / 2.0, machine.size[1] / 2.0 - (y0 + y1) / 2.0)


def check_job(job: Job, machine: XtoolMachine) -> None:
    """Refuses, with an XtoolJobError, a job with a group the machine
    cannot run as asked; disabled groups are not looked at."""
    for group in job.groups:
        if not group.enabled:
            continue
        label = group.label
        if group.tool not in (None, LASER):
            raise XtoolJobError(f"{label} was made for a {group.tool}: {machine.name} is a laser")
        if group.focus is not None:
            raise XtoolJobError(f"{label} asks for a focus height: {machine.name} has no focus axis, clear the group's focus")
        if group.min_power > 0:
            raise XtoolJobError(f"{label} has a power floor: {machine.name} takes no floor, set the group's minimum power to 0")
        if group.joints or group.moves:
            raise XtoolJobError(f"{label} holds joint or 3D moves: {machine.name} cuts board paths only")
        if not (0.0 <= group.power <= machine.s_max):
            raise XtoolJobError(f"{label} asks for power {group.power:g}: {machine.name} takes 0 to {machine.s_max:g}")
        if not (0.0 < group.speed <= machine.feed_max):
            raise XtoolJobError(f"{label} asks for speed {group.speed:g} mm/min: {machine.name} takes above 0 to {machine.feed_max:g}")


def write(job: Job, machine: XtoolMachine, source: str | None = None, offset: tuple[float, float] | None = None) -> XtoolFile:
    """The job as one G-code file for the machine. `source` names one of
    the file's sources (its first when None); `offset` is added to every
    board point before it is mirrored into the field (the job centered
    when None). Every group is checked and every point found in the field
    before the text is returned."""
    source = machine.source if source is None else source
    if source not in machine.sources:
        raise XtoolJobError(f"{machine.name} has no source {source!r}: it has {', '.join(machine.sources)}")
    check_job(job, machine)
    if offset is None:
        offset = centered(job, machine)
    elif board_bounds(job) is None:
        raise XtoolJobError(f"{job.name} has nothing to cut: no enabled group has a path")
    dx, dy = float(offset[0]), float(offset[1])
    if not (math.isfinite(dx) and math.isfinite(dy)):
        raise XtoolJobError("the offset must be two numbers")
    width, height = machine.size

    def field_point(point: tuple[float, float], label: str) -> tuple[float, float]:
        x, y = point[0] + dx, point[1] + dy
        if not (-EDGE <= x <= width + EDGE and -EDGE <= y <= height + EDGE):
            raise XtoolJobError(
                f"{label}: the point ({x:.3f}, {y:.3f}) is outside the field of {machine.name}, 0 to {width:g} by 0 to {height:g} mm"
            )
        x, y = min(max(x, 0.0), width), min(max(y, 0.0), height)
        return (width - x if machine.flip_x else x, height - y if machine.flip_y else y)

    # The plan: the galvo's dark crossing for every rapid, each cut at the
    # lower of its feed and that. Its joints are board points, the table
    # angle 0, so the plan is the job's own order of paths and passes. It
    # starts from the board point under the field's middle, where the spot
    # rests; a first path that starts there gets its travel all the same.
    rates = Rates(r_rate=machine.travel_rate, z_rate=machine.travel_rate)
    streamer = CartesianStreamer(angle=0.0, rates=rates)
    middle = (width / 2.0 - dx, height / 2.0 - dy)
    body: list[str] = []
    seconds = 0.0
    xs: list[float] = []
    ys: list[float] = []
    started = False
    labels = {index: group.label for index, group in enumerate(job.groups)}
    for piece in streamer.job_pieces(job, middle):
        label = labels.get(piece.group, job.name) if piece.group is not None else job.name
        if piece.kind == "go":
            x, y = field_point(piece.joint, label)
            body.extend(_fill(template, x=x, y=y) for template in machine.travel)
            started = True
        elif piece.kind == "cut":
            if not started:
                # The plan begins where the spot already is: say where.
                assert piece.start is not None
                sx, sy = field_point(piece.start, label)
                body.extend(_fill(template, x=sx, y=sy) for template in machine.travel)
                xs.append(sx)
                ys.append(sy)
                started = True
            x, y = field_point(piece.joint, label)
            body.extend(_fill(template, x=x, y=y, s=piece.power, f=piece.feed) for template in machine.cut)
        else:
            raise XtoolJobError(f"{label}: a {piece.kind} move has no line on {machine.name}")
        xs.append(x)
        ys.append(y)
        seconds += piece.seconds
    if not body:
        raise XtoolJobError(f"{job.name} has nothing to cut: no enabled group has a path")
    start = [machine.sources[source] if line == SOURCE_LINE else line for line in machine.start]
    lines = [*start, *body, *machine.end]
    return XtoolFile(
        text="\n".join(lines) + "\n",
        lines=len(lines),
        seconds=seconds,
        bounds=(min(xs), min(ys), max(xs), max(ys)),
        offset=(dx, dy),
        source=source,
    )


def _fill(template: str, x: float, y: float, s: float | None = None, f: float | None = None) -> str:
    """A template's line: X and Y to the micron, S and F whole numbers."""
    values = {"x": f"{x:.{DECIMALS}f}", "y": f"{y:.{DECIMALS}f}"}
    if s is not None:
        values["s"] = str(int(round(s)))
    if f is not None:
        values["f"] = str(int(round(f)))
    return template.format(**values)


class _Reader:
    """Typed reads out of the file's own tables, each error naming the file and the key."""

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

    def text(self, table: dict, key: str, section: str, default: str) -> str:
        value = table.get(key, default)
        if not isinstance(value, str) or not LINE.match(value):
            raise self.fail(section, key, "must be one line of printable ASCII")
        return value.strip()

    def choice(self, table: dict, key: str, section: str, choices: tuple[str, ...], default: str) -> str:
        value = table.get(key, default)
        if value not in choices:
            raise self.fail(section, key, f"must be one of {', '.join(choices)}")
        return value

    def lines(self, table: dict, key: str, section: str, default: tuple[str, ...]) -> tuple[str, ...]:
        value = table.get(key, list(default))
        if not isinstance(value, list) or not all(isinstance(item, str) and LINE.match(item) for item in value):
            raise self.fail(section, key, "must be a list of lines of printable ASCII")
        return tuple(item.strip() for item in value if item.strip())

    def number(self, table: dict, key: str, section: str, default: float, low: float, high: float) -> float:
        value = table.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not (low <= value <= high):
            raise self.fail(section, key, f"must be a number from {low:g} to {high:g}")
        return float(value)

    def port(self, table: dict, key: str, default: int) -> int:
        value = table.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not (1 <= value <= 65535):
            raise self.fail("link", key, "must be a port number, 1 to 65535")
        if value == FIRMWARE_PORT:
            raise self.fail("link", key, f"is {FIRMWARE_PORT}, the F1's firmware update service, which this backend never talks to")
        return value

    def pair(self, table: dict, key: str, section: str) -> tuple[float, float]:
        if key not in table:
            raise self.fail(section, key, "is needed: the field's width and height in mm, as machineInfo's workSize says")
        value = table[key]
        if (
            not isinstance(value, list)
            or len(value) != 2
            or not all(not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and 0.0 < v <= 2000.0 for v in value)
        ):
            raise self.fail(section, key, "must be two numbers above 0 and at most 2000 mm")
        return (float(value[0]), float(value[1]))

    def flag(self, table: dict, key: str, section: str, default: bool) -> bool:
        value = table.get(key, default)
        if not isinstance(value, bool):
            raise self.fail(section, key, "must be true or false")
        return value

    def done(self, table: dict, section: str, known: set[str]) -> None:
        unknown = sorted(set(table) - known)
        if unknown:
            raise self.fail(section, unknown[0], "is not a key here")

    def templates(self, lines: tuple[str, ...], key: str, allowed: frozenset[str], needed: set[str]) -> None:
        """Each template's placeholders are bare names it may hold, and
        between them the lines say every one that is needed."""
        if not lines:
            raise self.fail("lines", key, f"must list the {key}'s line templates, holding {', '.join('{' + name + '}' for name in sorted(needed))}")
        seen: set[str] = set()
        for line in lines:
            try:
                parts = list(string.Formatter().parse(line))
            except ValueError as exc:
                raise self.fail("lines", key, f"{line!r} is not a template: {exc}") from None
            for _, name, spec, conversion in parts:
                if name is None:
                    continue
                if name not in allowed or spec or conversion:
                    raise self.fail(
                        "lines", key, f"{line!r} holds {{{name}}}: a {key} line may hold only {', '.join('{' + n + '}' for n in sorted(allowed))}"
                    )
                seen.add(name)
        missing = sorted(needed - seen)
        if missing:
            raise self.fail("lines", key, f"never says {', '.join('{' + name + '}' for name in missing)}")
