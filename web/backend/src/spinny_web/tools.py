"""The tools a language model is given: one registry, served to any MCP
client by `spinny-mcp` and to the Auto tab's agent inside the backend.

A tool is a thin call on the backend's own HTTP API, so it can do nothing
a page could not do, and the list holds only tools that make, change or
read data: jobs, Plot page jobs, markers, the references and plans of a
pick and place machine, CAM jobs, and the state, machine files and CAM
profiles to read. No tool connects or disconnects the machine, jogs, goes
to a point, homes, runs, holds or stops a job, lights the laser, starts
the spindle, probes, starts a camera routine, moves a pick and place
machine, or writes the firmware's settings or a machine or CAM file. Every
tool names the routes it calls; a request to any other route is refused
before it leaves the client, and the tests hold the routes against a list
of routes that move nothing.
"""

from __future__ import annotations

import json
import math
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx
from jsonschema import Draft202012Validator

# How much of an answer the model reads, characters: a board job's paths
# run to megabytes, which no model needs and no context holds.
MAX_RESULT = 20000
# How long one call may take, s: a large board imported on a Pi is slow.
TIMEOUT = 300.0
# The largest file a tool writes for an upload, characters.
MAX_CONTENT = 2_000_000
# What a job, a profile and a file name may look like. The ids go into
# paths, so nothing that could step out of its segment passes.
JOB_ID = r"^[A-Za-z0-9_-]{1,64}$"
PROFILE_ID = r"^[a-z0-9][a-z0-9_-]{0,63}$"
FILE_NAME = r"^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,119}$"
# What a tool may change that the page shows: a tool marked with `jobs`
# has the page list the jobs again once it has run.
JOBS, MARKERS, PLACEMENT = "jobs", "markers", "placement"

# What a model is told about the machine and the tools, whichever front
# end serves them: the Auto tab's agent puts it in its system prompt, the
# MCP server gives it as the server's instructions.
GUIDE = """\
The machine cuts printed circuit boards and parts: a laser over a rotary
table (polar), or an X/Y machine with a laser, a spindle or a solder paste
dispenser; or, connected in its place, a pick and place machine on its own
G-code controller (a machine file with controller = "gcode"). These tools
make and change its data: jobs, Plot page jobs, markers, the references
and plans of a pick and place machine, and CAM jobs; and they read its
state, its machine files and its CAM profiles.

What they cannot do, by design: connect or disconnect the machine, move
it, home it, run, hold or stop a job, light the laser, start the spindle,
probe, start a camera routine, move a pick and place machine, or change the
firmware's settings or a machine or CAM file. When one of these is wanted,
make what it needs and tell the operator what to press on the page: a job
runs from the Jobs tab (a Plot job from the Plot tab too), a placement
from the PNP tab.

Units: lengths in mm in the board frame (on the polar machine the origin
is the table's rotation axis; on an X/Y machine it is where the operator
set zero), feeds in mm/min, laser power and spindle speed as the
firmware's S (0 to its s_max, 1000 unless set otherwise). A job is groups
of paths; each group has its own power, speed and passes, and a run cuts
the enabled groups in order.

Look before you make: get_state says which machine and tool the jobs are
for, list_jobs what is there already. After making or changing a job,
check it with get_job (its extent) and say what you made, with its id.
"""


class ToolError(Exception):
    """A call the backend refused, with what it said."""


@dataclass(frozen=True)
class Route:
    """A method and a path; a `{name}` segment of the path stands for any
    one segment."""

    method: str
    path: str

    def matches(self, method: str, path: str) -> bool:
        if method.upper() != self.method:
            return False
        want = self.path.split("/")
        have = path.split("/")
        return len(want) == len(have) and all(
            w == h or (w.startswith("{") and w.endswith("}") and h != "") for w, h in zip(want, have)
        )


def permitted(routes: Iterable[Route], method: str, path: str) -> bool:
    return any(route.matches(method, path) for route in routes)


@dataclass(frozen=True)
class Outcome:
    """What a call came to: the text the model reads, whether it failed,
    and what it changed that the page shows."""

    text: str
    error: bool = False
    changed: tuple[str, ...] = ()


class ToolApi:
    """The backend's API as one tool may use it: only the routes the tool
    names, each answer read as JSON (or text), a refusal raised with the
    backend's reason."""

    def __init__(self, client: httpx.AsyncClient, routes: tuple[Route, ...]) -> None:
        self.client = client
        self.routes = routes

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not permitted(self.routes, method, path):
            raise ToolError(f"{method} {path} is not one of this tool's routes")
        response = await self.client.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise ToolError(f"{response.status_code}: {_detail(response)}")
        if "json" in response.headers.get("content-type", ""):
            return response.json()
        return response.text

    async def get(self, path: str, params: dict | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, body: Any = None) -> Any:
        return await self.request("POST", path, json=body)

    async def put(self, path: str, body: Any) -> Any:
        return await self.request("PUT", path, json=body)

    async def patch(self, path: str, body: Any) -> Any:
        return await self.request("PATCH", path, json=body)

    async def delete(self, path: str, params: dict | None = None) -> Any:
        return await self.request("DELETE", path, params=params)

    async def upload(self, path: str, files: list[tuple[str, tuple[str, bytes, str]]], data: dict[str, str]) -> Any:
        return await self.request("POST", path, files=files, data=data)


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:2000] or response.reason_phrase
    if isinstance(body, dict) and "detail" in body:
        detail = body["detail"]
        return detail if isinstance(detail, str) else json.dumps(detail)[:2000]
    return json.dumps(body)[:2000]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    schema: dict
    routes: tuple[Route, ...]
    run: Callable[[ToolApi, dict], Awaitable[Any]]
    # What the tool changes that the page shows, whether it only reads,
    # and whether it can take away data that was there (a job, a marker).
    changes: tuple[str, ...] = ()
    read_only: bool = False
    destructive: bool = False
    validator: Draft202012Validator = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        Draft202012Validator.check_schema(self.schema)
        object.__setattr__(self, "validator", Draft202012Validator(self.schema))


