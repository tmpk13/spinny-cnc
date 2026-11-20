"""Surveys (survey.py): the robust fit of a board to the head's places, a
grade's numbers on made up locks, the baseline's verdict, the sweep's
stops and the searches' grade, pcbv played by a small script."""

from __future__ import annotations

import json
import math
import stat
import sys
import time

import numpy as np
import pytest

from spinny_web import survey

# The made up board lies turned 0.4 degrees, shifted as a LumenPnP's was.
TURN = 0.4
SHIFT = (-20.5, 375.0)


def head_over(point, turn=TURN, shift=SHIFT):
    """The head's place over a board point given as (x, -y)."""
    return survey.rotation(math.radians(turn)) @ np.asarray(point, dtype=float) + np.asarray(shift)


def similarity(center, angle_deg, mm_per_px, width=1280, height=720):
    """A row major map from picture pixels to KiCad board points that puts
    `center` under the picture's middle, turned and scaled."""
    a = math.radians(angle_deg)
    c, s = math.cos(a) * mm_per_px, math.sin(a) * mm_per_px
    tx = center[0] - (c * width / 2 - s * height / 2)
    ty = center[1] - (s * width / 2 + c * height / 2)
    return [c, -s, tx, s, c, ty, 0.0, 0.0, 1.0]


def answer_at(board_xy, inliers=40, expected=50, width=1280, height=720):
    """pcbv's locked answer with the board point (KiCad x, y) under the
    picture's center."""
    return {
        "state": "Locked", "width": width, "height": height, "seconds": 0.3,
        "pose": {
            "image_to_board": similarity(board_xy, 180.2, 0.016, width, height), "inliers": inliers, "expected": expected,
            "mm_per_px": 0.016, "angle_deg": 180.2, "rms_mm": 0.02,
        },
    }


LOST = {"state": "Lost", "pose": None, "width": 1280, "height": 720, "seconds": 0.2}


def made_up(rng, right=20, wrong=6, lost=5, noise=0.03):
    """Stops and answers: `right` locks within `noise` mm of the truth,
    `wrong` ones tens of mm off, `lost` without a lock."""
    stops, found = [], []
    index = 0
    for _ in range(right):
        board = (rng.uniform(100, 200), rng.uniform(60, 150))
        head = head_over((board[0], -board[1])) + rng.normal(0.0, noise, 2)
        stops.append({"index": index, "asked": [round(head[0], 1), round(head[1], 1)], "joint": {"r": float(head[0]), "z": float(head[1])}})
        found.append(answer_at(board))
        index += 1
    for _ in range(wrong):
        board = (rng.uniform(100, 200), rng.uniform(60, 150))
        head = head_over((board[0], -board[1])) + rng.uniform(20.0, 60.0, 2)
        stops.append({"index": index, "asked": [0, 0], "joint": {"r": float(head[0]), "z": float(head[1])}})
        found.append(answer_at(board, inliers=12, expected=40))
        index += 1
    for _ in range(lost):
        stops.append({"index": index, "asked": [100.0 + index, 250.0], "joint": {}})
        found.append(LOST)
        index += 1
    return stops, found


def test_fit_rigid_gives_back_the_turn_and_shift():
    rng = np.random.default_rng(1)
    src = rng.uniform(-50, 50, (12, 2))
    dst = np.array([head_over(p, 12.5, (3.0, -4.0)) for p in src])
    theta, rot, shift = survey.fit_rigid(src, dst)
    assert math.degrees(theta) == pytest.approx(12.5, abs=1e-9)
    assert shift == pytest.approx([3.0, -4.0], abs=1e-9)
    assert np.allclose(src @ rot.T + shift, dst)


def test_robust_fit_sees_through_wrong_points():
    rng = np.random.default_rng(2)
    src = rng.uniform(0, 100, (30, 2))
    dst = np.array([head_over(p) for p in src]) + rng.normal(0.0, 0.02, (30, 2))
    # A third of them wrong, all by the same shift: a rival map the
    # majority must outvote.
    dst[:10] += (35.0, -12.0)
    fit = survey.robust_fit(src, dst)
    assert fit.turn_deg == pytest.approx(TURN, abs=0.05)
    assert fit.shift == pytest.approx(SHIFT, abs=0.1)
    assert (fit.errors[:10] > 30).all()
    assert (fit.errors[10:] < 0.1).all()


