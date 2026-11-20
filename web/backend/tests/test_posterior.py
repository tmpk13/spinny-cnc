"""The probability over a board's pose (posterior.py): a lock makes a
hypothesis, a picture with nothing in it lowers the poses that would have
shown the board there, a repeated pattern splits the probability until a
picture tells the places apart, a wrong candidate stays a hypothesis of its
own, corners rule out, the next stop is the one that narrows most, the
board's stretch is fitted from pictures far apart, and a search with the
posterior finds and checks the board."""

from __future__ import annotations

import math

import pytest
from device_fakes import SeenBoard

from spinny_web import boardlook
from spinny_web.boardlook import BoardLook, Corner, PictureFrame, pose_estimate, rival_of, search, search_stops
from spinny_web.camera import picture_to_machine
from spinny_web.jobs import Design
from spinny_web.posterior import Board, Posterior, detection, strength

DESIGN = Design(shift=(-100.0, -70.0), board=True)
OUTLINE = (0.0, 0.0, 40.0, 30.0)
MIDDLE = (20.0, 15.0)
SCALE = 0.02
SIZE = (1280, 720)
TRUTH_TURN = 2.0
TRUTH_SHIFT = (150.0, 80.0)
# Pads on a 2 mm grid over the board but a margin: a picture 25.6 by 14.4
# mm holds about 80 of them over the board.
PADS = [(1.0 + 2.0 * i, 1.0 + 2.0 * j) for i in range(20) for j in range(15)]
# pcbv locks once the picture holds this many of the board's features.
LOCK_FEATURES = 10


def turn(point, degrees):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    return (point[0] * c - point[1] * s, point[0] * s + point[1] * c)


def machine_of(job, rotation=TRUTH_TURN, shift=TRUTH_SHIFT, stretch=(1.0, 1.0)):
    """Where a job point lies on the machine for a board at `rotation`,
    `shift`, stretched about its middle."""
    x = MIDDLE[0] + (job[0] - MIDDLE[0]) * stretch[0]
    y = MIDDLE[1] + (job[1] - MIDDLE[1]) * stretch[1]
    tx, ty = turn((x, y), rotation)
    return (tx + shift[0], ty + shift[1])


def truth_middle(rotation=TRUTH_TURN, shift=TRUTH_SHIFT):
    return machine_of(MIDDLE, rotation, shift)


class FakePcbv:
    """pcbv over a board on the machine, as the posterior reads it: every
    pose is a new search; it locks when the picture holds LOCK_FEATURES of
    the board's pads, wherever its center is, and lists its candidates: the
    lock, and on a repeated pattern (`pitch`) the pose one pitch along the
    board's X as a rival `ratio` as strong. `stretch` stretches the board
    on the machine about its middle."""

    def __init__(self, rotation=TRUTH_TURN, shift=TRUTH_SHIFT, pitch=None, ratio=0.95, stretch=(1.0, 1.0), candidates=True):
        self.seen = SeenBoard(OUTLINE, rotation, shift, design_shift=DESIGN.shift)
        self.rotation = rotation
        self.shift = shift
        self.pitch = pitch
        self.ratio = ratio
        self.stretch = stretch
        self.candidates = candidates
        self.searches = 0

    def job_at(self, machine):
        """The job point at a machine point (the stretch undone)."""
        x, y = turn((machine[0] - self.shift[0], machine[1] - self.shift[1]), -self.rotation)
        return (MIDDLE[0] + (x - MIDDLE[0]) / self.stretch[0], MIDDLE[1] + (y - MIDDLE[1]) / self.stretch[1])

    def in_view(self, center, roll=0.0) -> int:
        count = 0
        for pad in PADS:
            point = machine_of(pad, self.rotation, self.shift, self.stretch)
            dx, dy = point[0] - center[0], point[1] - center[1]
            u = dx * math.cos(math.radians(roll)) + dy * math.sin(math.radians(roll))
            v = -dx * math.sin(math.radians(roll)) + dy * math.cos(math.radians(roll))
            if abs(u) <= SIZE[0] * SCALE / 2.0 and abs(v) <= SIZE[1] * SCALE / 2.0:
                count += 1
        return count

    def pose(self, center, roll=0.0, mirror=False, off=(0.0, 0.0)) -> dict:
        self.searches += 1
        count = self.in_view(center, roll)
        base = {"frame": self.searches, "age_ms": 0, "width": SIZE[0], "height": SIZE[1], "fps": 10.0, "spots": count, "searched": True, "search": self.searches}
        if count < LOCK_FEATURES:
            return {**base, "state": "lost"}

        def kicad_at(dx, dy):
            offset = picture_to_machine(dx, dy, SCALE, roll, mirror)
            job = self.job_at((center[0] + offset[0], center[1] + offset[1]))
            return [job[0] + off[0] - DESIGN.shift[0], -(job[1] + off[1] - DESIGN.shift[1])]

        w, h = SIZE
        held = {
            "center": kicad_at(0.0, 0.0), "corners": [kicad_at(-w / 2, -h / 2), kicad_at(w / 2, -h / 2), kicad_at(w / 2, h / 2), kicad_at(-w / 2, h / 2)],
            "angle_deg": roll - self.rotation, "mm_per_px": SCALE, "found": count - 1, "inliers": count - 1, "expected": count, "unsure": 0, "rms_mm": 0.03,
        }
        raw = {**base, "state": "locked", "acquisition": self.searches, **held}
        listed = [{**held, "passed": True, "held": True}]
        if self.pitch is not None:
            other = {key: value for key, value in held.items()}
            other["center"] = [held["center"][0] + self.pitch, held["center"][1]]
            other["corners"] = [[x + self.pitch, y] for x, y in held["corners"]]
            other["found"] = (count - 1) * self.ratio
            raw["rival"] = {"center": other["center"], "angle_deg": other["angle_deg"], "found": other["found"], "ratio": self.ratio}
            listed.append({**other, "passed": True, "held": False})
        if self.candidates:
            raw["candidates"] = listed
            raw["candidates_search"] = self.searches
        return raw


