"""Search records: a look for a board and a search over a box kept as they
went (searchlog.py), and what the report makes of one (searchreport.py):
where the time went, the stop pcbv missed, the pose a pitch off, and what
other consensus settings would have called."""

from __future__ import annotations

import json
import math
import os
import sys

import pytest
from device_fakes import SeenBoard

from spinny_web import boardlook, searchlog, searchreport
from spinny_web.boardlook import BoardLook, PictureFrame, search, search_extra, search_stops, settings_now
from spinny_web.jobs import Design
from spinny_web.searchlog import SearchLog, affine_of

DESIGN = Design(shift=(-100.0, -70.0), board=True)
BOX = (0.0, 0.0, 40.0, 30.0)
MIDDLE = (20.0, 15.0)
OFFSET = (34.0, -9.0)
SCALE = 0.02
JPEG = b"\xff\xd8 a picture \xff\xd9"


class ScriptedCamera:
    """pcbv over a board lying on the machine (SeenBoard): locked while the
    picture's center is over the board, except at the `blind` places,
    which see nothing; the `pitch_off`-th locked pose is put one pitch
    (2.54 mm) along the board's X, as a repeated pattern matched wrong."""

    def __init__(self, seen: SeenBoard, blind=(), pitch_off: int | None = None, off_places=()) -> None:
        self.seen = seen
        self.blind = [tuple(point) for point in blind]
        self.pitch_off = pitch_off
        # Places where every lock is a pitch off.
        self.off_places = [tuple(point) for point in off_places]
        self.center = (0.0, 0.0)
        self.frames = 0
        self.locked = 0
        self.running = True
        self.asked: list[str] = []

    def pose(self) -> dict:
        self.frames += 1
        raw = self.seen.pose(self.center, 0.0, False, SCALE, 1280, 720, self.frames)
        if any(math.dist(self.center, point) < 1e-6 for point in self.blind):
            return {key: value for key, value in raw.items() if key in ("frame", "age_ms", "width", "height", "fps", "spots")} | {"state": "lost"}
        if raw["state"] == "locked":
            self.locked += 1
            if self.locked == self.pitch_off or any(math.dist(self.center, point) < 1e-6 for point in self.off_places):
                raw["center"] = [raw["center"][0] + 2.54, raw["center"][1]]
                raw["corners"] = [[x + 2.54, y] for x, y in raw["corners"]]
        return raw

    def request(self, cmd, timeout=None, **fields):
        self.asked.append(cmd)
        return {"version": "test"} if cmd == "hello" else {"ok": True}

    def frame(self, width=None, overlay=False, quality=80):
        return {"width": 1280, "height": 720, "frame": self.frames, "age_ms": 0, "bytes": len(JPEG)}, JPEG


class Mover:
    """Moves the head at once: the picture's center is the head plus the offset."""

    def __init__(self, camera: ScriptedCamera) -> None:
        self.camera = camera
        self.places: list[tuple[float, float]] = []

    def go(self, head) -> None:
        self.places.append(head)
        self.camera.center = (head[0] + OFFSET[0], head[1] + OFFSET[1])


def _middle(seen: SeenBoard) -> tuple[float, float]:
    """The board's middle on the machine."""
    x, y = MIDDLE
    c, s = math.cos(math.radians(seen.rotation)), math.sin(math.radians(seen.rotation))
    return (seen.shift[0] + c * x - s * y, seen.shift[1] + s * x + c * y)


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(boardlook, "LOCK_SECONDS", 0.15)
    monkeypatch.setattr(boardlook, "STOP_SECONDS", 0.6)
    monkeypatch.setattr(boardlook, "SAMPLE_SECONDS", 0.01)


def header(stops, box, start) -> dict:
    return {
        "job": {"id": "j1", "name": "board"},
        "board": {"file": "board.kicad_pcb", "side": "front", "finish": "masked"},
        "board_to_job": affine_of(DESIGN.board_to_job),
        "middle": list(MIDDLE),
        "outline_box": list(BOX),
        "picture": {"offset": list(OFFSET), "roll": 0.0, "mirror": False, "mm_per_px": SCALE, "width": 1280, "height": 720, "mm_per_px_used": SCALE},
        "settings": settings_now(),
        **search_extra(box, start, stops, 1280 * SCALE, 720 * SCALE),
    }


