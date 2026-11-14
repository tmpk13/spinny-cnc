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
    assert strength(1.0) == pytest.approx(16.0)
    assert strength(0.5) == pytest.approx(1.0)
    assert strength(0.5, passed=False) == pytest.approx(0.5)


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
