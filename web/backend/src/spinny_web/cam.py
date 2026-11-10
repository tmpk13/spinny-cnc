"""CAM profiles for the page: the files in `cam/` listed, read, saved and
patched, a design taken through one into a job, and a stored job written as
gcode for the profile's controller."""

from __future__ import annotations

import threading
from pathlib import Path

from laser_sweep import isocli
from spinny_laser import cam, camjob, post
from spinny_laser.cam import CamError, Profile

from .files import write_whole
from .jobs import Group, Job, JobImportError, NotFound, Offset, from_json, svg_polylines
from .kinematics import Streamer

SVG_SUFFIXES = (".svg",)


class ProfileStore:
    """The profiles in one directory, read afresh on every call so an edit
    by hand shows at once; saved all or nothing after a parse."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        # Writes take turns: a patch reads the file, changes a line and
        # writes it whole, and a write in between would be lost under it.
        self._writing = threading.RLock()

    def list(self) -> dict:
        profiles, problems = cam.load_all(self.directory)
        return {"profiles": [profile.summary() for profile in profiles], "problems": problems}

    def path(self, profile_id: str) -> Path:
        cam.check_id(profile_id)
        return self.directory / f"{profile_id}.toml"

    def text(self, profile_id: str) -> str:
        path = self.path(profile_id)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise NotFound(f"no profile {profile_id!r}") from None
        except OSError as exc:
            raise CamError(f"{path}: {exc.strerror or exc}") from exc

    def get(self, profile_id: str) -> Profile:
        return cam.parse(self.text(profile_id), profile_id, f"{profile_id}.toml")

    def document(self, profile_id: str) -> dict:
        text = self.text(profile_id)
        return {"document": cam.parse(text, profile_id, f"{profile_id}.toml").document(), "text": text}

    def save(self, profile_id: str, text: str) -> dict:
        """Writes the text as the profile, once it reads as one; a text that
        does not leaves the file as it was."""
        path = self.path(profile_id)
        profile = cam.parse(text, profile_id, f"{profile_id}.toml")
        if not text.endswith("\n"):
            text += "\n"
        try:
            with self._writing:
                self.directory.mkdir(parents=True, exist_ok=True)
                write_whole(path, text)
        except OSError as exc:
            raise CamError(f"cannot write {path}: {exc.strerror or exc}") from exc
        return {"document": profile.document(), "text": text}

    def patch(self, profile_id: str, path: list, value) -> dict:
        with self._writing:
            changed = cam.set_value(self.text(profile_id), tuple(path), value)
            return self.save(profile_id, changed)

    def remove(self, profile_id: str) -> None:
        path = self.path(profile_id)
        try:
            with self._writing:
                path.unlink()
        except FileNotFoundError:
            raise NotFound(f"no profile {profile_id!r}") from None
        except OSError as exc:
            raise CamError(f"cannot remove {path}: {exc.strerror or exc}") from exc


# --- designs --------------------------------------------------------------------


def pick_design(folder: Path, layer: str) -> tuple[Path, list[str]]:
    """Which of the uploaded files is the design: a KiCad board, else the
    copper gerber of the profile's layer (the other gerbers and the drill
    files are its siblings, read beside it, which names a drill file it
    leaves out), else the one file that is not a board layer. The rest are
    named in the notes."""
    files = sorted(p for p in folder.iterdir() if p.is_file())
    if not files:
        raise JobImportError("the upload holds no file")
    meshes = [p for p in files if p.suffix.lower() in camjob.MODEL_SUFFIXES]
    if meshes:
        return meshes[0], [f"{p.name} is not read: one model a job" for p in files if p is not meshes[0]]
    boards = [p for p in files if p.suffix.lower() == ".kicad_pcb"]
    if boards:
        return boards[0], [f"{p.name} is not read: the board file has every layer" for p in files if p is not boards[0]]
    gerbers = [p for p in files if p.suffix.lower() in camjob.GERBER_SUFFIXES]
    if gerbers:
        suffix = isocli.layer_suffix(layer)
        copper = [p for p in gerbers if suffix in p.name] or gerbers
        others = [p for p in files if p.suffix.lower() not in camjob.GERBER_SUFFIXES and p.suffix.lower() != ".drl"]
        return copper[0], [f"{p.name} is not read beside a board" for p in others]
    return files[0], [f"{p.name} is not read: one design a job" for p in files[1:]]


def read_design(path: Path, profile: Profile, tolerance: float) -> camjob.Design:
    """A design from an uploaded file: an SVG's shapes or a job's board
    paths here, placed as the profile says, and whatever the toolpath
    library reads (`camjob.read_design`) there."""
    suffix = path.suffix.lower()
    place = profile.placement
    if suffix in camjob.DESIGN_SUFFIXES:
        return camjob.read_design(path, place)
    if suffix in SVG_SUFFIXES:
        shapes = svg_polylines(path.read_text(encoding="utf-8"), tolerance)
        if not shapes:
            raise JobImportError("the SVG has no shapes to cut")
        sets: dict[str, camjob.PathSet] = {}
        for color, points in shapes:
            label = "no stroke" if color == "no stroke" else f"stroke {color}"
            sets.setdefault(color, camjob.PathSet(label, [])).paths.append([tuple(p) for p in points])
        design = camjob.Design(name=path.stem, source="svg", paths=list(sets.values()))
    elif suffix == ".json":
        job = from_json(path.read_text(encoding="utf-8"), path.stem)
        sets_ = [camjob.PathSet(group.label, [[tuple(p) for p in path_] for path_ in group.paths]) for group in job.groups if group.paths]
        if not sets_:
            raise JobImportError("the job has no board paths")
        design = camjob.Design(name=path.stem, source="json", paths=sets_, outline=[[tuple(p) for p in o] for o in job.outline])
    else:
        raise JobImportError(f"cannot read {path.name}: unknown file type {suffix!r}")
    design.paths = camjob.place_paths(design.paths, place.anchor, place.offset)
    return design


def build_job(profile: Profile, folder: Path, name: str | None, streamer: Streamer) -> tuple[Job, list[str]]:
    """The uploaded files in `folder` through the profile, priced by the
    streamer. A 3D model is planned by the kernel and is read from the
    folder before it goes."""
    path, notes = pick_design(folder, profile.placement.layer)
    try:
        design = read_design(path, profile, streamer.tolerance)
        pace = streamer.rates.r_rate / streamer.rates.a_rate if streamer.rates.a_rate > 0 else camjob.copper_clearing.DEFAULT_PACE
        built = camjob.build(profile, design, name or None, tolerance=streamer.tolerance, pace=pace)
    except (camjob.DesignError, ValueError) as exc:
        raise JobImportError(str(exc)) from exc
    job = Job(
        name=built.name,
        source=built.source,
        layer=design.layer,
        spot=built.spot,
        offset=Offset(x=built.offset[0], y=built.offset[1]),
        groups=[
            Group(
                label=group.label,
                power=group.power,
                min_power=group.min_power,
                speed=group.speed,
                passes=group.passes,
                enabled=group.enabled,
                depth=group.depth,
                plunge=group.plunge,
                tool=group.tool,
                tool_id=group.tool_id,
                tool_name=group.tool_name,
                height=group.height,
                paths=[[tuple(p) for p in path_] for path_ in group.paths],
                moves=[[tuple(m) for m in path_] for path_ in group.moves],
            )
            for group in built.groups
        ],
        outline=[[tuple(p) for p in path_] for path_ in built.outline],
        copper=[[tuple(p) for p in path_] for path_ in built.copper],
    )
    job.refresh_stats(streamer)
    return job, notes + built.notes


# --- gcode ------------------------------------------------------------------------


def built_of(job: Job, profile: Profile) -> camjob.BuiltJob:
    """A stored job as the post takes it. A group that says no tool is
    written for the profile's first tool's kind. A laser group a profile
    made keeps the height its operation gave it, or none; one made
    otherwise (a drawing, a Plot job) takes the first laser tool's that
    gives one."""
    default = profile.tools[0].kind
    groups = []
    for group in job.groups:
        if group.joints:
            raise post.PostError(f"{group.label}: a joint-space group has no board paths to write")
        tool = group.tool or default
        height = None
        if tool == cam.LASER:
            height = group.height
            if height is None and group.tool_id is None:
                heights = [t.settings.get("height") for t in profile.tools if t.kind == cam.LASER and "height" in t.settings]
                height = heights[0] if heights else None
        groups.append(
            camjob.BuiltGroup(
                label=group.label,
                tool=tool,
                power=group.power,
                min_power=group.min_power,
                speed=group.speed,
                passes=group.passes,
                depth=group.depth,
                plunge=group.plunge,
                paths=[[tuple(p) for p in path_] for path_ in group.paths],
                enabled=group.enabled,
                height=height,
                moves=[[(float(x), float(y), float(z), int(kind)) for x, y, z, kind in path_] for path_ in group.moves],
                tool_id=group.tool_id,
                tool_name=group.tool_name,
            )
        )
    return camjob.BuiltJob(
        name=job.name,
        source=job.source,
        spot=job.spot,
        offset=(job.offset.x, job.offset.y),
        groups=groups,
        outline=[[tuple(p) for p in path_] for path_ in job.outline],
        copper=[[tuple(p) for p in path_] for path_ in job.copper],
        notes=[],
    )


def gcode_of(job: Job, profile: Profile) -> dict:
    program = post.post(built_of(job, profile), profile)
    stem = "".join(c if c.isalnum() or c in "-_." else "_" for c in job.name) or "job"
    return {"text": program.text, "report": program.report.document(), "filename": f"{stem}.nc"}


# --- the page's twin ----------------------------------------------------------------

# Jobs written through profiles of their own, which the page's mock post is
# checked against line for line (mise run cam-fixture): rapids, plunges and
# cuts, feeds held to the axes' rates, a stop to change the bit, a laser's
# height, the words' decimals, the report, and the refusals. The profiles
# are written here rather than read from cam/, whose files are the
# operator's to edit.
TWIN_PROFILE = """
name = "Twin bench"
[[axes]]
letter = "X"
role = "x"
min = 0
max = 100
rate = 3000
rapid = 6000
offset = 1.5
home = 0
[[axes]]
letter = "Y"
role = "y"
rate = 1000
rapid = 4000
home = 0
[[axes]]
letter = "Z"
role = "depth"
min = -1.5
rate = 300
rapid = 900
safe = 4
home = 10
[[axes]]
letter = "A"
kind = "rotary"
role = "setup"
park = 15
home = 0
[[tools]]
id = "diode"
kind = "laser"
spot = 0.1
power = 300
speed = 2000
height = 2
[[tools]]
id = "vbit"
kind = "mill"
name = "V bit"
diameter = 0.2
rpm = 12000
feed = 300
plunge = 600
[[operations]]
name = "marks"
source = "paths"
tool = "diode"
[post]
spinup = 1.5
"""

PLAIN_PROFILE = """
name = "Plain mill"
[[axes]]
letter = "X"
role = "x"
[[axes]]
letter = "Y"
role = "y"
[[axes]]
letter = "Z"
role = "depth"
safe = 2.5
[[tools]]
id = "flat"
kind = "mill"
diameter = 1
rpm = 9000
feed = 250
[[tools]]
id = "beam"
kind = "laser"
spot = 0.1
power = 80
speed = 900
[[operations]]
name = "cut"
source = "outline"
tool = "flat"
[post]
header = ["G21", "G90"]
footer = ["M30"]
spindle_on = "M4"
laser_on = "M3"
spinup = 0
decimals = 2
return_home = false
"""

LASER_ONLY_PROFILE = """
[[axes]]
letter = "X"
role = "x"
[[axes]]
letter = "Y"
role = "y"
[[tools]]
id = "beam"
kind = "laser"
spot = 0.1
power = 80
speed = 900
[[operations]]
name = "cut"
source = "paths"
tool = "beam"
"""

MODEL_MOVES = [
    [[0.0, 0.0, 1.0, 0], [0.0, 0.0, -0.5, 2], [10.0, 0.0, -0.5, 1], [10.0, 10.0, -1.0, 1], [10.0, 10.0, 2.0, 0], [12.0, 10.0, 2.0, 0], [12.0, 10.0, -0.2, 2]],
    [[20.0, 0.0, 0.5, 1], [21.0, 0.0, 0.5, 1]],
]

TWIN_SAMPLES: list[dict] = [
    {
        "name": "laser and spindle on one depth axis",
        "profile": TWIN_PROFILE,
        "job": {
            "name": "twin (a)\nM3 S1",
            "groups": [
                {"label": "marks", "tool": "laser", "tool_id": "diode", "tool_name": "Diode", "height": 3, "power": 300, "min_power": 50,
                 "speed": 2000, "passes": 2, "paths": [[[20, 0], [30, 0]], [[20, -0.0006], [25, -0.0006], [25, 5]], [[40, 0]]]},
                {"label": "slot", "tool": "spindle", "tool_id": "vbit", "tool_name": "V bit", "power": 12000, "speed": 300, "plunge": 600,
                 "depth": 0.3, "passes": 2, "paths": [[[10, 10], [15, 10], [15, 12]], [[5, 5]]]},
                {"label": "holes", "tool": "spindle", "tool_id": "drill", "power": 8000, "speed": 100, "plunge": 50, "depth": 1.8,
                 "paths": [[[1, 1]], [[2, 1]]]},
                {"label": "off", "tool": "spindle", "tool_id": "other", "enabled": False, "power": 1, "paths": [[[0, 0], [1, 1]]]},
                {"label": "drawn", "power": 120, "speed": 600, "paths": [[[50, 50], [60, 50]]]},
                {"label": "traced", "tool": "laser", "tool_id": "beam", "power": 50, "speed": 600, "paths": [[[70, 50], [80, 50]]]},
                {"label": "model: V bit", "tool": "spindle", "tool_id": "vbit", "tool_name": "V bit", "power": 11000, "speed": 300,
                 "plunge": 600, "depth": 1.0, "moves": MODEL_MOVES},
            ],
        },
    },
    {
        "name": "the post's own words",
        "profile": PLAIN_PROFILE,
        "job": {
            "name": "Platine-\N{LATIN SMALL LETTER E WITH ACUTE}t\N{LATIN SMALL LETTER E WITH ACUTE} 1/2",
            "groups": [
                {"label": "edge", "tool": "spindle", "power": 9000.5, "speed": 250, "plunge": 60, "depth": 0.25,
                 "paths": [[[0.004, -0.004], [3.333333, 0.004], [3.333333, 7.125]]]},
                {"label": "mark", "tool": "laser", "power": 80, "speed": 900, "paths": [[[1, 1], [2, 2]]]},
                {"label": "edge again", "tool": "spindle", "power": 9000.5, "speed": 250, "plunge": 60, "depth": 0.25,
                 "paths": [[[0, 0], [1, 0]]]},
            ],
        },
    },
    {
        "name": "nothing enabled",
        "profile": TWIN_PROFILE,
        "job": {"name": "off", "groups": [{"label": "a", "enabled": False, "paths": [[[0, 0], [1, 0]]]}, {"label": "b", "paths": []}]},
    },
    {
        "name": "a joint-space group",
        "profile": TWIN_PROFILE,
        "job": {"name": "j", "groups": [{"label": "rail", "paths": [[[1, 0], [2, 0]]], "joints": [[[1, 0], [2, 0]]]}]},
    },
    {
        "name": "a spindle without a depth axis",
        "profile": LASER_ONLY_PROFILE,
        "job": {"name": "m", "groups": [{"label": "slot", "tool": "spindle", "power": 9000, "paths": [[[0, 0], [1, 0]]]}]},
    },
    {
        "name": "a spindle at no speed",
        "profile": PLAIN_PROFILE,
        "job": {"name": "s0", "groups": [{"label": "slot", "tool": "spindle", "power": 0, "paths": [[[0, 0], [1, 0]]]}]},
    },
]


def twin_samples() -> list[dict]:
    """Every sample with what the backend writes for it: the program and
    its report, or the refusal."""
    out = []
    for sample in TWIN_SAMPLES:
        job = Job.model_validate(sample["job"])
        entry: dict = {"name": sample["name"], "profile": sample["profile"], "job": job.model_dump(mode="json")}
        try:
            entry["written"] = gcode_of(job, cam.parse(sample["profile"], "twin"))
        except post.PostError as exc:
            entry["error"] = str(exc)
        out.append(entry)
    return out


if __name__ == "__main__":
    import json

    print(json.dumps(twin_samples(), indent=1))