def seg(value: Any) -> str:
    """One path segment, quoted."""
    return quote(str(value), safe="")


def as_text(value: Any) -> str:
    """An answer as the model reads it, cut to `MAX_RESULT` characters."""
    text = value if isinstance(value, str) else json.dumps(value, indent=1)
    if len(text) > MAX_RESULT:
        text = text[:MAX_RESULT] + f"\n[cut at {MAX_RESULT} of {len(text)} characters]"
    return text


def _extent(paths: Iterable[Iterable[Any]]) -> list[float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for path in paths:
        for point in path:
            x, y = float(point[0]), float(point[1])
            if math.isfinite(x) and math.isfinite(y):
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]


def slim_job(job: dict) -> dict:
    """A job with its geometry counted rather than listed: every group's
    settings, its number of paths and the box round them, and the box
    round the whole job, `[x min, y min, x max, y max]` in mm."""
    if not isinstance(job, dict):
        return job
    heavy = ("groups", "outline", "copper", "pads", "holes")
    out = {key: value for key, value in job.items() if key not in heavy}
    groups = []
    every: list[Any] = []
    for index, group in enumerate(job.get("groups") or []):
        shown = {key: value for key, value in group.items() if key not in ("paths", "joints", "moves", "areas")}
        paths = group.get("paths") or []
        moves = group.get("moves") or []
        drawn = paths or [[(m[0], m[1]) for m in path] for path in moves]
        shown["index"] = index
        shown["paths"] = len(paths)
        if group.get("joints"):
            shown["joints"] = len(group["joints"])
        if moves:
            shown["moves"] = len(moves)
        shown["extent"] = _extent(drawn)
        every.extend(drawn)
        groups.append(shown)
    out["groups"] = groups
    for key in heavy[1:]:
        out[key] = len(job.get(key) or [])
    out["extent"] = _extent(every)
    return out


def _slim_made(answer: Any) -> Any:
    """A `{"job": ..., "notes": ...}` answer with its job made slim."""
    if isinstance(answer, dict) and isinstance(answer.get("job"), dict):
        return {**answer, "job": slim_job(answer["job"])}
    return answer


