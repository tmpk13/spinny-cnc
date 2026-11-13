"""The tools a language model gets: their schemas, the routes they may call,
a call into the app itself, and the MCP server that serves them."""

from __future__ import annotations

import asyncio
import json
import math
import re

import httpx
import pytest
from fastapi.routing import APIRoute
from jsonschema import Draft202012Validator
from mcp import Client

from spinny_web.app import Backend, create_app
from spinny_web.mcp_server import build_server
from spinny_web.tools import BY_NAME, MAX_RESULT, ROUTES, TOOLS, Route, RouteGuard, ToolBox, as_text, slim_job

SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
    <rect x="5" y="5" width="10" height="10" stroke="#ff0000" fill="none"/>
</svg>
"""

# The routes a tool may call: each makes, changes or reads data, and none
# moves the machine, lights the laser, turns the spindle, probes, starts a
# camera routine, moves a pick and place machine or writes the firmware's
# settings or a machine or CAM file. A tool that needs a route not listed
# here fails the test until someone has looked at what the route does.
ALLOWED = {
    ("GET", "/api/state"),
    ("GET", "/api/jobs"),
    ("GET", "/api/jobs/{job_id}"),
    ("GET", "/api/jobs/{job_id}/components"),
    ("GET", "/api/machines"),
    ("GET", "/api/machines/{machine_id}"),
    ("GET", "/api/cam"),
    ("GET", "/api/cam/{profile_id}"),
    ("GET", "/api/markers"),
    ("PUT", "/api/markers"),
    ("GET", "/api/pnp/placing"),
    ("GET", "/api/searchlog"),
    ("GET", "/api/searchlog/{record_id}"),
    ("POST", "/api/jobs"),
    ("PATCH", "/api/jobs/{job_id}"),
    ("PUT", "/api/jobs/{job_id}"),
    ("POST", "/api/jobs/{job_id}/width"),
    ("POST", "/api/jobs/{job_id}/margin"),
    ("DELETE", "/api/jobs/{job_id}"),
    ("POST", "/api/mill/plan"),
    ("POST", "/api/mill"),
    ("POST", "/api/jobs/combine"),
    ("POST", "/api/cam/{profile_id}/jobs"),
    ("POST", "/api/cam/{profile_id}/gcode"),
    ("PUT", "/api/pnp/placing"),
    ("POST", "/api/pnp/references"),
    ("DELETE", "/api/pnp/references"),
    ("POST", "/api/pnp/plan"),
    ("GET", "/api/pnp/program.gcode"),
    # A plugin is written switched off; only the operator turns it on.
    ("GET", "/api/plugins"),
    ("GET", "/api/plugins/{plugin_id}"),
    ("PUT", "/api/plugins/{plugin_id}"),
    ("DELETE", "/api/plugins/{plugin_id}"),
}

# Routes that move or light something, or write the machine's own setup:
# never a tool's.
FORBIDDEN = {
    ("POST", "/api/connect"),
    ("POST", "/api/disconnect"),
    ("POST", "/api/jog"),
    ("POST", "/api/goto"),
    ("POST", "/api/jog/cancel"),
    ("POST", "/api/position"),
    ("POST", "/api/motors"),
    ("POST", "/api/unlock"),
    ("POST", "/api/home"),
    ("POST", "/api/realtime"),
    ("POST", "/api/command"),
    ("POST", "/api/laser"),
    ("POST", "/api/laser/off"),
    ("POST", "/api/spindle"),
    ("POST", "/api/spindle/off"),
    ("POST", "/api/mode"),
    ("PUT", "/api/settings"),
    ("POST", "/api/settings/save"),
    ("PUT", "/api/machines/{machine_id}"),
    ("DELETE", "/api/machines/{machine_id}"),
    ("POST", "/api/machines/{machine_id}/apply"),
    ("POST", "/api/machines/{machine_id}/from-board"),
    ("PUT", "/api/cam/{profile_id}"),
    ("PATCH", "/api/cam/{profile_id}"),
    ("DELETE", "/api/cam/{profile_id}"),
    ("POST", "/api/jobs/{job_id}/run"),
    ("POST", "/api/jobs/{job_id}/resume"),
    ("POST", "/api/run/hold"),
    ("POST", "/api/run/resume"),
    ("POST", "/api/run/stop"),
    ("POST", "/api/heightmap/probe"),
    ("POST", "/api/heightmap/touch"),
    ("POST", "/api/heightmap/pads"),
    ("POST", "/api/heightmap/focus"),
    ("POST", "/api/heightmap/stop"),
    ("POST", "/api/camera/start"),
    ("POST", "/api/camera/stop"),
    ("POST", "/api/camera/mark"),
    ("POST", "/api/camera/find"),
    ("POST", "/api/camera/abort"),
    ("POST", "/api/camlog/photo"),
    ("POST", "/api/pnp/start"),
    ("POST", "/api/pnp/stop"),
    ("POST", "/api/pnp/nozzle"),
    ("POST", "/api/pnp/part"),
    ("POST", "/api/pnp/goto"),
    ("PATCH", "/api/machines/{machine_id}"),
    ("POST", "/api/pnp/run"),
    ("POST", "/api/pnp/run/stop"),
    ("POST", "/api/pnp/park"),
    ("POST", "/api/pnp/over-camera"),
    ("POST", "/api/pnp/swap"),
    ("POST", "/api/pnp/light"),
    ("POST", "/api/pnp/vacuum"),
    ("POST", "/api/pnp/bus/feed"),
    ("POST", "/api/align/mark"),
    ("POST", "/api/align/capture"),
    ("POST", "/api/align/apply"),
    # A tool may not start or steer the Auto tab's own turns.
    ("POST", "/api/auto/messages"),
    ("PUT", "/api/auto/settings"),
    # Nor send a bug report or change where reports are sent.
    ("POST", "/api/reports"),
    ("PUT", "/api/reports/settings"),
    # Nor turn a plugin on (or off): a plugin runs with the page's whole
    # power, so only the operator's press turns one on.
    ("PUT", "/api/plugins/{plugin_id}/enabled"),
}

# Arguments every tool is walked with; a tool missing here fails the walk.
SAMPLES = {
    "get_state": {},
    "list_jobs": {},
    "get_job": {"job_id": "a1b2"},
    "list_machine_files": {},
    "get_machine_file": {"machine_id": "polar-laser"},
    "list_cam_profiles": {},
    "get_cam_profile": {"profile_id": "mill-3axis"},
    "list_markers": {},
    "list_board_parts": {"job_id": "a1b2"},
    "get_placement": {},
    "list_search_records": {"camera": "top", "limit": 5},
    "get_search_record": {"record_id": "20261112-153012-000"},
    "make_job": {"filename": "square.svg", "content": SVG, "power": 300, "anchor": "keep"},
    "change_job": {"job_id": "a1b2", "name": "x", "groups": [{"index": 0, "power": 200}]},
    "replace_job": {"job_id": "a1b2", "job": {"name": "x", "groups": []}},
    "set_job_width": {"job_id": "a1b2", "width": 0.2},
    "set_stencil_margin": {"job_id": "a1b2", "margin": 0.05},
    "delete_job": {"job_id": "a1b2"},
    "plan_plot_job": {"kind": "drill", "points": [[0, 0]]},
    "make_plot_job": {"kind": "drill", "points": [[0, 0]]},
    "set_plot_job_operations": {"operations": [{"kind": "pocket", "x1": 10, "y1": 6, "corner": 2}, {"kind": "drill", "points": [[12, 3]]}], "job": "a1b2"},
    "combine_jobs": {"job_ids": ["a1b2", "c3d4"], "name": "set"},
    "save_marker": {"name": "corner", "x": 1, "y": 2},
    "delete_marker": {"name": "corner"},
    "make_cam_job": {"profile_id": "mill-3axis", "files": [{"name": "a.svg", "content": SVG}]},
    "export_gcode": {"profile_id": "mill-3axis", "job_id": "a1b2"},
    "set_placement_angle": {"angle": 90},
    "set_placement_reference": {"job_id": "a1b2", "ref": "R1", "x": 10, "y": 20},
    "drop_placement_references": {"job_id": "a1b2", "ref": "R1"},
    "plan_placement": {"job_id": "a1b2", "refs": ["R1"]},
    "get_placement_program": {"job_id": "a1b2", "refs": ["R1", "R2"]},
    "list_plugins": {},
    "read_plugin": {"plugin_id": "big-position"},
    "write_plugin": {"plugin_id": "big-position", "source": 'export const name = "Big position";\nexport function activate(host) {}\n'},
    "delete_plugin": {"plugin_id": "big-position"},
}


def app_routes(app) -> set[tuple[str, str]]:
    return {(method, route.path) for route in app.routes if isinstance(route, APIRoute) for method in route.methods}


def recording_box():
    """A tool box whose client records every request and answers each with
    something that reads."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/markers":
            return httpx.Response(200, json={"markers": [{"name": "corner", "x": 0, "y": 0}]})
        if request.url.path.endswith(".gcode"):
            return httpx.Response(200, text="G0 X0 Y0\n", headers={"content-type": "text/plain"})
        return httpx.Response(200, json={"id": "a1b2", "name": "x", "groups": [{"label": "g", "paths": [[[0, 0], [1, 2]]]}]})

    client = httpx.AsyncClient(transport=RouteGuard(httpx.MockTransport(answer)), base_url="http://test")
    return ToolBox(client), seen


