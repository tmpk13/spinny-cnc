"""Looking for a board: where a pose puts it, the guesses the poses make
and when the most likely is found, corners taken by hand, the stops a
search takes, and when the head is taken to be at rest."""

from __future__ import annotations

import math

import pytest
from device_fakes import SeenBoard

from spinny_web import boardlook
from spinny_web.boardlook import (
    BoardLook,
    Consensus,
    Corner,
    Estimate,
    PictureFrame,
    RestTracker,
    corner_of,
    match_of,
    pose_estimate,
    rough_box,
    rough_place,
    search_stops,
)
from spinny_web.jobs import Design

DESIGN = Design(shift=(-100.0, -70.0), board=True)
MIDDLE = (20.0, 15.0)


def seen(rotation: float = 2.0, shift=(150.0, 80.0)) -> SeenBoard:
    return SeenBoard((0.0, 0.0, 40.0, 30.0), rotation, shift, design_shift=DESIGN.shift)


@pytest.mark.parametrize(("roll", "mirror", "rotation"), [(0.0, False, 0.0), (1.5, False, 2.0), (-40.0, False, 170.0), (12.0, True, -5.0)])
def test_a_locked_pose_puts_the_board_where_it_lies(roll, mirror, rotation):
    board = seen(rotation)
    machine_middle = board.shift[0] + math.cos(math.radians(rotation)) * 20.0 - math.sin(math.radians(rotation)) * 15.0, board.shift[1] + math.sin(math.radians(rotation)) * 20.0 + math.cos(math.radians(rotation)) * 15.0
    center = (machine_middle[0] + 3.0, machine_middle[1] - 2.0)
    raw = board.pose(center, roll, mirror, 0.02, 1280, 720, 1)
    estimate, problem = pose_estimate(raw, PictureFrame(center, roll, mirror), DESIGN.board_to_job, MIDDLE)
    assert problem is None and estimate is not None
    assert math.isclose(math.cos(math.radians(estimate.rotation - rotation)), 1.0, abs_tol=1e-9)
    assert estimate.center == pytest.approx(machine_middle, abs=1e-6) and estimate.rms < 1e-6
    # The picture's corners on the board, for the board drawing.
    assert len(estimate.corners) == 4 and estimate.seen == pytest.approx(board.job_of(center), abs=1e-6)
    if not mirror:
        # A pose without corners, as an older pcbv sends: its center and angle say the same.
        bare = {key: value for key, value in raw.items() if key != "corners"}
        fallback, _ = pose_estimate(bare, PictureFrame(center, roll, mirror), DESIGN.board_to_job, MIDDLE)
        assert fallback is not None and fallback.center == pytest.approx(machine_middle, abs=1e-6)
        assert math.isclose(math.cos(math.radians(fallback.rotation - rotation)), 1.0, abs_tol=1e-9)


def test_a_picture_mirrored_against_the_board_is_refused_and_a_lost_pose_gives_nothing():
    board = seen()
    raw = board.pose((170.0, 95.0), 0.0, True, 0.02, 1280, 720, 1)
    estimate, problem = pose_estimate(raw, PictureFrame((170.0, 95.0), 0.0, False), DESIGN.board_to_job, MIDDLE)
    assert estimate is None and "mirrored" in problem
    lost = board.pose((900.0, 900.0), 0.0, False, 0.02, 1280, 720, 1)
    assert lost["state"] == "lost" and pose_estimate(lost, PictureFrame((900.0, 900.0), 0.0), DESIGN.board_to_job, MIDDLE) == (None, None)


def estimate(x: float, y: float = 0.0, rotation: float = 0.0, match: float = 1.0) -> Estimate:
    return Estimate(rotation=rotation, shift=(x, y), center=(x, y), rms=0.01, match=match)