def obj(properties: dict, required: Iterable[str] = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def text(description: str, **extra: Any) -> dict:
    return {"type": "string", "description": description, **extra}


def number(description: str, **extra: Any) -> dict:
    return {"type": "number", "description": description, **extra}


def integer(description: str, **extra: Any) -> dict:
    return {"type": "integer", "description": description, **extra}


def flag(description: str) -> dict:
    return {"type": "boolean", "description": description}


def point_list(description: str) -> dict:
    return {
        "type": "array",
        "description": description,
        "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
        "maxItems": 5000,
    }


JOB = text("the job's id, as list_jobs gives it", pattern=JOB_ID)
CAM_PROFILE = text("the CAM profile's id, as list_cam_profiles gives it", pattern=PROFILE_ID)
MACHINE = text("the machine file's id, as list_machine_files gives it", pattern=PROFILE_ID)
REF = text("a part's reference on the board, such as R1 or U3", minLength=1, maxLength=64)
REFS = {"type": "array", "items": REF, "maxItems": 2000, "description": "the parts to place; left out, every part that can be"}
NO_ARGUMENTS = obj({})


# --- reading ------------------------------------------------------------------


async def _get_state(api: ToolApi, args: dict) -> Any:
    return await api.get("/api/state")


async def _list_jobs(api: ToolApi, args: dict) -> Any:
    return await api.get("/api/jobs")


async def _get_job(api: ToolApi, args: dict) -> Any:
    job = await api.get(f"/api/jobs/{seg(args['job_id'])}")
    return job if args.get("full") else slim_job(job)


async def _list_machine_files(api: ToolApi, args: dict) -> Any:
    return await api.get("/api/machines")


async def _get_machine_file(api: ToolApi, args: dict) -> Any:
    return await api.get(f"/api/machines/{seg(args['machine_id'])}")


async def _list_cam_profiles(api: ToolApi, args: dict) -> Any:
    return await api.get("/api/cam")


async def _get_cam_profile(api: ToolApi, args: dict) -> Any:
    return await api.get(f"/api/cam/{seg(args['profile_id'])}")


async def _list_markers(api: ToolApi, args: dict) -> Any:
    return await api.get("/api/markers")


async def _list_board_parts(api: ToolApi, args: dict) -> Any:
    return await api.get(f"/api/jobs/{seg(args['job_id'])}/components")


async def _get_placement(api: ToolApi, args: dict) -> Any:
    return await api.get("/api/pnp/placing")


async def _list_search_records(api: ToolApi, args: dict) -> Any:
    params: dict = {"limit": args.get("limit", 20)}
    if args.get("camera"):
        params["camera"] = args["camera"]
    return await api.get("/api/searchlog", params)


async def _get_search_record(api: ToolApi, args: dict) -> Any:
    answer = await api.get(f"/api/searchlog/{seg(args['record_id'])}")
    if not isinstance(answer, dict):
        return answer
    # The summary is the reading; of the header only what it was looked
    # with: the stops' list and the board map are long and add nothing.
    header = answer.get("record") or {}
    kept = ("id", "kind", "camera", "started", "job", "board", "picture", "settings", "pcbv", "box", "view_mm", "outcome")
    return {"record": {key: header[key] for key in kept if key in header}, "summary": answer.get("summary")}


# --- jobs ---------------------------------------------------------------------


UPLOAD_OPTIONS = ("power", "speed", "spot", "passes", "anchor", "offset_x", "offset_y")


async def _make_job(api: ToolApi, args: dict) -> Any:
    data = {key: str(args[key]) for key in UPLOAD_OPTIONS if args.get(key) is not None}
    files = [("file", (args["filename"], args["content"].encode("utf-8"), "application/octet-stream"))]
    return slim_job(await api.upload("/api/jobs", files, data))


async def _change_job(api: ToolApi, args: dict) -> Any:
    patch = {key: args[key] for key in ("name", "offset", "turn", "about", "groups") if key in args}
    return slim_job(await api.patch(f"/api/jobs/{seg(args['job_id'])}", patch))


async def _replace_job(api: ToolApi, args: dict) -> Any:
    return slim_job(await api.put(f"/api/jobs/{seg(args['job_id'])}", args["job"]))


async def _set_job_width(api: ToolApi, args: dict) -> Any:
    return slim_job(await api.post(f"/api/jobs/{seg(args['job_id'])}/width", {"width": args["width"]}))


async def _set_stencil_margin(api: ToolApi, args: dict) -> Any:
    return slim_job(await api.post(f"/api/jobs/{seg(args['job_id'])}/margin", {"margin": args["margin"]}))


async def _delete_job(api: ToolApi, args: dict) -> Any:
    return await api.delete(f"/api/jobs/{seg(args['job_id'])}")


# --- the Plot page ----------------------------------------------------------------


async def _plan_plot_job(api: ToolApi, args: dict) -> Any:
    return _slim_made(await api.post("/api/mill/plan", args))


async def _make_plot_job(api: ToolApi, args: dict) -> Any:
    return _slim_made(await api.post("/api/mill", args))


async def _set_plot_job_operations(api: ToolApi, args: dict) -> Any:
    body = {"ops": args["operations"], "name": args.get("name"), "job": args.get("job")}
    if body["name"] is None and body["job"] is not None:
        # A job given keeps its own name unless a new one is asked for.
        job = await api.get(f"/api/jobs/{body['job']}")
        body["name"] = job.get("name") if isinstance(job, dict) else None
    return _slim_made(await api.post("/api/mill", body))


async def _combine_jobs(api: ToolApi, args: dict) -> Any:
    return slim_job(await api.post("/api/jobs/combine", {"ids": args["job_ids"], "name": args.get("name")}))


# --- markers ----------------------------------------------------------------------


async def _save_marker(api: ToolApi, args: dict) -> Any:
    markers = (await api.get("/api/markers"))["markers"]
    marker = {"name": args["name"].strip(), "x": args["x"], "y": args["y"]}
    names = [entry["name"] for entry in markers]
    if marker["name"] in names:
        markers[names.index(marker["name"])] = marker
    else:
        markers.append(marker)
    return await api.put("/api/markers", {"markers": markers})


async def _delete_marker(api: ToolApi, args: dict) -> Any:
    markers = (await api.get("/api/markers"))["markers"]
    kept = [entry for entry in markers if entry["name"] != args["name"].strip()]
    if len(kept) == len(markers):
        raise ToolError(f"no marker is named {args['name']!r}")
    return await api.put("/api/markers", {"markers": kept})


# --- CAM ----------------------------------------------------------------------------


async def _make_cam_job(api: ToolApi, args: dict) -> Any:
    files = [("files", (entry["name"], entry["content"].encode("utf-8"), "application/octet-stream")) for entry in args["files"]]
    data = {"name": args["name"]} if args.get("name") else {}
    return _slim_made(await api.upload(f"/api/cam/{seg(args['profile_id'])}/jobs", files, data))


async def _export_gcode(api: ToolApi, args: dict) -> Any:
    return await api.post(f"/api/cam/{seg(args['profile_id'])}/gcode", {"job": args["job_id"]})


# --- pick and place -----------------------------------------------------------------


async def _set_placement_angle(api: ToolApi, args: dict) -> Any:
    return await api.put("/api/pnp/placing", {key: args[key] for key in ("angle", "clear_angle") if key in args})


async def _set_placement_reference(api: ToolApi, args: dict) -> Any:
    # The place is always given: left out, the backend would ask the
    # machine where its nozzle is, which is talking to the machine.
    body = {"job": args["job_id"], "ref": args["ref"], "at": [args["x"], args["y"]]}
    return await api.post("/api/pnp/references", body)


async def _drop_placement_references(api: ToolApi, args: dict) -> Any:
    params = {"job": args["job_id"]}
    if args.get("ref"):
        params["ref"] = args["ref"]
    return await api.delete("/api/pnp/references", params=params)


async def _plan_placement(api: ToolApi, args: dict) -> Any:
    body: dict = {"job": args["job_id"]}
    if args.get("refs") is not None:
        body["refs"] = args["refs"]
    return await api.post("/api/pnp/plan", body)


async def _get_placement_program(api: ToolApi, args: dict) -> Any:
    params = {"job": args["job_id"]}
    if args.get("refs"):
        params["refs"] = ",".join(args["refs"])
    return await api.get("/api/pnp/program.gcode", params=params)


# --- the schemas of the larger tools --------------------------------------------------


MAKE_JOB = obj(
    {
        "filename": text(
            "the file's name, whose suffix says what it is: .svg (a drawing in mm, one group per stroke"
            " color), .dxf (an ASCII DXF drawing, one group per layer, mm unless its $INSUNITS says otherwise),"
            " .gcode or .nc (absolute X/Y G0/G1 moves with S and F), or .json (a job: name and groups,"
            " each with label, power, speed, passes and paths as lists of [x, y] in mm); the name without"
            " the suffix becomes the job's name",
            pattern=r"^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,110}\.(svg|dxf|gcode|nc|ngc|json)$",
        ),
        "content": text("the whole file", minLength=1, maxLength=MAX_CONTENT),
        "power": number("laser power (or spindle speed) for a drawing's groups, the firmware's S", minimum=0),
        "speed": number("feed for a drawing's groups, mm/min", exclusiveMinimum=0),
        "spot": number("the beam's width, or the bit's, mm; the job remembers it", exclusiveMinimum=0, maximum=1000),
        "passes": integer("isolation passes; leave out for a drawing", minimum=1, maximum=50),
        "anchor": text("center puts the drawing's middle at the offset; keep leaves its coordinates as they are", enum=["center", "keep"]),
        "offset_x": number("where the drawing goes, mm (board frame)"),
        "offset_y": number("where the drawing goes, mm (board frame)"),
    },
    ("filename", "content"),
)

GROUP_CHANGE = obj(
    {
        "index": integer("the group's index in the job, from 0", minimum=0),
        "label": text("a new label", maxLength=200),
        "power": number("laser power, or spindle speed, the firmware's S", minimum=0),
        "min_power": number("the least power a cut keeps in corners", minimum=0),
        "speed": number("feed along the cut, mm/min", exclusiveMinimum=0),
        "passes": integer("times the whole group is cut", minimum=1, maximum=100),
        "enabled": flag("whether a run cuts the group"),
        "depth": number("milling: depth under the surface, mm", exclusiveMinimum=0, maximum=50),
        "plunge": number("milling: feed down into the cut, mm/min", exclusiveMinimum=0),
        "thickness": number("dispensing: paste over each pad, mm", minimum=0.01, maximum=5),
        "focus": {"type": ["number", "null"], "description": "laser with a focus axis: mm above focus for the group; null takes it away"},
    },
    ("index",),
)

CHANGE_JOB = obj(
    {
        "job_id": JOB,
        "name": text("a new name", minLength=1, maxLength=200),
        "offset": {**obj({"x": number("mm"), "y": number("mm")}, ("x", "y")), "description": "where the job's offset is to be, mm: the job moves by the difference"},
        "turn": number("degrees to turn the job counterclockwise, after any move", minimum=-360, maximum=360),
        "about": text("what a turn is about: the middle of what the job cuts, or the origin", enum=["center", "origin"]),
        "groups": {"type": "array", "items": GROUP_CHANGE, "maxItems": 500, "description": "changes to groups, by index"},
    },
    ("job_id",),
)

PLOT_OPERATION = obj(
    {
        "kind": text(
            "drill: points; holes: a board job's drill holes; line: a path through points; face: a"
            " rectangle; pocket or profile: of a rectangle or a circle",
            enum=["drill", "holes", "line", "face", "pocket", "profile"],
        ),
        "cutter": text("what cuts: a spindle's bit, or a laser's beam", enum=["spindle", "laser"]),
        "name": text("the job's name; left out, one is made", maxLength=200),
        "tool": number("the bit's diameter, or the beam's spot, mm", exclusiveMinimum=0, maximum=100),
        "depth": number("spindle: depth under the surface the cut ends at, mm", exclusiveMinimum=0, maximum=50),
        "step_down": number("spindle: how far each pass goes down, mm", exclusiveMinimum=0),
        "stepover": number("face or pocket: rows or loops apart as a share of the bit, at most 0.85 for a rectangular pocket", exclusiveMinimum=0, maximum=1),
        "speed": number("feed along the cut, mm/min", exclusiveMinimum=0),
        "plunge": number("spindle: feed down into the cut, mm/min", exclusiveMinimum=0),
        "spindle": number("spindle speed, the firmware's S", minimum=0),
        "power": number("laser power, the firmware's S", minimum=0),
        "passes": integer("laser: times each path is burnt", minimum=1, maximum=100),
        "climb": flag("climb milling, else conventional"),
        "points": point_list("drill or line: the points, [x, y] in mm"),
        "closed": flag("line: back to the first point at the end"),
        "shape": text("pocket or profile: of a rectangle or a circle", enum=["rect", "circle"]),
        "x0": number("rectangle: one corner, mm"),
        "y0": number("rectangle: one corner, mm"),
        "x1": number("rectangle: the opposite corner, mm"),
        "y1": number("rectangle: the opposite corner, mm"),
        "corner": number("pocket or profile of a rectangle: the radius its corners are rounded to, mm, at most half the shorter side; 0 or left out, square", minimum=0),
        "cx": number("circle: center, mm"),
        "cy": number("circle: center, mm"),
        "diameter": number("circle: diameter, mm", minimum=0),
        "side": text("profile: outside the shape, inside it, or on its line", enum=["outside", "inside", "on"]),
        "job": text("holes: the board job whose drill holes they are", pattern=JOB_ID),
        "sizes": {"type": "array", "items": {"type": "number"}, "maxItems": 100, "description": "holes: the diameters to take; left out, all"},
        "bore": flag("holes: bore a hole wider than the bit in rings, else drill it with the bit"),
    },
    ("kind",),
)

PLOT_OPERATIONS = obj(
    {
        "operations": {
            "type": "array",
            "items": PLOT_OPERATION,
            "minItems": 1,
            "maxItems": 100,
            "description": "the operations, cut in this order, all with one cutter and one bit or spot",
        },
        "name": text("the job's name; left out, one is made, or a job given keeps its own", maxLength=200),
        "job": text("a Plot page job whose operations these replace in place (same id, where the job now is); left out, a new job", pattern=JOB_ID),
    },
    ("operations",),
)

UPLOAD_FILE = obj(
    {
        "name": text("the file's name with its suffix: .kicad_pcb, a gerber, .drl, .svg, .dxf, .gcode, .json or .stl", pattern=FILE_NAME),
        "content": text("the whole file", minLength=1, maxLength=MAX_CONTENT),
    },
    ("name", "content"),
)


def _tools() -> tuple[Tool, ...]:
    get, post, put, patch, delete = "GET", "POST", "PUT", "PATCH", "DELETE"
    return (
        Tool(
            "get_state",
            "The machine as the backend sees it: whether a controller is connected, its state and position"
            " (joints and the head's board point), the machine's profile (polar or cartesian, laser, spindle"
            " or dispenser), the run under way or the last one, and the resume record. Call this to know what"
            " machine the jobs are for before making one.",
            NO_ARGUMENTS,
            (Route(get, "/api/state"),),
            _get_state,
            read_only=True,
        ),
        Tool(
            "list_jobs",
            "Every stored job in short: id, name, source, spot, offset and its groups' settings with how many"
            " paths each has. Call this first when the operator talks about a job by name.",
            NO_ARGUMENTS,
            (Route(get, "/api/jobs"),),
            _list_jobs,
            read_only=True,
        ),
        Tool(
            "get_job",
            "One job. By default its geometry is counted and boxed (each group's paths and extent, the job's"
            " extent [x min, y min, x max, y max] in mm), which is what most questions need; with full, the job"
            " as stored, paths and all, as replace_job takes it (cut off when very large).",
            obj({"job_id": JOB, "full": flag("the whole job, paths included")}, ("job_id",)),
            (Route(get, "/api/jobs/{job_id}"),),
            _get_job,
            read_only=True,
        ),
        Tool(
            "list_machine_files",
            "The machine files (machines/*.toml): each machine's kind, tool, axes and controller (spinny, this project's"
            " firmware, or gcode, a machine such as a pick and place machine on its own G-code controller), and the"
            " files that do not read.",
            NO_ARGUMENTS,
            (Route(get, "/api/machines"),),
            _list_machine_files,
            read_only=True,
        ),
        Tool(
            "get_machine_file",
            "One machine file: its text and what it reads as (settings, travel, the tool). Read-only: no tool writes machine files.",
            obj({"machine_id": MACHINE}, ("machine_id",)),
            (Route(get, "/api/machines/{machine_id}"),),
            _get_machine_file,
            read_only=True,
        ),
        Tool(
            "list_cam_profiles",
            "The CAM profiles (cam/*.toml): each profile's machine, tools and operations. Call this before make_cam_job.",
            NO_ARGUMENTS,
            (Route(get, "/api/cam"),),
            _list_cam_profiles,
            read_only=True,
        ),
        Tool(
            "get_cam_profile",
            "One CAM profile: its text and what it reads as. Read-only: no tool writes CAM profiles.",
            obj({"profile_id": CAM_PROFILE}, ("profile_id",)),
            (Route(get, "/api/cam/{profile_id}"),),
            _get_cam_profile,
            read_only=True,
        ),
        Tool(
            "list_markers",
            "The markers: named positions on the board in mm, which the operator saves to go back to and to take corners and points from.",
            NO_ARGUMENTS,
            (Route(get, "/api/markers"),),
            _list_markers,
            read_only=True,
        ),
        Tool(
            "list_board_parts",
            "The parts of a board job imported from a .kicad_pcb: reference, value, footprint, side, place in"
            " the job's frame (x, y in mm), rotation in degrees, pads, and whether it is marked do not place."
            " Empty, with a note, for a job that keeps no board file.",
            obj({"job_id": JOB}, ("job_id",)),
            (Route(get, "/api/jobs/{job_id}/components"),),
            _list_board_parts,
            read_only=True,
        ),
        Tool(
            "get_placement",
            "The pick and place state of the G-code machine the PNP tab places with (a machine file with"
            ' controller = "gcode"): which machine, its file read (feeders, heights), the board\'s turn on it,'
            " the references (a part's place in a job paired with where it is on the machine), the feeders'"
            " counts, and whether it is connected.",
            NO_ARGUMENTS,
            (Route(get, "/api/pnp/placing"),),
            _get_placement,
            read_only=True,
        ),
        Tool(
            "list_search_records",
            "The cameras' recorded looks for a board and searches over a box, newest first: id, kind (look or"
            " search), camera (head, or top on a G-code machine), job, result (found, not found, stopped, error;"
            " a look also searched, unloaded or cut short), seconds, stops visited of the stops, poses read. Call"
            " get_search_record with an id to see where one went wrong.",
            obj({"camera": text("only this camera's records", enum=["head", "top"]), "limit": integer("how many, newest first", minimum=1, maximum=200)}),
            (Route(get, "/api/searchlog"),),
            _list_search_records,
            read_only=True,
        ),
        Tool(
            "get_search_record",
            "What one recorded look or search says, to find why it was slow, never found the board or found it"
            " wrong: each stop's place, move and look time and result, the poses used, refused and read there,"
            " pcbv's medians (features paired of those expected, rms, ms a frame, spots, the look it used), how"
            " much of the picture the board covered by where it was found (missed: a quarter or more and nothing"
            " used), each estimate's distance from that place and the outliers, why poses were refused, pcbv's"
            " errors; with the camera's offset, roll and scale and the search's settings. Where the board was found"
            " is the truth here: a search that found nothing has no distances.",
            obj({"record_id": text("the record's id, as list_search_records gives it")}, ("record_id",)),
            (Route(get, "/api/searchlog/{record_id}"),),
            _get_search_record,
            read_only=True,
        ),
        Tool(
            "make_job",
            "Make a job from a file you write: an SVG or DXF drawing, absolute X/Y G-code, or a job as JSON. Use this"
            " for shapes, text outlines, test patterns and anything drawn. The job is stored and shows in the"
            " Jobs tab; nothing is cut until the operator runs it there.",
            MAKE_JOB,
            (Route(post, "/api/jobs"),),
            _make_job,
            changes=(JOBS,),
        ),
        Tool(
            "change_job",
            "Change a job's settings: its name, where it is (offset), a turn, and each group's power, speed,"
            " passes, depth, plunge, focus or whether it is cut. Call get_job first for the group indexes.",
            CHANGE_JOB,
            (Route(patch, "/api/jobs/{job_id}"),),
            _change_job,
            changes=(JOBS,),
        ),
        Tool(
            "replace_job",
            "Put a whole job in place of the one stored under its id, as get_job with full gives it: for"
            " editing paths, moving them between groups or adding groups. The job is checked as an upload is.",
            obj({"job_id": JOB, "job": {"type": "object", "description": "the whole job: name, spot, offset, groups with their paths, ..."}}, ("job_id", "job")),
            (Route(put, "/api/jobs/{job_id}"),),
            _replace_job,
            destructive=True,
            changes=(JOBS,),
        ),
        Tool(
            "set_job_width",
            "Make a job again for another bit or spot width, mm: a board job is imported again from its kept"
            " file, a Plot job is built again, a drawing keeps its paths and takes the width.",
            obj({"job_id": JOB, "width": number("the bit's or the spot's width, mm", exclusiveMinimum=0, maximum=1000)}, ("job_id", "width")),
            (Route(post, "/api/jobs/{job_id}/width"),),
            _set_job_width,
            destructive=True,
            changes=(JOBS,),
        ),
        Tool(
            "set_stencil_margin",
            "Cut a solder paste stencil job again with every opening shrunk by a margin, mm.",
            obj({"job_id": JOB, "margin": number("mm off every side of each opening", minimum=0, maximum=10)}, ("job_id", "margin")),
            (Route(post, "/api/jobs/{job_id}/margin"),),
            _set_stencil_margin,
            destructive=True,
            changes=(JOBS,),
        ),
        Tool(
            "delete_job",
            "Delete one job (never the one running). Only when the operator asks for it, or to take back a job you made by mistake.",
            obj({"job_id": JOB}, ("job_id",)),
            (Route(delete, "/api/jobs/{job_id}"),),
            _delete_job,
            destructive=True,
            changes=(JOBS,),
        ),
        Tool(
            "plan_plot_job",
            "Plan a Plot page operation (drill points, a board's holes, a line, a face, a pocket or a profile)"
            " without storing it: answers the job it would make, its extent and notes. Use it to check the"
            " numbers before make_plot_job.",
            PLOT_OPERATION,
            (Route(post, "/api/mill/plan"),),
            _plan_plot_job,
            read_only=True,
        ),
        Tool(
            "make_plot_job",
            "Make a Plot page operation into a stored job: drill points, a board job's holes, a line through"
            " points, a face, or a pocket or profile of a rectangle or a circle, cut with a spindle or burnt"
            " with a laser. It shows in the Jobs and Plot tabs; nothing is cut until the operator runs it.",
            PLOT_OPERATION,
            (Route(post, "/api/mill"),),
            _make_plot_job,
            changes=(JOBS,),
        ),
        Tool(
            "set_plot_job_operations",
            "Make a Plot page job of several operations, cut in order (a pocket, the holes beside it and the"
            " outline round both), or with job give a Plot page job a new list of operations in place of its"
            " own: get_job with full shows its list under recipe.ops. Every operation cuts with the same"
            " cutter and bit or spot. Nothing is cut until the operator runs it.",
            PLOT_OPERATIONS,
            (Route(get, "/api/jobs/{job_id}"), Route(post, "/api/mill")),
            _set_plot_job_operations,
            destructive=True,
            changes=(JOBS,),
        ),
        Tool(
            "combine_jobs",
            "Make one new job of two or more jobs, cut in the order given, each group's name led by its job's;"
            " the jobs stay. Jobs made for different tools do not combine.",
            obj(
                {
                    "job_ids": {"type": "array", "items": JOB, "minItems": 2, "maxItems": 50, "description": "the jobs, in the order they are cut"},
                    "name": text("the new job's name; left out, made from theirs", maxLength=200),
                },
                ("job_ids",),
            ),
            (Route(post, "/api/jobs/combine"),),
            _combine_jobs,
            changes=(JOBS,),
        ),
        Tool(
            "save_marker",
            "Save a marker: a named position on the board, mm. A name used again moves that marker.",
            obj({"name": text("the marker's name", minLength=1, maxLength=40), "x": number("mm"), "y": number("mm")}, ("name", "x", "y")),
            (Route(get, "/api/markers"), Route(put, "/api/markers")),
            _save_marker,
            changes=(MARKERS,),
        ),
        Tool(
            "delete_marker",
            "Delete a marker by its name, when the operator asks for it.",
            obj({"name": text("the marker's name", minLength=1, maxLength=40)}, ("name",)),
            (Route(get, "/api/markers"), Route(put, "/api/markers")),
            _delete_marker,
            destructive=True,
            changes=(MARKERS,),
        ),
        Tool(
            "make_cam_job",
            "Run design files you write through a CAM profile's operations into a stored job: a KiCad board"
            " (or a copper gerber with its outline and drill files beside it), an SVG or DXF drawing, X/Y G-code,"
            " a job, or an STL model on a 3D profile. Call list_cam_profiles first.",
            obj(
                {
                    "profile_id": CAM_PROFILE,
                    "files": {"type": "array", "items": UPLOAD_FILE, "minItems": 1, "maxItems": 8, "description": "the design's files"},
                    "name": text("the job's name; left out, the design's", maxLength=200),
                },
                ("profile_id", "files"),
            ),
            (Route(post, "/api/cam/{profile_id}/jobs"),),
            _make_cam_job,
            changes=(JOBS,),
        ),
        Tool(
            "export_gcode",
            "A stored job as G-code for a CAM profile's controller, to be run on another machine. Answers the G-code; changes nothing.",
            obj({"profile_id": CAM_PROFILE, "job_id": JOB}, ("profile_id", "job_id")),
            (Route(post, "/api/cam/{profile_id}/gcode"),),
            _export_gcode,
            read_only=True,
        ),
        Tool(
            "set_placement_angle",
            "The board's turn on the pick and place machine in degrees, for a fit from one reference; or"
            " take the typed turn away. Needs a G-code machine to place with (get_placement names it).",
            obj(
                {
                    "angle": number("degrees the board is turned on the machine", minimum=-360, maximum=360),
                    "clear_angle": flag("take the typed turn away"),
                }
            ),
            (Route(put, "/api/pnp/placing"),),
            _set_placement_angle,
            changes=(PLACEMENT,),
        ),
        Tool(
            "set_placement_reference",
            "Pair a part's place in a board job with where that place is on the pick and place machine, mm in"
            " the machine's coordinates: two references give the board's turn and shift on the machine. The"
            " operator reads these off the machine; never guess them.",
            obj({"job_id": JOB, "ref": REF, "x": number("machine X, mm"), "y": number("machine Y, mm")}, ("job_id", "ref", "x", "y")),
            (Route(post, "/api/pnp/references"),),
            _set_placement_reference,
            changes=(PLACEMENT,),
        ),
        Tool(
            "drop_placement_references",
            "Forget a board job's references on the pick and place machine: one part's, or all of them.",
            obj({"job_id": JOB, "ref": REF}, ("job_id",)),
            (Route(delete, "/api/pnp/references"),),
            _drop_placement_references,
            destructive=True,
            changes=(PLACEMENT,),
        ),
        Tool(
            "plan_placement",
            "Plan placing a board job's parts with the pick and place machine: what is placed from which feeder,"
            " in what order, and what is left out and why. Changes nothing and moves nothing.",
            obj({"job_id": JOB, "refs": REFS}, ("job_id",)),
            (Route(post, "/api/pnp/plan"),),
            _plan_placement,
            read_only=True,
        ),
        Tool(
            "get_placement_program",
            "The G-code program that places a board job's parts on the pick and place machine as planned before a run;"
            " a run changes it where a camera or the vacuum sensor says otherwise. Answers the text; sends nothing.",
            obj({"job_id": JOB, "refs": REFS}, ("job_id",)),
            (Route(get, "/api/pnp/program.gcode"),),
            _get_placement_program,
            read_only=True,
        ),
    )


TOOLS: tuple[Tool, ...] = _tools()
BY_NAME: dict[str, Tool] = {tool.name: tool for tool in TOOLS}
# Every route any tool calls: the client's guard passes only these.
ROUTES: tuple[Route, ...] = tuple(dict.fromkeys(route for tool in TOOLS for route in tool.routes))


class RouteGuard(httpx.AsyncBaseTransport):
    """Passes on only the requests some tool may make; any other is answered
    403 here, before it reaches the backend."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self.inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not permitted(ROUTES, request.method, request.url.path):
            return httpx.Response(
                403,
                json={"detail": f"{request.method} {request.url.path} is not a route a tool may call"},
                request=request,
            )
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()


def _short(message: str) -> str:
    """A schema's message cut to 300 characters: it quotes the value."""
    return message if len(message) <= 300 else message[:300] + "..."


def sendable(text: str) -> str:
    """Text as UTF-8 takes it: an unpaired surrogate is written as its
    backslash escape."""
    return text.encode("utf-8", "backslashreplace").decode("utf-8")


NOT_FINITE = "not a finite number"
NOT_TEXT = "not valid text (an unpaired surrogate)"


def unfit(value: Any, path: tuple[str, ...] = ()) -> str | None:
    """Where `value` holds what JSON cannot carry, and what it is: a number
    that is not finite (NaN, an infinity, or a number too large for a float,
    which a parser reads as one), or text that is not valid Unicode (an
    unpaired surrogate), a key's included. None when it holds neither. A
    model's parser can make either, and the schema's number and string take
    both."""
    where = sendable("/".join(path)) or "arguments"
    if isinstance(value, float):
        return None if math.isfinite(value) else f"{where}: {NOT_FINITE}"
    if isinstance(value, str):
        return None if sendable(value) == value else f"{where}: {NOT_TEXT}"
    items = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
    for key, item in items:
        inner = (*path, str(key))
        if isinstance(key, str) and sendable(key) != key:
            return f"{sendable('/'.join(inner))}: {NOT_TEXT}"
        problem = unfit(item, inner)
        if problem is not None:
            return problem
    return None


class ToolBox:
    """The tools over one client: arguments checked against the tool's
    schema, the call made, the answer turned into what the model reads."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    @classmethod
    def in_process(cls, app: Any) -> ToolBox:
        """Calls into `app` itself, with nothing listening on a port. The
        requests carry no Origin, as a script's do, so the origin guard
        passes them, and come in under the loopback address, which the
        host check always takes."""
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        return cls(httpx.AsyncClient(transport=RouteGuard(transport), base_url="http://127.0.0.1", timeout=TIMEOUT))

    @classmethod
    def over_http(cls, url: str) -> ToolBox:
        transport = httpx.AsyncHTTPTransport()
        return cls(httpx.AsyncClient(transport=RouteGuard(transport), base_url=url.rstrip("/"), timeout=TIMEOUT))

    async def __aenter__(self) -> ToolBox:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self.client.aclose()

    async def call(self, name: str, arguments: Any) -> Outcome:
        tool = BY_NAME.get(name)
        if tool is None:
            return Outcome(f"no tool is named {name!r}", True)
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            return Outcome("the arguments must be a JSON object", True)
        # Before the schema, whose messages quote the values: the request
        # could not be written, and neither could an answer quoting them.
        problem = unfit(arguments)
        if problem is not None:
            return Outcome(f"the arguments do not fit {name}: {problem}", True)
        problems = sorted(tool.validator.iter_errors(arguments), key=lambda error: [str(part) for part in error.path])
        if problems:
            said = "; ".join(f"{'/'.join(str(part) for part in error.path) or 'arguments'}: {_short(error.message)}" for error in problems[:5])
            return Outcome(f"the arguments do not fit {name}: {said}", True)
        try:
            value = await tool.run(ToolApi(self.client, tool.routes), arguments)
        except ToolError as exc:
            return Outcome(str(exc), True)
        except httpx.HTTPError as exc:
            return Outcome(f"the backend did not answer: {exc!r}", True)
        return Outcome(as_text(value), False, tool.changes)
