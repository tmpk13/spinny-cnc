"""The xTool galvo: its machine file's tables, jobs written for it, the
virtual F1 held to what the F1 here answered, and the V1 transport and the
command run against the virtual one."""

from __future__ import annotations

import dataclasses
import json
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from spinny_laser import machines as machine_files
from spinny_laser.machines import MachineError

from spinny_web import xtool_cli
from spinny_web.jobs import Group, Job
from spinny_web.machines import MachineStore
from spinny_web.virtual_xtool import BUTTON_PATH, VirtualXtool, load_recording
from spinny_web.xtool import XtoolJobError, XtoolMachine, centered, machine_of, write
from spinny_web.xtool_link import XtoolError, check_firmware, transport_for

REPO = Path(__file__).resolve().parents[3]
F1 = REPO / "machines" / "xtool-f1.toml"
VIRTUAL = REPO / "machines" / "virtual-f1.toml"
START = ["$L", "G0 F180000", "M3 S0", "G1 F180000", "M114 S1", "G21", "G90"]
END = ["G90", "G0 S0", "G0 F180000", "G1 F180000", "M6 P1", "$P"]
SQUARE = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]


def read(text: str, machine_id: str = "f1") -> XtoolMachine:
    return machine_of(machine_files.parse(text, machine_id, f"{machine_id}.toml"))


def f1(*edits: tuple[str, str]) -> XtoolMachine:
    """The shipped F1 file with each (old, new) edit made once."""
    text = F1.read_text(encoding="utf-8")
    for old, new in edits:
        assert old in text, old
        text = text.replace(old, new, 1)
    return read(text)


def plain() -> XtoolMachine:
    """The F1's file with neither axis mirrored, so board and field agree."""
    return f1(("flip_y = true", "flip_y = false"))


def job(*groups: Group) -> Job:
    return Job(id="ab12", name="board", groups=list(groups) or [Group(label="outline", power=300, speed=6000, paths=[SQUARE])])


def body(written) -> list[str]:
    lines = written.text.splitlines()
    assert lines[: len(START)] == START and lines[-len(END) :] == END
    return lines[len(START) : -len(END)]


# --- the machine file ---------------------------------------------------------------


def test_the_shipped_files_read_as_the_f1_here_and_its_virtual_twin():
    machine = machine_of(machine_files.load(F1))
    assert (machine.host, machine.gcode_port, machine.http_port, machine.generation) == ("201.234.3.1", 8780, 8080, "v1")
    assert machine.tried == ("40.51.013.2020.01.ht5",) and machine.machine_type == "S1"
    assert machine.size == (121.98, 121.98) and machine.sources == {"blue": "M114 S1", "infrared": "M114 S2"}
    assert machine.source == "blue" and "{source}" in machine.start and (machine.s_max, machine.feed_max) == (1000.0, 180000.0)
    virtual = machine_of(machine_files.load(VIRTUAL))
    assert (virtual.host, virtual.gcode_port, virtual.http_port) == ("127.0.0.1", 2330, 2331)
    # Everything but where it answers is the F1's.
    same = lambda m: {k: v for k, v in m.document().items() if k != "link"}  # noqa: E731
    assert same(virtual) == same(machine)