@pytest.fixture
def app(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    return create_app(backend, frontend=tmp_path / "no-dist")


def test_every_schema_is_an_object_schema_and_every_name_reads_for_every_provider():
    names = [tool.name for tool in TOOLS]
    assert len(names) == len(set(names))
    for tool in TOOLS:
        # Every provider takes this: Anthropic, OpenAI and MCP alike.
        assert re.fullmatch(r"[a-z][a-z_]{2,63}", tool.name), tool.name
        assert len(tool.description) > 30, tool.name
        Draft202012Validator.check_schema(tool.schema)
        assert tool.schema["type"] == "object" and tool.schema["additionalProperties"] is False, tool.name
        assert set(tool.schema["required"]) <= set(tool.schema["properties"]), tool.name
        assert tool.routes, tool.name
        # A tool that only reads changes nothing the page shows.
        assert not (tool.read_only and tool.changes), tool.name
        assert not (tool.read_only and tool.destructive), tool.name


def test_every_route_a_tool_calls_moves_nothing(app):
    called = {(route.method, route.path) for route in ROUTES}
    assert called <= ALLOWED, sorted(called - ALLOWED)
    assert not ALLOWED & FORBIDDEN
    # Both lists name routes the app has, so neither goes stale unseen.
    routes = app_routes(app)
    assert ALLOWED <= routes, sorted(ALLOWED - routes)
    assert FORBIDDEN <= routes, sorted(FORBIDDEN - routes)


def test_walking_every_tool_reaches_only_its_own_routes():
    assert set(SAMPLES) == set(BY_NAME)

    async def walk():
        box, seen = recording_box()
        async with box:
            for tool in TOOLS:
                seen.clear()
                outcome = await box.call(tool.name, SAMPLES[tool.name])
                assert not outcome.error, (tool.name, outcome.text)
                assert seen, tool.name
                for request in seen:
                    assert any(route.matches(request.method, request.url.path) for route in tool.routes), (tool.name, request.method, request.url.path)
                    assert (request.method, next(r.path for r in tool.routes if r.matches(request.method, request.url.path))) in ALLOWED
                if tool.name == "set_placement_reference":
                    # Always with the place: left out, the backend would ask the machine.
                    assert json.loads(seen[0].content) == {"job": "a1b2", "ref": "R1", "at": [10, 20]}

    asyncio.run(walk())


def test_the_guard_refuses_any_other_route_before_it_leaves():
    reached: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        reached.append(request.url.path)
        return httpx.Response(200, json={})

    async def go():
        client = httpx.AsyncClient(transport=RouteGuard(httpx.MockTransport(answer)), base_url="http://test")
        async with client:
            for method, path in (("POST", "/api/laser"), ("POST", "/api/jobs/a1b2/run"), ("POST", "/api/home"), ("GET", "/api/jobs/a/b")):
                response = await client.request(method, path)
                assert response.status_code == 403 and "not a route a tool may call" in response.json()["detail"]
            assert (await client.get("/api/jobs")).status_code == 200

    asyncio.run(go())
    assert reached == ["/api/jobs"]
    assert Route("GET", "/api/jobs/{job_id}").matches("get", "/api/jobs/a1b2")
    assert not Route("GET", "/api/jobs/{job_id}").matches("GET", "/api/jobs/")


def test_arguments_that_do_not_fit_are_refused_before_any_request():
    async def go():
        box, seen = recording_box()
        async with box:
            for name, arguments in (
                ("get_job", {}),
                ("get_job", {"job_id": "../state"}),
                ("make_job", {"filename": "evil.sh", "content": "x"}),
                ("change_job", {"job_id": "a1b2", "groups": [{"index": 0, "speed": 0}]}),
                ("save_marker", {"name": "m", "x": 1}),
                ("list_jobs", {"extra": 1}),
                ("no_such_tool", {}),
            ):
                outcome = await box.call(name, arguments)
                assert outcome.error, name
            assert (await box.call("list_jobs", [1, 2])).error
        assert seen == []

    asyncio.run(go())


def test_numbers_and_text_json_cannot_carry_are_refused_before_any_request():
    # What a model's parser can make of NaN, Infinity or 1e400, and of an
    # unpaired surrogate escape: the schema's number and string take them,
    # and the request body could not be written.
    async def go():
        box, seen = recording_box()
        async with box:
            for name, arguments, where in (
                ("save_marker", {"name": "a", "x": math.inf, "y": 0}, "x: not a finite number"),
                ("save_marker", {"name": "a", "x": 0, "y": -math.inf}, "y: not a finite number"),
                ("save_marker", {"name": "a", "x": math.nan, "y": 0}, "x: not a finite number"),
                ("plan_plot_job", {"kind": "drill", "points": [[1.0, 2.0], [math.inf, 0.0]], "tool": 1}, "points/1/0: not a finite number"),
                ("make_job", {"filename": "a.svg", "content": "<svg>\ud800</svg>"}, "content: not valid text (an unpaired surrogate)"),
                ("save_marker", {"name": "a\udfff", "x": 0, "y": 0}, "name: not valid text (an unpaired surrogate)"),
                ("change_job", {"job_id": "a1b2", "\ud800": 1}, "\\ud800: not valid text (an unpaired surrogate)"),
            ):
                outcome = await box.call(name, arguments)
                assert outcome.error and outcome.text == f"the arguments do not fit {name}: {where}", (name, outcome.text)
                outcome.text.encode("utf-8")
        assert seen == []

    asyncio.run(go())


def test_a_long_answer_is_cut_and_a_job_is_counted_rather_than_listed():
    assert len(as_text("x" * (MAX_RESULT + 50))) < MAX_RESULT + 100
    job = {
        "id": "a1",
        "name": "j",
        "groups": [{"label": "g", "power": 1, "paths": [[[0, 0], [10, 5]], [[-2, 1], [3, 3]]]}],
        "outline": [[[0, 0], [1, 1]]],
        "pads": [[0, 0, 1], [1, 1, 1]],
    }
    slim = slim_job(job)
    assert slim["groups"] == [{"label": "g", "power": 1, "index": 0, "paths": 2, "extent": [-2.0, 0.0, 10.0, 5.0]}]
    assert slim["extent"] == [-2.0, 0.0, 10.0, 5.0]
    assert slim["outline"] == 1 and slim["pads"] == 2 and slim["holes"] == 0


def test_tools_make_change_and_delete_a_job_in_the_app_itself(app):
    async def go():
        async with ToolBox.in_process(app) as box:
            made = await box.call("make_job", {"filename": "square.svg", "content": SVG, "power": 250, "speed": 600})
            assert not made.error, made.text
            assert made.changed == ("jobs",)
            job = json.loads(made.text)
            assert job["name"] == "square" and job["groups"][0]["power"] == 250 and job["groups"][0]["speed"] == 600
            low_x, low_y, high_x, high_y = job["extent"]
            assert high_x - low_x == pytest.approx(10.0) and high_y - low_y == pytest.approx(10.0)
            listed = json.loads((await box.call("list_jobs", {})).text)
            assert [entry["id"] for entry in listed["jobs"]] == [job["id"]]
            changed = await box.call("change_job", {"job_id": job["id"], "groups": [{"index": 0, "power": 120, "passes": 2}]})
            assert not changed.error, changed.text
            assert json.loads(changed.text)["groups"][0]["power"] == 120
            full = json.loads((await box.call("get_job", {"job_id": job["id"], "full": True})).text)
            assert len(full["groups"][0]["paths"]) == 1
            refused = await box.call("get_job", {"job_id": "zzzz"})
            assert refused.error and refused.text.startswith("404")
            marker = await box.call("save_marker", {"name": "corner", "x": 1.5, "y": -2})
            assert json.loads(marker.text) == {"markers": [{"name": "corner", "x": 1.5, "y": -2.0}]}
            assert not (await box.call("delete_job", {"job_id": job["id"]})).error
            assert json.loads((await box.call("list_jobs", {})).text) == {"jobs": []}

    asyncio.run(go())


DXF = "  0\nSECTION\n  2\nENTITIES\n  0\nCIRCLE\n  8\nHOLES\n 10\n0\n 20\n0\n 40\n2\n  0\nLINE\n  8\nCUT\n 10\n0\n 20\n0\n 11\n10\n 21\n0\n  0\nENDSEC\n  0\nEOF\n"


def test_a_tool_makes_a_job_of_a_dxf_drawing_a_group_a_layer(app):
    async def go():
        async with ToolBox.in_process(app) as box:
            made = await box.call("make_job", {"filename": "plate.dxf", "content": DXF, "anchor": "keep"})
            assert not made.error, made.text
            job = json.loads(made.text)
            assert job["name"] == "plate" and [group["label"] for group in job["groups"]] == ["layer HOLES", "layer CUT"]
            # The circle's chords stay within the tolerance of it, inside it.
            assert job["extent"] == pytest.approx([-2.0, -2.0, 10.0, 2.0], abs=0.006)

    asyncio.run(go())


def test_tools_make_a_plot_job_of_operations_change_its_list_and_combine_jobs(app):
    async def go():
        async with ToolBox.in_process(app) as box:
            pocket = {"kind": "pocket", "x0": 0, "y0": 0, "x1": 10, "y1": 6, "tool": 1, "corner": 2}
            made = await box.call("set_plot_job_operations", {"operations": [pocket], "name": "plate"})
            assert not made.error, made.text
            job = json.loads(made.text)["job"]
            assert job["name"] == "plate"
            drill = {"kind": "drill", "points": [[12, 3]], "tool": 1}
            changed = await box.call("set_plot_job_operations", {"operations": [pocket, drill], "job": job["id"]})
            assert not changed.error, changed.text
            again = json.loads(changed.text)["job"]
            assert again["id"] == job["id"] and again["name"] == "plate", "the job keeps its id and its name"
            full = json.loads((await box.call("get_job", {"job_id": job["id"], "full": True})).text)
            assert [op["kind"] for op in full["recipe"]["ops"]] == ["pocket", "drill"]
            assert full["groups"][0]["label"] == "pocket 10 x 6 mm, corners R2"
            mixed = await box.call("set_plot_job_operations", {"operations": [pocket, {**drill, "tool": 2}]})
            assert mixed.error and "a job cuts with one bit" in mixed.text
            other = json.loads((await box.call("make_plot_job", {"kind": "drill", "points": [[0, 0]], "tool": 1})).text)["job"]
            combined = await box.call("combine_jobs", {"job_ids": [job["id"], other["id"]]})
            assert not combined.error, combined.text
            whole = json.loads(combined.text)
            assert whole["name"] == "plate + drill 1 points"
            assert len(json.loads((await box.call("list_jobs", {})).text)["jobs"]) == 3

    asyncio.run(go())


def test_the_tools_reach_a_backend_that_pins_its_host_names(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    app = create_app(backend, frontend=tmp_path / "no-dist", allowed_hosts=["spinny.local"])

    async def go():
        async with ToolBox.in_process(app) as box:
            listed = await box.call("list_jobs", {})
            assert not listed.error, listed.text

    asyncio.run(go())


def test_the_mcp_server_lists_the_tools_and_calls_them(app):
    async def go():
        async with ToolBox.in_process(app) as box:
            async with Client(build_server(box)) as client:
                listed = await client.list_tools()
                assert [tool.name for tool in listed.tools] == [tool.name for tool in TOOLS]
                by_name = {tool.name: tool for tool in listed.tools}
                assert by_name["make_job"].input_schema == BY_NAME["make_job"].schema
                assert by_name["list_jobs"].annotations.read_only_hint is True
                assert by_name["delete_job"].annotations.destructive_hint is True
                listed_jobs = await client.call_tool("list_jobs", {})
                assert not listed_jobs.is_error
                assert json.loads(listed_jobs.content[0].text) == {"jobs": []}
                refused = await client.call_tool("make_job", {"filename": "x.exe", "content": "y"})
                assert refused.is_error and "do not fit" in refused.content[0].text

    asyncio.run(go())