def feed(posterior: Posterior, raw: dict, frame: PictureFrame) -> None:
    """A pose into the probability, as the board look gives it one."""
    estimate, problem = pose_estimate(raw, frame, DESIGN.board_to_job, MIDDLE)
    if estimate is not None:
        estimate.session = int(raw.get("acquisition", 0))
        estimate.rival = rival_of(raw)
    posterior.take(raw, frame, 0.0, DESIGN.board_to_job, estimate, problem)


def board() -> Board:
    return Board.of(MIDDLE, OUTLINE, PADS)


def look(posterior: Posterior, pcbv: FakePcbv, center, times: int = 1) -> None:
    for _ in range(times):
        feed(posterior, pcbv.pose(center), PictureFrame(center, 0.0, False))


def test_detection_grows_with_the_features_in_view_and_strength_with_the_match():
    assert float(detection(0)) == 0.0
    assert float(detection(6)) == pytest.approx(0.9 * (1.0 - math.exp(-1.0)))
    assert float(detection(100)) == pytest.approx(0.9, abs=1e-6)
    # Even at the match where right and wrong locks were as likely, steep
    # about it: a right lock's 0.85 against a wrong one's 0.32.
    assert strength(0.65) == pytest.approx(1.0)
    assert strength(0.65, passed=False) == pytest.approx(0.5)
    assert strength(0.85) / strength(0.32) > 1000.0


def test_a_lock_makes_a_hypothesis_where_the_board_lies_and_two_searches_find_it():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, threshold=0.5)
    pcbv = FakePcbv()
    center = machine_of((12.0, 10.0))
    look(posterior, pcbv, center)
    lead = posterior.lead
    assert lead is not None
    assert math.dist(lead.estimate.center, middle) < 0.05
    assert abs(lead.estimate.rotation - TRUTH_TURN) < 0.05
    assert lead.probability > 0.5
    assert lead.spread_mm < 0.5 and lead.spread_deg < 1.0
    # One search: likely, but the vote's two independent locks are asked of it too.
    assert not posterior.found and posterior.wants_another_lock
    look(posterior, pcbv, center)
    assert posterior.found
    assert len(posterior.views) == 1, "two searches of one picture are one view"
    data = posterior.to_dict()
    assert data["method"] == "posterior" and data["views"] == 1 and data["found"]
    assert 0.0 <= data["elsewhere"] < 0.5


def test_a_picture_with_nothing_in_it_lowers_the_poses_that_would_have_shown_the_board():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, scale=SCALE)
    before = posterior._elsewhere()
    # A picture of the bare bed beside the board: it would have shown the
    # board's pads for every pose that puts the board under it.
    empty = (middle[0] - 40.0, middle[1])
    pcbv = FakePcbv()
    assert pcbv.in_view(empty) == 0
    look(posterior, pcbv, empty)
    assert posterior.lead is None
    assert posterior._elsewhere() < before - 0.05
    # The pictures over the empty place are now less likely to show the
    # board than those over the box's far side.
    near = posterior.look_value(empty, 0.0, False, SIZE[0], SIZE[1], SCALE)
    far = posterior.look_value((middle[0] + 10.0, middle[1]), 0.0, False, SIZE[0], SIZE[1], SCALE)
    assert far > near


def test_a_repeated_pattern_splits_the_probability_until_a_picture_tells_the_places_apart():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, threshold=0.5, sessions=1)
    # A pattern repeated so well that the pitch off fits as the truth does.
    repeated = FakePcbv(pitch=2.54, ratio=1.0)
    center = machine_of((20.0, 15.0))
    look(posterior, repeated, center)
    assert len(posterior.guesses) >= 2
    first, second = posterior.guesses[0], posterior.guesses[1]
    assert abs(first.probability - second.probability) < 0.25
    assert not posterior.found
    # A picture at the board's edge, which the pattern does not reach: only
    # the true place gives a lock there (one pcbv numbers its searches on).
    repeated.pitch = None
    edge = machine_of((4.0, 15.0))
    look(posterior, repeated, edge)
    lead = posterior.lead
    assert lead is not None
    assert math.dist(lead.estimate.center, middle) < 0.1
    assert posterior.found


def test_a_wrong_candidate_is_a_hypothesis_of_its_own_and_does_not_bend_the_fit():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, sessions=1)
    plain = FakePcbv()
    for job in ((10.0, 8.0), (30.0, 8.0), (30.0, 22.0)):
        look(posterior, plain, machine_of(job))
    # One picture whose lock is a pitch off, nothing else in it.
    wrong = machine_of((10.0, 22.0))
    feed(posterior, plain.pose(wrong, off=(2.54, 0.0)), PictureFrame(wrong, 0.0, False))
    lead = posterior.lead
    assert lead is not None
    assert math.dist(lead.estimate.center, middle) < 0.05
    assert len(posterior.hypotheses) >= 2
    assert lead.probability > 0.9


def test_a_candidate_the_whole_picture_fits_counts_by_its_score_not_by_its_few_pairs():
    posterior = Posterior(board(), None, sessions=1)
    plain = FakePcbv()
    center = machine_of((20.0, 15.0))
    raw = plain.pose(center)
    frame = PictureFrame(center, 0.0, False)
    # pcbv's whole-picture search locked a view whose pads the spot finder
    # saw a third of: the candidate says how well the picture fits.
    held = raw["candidates"][0]
    held["found"] = held["inliers"] = held["expected"] / 3.0
    estimate, _ = pose_estimate(raw, frame, DESIGN.board_to_job, MIDDLE)
    by_pairs = posterior._candidates(raw, frame, DESIGN.board_to_job, estimate)[0]
    assert by_pairs.match == pytest.approx(1.0 / 3.0)
    held["score"] = 0.82
    by_score = posterior._candidates(raw, frame, DESIGN.board_to_job, estimate)[0]
    assert by_score.match == pytest.approx(0.82)
    assert by_score.strength > 100.0 * by_pairs.strength