@pytest.mark.parametrize(
    ("old", "new", "problem"),
    [
        ("http_port = 8080", "http_port = 8087", r"\[link\] http_port is 8087, the F1's firmware update service"),
        ("http_port = 8080", "http_port = 8780", r"\[link\] http_port must differ from gcode_port"),
        ('host = "201.234.3.1"', 'host = "http://201.234.3.1"', r"\[link\] host must be a host name or address"),
        ('upload = "/processing/upload"', 'upload = "processing/upload"', r"\[link\] upload must be a path"),
        ('upload_as = "multipart"', 'upload_as = "form"', r"\[link\] upload_as must be one of multipart, body"),
        ('generation = "v1"', 'generation = "v2"', r"\[firmware\] generation must be one of v1"),
        ('tried = ["40.51.013.2020.01.ht5"]', "tried = []", r"\[firmware\] tried must list the firmware packages"),
        ("size = [121.98, 121.98]", "size = [121.98, 0]", r"\[field\] size must be two numbers above 0"),
        ("flip_y = true", "flip_y = true\nmirror = true", r"\[field\] mirror is not a key here"),
        ('blue = "M114 S1"', 'Blue = "M114 S1"', r"\[sources\] Blue is not a source name"),
        ('"{source}", ', "", r"\[lines\] start must hold the line \{source\} once"),
        ('"$P"]', '"$P {x}"]', r"\[lines\] end '\$P \{x\}' holds a brace"),
        ('travel = ["G0X{x}Y{y}", "G0 S0"]', 'travel = ["G0X{x}Y{y}S{s}"]', r"\[lines\] travel 'G0X\{x\}Y\{y\}S\{s\}' holds \{s\}"),
        ('cut = ["G1X{x}Y{y}S{s}F{f}"]', 'cut = ["G1X{x}Y{y}S{s}"]', r"\[lines\] cut never says \{f\}"),
        ('cut = ["G1X{x}Y{y}S{s}F{f}"]', 'cut = ["G1X{x:.1f}Y{y}S{s}F{f}"]', r"\[lines\] cut 'G1X\{x:.1f\}.*' holds \{x\}"),
        ('cut = ["G1X{x}Y{y}S{s}F{f}"]', "cut = []", r"\[lines\] cut must list the cut's line templates"),
    ],
)
def test_a_file_amiss_names_the_key(old, new, problem):
    with pytest.raises(MachineError, match=problem):
        f1((old, new))


def test_a_file_without_sources_or_a_field_says_what_it_needs():
    text = F1.read_text(encoding="utf-8")
    with pytest.raises(MachineError, match=r"sources must name at least one source"):
        read(text.replace('blue = "M114 S1"\ninfrared = "M114 S2"\n', ""))
    with pytest.raises(MachineError, match=r"\[field\] size is needed"):
        read(text.replace("size = [121.98, 121.98]\n", ""))


def test_the_store_checks_the_tables_and_shows_them(tmp_path):
    store = MachineStore(tmp_path / "machines")
    store.save("f1", F1.read_text(encoding="utf-8"))
    document = store.document("f1")["document"]
    assert document["controller"] == "xtool" and document["xtool"]["link"]["host"] == "201.234.3.1"
    assert document["xtool"]["lines"]["travel"] == ["G0X{x}Y{y}", "G0 S0"] and document["focus"] is False
    # A file whose own tables do not read is not saved.
    with pytest.raises(MachineError, match="firmware update service"):
        store.save("f1", F1.read_text(encoding="utf-8").replace("http_port = 8080", "http_port = 8087"))
    assert "8087" not in store.text("f1")


# --- jobs written for it -------------------------------------------------------------


def test_a_job_is_the_start_a_travel_its_cuts_and_the_end():
    machine = plain()
    written = write(job(), machine, offset=(10.0, 20.0))
    assert body(written) == [
        "G0X10.000Y20.000",
        "G0 S0",
        "G1X20.000Y20.000S300F6000",
        "G1X20.000Y30.000S300F6000",
        "G1X10.000Y30.000S300F6000",
        "G1X10.000Y20.000S300F6000",
    ]
    assert written.lines == len(START) + 6 + len(END) and written.text.endswith("$P\n")
    assert written.bounds == (10.0, 20.0, 20.0, 30.0) and written.offset == (10.0, 20.0) and written.source == "blue"
    # 40 mm of cuts at 6000 mm/min, and the jump from the field's middle.
    assert written.seconds == pytest.approx(0.4 + (60.99 - 10.0) / 180000.0 * 60.0)
    # The other source's line takes the {source} place.
    assert write(job(), machine, "infrared", (10.0, 20.0)).text.splitlines()[4] == "M114 S2"