def run_search(tmp_path, seen: SeenBoard, box, blind_first_over_board: bool = False, pitch_off: int | None = None, off_first_over_board: bool = False):
    """A search over `box` from the machine's origin, recorded: the record's
    folder, the log, the camera and the outcome (an estimate or the error)."""
    start = (0.0 + OFFSET[0], 0.0 + OFFSET[1])
    stops = search_stops(box, (1280 * SCALE, 720 * SCALE), start)
    blind = []
    if blind_first_over_board:
        blind = [next(stop for stop in stops if seen.pose(stop, 0.0, False, SCALE, 1280, 720, 0)["state"] == "locked")]
    off = []
    if off_first_over_board:
        off = [next(stop for stop in stops if seen.pose(stop, 0.0, False, SCALE, 1280, 720, 0)["state"] == "locked")]
    camera = ScriptedCamera(seen, blind, pitch_off, off)
    look = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True)
    look.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off")
    board = tmp_path / "upload.kicad_pcb"
    board.write_text("(kicad_pcb)", encoding="utf-8")
    log = SearchLog(tmp_path / "log")
    record = log.begin("search", "top", header(stops, box, start), board)
    assert record is not None
    try:
        outcome = search(look, Mover(camera), stops, OFFSET, lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError, record)
    except RuntimeError as exc:
        outcome = exc
    finally:
        look.stop()
    return record.folder, log, camera, outcome, blind and stops.index(blind[0])