def test_corners_taken_rule_out_a_place_that_puts_one_elsewhere():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    shifted = (TRUTH_SHIFT[0] + 6.0, TRUTH_SHIFT[1])
    corner = Corner("bottom left", (0.0, 0.0), machine_of((0.0, 0.0), TRUTH_TURN, shifted))
    posterior = Posterior(board(), box, corners=[corner], corner_mm=2.0, sessions=1)
    look(posterior, FakePcbv(), machine_of((20.0, 15.0)))
    guess = posterior.guesses[0]
    assert guess.ruled_out and guess.corner_mm is not None and guess.corner_mm > 5.0
    assert posterior.lead is None and not posterior.found
    # The corner where the board really is: the place is found.
    right = Corner("bottom left", (0.0, 0.0), machine_of((0.0, 0.0)))
    posterior.tune(corners=[right])
    assert posterior.lead is not None and posterior.found


def test_the_next_stop_is_the_one_that_tells_two_places_apart():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, sessions=1)
    # Two places 6 mm apart along X, each as likely.
    pcbv = FakePcbv(pitch=6.0, ratio=1.0)
    look(posterior, pcbv, machine_of((20.0, 15.0)))
    assert len(posterior.hypotheses) == 2
    # Over the board's middle both places put pads in the picture; past
    # an edge, only one of them does.
    middle_stop = machine_of((20.0, 15.0))
    edge_stop = machine_of((-4.0, 15.0))
    assert posterior.look_value(edge_stop, 0.0, False, SIZE[0], SIZE[1], SCALE) > posterior.look_value(middle_stop, 0.0, False, SIZE[0], SIZE[1], SCALE)
    stops = [middle_stop, edge_stop]
    assert posterior.next_stop(stops, middle_stop, 0.0, False, SIZE[0], SIZE[1], SCALE, speed=1e9, look_seconds=1.0) == 1
    # The travel is counted against a stop: one as telling but far away waits.
    far = (edge_stop[0] - 500.0, edge_stop[1])
    assert posterior.next_stop([far, middle_stop], middle_stop, 0.0, False, SIZE[0], SIZE[1], SCALE, speed=10.0, look_seconds=1.0) == 1


def test_board_stretch_is_fitted_from_pictures_far_apart():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, stretch=True, sessions=1, scale=SCALE)
    stretched = FakePcbv(stretch=(1.004, 0.997))
    for job in [(x, y) for x in (6.0, 20.0, 34.0) for y in (5.0, 15.0, 25.0)]:
        look(posterior, stretched, machine_of(job, stretch=(1.004, 0.997)))
    stretch = posterior.stretch
    assert stretch is not None
    # Pictures place the board to a few hundredths of a mm, so nine of them
    # pull the scale well off 1, as far as the fab's tolerance lets them,
    # and the truth stays within the uncertainty they leave.
    assert stretch["scale_x"] > 1.0015 and abs(stretch["scale_x"] - 1.004) < 3.0 * stretch["scale_x_sd"]
    assert stretch["scale_y"] < 0.9993 and abs(stretch["scale_y"] - 0.997) < 3.0 * stretch["scale_y_sd"]
    assert abs(stretch["shear_deg"]) < 3.0 * stretch["shear_deg_sd"]
    lead = posterior.lead
    assert lead is not None and math.dist(lead.estimate.center, middle) < 0.05


def test_a_pcbv_before_candidates_gives_its_lock_and_rival():
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, sessions=1)
    old = FakePcbv(pitch=2.54, ratio=0.9, candidates=False)
    look(posterior, old, machine_of((20.0, 15.0)))
    assert len(posterior.hypotheses) == 2
    lead = posterior.lead
    assert lead is not None and math.dist(lead.estimate.center, middle) < 0.05