def test_robust_fit_starts_from_every_point_without_a_pair_apart():
    src = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]])
    dst = np.array([head_over(p) for p in src])
    fit = survey.robust_fit(src, dst)
    assert fit.errors.max() < 1e-9
    with pytest.raises(ValueError):
        survey.robust_fit(src[:1], dst[:1])


def test_row_of_puts_the_board_point_under_the_middle_as_x_minus_y():
    stop = {"index": 3, "asked": [1.0, 2.0], "joint": {"r": 10.0, "z": 20.0}}
    row = survey.row_of(stop, answer_at((150.0, 100.0), inliers=30, expected=40))
    assert row["head"] == [10.0, 20.0]
    assert row["board"] == pytest.approx([150.0, -100.0])
    assert row["match"] == pytest.approx(0.75)
    # A smaller picture's middle is its own.
    row = survey.row_of(stop, answer_at((150.0, 100.0), width=640, height=480))
    assert row["board"] == pytest.approx([150.0, -100.0])
    # No place read back: the place asked for.
    row = survey.row_of({"index": 4, "asked": [1.0, 2.0], "joint": {}}, LOST)
    assert row["head"] == [1.0, 2.0] and "board" not in row and row["state"] == "lost"


def test_grade_counts_right_and_wrong_locks():
    rng = np.random.default_rng(3)
    stops, found = made_up(rng, noise=0.03)
    rows = [survey.row_of(s, a) for s, a in zip(stops, found)]
    answer = survey.grade(rows)
    assert (answer["pictures"], answer["locked"], answer["right"], answer["wrong"]) == (31, 26, 20, 6)
    assert answer["truth"] == "fitted"
    assert answer["turn_deg"] == pytest.approx(TURN, abs=0.05)
    # The heads scatter 0.03 mm in each axis about the truth: their
    # distances from the fit have an rms of about 0.03 * sqrt(2).
    assert answer["right_rms_mm"] == pytest.approx(0.03 * math.sqrt(2), rel=0.4)
    assert answer["right_error"]["max"] < 0.2
    offs = [w["error_mm"] for w in answer["wrong_locks"]]
    assert offs == sorted(offs, reverse=True) and min(offs) > 20
    assert answer["match_right"]["median"] == pytest.approx(0.8)
    assert answer["match_wrong"]["median"] == pytest.approx(0.3)
    text = survey.grade_text(answer)
    assert "31 pictures, 26 locked" in text and "right locks 20" in text and "wrong locks 6" in text


def test_grade_against_a_truth_given():
    rng = np.random.default_rng(4)
    stops, found = made_up(rng, right=10, wrong=2, lost=1, noise=0.01)
    rows = [survey.row_of(s, a) for s, a in zip(stops, found)]
    answer = survey.grade(rows, {"turn_deg": TURN, "shift": list(SHIFT)})
    assert answer["truth"] == "given"
    assert (answer["right"], answer["wrong"]) == (10, 2)
    # A truth a few millimeters off makes every lock wrong.
    answer = survey.grade(rows, {"turn_deg": TURN, "shift": [SHIFT[0] + 3.0, SHIFT[1]]})
    assert (answer["right"], answer["wrong"]) == (0, 12)
    assert answer["right_rms_mm"] is None


def test_grade_with_too_few_locks_fits_nothing():
    rows = [survey.row_of({"index": i, "asked": [0, 0]}, LOST) for i in range(4)]
    answer = survey.grade(rows)
    assert answer["truth"] is None and answer["locked"] == 0
    assert "too few locks" in survey.grade_text(answer)


def test_worse_and_better():
    kept = {"right": 52, "wrong": 54, "right_rms_mm": 0.069}
    assert survey.worse({"right": 52, "wrong": 54, "right_rms_mm": 0.07}, kept, 0.005) == []
    assert survey.worse({"right": 51, "wrong": 54, "right_rms_mm": 0.06}, kept, 0.005) == ["right 51 < 52"]
    assert survey.worse({"right": 60, "wrong": 55, "right_rms_mm": 0.06}, kept, 0.005) == ["wrong 55 > 54"]
    assert survey.worse({"right": 52, "wrong": 54, "right_rms_mm": 0.08}, kept, 0.005)
    assert survey.worse({"right": 0, "wrong": 0, "right_rms_mm": None}, kept, 0.005)
    assert survey.better({"right": 53, "wrong": 54, "right_rms_mm": 0.069}, kept)
    assert survey.better({"right": 52, "wrong": 50, "right_rms_mm": 0.069}, kept)
    assert not survey.better({"right": 52, "wrong": 54, "right_rms_mm": 0.069}, kept)