def test_a_search_is_recorded_stop_by_stop_and_ends_found(tmp_path, quick):
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    folder, log, camera, found, _ = run_search(tmp_path, seen, (140.0, 70.0, 200.0, 125.0))
    assert not isinstance(found, Exception)
    data = json.loads((folder / "record.json").read_text(encoding="utf-8"))
    assert data["kind"] == "search" and data["camera"] == "top" and data["board"]["copy"] == "board.kicad_pcb"
    assert (folder / "board.kicad_pcb").read_text(encoding="utf-8") == "(kicad_pcb)" and len(data["board"]["sha256"]) == 64
    outcome = data["outcome"]
    assert outcome["result"] == "found" and outcome["estimate"]["center"] == pytest.approx(list(_middle(seen)), abs=0.01)
    assert outcome["consensus"]["found"] is True and outcome["visited"] == outcome["found_at"] + 1
    events = [json.loads(line) for line in (folder / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    kinds = [event["event"] for event in events]
    # Every stop visited: its move, its arrival, its end and its picture,
    # then the look over the board's middle.
    assert kinds.count("stop") == outcome["visited"] + 1 and kinds.count("stop_end") == outcome["visited"] + 1
    pictures = [event for event in events if event["event"] == "picture"]
    assert [p["file"] for p in pictures] == [f"stop-{i:03d}.jpg" for i in range(outcome["visited"])] + [f"stop-{len(data['stops']):03d}.jpg"]
    assert all((folder / p["file"]).read_bytes() == JPEG for p in pictures)
    poses = [event for event in events if event["event"] == "pose"]
    assert poses and all(isinstance(event["stop"], int) and "pose" in event and "id" not in event["pose"] for event in poses)
    used = [event for event in poses if event["seen"] == "used"]
    assert used and all(event["place"]["center"] and event["estimate"]["center"] for event in used)
    # The listing and the files.
    state = log.state()
    assert state["count"] == 1 and state["records"][0]["result"] == "found" and state["records"][0]["visited"] == outcome["visited"]
    assert log.path_of(data["id"], "stop-000.jpg") is not None
    for bad in ("../record.json", "events.jsonl/..", "x.jpg", "record.json.tmp"):
        assert log.path_of(data["id"], bad) is None
    assert log.path_of("../" + data["id"], "record.json") is None


def test_the_report_finds_the_missed_stop_the_pitch_off_pose_and_what_fewer_looks_would_have_called(tmp_path, quick):
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    folder, _, _, found, blind = run_search(tmp_path, seen, (140.0, 70.0, 200.0, 125.0), blind_first_over_board=True, pitch_off=1)
    assert not isinstance(found, Exception)
    record = searchreport.load(folder)
    summary = searchreport.summarize(record)
    assert summary["result"] == "found" and summary["truth"]["source"] == "found"
    # The stop over the board that saw nothing is a miss; so is any whose
    # center was just off the board (the fake locks only with its center
    # over it) while the board covered a good part of its picture.
    assert blind in summary["missed"]
    for row in summary["stops"]:
        assert row["missed"] == (row["index"] in summary["missed"])
        if row["missed"]:
            assert row["used"] == 0 and row["cover"] >= searchreport.MISS_COVER and row["picture"] == f"stop-{row['index']:03d}.jpg"
    # The pose a pitch off is the one outlier, about a pitch from the truth.
    assert len(summary["outliers"]) == 1 and summary["outliers"][0]["mm"] == pytest.approx(2.54, abs=0.05)
    assert summary["deviation"]["median_mm"] < 0.01 and summary["deviation"]["outliers"] == 1
    assert summary["first_used_s"] is not None and summary["found_s"] >= summary["first_used_s"]
    ifs = searchreport.what_ifs(record, needs=(1, 5), agrees=(0.5,))
    one, five = ifs
    # One look would have called the outlier found, a pitch off: wrong.
    assert one["found"] and one["error_mm"] == pytest.approx(2.54, abs=0.05) and not one["recorded"]
    # The settings the search ran with call it where the search did.
    assert five["recorded"] and five["found"] and five["t"] == summary["found_s"] and five["error_mm"] < 0.01
    lines = searchreport.text(summary, ifs)
    assert "MISSED" in lines and "WRONG" in lines and "outlier" in lines
    page = searchreport.html(record, ifs=ifs)
    page.encode("ascii")
    assert "<svg" in page and f'src="stop-{blind:03d}.jpg"' in page and "as recorded" in page


def test_a_place_found_must_be_agreed_by_the_looks_at_the_check_else_the_search_goes_on(tmp_path, quick):
    # Every lock at the first stop over the board is a pitch off: it is
    # found there from two locks, but the check over the board's middle
    # sees the truth, so the search goes on until the truth is found and
    # the check agrees.
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    folder, _, camera, found, _ = run_search(tmp_path, seen, (140.0, 70.0, 200.0, 125.0), off_first_over_board=True)
    assert not isinstance(found, Exception), found
    assert math.dist(found.center, _middle(seen)) < 0.05
    events = [json.loads(line) for line in (folder / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    checks = [event["result"] for event in events if event["event"] == "check"]
    assert checks[0] == "disagreed" and checks[-1] == "agreed" and len(checks) <= boardlook.MAX_CHECKS
    # A guess from one lock had pcbv look afresh before it was found.
    assert any(event["event"] == "recheck" for event in events)
    used = [event for event in events if event["event"] == "pose" and event.get("estimate")]
    assert len({event["estimate"]["session"] for event in used}) >= 3


def test_the_cover_is_the_share_of_the_picture_the_board_takes():
    board = [(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0)]

    def square(cx: float, cy: float, half: float, turned: float = 0.0):
        c, s = math.cos(math.radians(turned)), math.sin(math.radians(turned))
        return [(cx + c * x - s * y, cy + s * x + c * y) for x, y in ((-half, -half), (half, -half), (half, half), (-half, half))]

    assert searchreport.cover(square(20.0, 15.0, 5.0), board) == pytest.approx(1.0)
    # Half over the right edge, either way round.
    assert searchreport.cover(square(40.0, 15.0, 5.0), board) == pytest.approx(0.5)
    assert searchreport.cover(list(reversed(square(40.0, 15.0, 5.0))), list(reversed(board))) == pytest.approx(0.5)
    # A quarter over a corner; turned 45 degrees about the edge's middle, half.
    assert searchreport.cover(square(0.0, 0.0, 5.0), board) == pytest.approx(0.25)
    assert searchreport.cover(square(40.0, 15.0, 5.0, 45.0), board) == pytest.approx(0.5)
    assert searchreport.cover(square(100.0, 100.0, 5.0), board) == 0.0


def test_a_search_that_never_finds_the_board_is_recorded_as_not_found_and_given_a_truth(tmp_path, quick):
    seen = SeenBoard(BOX, 0.0, (500.0, 500.0), design_shift=DESIGN.shift)
    folder, log, _, error, _ = run_search(tmp_path, seen, (100.0, 30.0, 140.0, 60.0))
    assert isinstance(error, RuntimeError) and "no board found" in str(error)
    record = searchreport.load(folder)
    assert record.outcome["result"] == "not found" and record.outcome["visited"] == len(record.header["stops"])
    summary = searchreport.summarize(record)
    assert summary["truth"] is None and summary["deviation"] is None and all(row["cover"] is None for row in summary["stops"])
    assert "no truth" in searchreport.text(summary)
    # Told where the board lies, the stops' cover is known: none saw it.
    truth = searchreport.given_place(record, "520,515,0")
    told = searchreport.summarize(record, truth)
    assert told["truth"]["middle"] == pytest.approx([520.0, 515.0]) and all(row["cover"] == 0.0 for row in told["stops"])
    with pytest.raises(ValueError, match="X,Y,DEG"):
        searchreport.given_place(record, "1,2")


def test_a_stopped_search_ends_its_record_as_stopped(tmp_path, quick):
    seen = SeenBoard(BOX, 0.0, (500.0, 500.0), design_shift=DESIGN.shift)
    camera = ScriptedCamera(seen)
    look = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True)
    look.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "held off")
    log = SearchLog(tmp_path / "log")
    stops = [(10.0, 10.0), (30.0, 10.0)]
    record = log.begin("search", "head", header(stops, (0.0, 0.0, 40.0, 20.0), (0.0, 0.0)))
    with pytest.raises(RuntimeError, match="stopped"):
        search(look, Mover(camera), stops, OFFSET, lambda point: PictureFrame(point, 0.0, False), lambda: True, lambda i, n: None, RuntimeError, record)
    look.stop()
    assert record is not None and record.outcome["result"] == "stopped" and record.outcome["visited"] == 1


def test_a_look_is_recorded_until_enough_agree_and_a_search_ends_it_as_searched(tmp_path):
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    camera = ScriptedCamera(seen)
    camera.center = _middle(seen)
    look = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True)
    log = SearchLog(tmp_path / "log")
    record = log.begin("look", "head", header([], (0.0, 0.0, 1.0, 1.0), camera.center))
    assert record is not None
    look.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: PictureFrame(camera.center, 0.0, False), record)
    assert look.state()["record"] == record.id
    for _ in range(boardlook.NEED + 2):
        look.sample()
        if record.closed:
            break
    assert record.outcome["result"] == "found" and record.outcome["estimate"]["center"] == pytest.approx(list(_middle(seen)), abs=0.01)
    assert [path.name for path in sorted(record.folder.glob("look-*.jpg"))] == ["look-000.jpg", "look-001.jpg"]
    # Poses after the end are not written; the look goes on.
    events = record.events
    look.sample()
    assert record.events == events and look.record is None
    # A new look's record, ended by a search taking its place.
    second = log.begin("look", "head", header([], (0.0, 0.0, 1.0, 1.0), camera.center))
    look.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "held off", second)
    third = log.begin("search", "head", header([], (0.0, 0.0, 1.0, 1.0), camera.center))
    look.begin_record(third)
    assert second is not None and second.outcome["result"] == "searched" and look.record is third
    look.stop()
    assert third is not None and third.outcome["result"] == "unloaded"