def test_looks_make_guesses_and_the_most_likely_is_found_once_it_has_enough_looks_and_share():
    consensus = Consensus()
    for x in (10.0, 10.1, 9.95, 10.05):
        consensus.see("locked", estimate(x), None)
    assert consensus.agree == 4 and not consensus.found and len(consensus.guesses) == 1
    # One look a pitch off is a guess of its own: it takes a share of the
    # evidence and leaves the count of the most likely one as it was.
    consensus.see("locked", estimate(12.54), None)
    assert consensus.agree == 4 and consensus.best is not None and consensus.best.center[0] == pytest.approx(10.025, abs=0.03)
    assert [round(guess.probability, 3) for guess in consensus.guesses] == [0.8, 0.2]
    # A pose that is not locked counts as a look, not as evidence.
    consensus.see("lost", None, None)
    consensus.see("locked", estimate(10.02), None)
    assert consensus.found and consensus.agree == boardlook.NEED
    for x in (9.98, 10.0, 10.04, 10.01):
        consensus.see("locked", estimate(x), None)
    state = consensus.to_dict()
    assert state["found"] is True and state["looks"] == 11 and state["locked"] == 10
    assert state["spread_mm"] < 0.1 and state["estimate"]["center"][0] == pytest.approx(10.01, abs=0.03)
    assert state["threshold"] == boardlook.THRESHOLD and state["more"] == 0
    guesses = state["guesses"]
    assert [(guess["looks"], guess["probability"]) for guess in guesses] == [(9, 0.9), (1, 0.1)]
    # No picture's place known yet: no place on the board for either.
    assert guesses[0]["view"] is None and guesses[1]["center"] == [12.54, 0.0]
    # Turns near half a turn agree across the wrap.
    turned = Consensus()
    for rotation in (179.8, -179.9, 179.95, -179.7, 180.0):
        turned.see("locked", estimate(0.0, 0.0, rotation), None)
    assert turned.found and abs(abs(turned.best.rotation) - 180.0) < 0.3


def test_the_threshold_is_the_least_share_and_the_matches_weigh_the_looks():
    consensus = Consensus(threshold=0.9)
    for _ in range(9):
        consensus.see("locked", estimate(10.0), None)
    consensus.see("locked", estimate(20.0), None)
    assert consensus.found and consensus.lead.probability == pytest.approx(0.9)
    consensus.tune(threshold=0.95)
    assert not consensus.found and consensus.agree == 9
    # Five looks matched poorly against five matched well: the well matched
    # guess leads, though it has as many looks.
    weighed = Consensus()
    for _ in range(5):
        weighed.see("locked", estimate(10.0, match=0.3), None)
        weighed.see("locked", estimate(30.0, match=0.9), None)
    assert weighed.found and weighed.best.center[0] == pytest.approx(30.0)
    assert weighed.lead.probability == pytest.approx(0.75) and weighed.guesses[1].probability == pytest.approx(0.25)
    # Two guesses with the same share: neither leads, whatever the threshold.
    tied = Consensus(threshold=0.0)
    for _ in range(5):
        tied.see("locked", estimate(10.0), None)
        tied.see("locked", estimate(30.0), None)
    assert not tied.found and tied.agree == 5
    # The history keeps the newest looks only.
    short = Consensus(history=6)
    for _ in range(6):
        short.see("locked", estimate(10.0), None)
    for _ in range(5):
        short.see("locked", estimate(30.0), None)
    assert [guess.looks for guess in short.guesses] == [5, 1] and short.found and short.best.center[0] == pytest.approx(30.0)