class SearchCamera:
    """The fake pcbv where the search's mover puts the picture's center."""

    def __init__(self, pcbv: FakePcbv) -> None:
        self.pcbv = pcbv
        self.center = (0.0, 0.0)
        self.running = True

    def pose(self) -> dict:
        return self.pcbv.pose(self.center)

    def request(self, cmd, timeout=None, **fields):
        return {"ok": True}

    def frame(self, width=None, overlay=False, quality=80):
        factor = max(1, -(-SIZE[0] // width)) if width else 1
        return {"width": SIZE[0] // factor, "height": SIZE[1] // factor, "frame": 0, "age_ms": 0}, b"\xff\xd8 picture \xff\xd9"


class Mover:
    def __init__(self, camera: SearchCamera) -> None:
        self.camera = camera
        self.places: list = []

    def go(self, head) -> None:
        self.places.append(head)
        self.camera.center = head


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(boardlook, "LOCK_SECONDS", 0.15)
    monkeypatch.setattr(boardlook, "STOP_SECONDS", 0.6)
    monkeypatch.setattr(boardlook, "SAMPLE_SECONDS", 0.01)


@pytest.mark.parametrize("steer", [False, True])
def test_a_search_with_the_posterior_finds_and_checks_the_board(quick, steer):
    middle = truth_middle()
    camera = SearchCamera(FakePcbv())
    look_ = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True, options=lambda: {"method": "posterior", "scale": SCALE})
    look_.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    box = (middle[0] - 30.0, middle[1] - 25.0, middle[0] + 30.0, middle[1] + 25.0)
    start = (box[0], box[1])
    stops = search_stops(box, (SIZE[0] * SCALE, SIZE[1] * SCALE), start)
    mover = Mover(camera)
    try:
        found = search(
            look_, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError,
            box=box, steer={"width": SIZE[0], "height": SIZE[1], "scale": SCALE, "speed": 30.0, "start": start} if steer else None,
        )
    finally:
        look_.stop()
    assert math.dist(found.center, middle) < 0.1
    assert abs(found.rotation - TRUTH_TURN) < 0.1
    # Found well before the box was covered.
    assert len(mover.places) < len(stops)


def test_a_board_found_and_checked_is_fitted_from_a_third_place_far_from_both(quick, monkeypatch):
    from spinny_web.boardlook import FINAL_PLACES, PLACES_MM, check_places

    checked = []
    looked = boardlook.look_at_stop

    def look_at(look, frame, stopped, error, check=None, *args, **kwargs):
        result = looked(look, frame, stopped, error, check, *args, **kwargs)
        if check is not None:
            checked.append((frame.center, result))
        return result

    monkeypatch.setattr(boardlook, "look_at_stop", look_at)
    middle = truth_middle()
    camera = SearchCamera(FakePcbv())
    look_ = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True, options=lambda: {"method": "posterior", "scale": SCALE})
    look_.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    box = (middle[0] - 30.0, middle[1] - 25.0, middle[0] + 30.0, middle[1] + 25.0)
    stops = search_stops(box, (SIZE[0] * SCALE, SIZE[1] * SCALE), (box[0], box[1]))
    mover = Mover(camera)
    view = (SIZE[0] * SCALE, SIZE[1] * SCALE)
    try:
        found = search(
            look_, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError,
            checks=lambda place: check_places(place, MIDDLE, OUTLINE, PADS, view), box=box,
        )
    finally:
        look_.stop()
    assert math.dist(found.center, middle) < 0.1
    # After the check that agreed, one more place 10 mm or more from the
    # stop that found the board and from that check, which agreed too.
    assert len(checked) == FINAL_PLACES - 1 and checked[0][1] == "agreed" and checked[1][1] == "agreed", checked
    assert math.dist(checked[0][0], checked[1][0]) >= PLACES_MM / 2.0 - 1e-6


def test_a_recorded_search_replays_through_the_posterior_and_the_sweep_sets_both_side_by_side(tmp_path, quick):
    from spinny_web import searchreport
    from spinny_web.boardlook import search_extra, settings_now
    from spinny_web.searchlog import SearchLog, affine_of

    middle = truth_middle()
    camera = SearchCamera(FakePcbv())
    look_ = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True, options=lambda: {"method": "vote"})
    look_.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    box = (middle[0] - 30.0, middle[1] - 25.0, middle[0] + 30.0, middle[1] + 25.0)
    start = (box[0], box[1])
    stops = search_stops(box, (SIZE[0] * SCALE, SIZE[1] * SCALE), start)
    header = {
        "job": {"id": "j1", "name": "board"},
        "board": {"file": "board.kicad_pcb", "side": "front", "finish": "masked"},
        "board_to_job": affine_of(DESIGN.board_to_job),
        "middle": list(MIDDLE),
        "outline_box": list(OUTLINE),
        "features": [list(pad) for pad in PADS],
        "picture": {"offset": [0.0, 0.0], "roll": 0.0, "mirror": False, "mm_per_px": SCALE, "width": SIZE[0], "height": SIZE[1], "mm_per_px_used": SCALE},
        "settings": settings_now(look_, "j1"),
        **search_extra(box, start, stops, SIZE[0] * SCALE, SIZE[1] * SCALE),
    }
    log = SearchLog(tmp_path / "log")
    record = log.begin("search", "head", header, None)
    assert record is not None
    try:
        search(look_, Mover(camera), stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError, record, box=box)
    finally:
        look_.stop()
    loaded = searchreport.load(record.folder)
    assert loaded.settings["method"] == "vote"
    row = searchreport.replay_posterior(loaded)
    assert row["found"] and row["error_mm"] < 0.1 and row["views"] >= 1
    answer = searchreport.sweep([loaded], methods=searchreport.METHODS, thresholds=(0.5, 0.99))
    assert answer["settings"] and [total["threshold"] for total in answer["posterior"]] == [0.5, 0.99]
    assert answer["posterior"][0]["found"] == 1 and answer["posterior"][0]["wrong"] == 0
    text = searchreport.sweep_text(answer)
    assert "the posterior, threshold" in text and "the vote, need" in text
    shown = searchreport.text(searchreport.summarize(loaded), None, None, searchreport.posterior_ifs(loaded))
    assert "threshold 0.5: found" in shown
    # Its stops ended again by today's stop rule, with the vote it ran with
    # and with the posterior: every stop kept, none longer than recorded.
    for method in ("vote", "posterior"):
        stopped = searchreport.replay_stops(loaded, method)
        assert stopped["method"] == method and stopped["saved_s"] >= 0.0
        assert [row["stop"] for row in stopped["stops"]] == [event["index"] for event in loaded.of("arrived")]
        assert all(row["replayed"] is not None and row["replayed_s"] <= row["seconds"] + 1e-9 for row in stopped["stops"])


def tracked(raw: dict, frame: int) -> dict:
    """pcbv's pose of a later frame that tracked `raw`'s lock: no search."""
    return {**raw, "frame": frame, "searched": False}