def test_a_job_is_centered_in_the_field_unless_placed():
    machine = plain()
    assert centered(job(), machine) == pytest.approx((55.99, 55.99))
    assert body(write(job(), machine))[0] == "G0X55.990Y55.990"


def test_the_file_mirrors_the_axes_it_names():
    # The F1 here, its Y toward its front (check 3).
    machine = machine_of(machine_files.load(F1))
    lines = body(write(job(), machine, offset=(10.0, 20.0)))
    assert lines[0] == "G0X10.000Y101.980" and lines[2] == "G1X20.000Y101.980S300F6000" and lines[3] == "G1X20.000Y91.980S300F6000"
    machine = f1(("flip_x = false", "flip_x = true"), ("flip_y = true", "flip_y = false"))
    assert body(write(job(), machine, offset=(10.0, 20.0)))[0] == "G0X111.980Y20.000"


def test_passes_disabled_groups_and_a_plan_that_starts_where_the_spot_rests():
    machine = plain()
    twice = job(Group(label="outline", power=250.4, speed=3000.6, passes=2, paths=[SQUARE]), Group(label="off", enabled=False, power=5000, paths=[SQUARE]))
    lines = body(write(twice, machine, offset=(10.0, 20.0)))
    # A closed loop starts its second pass where it ended: no travel between.
    assert lines[:2] == ["G0X10.000Y20.000", "G0 S0"] and len(lines) == 2 + 8
    assert lines[2] == "G1X20.000Y20.000S250F3001"
    # The first path starting under the field's middle still gets its travel.
    assert body(write(job(), machine, offset=(60.99, 60.99)))[:3] == ["G0X60.990Y60.990", "G0 S0", "G1X70.990Y60.990S300F6000"]


@pytest.mark.parametrize(
    ("group", "problem"),
    [
        (Group(label="hot", power=1001, paths=[SQUARE]), r"hot asks for power 1001: xTool F1 takes 0 to 1000"),
        (Group(label="fast", power=10, speed=200000, paths=[SQUARE]), r"fast asks for speed 200000 mm/min"),
        (Group(label="lift", power=10, focus=1.0, paths=[SQUARE]), r"lift asks for a focus height"),
        (Group(label="floor", power=100, min_power=20, paths=[SQUARE]), r"floor has a power floor"),
        (Group(label="mill", power=100, tool="spindle", paths=[SQUARE]), r"mill was made for a spindle"),
        (Group(label="polar", power=100, joints=[[(1.0, 0.0), (2.0, 0.0)]], paths=[SQUARE]), r"polar holds joint or 3D moves"),
    ],
)
def test_a_group_the_machine_cannot_run_refuses_the_job(group, problem):
    with pytest.raises(XtoolJobError, match=problem):
        write(job(group), machine_of(machine_files.load(F1)))


def test_a_point_outside_the_field_an_unknown_source_or_nothing_to_cut_refuses():
    machine = machine_of(machine_files.load(F1))
    with pytest.raises(XtoolJobError, match=r"outline: the point \(130.000, 0.000\) is outside the field of xTool F1"):
        write(job(), machine, offset=(120.0, 0.0))
    with pytest.raises(XtoolJobError, match=r"has no source 'red': it has blue, infrared"):
        write(job(), machine, "red")
    empty = job(Group(label="dot", paths=[[(1.0, 1.0)]]))
    with pytest.raises(XtoolJobError, match="has nothing to cut"):
        write(empty, machine)
    with pytest.raises(XtoolJobError, match="has nothing to cut"):
        write(empty, machine, offset=(0.0, 0.0))


# --- the virtual F1 against the recording ----------------------------------------------