def test_corners_rule_out_the_guesses_that_put_them_elsewhere_and_give_a_rough_place():
    # The truth: the board turned 2 degrees and shifted to (150, 80); a
    # look a pitch off, and one turned wrong about the middle.
    truth = Estimate(2.0, (150.0, 80.0), (0.0, 0.0), 0.0)
    truth.center = truth.apply(MIDDLE)
    corners = [Corner("bottom left", (0.0, 0.0), truth.apply((0.0, 0.0))), Corner("top right", (40.0, 30.0), truth.apply((40.0, 30.0)))]
    off = Estimate(2.0, (152.54, 80.0), (0.0, 0.0), 0.0)
    off.center = off.apply(MIDDLE)
    consensus = Consensus(MIDDLE)
    for _ in range(6):
        consensus.see("locked", off, None)
    for _ in range(4):
        consensus.see("locked", Estimate(truth.rotation, truth.shift, truth.center, 0.01), None)
    assert consensus.best.center == pytest.approx(off.center) and consensus.found
    consensus.tune(corners=corners)
    # The pitch-off guess puts each corner 2.54 mm off: ruled out, and the
    # true guess holds all the evidence left, but has too few looks yet.
    ruled = next(guess for guess in consensus.guesses if guess.ruled_out)
    assert ruled.probability == 0.0 and ruled.corner_mm == pytest.approx(2.54, abs=1e-6)
    shown = {guess["looks"]: guess for guess in consensus.to_dict()["guesses"]}
    assert shown[6]["ruled_out"] and shown[6]["share"] == 0.6 and shown[4]["share"] == 0.4 and shown[4]["probability"] == 1.0
    assert consensus.lead.probability == 1.0 and consensus.best.center == pytest.approx(truth.center) and not consensus.found
    consensus.see("locked", Estimate(truth.rotation, truth.shift, truth.center, 0.01), None)
    assert consensus.found and consensus.lead.corner_mm == pytest.approx(0.0, abs=1e-9)
    # A looser tolerance lets the pitch-off guess back in.
    consensus.tune(corner_mm=3.0)
    assert not any(guess.ruled_out for guess in consensus.guesses) and consensus.best.center == pytest.approx(off.center)
    # Every guess ruled out: none leads.
    consensus.tune(corner_mm=0.1, corners=[Corner("top left", (0.0, 30.0), (0.0, 0.0))])
    assert consensus.lead is None and consensus.best is None and not consensus.found and consensus.agree == 0
    # The corners' rough place: two fit the turn, one keeps it square.
    place = rough_place(corners, MIDDLE)
    assert place.rotation == pytest.approx(2.0, abs=1e-6) and place.center == pytest.approx(truth.center, abs=1e-6)
    one = rough_place(corners[:1], MIDDLE)
    assert one.rotation == 0.0 and one.apply((0.0, 0.0)) == pytest.approx(truth.apply((0.0, 0.0)))
    assert rough_place([], MIDDLE) is None
    box = rough_box(place, (0.0, 0.0, 40.0, 30.0), 1.0)
    xs = [truth.apply(p)[0] for p in ((0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0))]
    assert box[0] == pytest.approx(min(xs) - 1.0, abs=1e-6) and box[2] == pytest.approx(max(xs) + 1.0, abs=1e-6)
    assert corner_of((1.0, 2.0, 3.0, 4.0), "top left") == (1.0, 4.0)
    with pytest.raises(ValueError, match="no corner"):
        corner_of((1.0, 2.0, 3.0, 4.0), "middle")


def test_a_pose_says_how_well_it_matched():
    assert match_of({"inliers": 30, "expected": 32}) == pytest.approx(30 / 32)
    # An unsure feature counts half among those expected, as pcbv weighs it.
    assert match_of({"inliers": 30, "expected": 20, "unsure": 20}) == pytest.approx(1.0)
    assert match_of({"inliers": 15, "expected": 20, "unsure": 20}) == pytest.approx(0.5)
    assert match_of({"state": "locked"}) == 1.0 and match_of({"inliers": 3, "expected": 0}) == 1.0


def test_each_guess_says_where_the_newest_picture_lies_on_the_board():
    board = seen(2.0)
    center = (160.0, 95.0)
    raw = board.pose(center, 1.5, False, 0.02, 1280, 720, 1)
    frame = PictureFrame(center, 1.5, False)
    found, _ = pose_estimate(raw, frame, DESIGN.board_to_job, MIDDLE)
    assert found is not None and found.match == pytest.approx(30 / 32)
    consensus = Consensus(MIDDLE)
    consensus.picture = (frame, 1280.0, 720.0, 0.02)
    consensus.see("locked", found, None)
    guess = consensus.to_dict()["guesses"][0]
    # The guess puts the picture where the pose saw it.
    assert [coordinate for point in guess["view"] for coordinate in point] == pytest.approx([coordinate for point in found.corners for coordinate in point], abs=1e-3)
    assert guess["seen"] == pytest.approx(list(board.job_of(center)), abs=1e-3) and guess["match"] == pytest.approx(30 / 32, abs=1e-4)