def test_a_camera_without_pictures_or_failing_poses_never_stops_the_record(tmp_path):
    class Blind(ScriptedCamera):
        def frame(self, width=None, overlay=False, quality=80):
            raise OSError("no picture today")

        def pose(self):
            from spinny_web.vision import VisionError

            raise VisionError("pcbv went away")

    camera = Blind(SeenBoard(BOX, 0.0, (0.0, 0.0)))
    look = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True)
    log = SearchLog(tmp_path / "log")
    record = log.begin("look", "head", header([], (0.0, 0.0, 1.0, 1.0), (0.0, 0.0)))
    look.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "held off", record)
    for _ in range(5):
        assert look.sample() == "off"
    # The same failure is written once.
    assert record is not None and record.counts == {"error": 1}
    assert record.picture(camera, "look-000") is None and record.counts["picture"] == 1
    look.stop()
    assert record.outcome["result"] == "unloaded"


def test_the_oldest_records_go_past_the_count_and_the_room_but_never_one_being_written(tmp_path, monkeypatch):
    monkeypatch.setattr(searchlog, "MAX_RECORDS", 3)
    log = SearchLog(tmp_path / "log")
    kept_open = log.begin("look", "head", {})
    assert kept_open is not None
    for _ in range(5):
        record = log.begin("search", "top", {})
        assert record is not None
        record.close("not found")
    ids = log.ids()
    assert len(ids) == 3 and kept_open.id in ids
    # Past the room: only the newest stays, however big, and the open one.
    monkeypatch.setattr(searchlog, "MAX_BYTES", 10)
    big = log.begin("search", "top", {})
    assert big is not None
    (big.folder / "stop-000.jpg").write_bytes(b"x" * 100)
    big.close("found")
    assert set(log.ids()) == {kept_open.id, big.id}
    # A clear leaves the record being written.
    assert log.clear() == 1 and log.ids() == [kept_open.id]
    assert log.state()["records"][0]["result"] == "running"
    # A record a backend that stopped never ended reads as unfinished.
    assert SearchLog(tmp_path / "log").state()["records"][0]["result"] == "unfinished"