def test_grid_runs_back_and_forth():
    places = survey.grid((80.0, 225.0, 96.0, 240.0), (8.0, 7.5))
    assert places == [
        (80.0, 225.0), (88.0, 225.0), (96.0, 225.0),
        (96.0, 232.5), (88.0, 232.5), (80.0, 232.5),
        (80.0, 240.0), (88.0, 240.0), (96.0, 240.0),
    ]
    # The battery card's sweep: 13 by 13.
    assert len(survey.grid((80.0, 225.0, 176.0, 315.0), (8.0, 7.5))) == 169
    with pytest.raises(ValueError):
        survey.grid((0.0, 0.0, 10.0, 10.0), (0.0, 1.0))


def test_middle_truth_takes_the_record_frame_and_the_camera_offset():
    truth = {"turn_deg": TURN, "shift": list(SHIFT)}
    # A front side job: (x, -y) shifted so the outline's middle is 0, 0.
    header = {"board_to_job": [[1.0, 0.0, -148.5], [0.0, -1.0, 105.0]], "middle": [0.0, 0.0], "picture": {"offset": [23.5, 65.2]}}
    place = survey.middle_truth(truth, header)
    expected = head_over((148.5, -105.0)) + (23.5, 65.2)
    assert place.center == pytest.approx(tuple(expected))
    assert place.turn_deg == pytest.approx(TURN)
    assert survey.middle_truth(truth, {"middle": [0, 0]}) is None


def test_searches_are_graded_against_the_truth():
    truth = survey.Truth((150.0, 335.0), 0.2)
    lines = [
        {"start": [80, 225], "seconds": 9.0, "routine": {"state": "done"},
         "record": {"id": "a", "result": "found", "visited": 2, "stops": 80, "estimate": {"center": [150.1, 335.0], "rotation": -0.2, "match": 0.8}}},
        {"start": [60, 270], "seconds": 30.0, "routine": {"state": "done"},
         "record": {"id": "b", "result": "found", "visited": 9, "stops": 80, "estimate": {"center": [170.0, 300.0], "rotation": 90.0}}},
        {"start": [0, 0], "seconds": 60.0, "routine": {"state": "error"}, "record": {"id": "c", "result": "not found"}},
    ]
    rows = [survey.grade_search(line, truth) for line in lines]
    assert rows[0]["off_mm"] == pytest.approx(0.1) and rows[0]["off_deg"] == pytest.approx(-0.4)
    assert rows[1]["off_mm"] > 30 and "off_mm" not in rows[2]
    summary = survey.searches_summary(rows)
    assert (summary["searches"], summary["found"], summary["right"], summary["wrong"]) == (3, 2, 1, 1)
    assert "3 searches, 2 found: 1 right" in survey.searches_text(rows, summary, truth)
    assert survey.given_truth("150,335,0.2") == truth
    with pytest.raises(ValueError):
        survey.given_truth("150,335")


# --- pcbv played by a script ---------------------------------------------------------------------


FAKE_PCBV = """#!{python}
# Plays pcbv locate: prints the answer kept beside the picture
# (NNNN.answer.json) and counts its runs in runs.txt beside it.
import json, pathlib, sys
picture = pathlib.Path(sys.argv[3])
with open(picture.parent / "runs.txt", "a") as fh:
    fh.write(" ".join(sys.argv[4:]) + "\\n")
answer = json.loads(picture.with_suffix(".answer.json").read_text())
answer["spots"] = [[1, 2]]
print(json.dumps(answer))
sys.exit(0 if answer.get("pose") else 2)
"""