def test_a_stop_with_the_scale_known_ends_on_pcbvs_searches_not_on_its_clocks():
    from spinny_web.boardlook import LOCK_SECONDS, STOP_SEARCHES, TRACKED_POSES, StopEnd

    # A stop off the board: pcbv searches frame after frame and never locks.
    posterior = Posterior(board(), (100.0, 50.0, 200.0, 120.0), scale=SCALE)
    pcbv = FakePcbv()
    far = PictureFrame((100.0, 50.0), 0.0, False)
    rule = StopEnd(posterior, far, None, 0.0)
    ends = []
    for i in range(STOP_SEARCHES + 2):
        feed(posterior, pcbv.pose(far.center), far)
        ends.append(rule.see("none", 0.01 * (i + 1)))
    assert ends[: STOP_SEARCHES - 1] == [None] * (STOP_SEARCHES - 1) and ends[STOP_SEARCHES - 1] == "no lock"
    assert 0.01 * STOP_SEARCHES < LOCK_SECONDS
    # Poses read slower than pcbv searches: its numbers count the searches
    # not read too.
    rule = StopEnd(posterior, far, None, 0.0)
    pcbv.searches += 1
    feed(posterior, pcbv.pose(far.center), far)
    assert rule.see("none", 0.01) is None
    pcbv.searches += STOP_SEARCHES
    feed(posterior, pcbv.pose(far.center), far)
    assert rule.see("none", 0.02) == "no lock"

    # A lock at a place of a repeated pattern: two places as likely, so not
    # worth a check, and tracking it adds nothing: the stop ends `searched`.
    posterior = Posterior(board(), (100.0, 50.0, 200.0, 120.0), scale=SCALE)
    pcbv = FakePcbv(pitch=6.0, ratio=1.0)
    here = PictureFrame(truth_middle(), 0.0, False)
    rule = StopEnd(posterior, here, None, 0.0)
    raw = pcbv.pose(here.center)
    feed(posterior, raw, here)
    assert not posterior.worth_checking and rule.see("used", 0.01) is None
    ends = []
    for i in range(TRACKED_POSES):
        feed(posterior, tracked(raw, 100 + i), here)
        ends.append(rule.see("used", 0.02 + 0.01 * i))
    assert ends == [None] * (TRACKED_POSES - 1) + ["searched"]

    # The vote counts each pose, and a posterior with no scale searches
    # scale windows that can take hundreds of searches: the clocks only.
    for consensus in (boardlook.Consensus(MIDDLE), Posterior(board(), (100.0, 50.0, 200.0, 120.0))):
        rule = StopEnd(consensus, far, None, 0.0)
        pcbv = FakePcbv()
        for i in range(STOP_SEARCHES + 2):
            raw = pcbv.pose(far.center)
            consensus.take(raw, far, 0.0, DESIGN.board_to_job, None, None)
            assert rule.see("none", 0.01 * (i + 1)) is None
        assert rule.see("none", LOCK_SECONDS + boardlook.camera_module.SETTLE_SECONDS) == "no lock"


def test_the_vote_with_the_scale_known_ends_a_stop_without_a_lock_on_pcbvs_searches_and_stays_for_a_lock():
    from spinny_web.boardlook import LOCK_SECONDS, STOP_SEARCHES, TRACKED_POSES, StopEnd

    # A scan's stop off the board: pcbv searches each frame and never locks.
    # The vote, the camera's scale known, ends it once pcbv searched it
    # STOP_SEARCHES times, its frames made again pose by pose as a replay
    # makes them (a LumenPnP scan waited LOCK_SECONDS at 49 of 84 stops).
    consensus = boardlook.Consensus(MIDDLE)
    consensus.numbers_searches = True
    far = PictureFrame((100.0, 50.0), 0.0, False)
    pcbv = FakePcbv()
    rule = StopEnd(consensus, far, None, 0.0)
    ends = []
    for i in range(STOP_SEARCHES + 2):
        feed(consensus, pcbv.pose(far.center), PictureFrame((100.0, 50.0), 0.0, False))
        ends.append(rule.see("none", 0.01 * (i + 1)))
    assert ends[: STOP_SEARCHES - 1] == [None] * (STOP_SEARCHES - 1) and ends[STOP_SEARCHES - 1] == "no lock"
    assert 0.01 * STOP_SEARCHES < LOCK_SECONDS
    # Searches of frames taken while the head came to rest, or at another
    # place, count for nothing here.
    rule = StopEnd(consensus, far, None, 0.0)
    for i in range(STOP_SEARCHES + 2):
        consensus.take(pcbv.pose(far.center), "the head is coming to rest", 0.0, DESIGN.board_to_job, None, None)
        assert rule.see("none", 0.01 * (i + 1)) is None
        feed(consensus, pcbv.pose(far.center), PictureFrame((100.5, 50.0), 0.0, False))
        assert rule.see("none", 0.01 * (i + 1)) is None
    # A lock tracked pose after pose holds the vote's stop: each pose is a
    # look the vote counts, so the stop is not ended `searched`.
    consensus = boardlook.Consensus(MIDDLE)
    consensus.numbers_searches = True
    here = PictureFrame(truth_middle(), 0.0, False)
    pcbv = FakePcbv()
    rule = StopEnd(consensus, here, None, 0.0)
    raw = pcbv.pose(here.center)
    feed(consensus, raw, here)
    ends = [rule.see("used", 0.01)]
    for i in range(TRACKED_POSES + 2):
        feed(consensus, tracked(raw, 100 + i), here)
        ends.append(rule.see("used", 0.02 + 0.01 * i) if not consensus.found else "found")
    assert "searched" not in ends and "no lock" not in ends


def test_a_weak_lock_tracked_holds_the_stop_for_pcbvs_next_search():
    from spinny_web.boardlook import MIN_MATCH, STOP_SEARCHES, StopEnd

    posterior = Posterior(board(), (100.0, 50.0, 200.0, 120.0), scale=SCALE)
    here = PictureFrame(truth_middle(), 0.0, False)
    pcbv = FakePcbv()
    rule = StopEnd(posterior, here, None, 0.0)
    raw = pcbv.pose(here.center)
    # Paired under the least match: pcbv lets go of such a lock and searches
    # again (on a LumenPnP the right place came at its third search).
    paired = int(raw["expected"] * (MIN_MATCH - 0.2))
    weak = {**raw, "found": paired, "inliers": paired}
    weak["candidates"] = [{**item, "found": paired, "inliers": paired} for item in raw["candidates"]]
    feed(posterior, weak, here)
    ends = [rule.see("used", 0.01)]
    for i in range(STOP_SEARCHES):
        feed(posterior, tracked(weak, 100 + i), here)
        ends.append(rule.see("used", 0.02 + 0.01 * i))
    assert ends == [None] * (STOP_SEARCHES + 1)


def test_a_lock_agrees_with_a_place_by_the_point_under_its_picture_center():
    from spinny_web.boardlook import Estimate

    consensus = boardlook.Consensus(MIDDLE)
    place = Estimate(0.0, (100.0, 50.0), (120.0, 65.0), 0.03)
    # A lock 30 mm from the board's middle that read the turn 2 degrees
    # off, its point under the picture's center right.
    seen = (50.0, 15.0)
    look_ = Estimate(2.0, (0.0, 0.0), (0.0, 0.0), 0.03, seen=seen, place=place.apply(seen))
    look_.shift = (place.apply(seen)[0] - turn(seen, 2.0)[0], place.apply(seen)[1] - turn(seen, 2.0)[1])
    look_.center = look_.apply(MIDDLE)
    assert consensus.agrees_here(look_, place) and not consensus.agrees(look_, place)
    # The same point 0.8 mm away: a wrong place by either.
    wrong = Estimate(0.0, (100.8, 50.0), (120.8, 65.0), 0.03)
    assert not consensus.agrees_here(look_, wrong)
    # A look with no point is compared whole.
    whole = Estimate(0.0, (100.0, 50.0), (120.0, 65.0), 0.03)
    assert consensus.agrees_here(whole, place)