def exchange(connection: socket.socket, sent: str, expected: str) -> bytes:
    """What the line `sent` is answered with: read until the expected
    length, or for a quarter of a second when nothing is expected."""
    connection.sendall(sent.encode("ascii"))
    want = len(expected.encode("ascii"))
    got = b""
    deadline = time.monotonic() + (0.25 if want == 0 else 3.0)
    while time.monotonic() < deadline and (want == 0 or len(got) < want):
        connection.settimeout(max(0.01, deadline - time.monotonic()))
        try:
            chunk = connection.recv(4096)
        except socket.timeout:
            break
        if not chunk:
            break
        got += chunk
    return got


def test_the_virtual_f1_answers_as_the_f1_here_did():
    recording = load_recording()
    with VirtualXtool() as virtual:
        with socket.create_connection(("127.0.0.1", virtual.gcode_port), timeout=3) as connection:
            for entry in recording["lines"]:
                assert exchange(connection, entry["sent"], entry["answer"]) == entry["answer"].encode("ascii"), entry
        with urllib.request.urlopen(f"http://127.0.0.1:{virtual.http_port}/device/machineInfo", timeout=3) as answer:
            assert json.load(answer) == recording["machineInfo"]
        with urllib.request.urlopen(f"http://127.0.0.1:{virtual.http_port}/device/runningStatus", timeout=3) as answer:
            assert json.load(answer) == recording["runningStatus"]
    # The session of checks 3 and 4: every line ok, and done after it.
    with VirtualXtool() as virtual:
        with socket.create_connection(("127.0.0.1", virtual.gcode_port), timeout=3) as connection:
            for entry in recording["session"]["lines"]:
                assert exchange(connection, entry["sent"], entry["answer"]) == entry["answer"].encode("ascii"), entry
        link = link_to(virtual)
        assert link.state().mode == recording["session"]["mode_after"] and link.state().at_rest
    # Check 5: a file handed over waits for the button, runs, and stops.
    upload = recording["upload"]
    with VirtualXtool() as virtual:
        link = link_to(virtual)
        assert link.send_job("G21\n", "check5.gcode")["answer"] == upload["answer"]
        mode = lambda: {"mode": link.state().mode, "subMode": link.state().sub_mode}  # noqa: E731
        assert mode() == upload["after_upload"]
        press(virtual)
        assert mode() == upload["after_button"]
        link.stop()
        assert mode() == upload["after_stop"]
    # What names the machine stays out of the recording.
    data = recording["machineInfo"]["data"]
    assert (data["sn"], data["mac"], data["deviceName"]) == ("SERIAL", "00:00:00:00:00:00", "xTool_F1_000000")


# --- the V1 transport ---------------------------------------------------------------


@pytest.fixture
def virtual():
    with VirtualXtool(run_seconds=30.0) as running:
        yield running


def press(virtual: VirtualXtool) -> None:
    """The virtual F1's button, standing for the press on the machine."""
    request = urllib.request.Request(f"http://127.0.0.1:{virtual.http_port}{BUTTON_PATH}", data=b"", method="POST")
    urllib.request.urlopen(request, timeout=3).close()


def link_to(virtual: VirtualXtool, **changes):
    machine = dataclasses.replace(machine_of(machine_files.load(VIRTUAL)), **changes)
    return transport_for(machine, "127.0.0.1", virtual.gcode_port, virtual.http_port)


def test_the_info_and_state_are_read_and_the_firmware_held_to_the_file(virtual):
    link = link_to(virtual)
    info = link.info()
    assert (info.firmware, info.machine_type, info.sources) == ("40.51.013.2020.01.ht5", "S1", ("RED", "BLUE"))
    assert info.size == pytest.approx((121.98, 121.98))
    check_firmware(info, link.machine)
    state = link.state()
    assert state.at_rest and (state.mode, state.alarm) == ("P_IDLE", None)
    with pytest.raises(XtoolError, match=r"says it is type S1, the file is for F2"):
        check_firmware(info, dataclasses.replace(link.machine, machine_type="F2"))