def fake_survey(tmp_path, stops, found):
    folder = tmp_path / "surveys" / "made-up"
    folder.mkdir(parents=True)
    (folder / survey.STOPS).write_text("".join(json.dumps(s) + "\n" for s in stops))
    (folder / survey.BOARD).write_text("(kicad_pcb)\n")
    for stop, answer in zip(stops, found):
        survey.picture_of(folder, stop["index"]).write_bytes(b"\xff\xd8\xff\xd9")
        (folder / f"{stop['index']:04d}.answer.json").write_text(json.dumps(answer))
    program = tmp_path / "pcbv"
    program.write_text(FAKE_PCBV.format(python=sys.executable))
    program.chmod(program.stat().st_mode | stat.S_IXUSR)
    return folder, program


def runs(folder):
    path = folder / "runs.txt"
    return path.read_text().splitlines() if path.is_file() else []


def test_graded_runs_pcbv_once_per_build_board_and_options(tmp_path):
    rng = np.random.default_rng(5)
    stops, found = made_up(rng, right=8, wrong=2, lost=2)
    folder, program = fake_survey(tmp_path, stops, found)
    answer = survey.graded(folder, ["--finish", "masked"], program=str(program), jobs=3)
    assert (answer["locked"], answer["right"], answer["wrong"]) == (10, 8, 2)
    assert len(runs(folder)) == 12 and runs(folder)[0] == "--json --finish masked"
    kept = json.loads((tmp_path / answer["cache"] / "locate-0000.json").read_text())
    assert "spots" not in kept
    # The same build, board and options: every answer from the cache.
    again = survey.graded(folder, ["--finish", "masked"], program=str(program))
    assert again["right"] == 8 and len(runs(folder)) == 12
    # Other options: pcbv again.
    survey.graded(folder, ["--finish", "bare"], program=str(program))
    assert len(runs(folder)) == 24
    # The fit is kept as the truth, and only a better one replaces it.
    assert survey.keep_truth(folder, answer)
    assert json.loads((folder / survey.TRUTH).read_text())["right"] == 8
    assert not survey.keep_truth(folder, again)


def test_main_grade_takes_pcbv_options_after_a_double_dash(tmp_path, capsys):
    rng = np.random.default_rng(6)
    stops, found = made_up(rng, right=6, wrong=1, lost=1)
    folder, program = fake_survey(tmp_path, stops, found)
    code = survey.main(["--dir", str(folder.parent), "grade", "made-up", "--pcbv", str(program), "--json", "--", "--scale", "0.01:0.02"])
    assert code == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["options"] == ["--scale", "0.01:0.02"] and answer["right"] == 6
    assert runs(folder)[0] == "--json --scale 0.01:0.02"
    with pytest.raises(SystemExit):
        survey.main(["--dir", str(folder.parent), "baseline", "--", "--scale", "1:2"])


def test_baseline_fails_a_build_that_does_worse(tmp_path, capsys):
    rng = np.random.default_rng(7)
    stops, found = made_up(rng, right=8, wrong=2, lost=2, noise=0.01)
    folder, program = fake_survey(tmp_path, stops, found)
    truth = {"turn_deg": TURN, "shift": list(SHIFT)}
    rms = survey.graded(folder, ["--finish", "masked"], program=str(program), truth=truth)["right_rms_mm"]
    data = {
        "survey": "made-up", "pictures": 12, "board_sha256": survey.sha256_of(folder / survey.BOARD), "truth": truth, "rms_slack_mm": 0.005,
        "cases": {"scale": {"options": ["--finish", "masked"], "pictures": 12, "locked": 10, "right": 8, "wrong": 2, "right_rms_mm": round(rms, 4)}},
    }
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps(data))
    argv = ["--dir", str(folder.parent), "baseline", "--file", str(baseline), "--pcbv", str(program)]
    assert survey.main(argv) == 0
    assert "as good" in capsys.readouterr().out
    # A build that loses two right locks: one picture lost, one wrong.
    (folder / "0000.answer.json").write_text(json.dumps(LOST))
    worse = answer_at((150.0, 100.0))
    (folder / "0001.answer.json").write_text(json.dumps(worse))
    other = tmp_path / "pcbv-other"
    other.write_text(program.read_text() + "# another build\n")
    other.chmod(program.stat().st_mode)
    argv[-1] = str(other)
    assert survey.main(argv) == 1
    out = capsys.readouterr().out
    assert "WORSE" in out and "right 6 < 8" in out and "wrong 3 > 2" in out
    # Kept on request: the baseline is then what was measured.
    assert survey.main([*argv, "--write"]) == 0
    kept = json.loads(baseline.read_text())["cases"]["scale"]
    assert (kept["right"], kept["wrong"]) == (6, 3) and "sha256" in kept["pcbv"]
    # Another board than the baseline's is refused.
    (folder / survey.BOARD).write_text("(kicad_pcb (version 2))\n")
    assert survey.main(argv) == 2