def test_a_scans_rows_cover_the_box_back_and_forth():
    from spinny_web.boardlook import scan_stops

    stops = scan_stops((0.0, 0.0, 60.0, 30.0), (25.6, 14.4))
    xs = sorted({round(x, 6) for x, _ in stops})
    ys = sorted({round(y, 6) for _, y in stops})
    # The first and last pictures reach the box's edges, a picture less the overlap apart at most.
    assert xs[0] - 12.8 <= 0.0 + 1e-9 and xs[-1] + 12.8 >= 60.0 - 1e-9
    assert ys[0] - 7.2 <= 0.0 + 1e-9 and ys[-1] + 7.2 >= 30.0 - 1e-9
    assert max(b - a for a, b in zip(xs, xs[1:])) <= 25.6 * 0.7 + 1e-9
    # Row by row from the bottom, the first left to right, the next back.
    rows = [[x for x, y in stops if abs(y - row) < 1e-9] for row in ys]
    assert rows[0] == sorted(rows[0]) and rows[1] == sorted(rows[1], reverse=True)
    assert len(stops) == len(xs) * len(ys)
    with pytest.raises(ValueError, match="pictures to cover"):
        scan_stops((0.0, 0.0, 2000.0, 2000.0), (2.0, 2.0))


@pytest.mark.parametrize("method", ["vote", "posterior"])
def test_a_full_scan_looks_at_every_picture_keeps_each_for_the_mosaic_and_finds_the_board(quick, method):
    from spinny_web.boardlook import rough_box, scan, scan_stops
    from spinny_web.boardlook import Estimate as Place

    middle = truth_middle()
    camera = SearchCamera(FakePcbv())
    look_ = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True, options=lambda: {"method": method, "scale": SCALE})
    look_.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    # A rough place a millimeter and a half off: the rows cover the board around it.
    rough = Place(TRUTH_TURN, (TRUTH_SHIFT[0] + 1.5, TRUTH_SHIFT[1] - 1.0), middle, 0.0)
    box = rough_box(rough, OUTLINE, 3.0)
    stops = scan_stops(box, (SIZE[0] * SCALE, SIZE[1] * SCALE))
    mover = Mover(camera)
    try:
        found = scan(
            look_, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError,
            box=box, picture=(SIZE[0], SIZE[1], SCALE), outline=OUTLINE,
        )
    finally:
        look_.stop()
    assert len(mover.places) == len(stops), "every stop is looked at, found or not"
    assert found is not None and math.dist(found.center, middle) < 0.1
    state = look_.mosaic.state()
    assert state["job"] == "j1" and state["motion"] == "stop" and len(state["pictures"]) == len(stops)
    tile = state["pictures"][0]
    # Kept at most 640 px wide: each kept px two full size ones.
    assert tile["width"] == 640 and tile["mm_per_px"] == pytest.approx(SCALE * 2.0)
    assert tile["center"] == pytest.approx(list(stops[0]))
    assert state["estimate"]["center"] == pytest.approx(list(found.center), abs=1e-3)
    assert look_.mosaic.picture(0) == b"\xff\xd8 picture \xff\xd9" and look_.mosaic.picture(len(stops)) is None


def test_marks_give_the_boards_stretch_and_one_mark_far_off_is_weighed_down_not_followed():
    from spinny_web.posterior import fit_marks

    truth = (1.003, 0.998)
    designs = [(2.0, 2.0), (38.0, 2.0), (38.0, 28.0), (2.0, 28.0), (20.0, 15.0), (30.0, 10.0)]
    pairs = [(d, machine_of(d, stretch=truth)) for d in designs]
    fit = fit_marks(pairs)
    assert fit.scale_x == pytest.approx(truth[0], abs=3.0 * fit.scale_x_sd + 1e-6)
    assert fit.scale_y == pytest.approx(truth[1], abs=3.0 * fit.scale_y_sd + 1e-6)
    assert fit.scale_x > 1.0015 and fit.scale_y < 0.999
    assert abs(fit.shear_deg) < 3.0 * fit.shear_deg_sd + 1e-6 and fit.rotation == pytest.approx(TRUTH_TURN, abs=0.02)
    # The fab tolerance prior holds the scale a little short of exact marks: a few hundredths left over.
    assert all(weight > 0.99 for weight in fit.weights) and fit.rms < 0.03
    # One mark 2 mm off: weighed down, the turn and scale stay.
    wrong = list(pairs)
    wrong[2] = (wrong[2][0], (wrong[2][1][0] + 2.0, wrong[2][1][1]))
    robust = fit_marks(wrong)
    assert robust.weights[2] < 0.01 and min(robust.weights[:2] + robust.weights[3:]) > 0.99
    assert robust.rotation == pytest.approx(TRUTH_TURN, abs=0.05) and robust.residuals[2] > 1.5
    assert abs(robust.scale_x - fit.scale_x) < 0.002
    with pytest.raises(ValueError, match="three marks"):
        fit_marks(pairs[:2])


