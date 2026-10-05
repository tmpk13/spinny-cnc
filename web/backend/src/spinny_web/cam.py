"""CAM profiles for the page: the files in `cam/` listed, read, saved and
patched, a design taken through one into a job, and a stored job written as
gcode for the profile's controller."""

from __future__ import annotations

import os
from pathlib import Path

from laser_sweep import isocli
from spinny_laser import cam, camjob, post
from spinny_laser.cam import CamError, Profile

from .jobs import Group, Job, JobImportError, Offset, from_json, svg_polylines
from .kinematics import Streamer

SVG_SUFFIXES = (".svg",)
GCODE_SUFFIXES = (".gcode", ".nc", ".ngc")


class NotFound(LookupError):
    """No profile, or no job, of that id."""


class ProfileStore:
    """The profiles in one directory, read afresh on every call so an edit
    by hand shows at once; saved all or nothing after a parse."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)

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
            self.directory.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + ".tmp")
            temporary.write_text(text, encoding="utf-8")
            os.replace(temporary, path)
        except OSError as exc:
            raise CamError(f"cannot write {path}: {exc.strerror or exc}") from exc
        return {"document": profile.document(), "text": text}

    def patch(self, profile_id: str, path: list, value) -> dict:
        changed = cam.set_value(self.text(profile_id), tuple(path), value)
        return self.save(profile_id, changed)

    def remove(self, profile_id: str) -> None:
        path = self.path(profile_id)
        try:
            path.unlink()
        except FileNotFoundError:
            raise NotFound(f"no profile {profile_id!r}") from None
        except OSError as exc:
            raise CamError(f"cannot remove {path}: {exc.strerror or exc}") from exc


# --- designs --------------------------------------------------------------------


def pick_design(folder: Path, layer: str) -> tuple[Path, list[str]]:
    """Which of the uploaded files is the design: a KiCad board, else the
    copper gerber of the profile's layer (the other gerbers and the drill
    file are its siblings, read beside it), else the one file that is not a
    board layer. The rest are named in the notes."""
    files = sorted(p for p in folder.iterdir() if p.is_file())
    if not files:
        raise JobImportError("the upload holds no file")
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
    suffix = path.suffix.lower()
    place = profile.placement
    if suffix in camjob.BOARD_SUFFIXES:
        return camjob.read_board(path, place.layer)
    if suffix in SVG_SUFFIXES:
        shapes = svg_polylines(path.read_text(encoding="utf-8"), tolerance)
        if not shapes:
            raise JobImportError("the SVG has no shapes to cut")
        sets: dict[str, camjob.PathSet] = {}
        for color, points in shapes:
            label = "no stroke" if color == "no stroke" else f"stroke {color}"
            sets.setdefault(color, camjob.PathSet(label, [])).paths.append([tuple(p) for p in points])
        design = camjob.Design(name=path.stem, source="svg", paths=list(sets.values()))
    elif suffix in GCODE_SUFFIXES:
        design = camjob.read_gcode(path.read_text(encoding="utf-8", errors="replace"), path.stem)
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
    """The uploaded files in `folder` through the profile, priced by the streamer."""
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
                paths=[[tuple(p) for p in path_] for path_ in group.paths],
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
    written for the profile's first tool's kind."""
    default = profile.tools[0].kind
    groups = []
    for group in job.groups:
        if group.joints:
            raise post.PostError(f"{group.label}: a joint-space group has no board paths to write")
        tool = group.tool or default
        height = None
        if tool == cam.LASER:
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