def test_stale_stops_are_left_out_of_a_grade(tmp_path):
    rng = np.random.default_rng(8)
    stops, found = made_up(rng, right=8, wrong=2, lost=2, noise=0.01)
    folder, program = fake_survey(tmp_path, stops, found)
    truth = {"turn_deg": TURN, "shift": list(SHIFT)}
    whole = survey.graded(folder, ["--finish", "masked"], program=str(program), truth=truth)
    assert (whole["pictures"], whole["right"], whole["wrong"]) == (12, 8, 2)
    # Named by a baseline: two right locks' pictures were of another place.
    less = survey.graded(folder, ["--finish", "masked"], program=str(program), truth=truth, skip=frozenset({0, 1}))
    assert (less["pictures"], less["right"], less["wrong"]) == (10, 6, 2)
    data = {
        "survey": "made-up", "pictures": 12, "board_sha256": survey.sha256_of(folder / survey.BOARD), "truth": truth, "rms_slack_mm": 0.005,
        "stale": {"stops": [0, 1]},
        "cases": {"scale": {"options": ["--finish", "masked"], "pictures": 10, "locked": 8, "right": 6, "wrong": 2, "right_rms_mm": 1.0}},
    }
    result = survey.run_baseline(data, folder, ["scale"], str(program), 1)[0]
    assert result["now"]["pictures"] == 10 and result["now"]["right"] == 6 and not result["worse"]
    # Marked by the sweep itself: left out without being named.
    lines = [json.loads(line) for line in (folder / survey.STOPS).read_text().splitlines()]
    lines[2]["stale"] = True
    (folder / survey.STOPS).write_text("".join(json.dumps(line) + "\n" for line in lines))
    assert survey.graded(folder, ["--finish", "masked"], program=str(program), truth=truth)["pictures"] == 11


def test_the_shipped_baseline_names_its_cases():
    data = survey.read_baseline()
    assert data["pictures"] == 169
    scale = data["cases"]["scale"]
    assert "--scale" in scale["options"]
    # Two of the sweep's 169 stops kept the picture of the stop before.
    assert data["stale"]["stops"] == [24, 46] and scale["pictures"] == 167
    assert (scale["locked"], scale["right"], scale["wrong"]) == (130, 72, 58)
    # A measured camera whose pcbv trusts its whole-picture search locks no
    # picture wrong.
    sure = data["cases"]["sure"]
    assert "sure" in sure["options"] and sure["wrong"] == 0 and sure["right"] >= 114


# --- the sweep, over a backend played by a class -------------------------------------------------


class FakeBackend(survey.Backend):
    """A backend whose G-code machine's head goes where it is sent, read
    back 0.01 mm off, its top camera answering a picture naming the place."""

    def __init__(self, connected=True):
        super().__init__("http://fake")
        self.at = (0.0, 0.0)
        self.connected = connected
        self.sent = []

    def goto(self, place):
        self.sent.append(place)
        self.at = place

    def joint(self):
        return {"r": self.at[0] + 0.01, "z": self.at[1], "h": 31.5, "a": 0.0}

    def placing(self):
        return {"connected": self.connected, "name": "Fake LumenPnP", "position": {"x": self.at[0], "y": self.at[1]},
                "top": {"offset": [23.5, 65.2], "board_look": {"pose": "lost", "found": False}}}

    def picture(self, path, timeout=120.0):
        assert path.startswith("/api/pnp/top/frame.jpg?width=640&overlay=0")
        self.asked = getattr(self, "asked", 0) + 1
        # The ages a test scripted, one a request, then fresh pictures.
        ages = getattr(self, "ages", [])
        age = ages.pop(0) if ages else 0.0
        return f"picture at {self.at}".encode(), age