def test_a_look_keeps_corners_of_one_board_and_notes_changes_in_its_record():
    tuning = [0.5, 2.0]
    look = BoardLook(lambda: None, publish=lambda: None, paused=lambda: True, tuning=lambda: (tuning[0], tuning[1]))
    look.add_corner("j1", "bottom left", (0.0, 0.0), (10.0, 20.0), MIDDLE)
    look.add_corner("j1", "bottom left", (0.0, 0.0), (11.0, 20.0), MIDDLE)
    state = look.state()
    assert state["job"] is None and state["threshold"] == 0.5 and state["corner_mm"] == 2.0
    assert state["corners"]["job"] == "j1" and state["corners"]["points"] == [{"corner": "bottom left", "job": [0.0, 0.0], "machine": [11.0, 20.0]}]
    assert state["corners"]["rough"]["shift"] == [11.0, 20.0] and look.rough("j2") is None
    # Another job's corner starts its own set.
    look.add_corner("j2", "top right", (40.0, 30.0), (60.0, 60.0), MIDDLE)
    assert look.corners_of("j1") == [] and [corner.name for corner in look.corners_of("j2")] == ["top right"]

    class Record:
        events: list = []

        def event(self, name, **fields):
            self.events.append((name, fields))

    look.start("j2", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off")
    try:
        assert look.consensus.corners == look.corners_of("j2")
        look.record = Record()
        tuning[0] = 0.8
        state = look.state()
        assert state["threshold"] == 0.8 and look.consensus.threshold == 0.8
        look.clear_corners()
        assert look.consensus.corners == [] and look.state()["corners"] is None
        assert [name for name, _ in Record.events] == ["settings", "settings"]
        assert Record.events[0][1]["threshold"] == 0.8 and Record.events[0][1]["corners"][0]["corner"] == "top right"
        look.record = None
    finally:
        look.stop()


def test_the_stops_cover_the_box_a_picture_apart_nearest_first():
    stops = search_stops((0.0, 0.0, 30.0, 20.0), (10.0, 8.0), (0.0, 0.0))
    # 7 mm apart along X and 5.6 along Y: 5 by 4, centered in the box.
    assert len(stops) == 20
    xs = sorted({round(x, 3) for x, _ in stops})
    assert xs[0] == pytest.approx(15.0 - 14.0) and xs[-1] == pytest.approx(29.0)
    assert math.dist(stops[0], (0.0, 0.0)) == min(math.dist(stop, (0.0, 0.0)) for stop in stops)
    assert [math.dist(stop, (0.0, 0.0)) for stop in stops] == sorted(math.dist(stop, (0.0, 0.0)) for stop in stops)
    # A box smaller than a picture: one stop at its middle.
    assert search_stops((5.0, 5.0, 6.0, 7.0), (10.0, 8.0), (0.0, 0.0)) == [(5.5, 6.0)]
    with pytest.raises(ValueError, match="smaller box"):
        search_stops((0.0, 0.0, 1000.0, 1000.0), (5.0, 5.0), (0.0, 0.0))


def test_a_frame_shows_the_head_at_rest_only_after_its_move_and_the_settle_time(monkeypatch):
    monkeypatch.setattr("spinny_web.camera.SETTLE_SECONDS", 0.25)
    tracker = RestTracker(speed=50.0)
    assert tracker.see(None) is None
    assert tracker.see((0.0, 0.0), now=100.0) == pytest.approx(100.25)
    # Seen again where it was: the same time.
    assert tracker.see((0.0, 0.0), now=101.0) == pytest.approx(100.25)
    # Moved 100 mm at 50 mm/s: two seconds and the settle time.
    assert tracker.see((100.0, 0.0), now=102.0) == pytest.approx(104.25)
    # A machine that says it moves: no frame is trusted.
    assert tracker.see((100.0, 0.0), moving=True, now=103.0) is None