def test_align_shows_the_stretch_of_three_marks_or_more_and_the_posterior_weighs_its_measured_marks():
    from types import SimpleNamespace

    from spinny_web.align import Alignment

    alignment = Alignment()
    job = SimpleNamespace(id="j1", pads=[], holes=[])
    for design in ((2.0, 2.0), (38.0, 2.0)):
        alignment.mark_tool(job, machine_of(design), design, None, 1.0)
    assert "stretch" not in alignment.state()["fit"]
    alignment.mark_tool(job, machine_of((38.0, 28.0)), (38.0, 28.0), None, 1.0)
    stretch = alignment.state()["fit"]["stretch"]
    assert stretch["scale_x"] == pytest.approx(1.0, abs=0.001) and min(stretch["weights"]) > 0.99
    assert alignment.fit_dict("j1")["stretch"] == stretch
    # The camera's capture of a look's own place is no measurement of its own.
    alignment.mark_camera(job, (20.0, 15.0), machine_of((20.0, 15.0)), TRUTH_TURN)
    assert len(alignment.stretch_pairs("j1")) == 3 and alignment.stretch_pairs("other") == []
    # Marks pin the place: a pitch-off candidate alone is ruled out by them.
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, sessions=1, marks=alignment.stretch_pairs("j1"))
    pcbv = FakePcbv(pitch=2.54, ratio=1.0)
    look(posterior, pcbv, machine_of((20.0, 15.0)))
    lead = posterior.lead
    assert lead is not None and math.dist(lead.estimate.center, middle) < 0.05 and lead.probability > 0.99


def test_the_heads_place_between_reports_its_speed_rows_to_fly_and_the_exposure():
    from spinny_web.app import exposure_seconds
    from spinny_web.boardlook import PlaceHistory, fly_rows, fly_speed

    history = PlaceHistory()
    history.add(1.0, (0.0, 0.0))
    history.add(1.1, (2.0, 0.0))
    history.add(1.1, (9.0, 9.0))  # no newer than the last: ignored
    history.add(1.2, (4.0, 1.0))
    point, velocity = history.at(1.15)
    assert point == pytest.approx((3.0, 0.5)) and velocity == pytest.approx((20.0, 10.0))
    assert history.at(0.5) is None and history.at(1.3) is None
    history.add(2.0, (4.0, 1.0))
    assert history.at(1.5) is None, "no place across a gap between reports"
    rows = fly_rows([(0.0, 0.0), (10.0, 0.0), (10.0, 5.0), (0.0, 5.0)], 4.0)
    assert rows == [((-2.0, 0.0), (12.0, 0.0)), ((12.0, 5.0), (-2.0, 5.0))]
    # A 0.5 mm pad at 5 ms: a quarter of it blurs at 25 mm/s, held to the most.
    assert fly_speed(0.005, 0.5, 25.6) == pytest.approx(20.0)
    assert fly_speed(0.02, 0.5, 25.6) == pytest.approx(6.25)
    with pytest.raises(ValueError, match="exposure set by hand"):
        fly_speed(0.0, 0.5, 25.6)
    assert exposure_seconds({"auto_exposure": 1, "exposure_time_absolute": 50}) == pytest.approx(0.005)
    assert exposure_seconds({"auto_exposure": 3, "exposure_time_absolute": 50}) is None
    assert exposure_seconds({}) is None


def test_rows_flown_both_ways_measure_the_cameras_delay_and_place_the_board():
    from spinny_web.posterior import DELAY_S

    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, sessions=1, scale=SCALE, delay=(DELAY_S, 0.06))
    pcbv = FakePcbv()
    true_delay, speed = 0.13, 15.0
    # Two rows along the board's middle third, one each way, a frame every 0.1 s.
    for direction, y in ((1.0, 10.0), (-1.0, 20.0)):
        for step in range(12):
            x = 8.0 + 2.0 * step if direction > 0 else 32.0 - 2.0 * step
            seen_at = machine_of((x, y))
            velocity = turn((direction * speed, 0.0), TRUTH_TURN)
            # The head was where the picture shows the delay before the
            # frame's time; the backend places it for the delay first guessed.
            placed = (seen_at[0] + velocity[0] * (true_delay - DELAY_S), seen_at[1] + velocity[1] * (true_delay - DELAY_S))
            raw = pcbv.pose(seen_at)
            raw["frame"] = pcbv.searches
            feed(posterior, raw, PictureFrame(placed, 0.0, False, velocity))
    delay = posterior.delay
    assert delay is not None and delay["seconds"] == pytest.approx(true_delay, abs=0.015) and delay["sd"] < 0.02
    lead = posterior.lead
    assert lead is not None and math.dist(lead.estimate.center, middle) < 0.1
    assert len(posterior.views) == 24, "every frame on the move is a view of its own"


class FlyMover:
    """A head that goes at once to a row's start and then along the row at
    a steady speed in real time, its places reported into a history every
    20 ms, as the link's status reports would be."""

    def __init__(self, history) -> None:
        import threading
        import time

        self.time = time
        self.history = history
        self.start = (0.0, 0.0)
        self.end = (0.0, 0.0)
        self.began = time.monotonic()
        self.seconds = 0.0
        self.rows = 0
        self.running = True
        self._thread = threading.Thread(target=self._report, daemon=True)
        self._thread.start()

    def where(self, moment: float):
        share = min(max((moment - self.began) / self.seconds, 0.0), 1.0) if self.seconds > 0 else 1.0
        return (self.start[0] + (self.end[0] - self.start[0]) * share, self.start[1] + (self.end[1] - self.start[1]) * share)

    def _report(self) -> None:
        while self.running:
            now = self.time.monotonic()
            self.history.add(now, self.where(now))
            self.time.sleep(0.02)

    def go(self, point) -> None:
        self.start = self.end = point
        self.seconds = 0.0

    def fly(self, point, speed: float) -> None:
        self.end = point
        self.seconds = math.dist(self.start, point) / speed
        self.began = self.time.monotonic()
        self.rows += 1

    def arrived(self) -> bool:
        return self.time.monotonic() >= self.began + self.seconds + 0.05


class FlyCamera(SearchCamera):
    """The fake pcbv seeing where the flying head was its delay ago."""

    def __init__(self, pcbv: FakePcbv, mover: FlyMover, delay: float) -> None:
        super().__init__(pcbv)
        self.mover = mover
        self.delay = delay

    def pose(self) -> dict:
        import time

        raw = self.pcbv.pose(self.mover.where(time.monotonic() - self.delay))
        raw["frame"] = self.pcbv.searches
        return raw