def test_a_record_stops_writing_lines_when_full_and_pictures_past_its_share(tmp_path, monkeypatch):
    monkeypatch.setitem(searchlog.MAX_EVENTS, "look", 4)
    monkeypatch.setattr(searchlog, "MAX_PICTURES", 1)
    log = SearchLog(tmp_path / "log")
    record = log.begin("look", "head", {})
    assert record is not None
    camera = ScriptedCamera(SeenBoard(BOX, 0.0, (0.0, 0.0)))
    assert record.picture(camera, "look-000") == "look-000.jpg"
    assert record.picture(camera, "look-001") is None and record.picture(camera, "look-002") is None
    for n in range(10):
        record.event("pose", n=n)
    assert record.full and record.events == 4
    lines = (record.folder / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 4 and json.loads(lines[1])["error"].startswith("no more pictures")
    record.close("cut short")
    assert record.outcome["pictures"] == 1


def test_pcbv_run_again_on_the_pictures_is_compared_with_the_truth(tmp_path, quick):
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    folder, _, _, found, _ = run_search(tmp_path, seen, (140.0, 70.0, 200.0, 125.0))
    record = searchreport.load(folder)
    # A stand-in pcbv: locked at the board point under the middle stop's
    # picture, lost on the rest.
    middle_stop = len(record.header["stops"])
    truth = searchreport.found_place(record)
    target = next(event["target"] for event in record.of("stop") if event["index"] == middle_stop)
    expected = searchreport.board_point(record, truth.back(tuple(target)))
    program = tmp_path / "fake-pcbv"
    program.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "assert sys.argv[1] == 'locate' and sys.argv[-1] == '--json' and '--side' in sys.argv\n"
        f"if sys.argv[3].endswith('stop-{middle_stop:03d}.jpg'):\n"
        f"    print(json.dumps({{'state': 'Locked', 'pose': {{'center': {{'x': {expected[0] + 0.1}, 'y': {expected[1]}}}, 'inliers': 30, 'expected': 32, 'rms_mm': 0.02}}, 'spots': [1, 2], 'timing': {{'total_ms': 12.0}}}}))\n"
        "else:\n"
        "    print(json.dumps({'state': 'Lost', 'pose': None, 'spots': [], 'timing': {'total_ms': 8.0}}))\n"
        "    sys.exit(2)\n",
        encoding="utf-8",
    )
    os.chmod(program, 0o755)
    rows = searchreport.rerun_pcbv(record, str(program))
    assert len(rows) == len(record.of("picture"))
    middle = next(row for row in rows if row["file"] == f"stop-{middle_stop:03d}.jpg")
    assert middle["locked"] and middle["error_mm"] == pytest.approx(0.1, abs=1e-6) and middle["ms"] == 12.0
    assert all(not row["locked"] and row["state"] == "lost" for row in rows if row is not middle)
    assert "pcbv locate on the pictures" in searchreport.text(searchreport.summarize(record), None, rows)
    assert "pcbv on the pictures now" in searchreport.html(record, pcbv=rows)