def test_a_firmware_the_file_was_not_tried_with_is_refused():
    with VirtualXtool(firmware="40.51.020.04") as newer:
        link = link_to(newer)
        with pytest.raises(XtoolError, match=r"runs firmware 40.51.020.04, which this file has not been tried with"):
            check_firmware(link.info(), link.machine)


def test_lines_go_one_at_a_time_and_question_marks_never(virtual):
    link = link_to(virtual)
    assert link.send_lines(["G21", "G90", "G0X10.000Y20.000", "M114 S2"]) == ["ok"] * 4
    assert virtual.lines == ["G21", "G90", "G0X10.000Y20.000", "M114 S2"]
    assert virtual.position == (10.0, 20.0) and virtual.source == 2
    with pytest.raises(XtoolError, match="answered with two oks"):
        link.send_lines(["G21", "?"])
    with pytest.raises(XtoolError, match="is not one line"):
        link.send_lines(["G21\nG90"])
    assert len(virtual.lines) == 4


def test_an_error_or_no_answer_lets_the_connection_go(virtual):
    virtual.answer = lambda line: "error:20\n"  # type: ignore[method-assign]
    with pytest.raises(XtoolError, match=r"answered 'G21' with error:20"):
        link_to(virtual).send_lines(["G21", "G90"])
    with VirtualXtool(mute=True) as mute:
        started = time.monotonic()
        with pytest.raises(XtoolError, match=r"did not answer 'G21' in 0.5 s: the connection is let go"):
            link_to(mute, timeout=0.5).send_lines(["G21"])
        assert time.monotonic() - started < 3.0


def test_a_job_is_handed_over_whole_and_waits_for_the_button(virtual):
    link = link_to(virtual)
    text = write(job(), link.machine).text
    sent = link.send_job(text, "ab12-virtual-f1.gcode")
    assert sent["bytes"] == len(text) and sent["path"] == "/processing/upload"
    # Held, waiting for the machine's button: not at rest, not running.
    state = link.state()
    assert virtual.files == [("ab12-virtual-f1.gcode", text)] and state.ready and not state.at_rest and not state.working
    # As the request's body, for an upload path that takes it so.
    link_to(virtual, upload_as="body").send_job(text, "plain.gcode")
    assert virtual.files[-1] == ("", text)
    # The button runs it; the stop goes out over HTTP.
    press(virtual)
    assert link.state().working and not link.state().at_rest
    assert link.stop() == "POST" and link.state().at_rest and virtual.stops == 1


def test_a_file_left_to_run_ends_at_rest():
    with VirtualXtool(run_seconds=0.05) as quick:
        link = link_to(quick)
        link.send_job("G21\n", "short.gcode")
        press(quick)
        time.sleep(0.1)
        assert link.state().mode == "P_WORK_DONE" and link.state().at_rest
        # And a press with nothing waiting does nothing.
        with pytest.raises(urllib.error.HTTPError):
            press(quick)


def test_nothing_reached_and_the_firmware_port_never_named():
    machine = machine_of(machine_files.load(VIRTUAL))
    with socket.socket() as spare:
        spare.bind(("127.0.0.1", 0))
        closed = spare.getsockname()[1]
    link = transport_for(dataclasses.replace(machine, timeout=1.0), "127.0.0.1", closed, closed + 1 if closed < 65535 else closed - 1)
    with pytest.raises(XtoolError, match="did not answer GET /device/machineInfo"):
        link.info()
    with pytest.raises(XtoolError, match="took no connection"):
        link.send_lines(["G21"])
    with pytest.raises(XtoolError, match="firmware update service"):
        transport_for(machine, http_port=8087)


# --- the command ----------------------------------------------------------------------