def test_sweep_keeps_a_picture_and_the_place_read_back_at_each_stop(tmp_path):
    backend = FakeBackend()
    places = survey.grid((10.0, 20.0, 12.0, 21.0), (1.0, 1.0))
    folder = tmp_path / "s"
    done = survey.sweep(backend, folder, places, 0.0, 640, {"box": [10, 20, 12, 21]}, say=lambda text: None)
    assert done == 6 and backend.sent == places
    stops = survey.read_stops(folder)
    assert [s["index"] for s in stops] == list(range(6))
    assert stops[3]["asked"] == [12.0, 21.0] and stops[3]["joint"]["r"] == pytest.approx(12.01)
    assert survey.head_of(stops[3]) == pytest.approx((12.01, 21.0))
    assert survey.picture_of(folder, 3).read_bytes() == b"picture at (12.0, 21.0)"
    header = json.loads((folder / survey.HEADER).read_text())
    assert header["machine"] == "Fake LumenPnP" and header["stops"] == 6 and header["top"]["offset"] == [23.5, 65.2]
    with pytest.raises(ValueError, match="no G-code machine"):
        survey.sweep(FakeBackend(connected=False), tmp_path / "t", places, 0.0, 640, {}, say=lambda text: None)


def test_sweep_asks_again_for_a_picture_taken_before_the_head_came_to_rest(tmp_path, monkeypatch):
    monkeypatch.setattr(survey, "FRESH_SECONDS", 0.5)
    places = [(10.0, 20.0)]
    # A camera that stalled: its last picture is 30 s old at the first ask,
    # and a fresh one comes at the third.
    backend = FakeBackend()
    backend.ages = [30.0, 30.1]
    said = []
    assert survey.sweep(backend, tmp_path / "s", places, 0.0, 640, {}, say=said.append) == 1
    stop = survey.read_stops(tmp_path / "s")[0]
    assert backend.asked == 3 and "stale" not in stop and stop["age_ms"] == 0.0
    # One that never delivers again: the old picture is kept, and marked.
    dead = FakeBackend()
    dead.ages = [30.0 + 0.1 * i for i in range(100)]
    assert survey.sweep(dead, tmp_path / "t", places, 0.0, 640, {}, say=said.append) == 1
    stop = survey.read_stops(tmp_path / "t")[0]
    assert stop["stale"] is True and any("stale" in text for text in said)
    # A backend that tells no age is taken at its word, once.
    old = FakeBackend()
    old.ages = [None]
    assert survey.sweep(old, tmp_path / "u", places, 0.0, 640, {}, say=said.append) == 1
    assert old.asked == 1 and "age_ms" not in survey.read_stops(tmp_path / "u")[0]


def test_a_slow_answer_never_passes_a_picture_from_before_the_rest_as_fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(survey, "FRESH_SECONDS", 0.4)

    class Slow(FakeBackend):
        """A camera stuck on a picture taken just before the head came to
        rest; the backend tells its age as it answers, and the answer takes
        0.2 s to arrive."""

        def goto(self, place):
            super().goto(place)
            self.captured = time.monotonic() - 0.02

        def picture(self, path, timeout=120.0):
            self.asked = getattr(self, "asked", 0) + 1
            age = time.monotonic() - self.captured
            time.sleep(0.2)
            return b"old picture", age

    backend = Slow()
    assert survey.sweep(backend, tmp_path / "s", [(10.0, 20.0)], 0.0, 640, {}, say=lambda text: None) == 1
    stop = survey.read_stops(tmp_path / "s")[0]
    assert stop.get("stale") is True and backend.asked > 1


def test_a_search_kept_without_its_frame_takes_the_record_header(tmp_path):
    header = {"board_to_job": [[1.0, 0.0, -148.5], [0.0, -1.0, 105.0]], "middle": [0.0, 0.0], "picture": {"offset": [23.5, 65.2]}}
    (tmp_path / "20261114-192146-000").mkdir()
    (tmp_path / "20261114-192146-000" / "record.json").write_text(json.dumps(header))
    line = {"record": {"id": "20261114-192146-000"}}
    assert survey.header_of(line, tmp_path) == header
    assert survey.header_of({"record": {"id": "missing"}}, tmp_path) == {}
    kept = {"header": {**header, "middle": [1.0, 1.0]}}
    assert survey.header_of(kept, tmp_path)["middle"] == [1.0, 1.0]