def test_a_flying_scan_places_its_frames_by_the_heads_reports_and_fits_the_delay(quick):
    from spinny_web.boardlook import PlaceHistory, fly_rows, fly_scan, rough_box, scan_stops
    from spinny_web.boardlook import Estimate as Place

    middle = truth_middle()
    history = PlaceHistory()
    mover = FlyMover(history)
    camera = FlyCamera(FakePcbv(), mover, delay=0.12)
    look_ = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True, options=lambda: {"method": "posterior", "scale": SCALE})
    look_.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    rough = Place(TRUTH_TURN, (TRUTH_SHIFT[0] + 1.0, TRUTH_SHIFT[1]), middle, 0.0)
    box = rough_box(rough, OUTLINE, 1.0)
    rows = fly_rows(scan_stops(box, (SIZE[0] * SCALE, SIZE[1] * SCALE)), SIZE[0] * SCALE)
    try:
        found = fly_scan(
            look_, mover, rows, (0.0, 0.0), 0.0, history, 30.0, lambda: False, lambda index, count: None, RuntimeError,
            box=box, picture=(SIZE[0], SIZE[1], SCALE), outline=OUTLINE,
        )
        delay = look_.consensus.delay
    finally:
        mover.running = False
        look_.stop()
    assert mover.rows == len(rows) >= 2
    # Rows both ways: the delay measured, the board where it lies.
    assert found is not None and math.dist(found.center, middle) < 0.1
    state = look_.mosaic.state()
    assert state["motion"] == "fly" and len(state["pictures"]) >= len(rows)
    assert delay is not None and delay["seconds"] == pytest.approx(0.12, abs=0.02)


def test_a_search_on_a_frame_taken_while_the_head_settled_counts_through_its_tracked_lock():
    import time

    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, sessions=1, scale=SCALE)
    pcbv = FakePcbv()
    center = machine_of((20.0, 15.0))
    raw = pcbv.pose(center)
    raw["candidates_age_ms"] = 400
    raw["searched"] = False
    frame = PictureFrame(center, 0.0, False)
    estimate, problem = pose_estimate(raw, frame, DESIGN.board_to_job, MIDDLE)
    # The search's own frame is refused (the head was coming to rest); this
    # frame, tracked from its lock, is at rest: the lock counts.
    posterior.take(raw, frame, time.monotonic(), DESIGN.board_to_job, estimate, problem, searched_where="the head is coming to rest")
    lead = posterior.lead
    assert lead is not None and math.dist(lead.estimate.center, middle) < 0.05
    assert len(posterior.views) == 1 and posterior.views[0].searches == {("search", raw["search"])}
    # With no frame at rest yet the search is kept for later.
    other = Posterior(board(), box, sessions=1, scale=SCALE)
    other.take(raw, "the head is moving", 0.0, DESIGN.board_to_job, None, None, searched_where="the head is coming to rest")
    assert not other.views and ("search", raw["search"]) not in other._acquisitions


def test_a_search_keeps_its_pictures_as_a_map_and_clear_guesses_keeps_the_board_loaded(quick):
    middle = truth_middle()
    camera = SearchCamera(FakePcbv())
    look_ = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True, options=lambda: {"method": "posterior", "scale": SCALE})
    look_.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    box = (middle[0] - 30.0, middle[1] - 25.0, middle[0] + 30.0, middle[1] + 25.0)
    stops = search_stops(box, (SIZE[0] * SCALE, SIZE[1] * SCALE), (box[0], box[1]))
    mover = Mover(camera)
    try:
        found = search(
            look_, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError,
            box=box, picture=(SIZE[0], SIZE[1], SCALE), outline=OUTLINE,
        )
        state = look_.mosaic.state()
        # One picture a stop the search looked from, the checks too.
        assert state["motion"] == "search" and len(state["pictures"]) == len(mover.places)
        assert state["estimate"]["center"] == pytest.approx(list(found.center), abs=1e-3)
        assert look_.state()["scan"]["motion"] == "search"
        # Clear guesses: the place predicted is forgotten, the board stays loaded.
        assert look_.consensus.guesses
        look_.forget()
        assert look_.job == "j1" and not look_.consensus.guesses and look_.state()["estimate"] is None
    finally:
        look_.stop()


def test_a_crop_keeps_a_hypothesis_from_being_missed_where_pcbv_did_not_look():
    """With a board crop pcbv looks only inside it: a picture whose crop
    holds none of the board's pads at a hypothesis' pose says nothing of
    that hypothesis, though the rest of the picture holds pads, and each
    view counts a hypothesis' pads where the poses drawn from the prior
    are counted (features_in)."""
    middle = truth_middle()
    box = (middle[0] - 25.0, middle[1] - 25.0, middle[0] + 25.0, middle[1] + 25.0)
    posterior = Posterior(board(), box, threshold=0.5, scale=SCALE)
    # pcbv's board look keeps to the picture's left quarter.
    posterior.crop = (0.0, 0.0, 0.25, 1.0)
    pcbv = FakePcbv()
    look(posterior, pcbv, machine_of((12.0, 10.0)))
    hypothesis = posterior.hypotheses[0]
    before = posterior._evidence(hypothesis)
    # A picture over the board's left edge: its right half holds pads, its
    # left quarter (the crop) only the bed beside the board.
    beside = machine_of((-6.0, 15.0))
    assert pcbv.in_view(beside) >= LOCK_FEATURES
    pcbv.searches += 1
    lost = {"frame": pcbv.searches, "age_ms": 0, "width": SIZE[0], "height": SIZE[1], "searched": True, "search": pcbv.searches, "state": "lost"}
    feed(posterior, lost, PictureFrame(beside, 0.0, False))
    view = posterior.views[-1]
    assert float(posterior.features_in(hypothesis.mean, view)[0]) == 0.0
    assert posterior._seen_counts(hypothesis)[view.index] == 0.0
    assert posterior._evidence(hypothesis) == pytest.approx(before, abs=1e-6)