def run(virtual: VirtualXtool, *args: str) -> int:
    return xtool_cli.main(["--machine", str(VIRTUAL), "--gcode-port", str(virtual.gcode_port), "--http-port", str(virtual.http_port), *args])


def test_the_command_writes_reads_sends_and_stops(virtual, tmp_path, capsys):
    job_file = tmp_path / "ab12.json"
    job_file.write_text(job().model_dump_json(), encoding="utf-8")
    out = tmp_path / "out" / "ab12.gcode"
    assert run(virtual, "write", str(job_file), "-o", str(out), "--offset", "10,20") == 0
    # The virtual F1's file is the F1's, its Y toward the front.
    assert out.read_text(encoding="ascii").splitlines()[len(START)] == "G0X10.000Y101.980"
    assert "in the field: X 10.000 to 20.000, Y 91.980 to 101.980" in capsys.readouterr().out

    assert run(virtual, "info") == 0
    assert "firmware: tried with this file" in capsys.readouterr().out

    # What reaches a laser asks to be told someone is at it.
    assert run(virtual, "send", str(out)) == 2 and virtual.files == []
    assert run(virtual, "lines", "G21") == 2 and virtual.lines == []
    assert run(virtual, "send", str(out), "--at-the-laser") == 0
    assert virtual.files == [("ab12.gcode", out.read_text(encoding="ascii"))]
    assert "it waits for the machine's own button" in capsys.readouterr().out
    # A file already waiting is not replaced by another.
    assert run(virtual, "send", str(out), "--at-the-laser") == 1 and len(virtual.files) == 1
    assert "is not at rest (Work)" in capsys.readouterr().err
    assert run(virtual, "lines", "G21", "--at-the-laser") == 0 and virtual.lines == ["G21"]
    assert run(virtual, "stop") == 0 and virtual.stops == 1
    capsys.readouterr()

    # A write that cannot be made says why and leaves nothing.
    assert run(virtual, "write", str(job_file), "-o", str(tmp_path / "far.gcode"), "--offset", "120,0") == 1
    assert "outside the field" in capsys.readouterr().err and not (tmp_path / "far.gcode").exists()


def test_the_command_refuses_to_send_to_a_firmware_not_tried(tmp_path, capsys):
    out = tmp_path / "job.gcode"
    out.write_text("G21\n", encoding="ascii")
    with VirtualXtool(firmware="40.51.020.04") as newer:
        assert run(newer, "send", str(out), "--at-the-laser") == 1
        assert newer.files == [] and "has not been tried with" in capsys.readouterr().err
        assert run(newer, "info") == 1


# --- the page's routes ------------------------------------------------------------------


def test_the_page_is_told_it_does_not_drive_a_galvo_yet(tmp_path):
    from fastapi.testclient import TestClient

    from spinny_web.app import Backend, create_app

    machines = tmp_path / "machines"
    machines.mkdir()
    text = F1.read_text(encoding="utf-8")
    (machines / "xtool-f1.toml").write_text(text, encoding="utf-8")
    backend = Backend(root=tmp_path, machines_dir=machines)
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        listed = client.get("/api/machines").json()
        assert [(m["id"], m["controller"]) for m in listed["machines"]] == [("xtool-f1", "xtool")]
        response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9", "machine": "xtool-f1"})
        assert response.status_code == 400 and "is an xTool galvo: the page does not drive one yet" in response.json()["detail"]
        response = client.post("/api/machines/xtool-f1/from-board", json={"text": text})
        assert response.status_code == 400 and "an xTool galvo's file takes nothing from a board" in response.json()["detail"]
        response = client.post("/api/machines/xtool-f1/apply")
        assert response.status_code == 400 and "nothing is loaded onto it" in response.json()["detail"]
        # Using it names it the machine in use, not the board's file.
        assert client.post("/api/machines/xtool-f1/use").status_code == 200
        assert backend.config["machine_used"] == "xtool-f1" and backend.config.get("last_machine") != "xtool-f1"