def test_the_command_line_lists_shows_and_writes_the_page(tmp_path, quick, capsys):
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    folder, _, _, _, _ = run_search(tmp_path, seen, (140.0, 70.0, 200.0, 125.0))
    log_dir = str(tmp_path / "log")
    assert searchreport.main(["--dir", log_dir, "list"]) == 0
    assert folder.name in capsys.readouterr().out
    assert searchreport.main(["--dir", log_dir, "show", folder.name, "--json", "--need", "4,5", "--agree", "0.5"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["summary"]["result"] == "found" and [row["need"] for row in shown["what_ifs"]] == [4, 5] and shown["pcbv"] is None
    page = folder / "report.html"
    assert searchreport.main(["show", str(folder), "--html", str(page)]) == 0
    assert "result: found" in capsys.readouterr().out and page.read_text(encoding="utf-8").startswith("<title>")
    assert searchreport.main(["--dir", log_dir, "show", "20000101-000000-000"]) == 2
    assert "no search record" in capsys.readouterr().err


def test_the_tool_gives_an_agent_the_summary_and_what_the_record_was_looked_with():
    import asyncio

    from spinny_web import tools

    class Api:
        async def get(self, path, params=None):
            assert path == "/api/searchlog/20261112-153012-000" and params is None
            header = {"id": "x", "kind": "search", "stops": [[0.0, 0.0]] * 50, "board_to_job": [[1, 0, 0], [0, 1, 0]], "picture": {"roll": 1.0}, "outcome": {"result": "found"}}
            return {"record": header, "summary": {"result": "found"}}

    answer = asyncio.run(tools._get_search_record(Api(), {"record_id": "20261112-153012-000"}))
    assert answer == {"record": {"id": "x", "kind": "search", "picture": {"roll": 1.0}, "outcome": {"result": "found"}}, "summary": {"result": "found"}}


def test_a_sweep_weighs_other_settings_and_a_pcbv_build_on_every_record(tmp_path, quick, capsys):
    seen = SeenBoard(BOX, 2.0, (150.0, 80.0), design_shift=DESIGN.shift)
    run_search(tmp_path, seen, (140.0, 70.0, 200.0, 125.0), pitch_off=1)
    run_search(tmp_path, SeenBoard(BOX, 0.0, (500.0, 500.0), design_shift=DESIGN.shift), (100.0, 30.0, 140.0, 60.0))
    log_dir = tmp_path / "log"
    records = [searchreport.load(log_dir / name) for name in SearchLog(log_dir).ids()]
    answer = searchreport.sweep(records, needs=(1, 5), agrees=(0.5,))
    one, five = answer["settings"]
    assert answer["records"] == 2 and answer["found"] == 1
    # One look calls the pitch-off pose found, wrongly; five call it right,
    # as both searches ran; neither finds the board that was never seen.
    assert (one["found"], one["wrong"], one["recorded"]) == (1, 1, 0)
    assert (five["found"], five["wrong"], five["recorded"], five["found_unjudged"]) == (1, 0, 2, 0)
    assert five["median_poses"] > one["median_poses"]
    # A pcbv build that locks nowhere loses every stop a pose was used at.
    program = tmp_path / "blind-pcbv"
    program.write_text(f"#!{sys.executable}\nimport json, sys\nprint(json.dumps({{'state': 'Lost', 'pose': None, 'spots': []}}))\nsys.exit(2)\n", encoding="utf-8")
    os.chmod(program, 0o755)
    lines = searchreport.sweep(records, (5,), (0.5,), str(program))["pcbv"]
    assert [line["pictures"] for line in lines] == [len(record.of("picture")) for record in records]
    found_line = next(line for line in lines if line["id"] == records[0].header["id"])
    assert found_line["used_then"] >= 2 and found_line["lost_now"] == found_line["used_then"] and found_line["locked_now"] == 0
    assert searchreport.main(["--dir", str(log_dir), "sweep", "--need", "1,5", "--agree", "0.5"]) == 0
    out = capsys.readouterr().out
    assert "2 records, 1 found" in out and "need 1 within 0.5: 1 of 2, 1 wrong" in out and "(as recorded in 2)" in out
