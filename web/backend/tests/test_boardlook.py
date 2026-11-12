"""Looking for a board: where a pose puts it, when enough poses agree,
the stops a search takes, and when the head is taken to be at rest."""

from __future__ import annotations

import math

import pytest
from device_fakes import SeenBoard

from spinny_web import boardlook
from spinny_web.boardlook import Consensus, Estimate, PictureFrame, RestTracker, pose_estimate, search_stops
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


def estimate(x: float, y: float = 0.0, rotation: float = 0.0) -> Estimate:
    return Estimate(rotation=rotation, shift=(x, y), center=(x, y), rms=0.01)


def test_enough_looks_in_a_row_call_the_board_found_and_one_off_starts_the_count_again():
    consensus = Consensus()
    for x in (10.0, 10.1, 9.95, 10.05):
        consensus.see("locked", estimate(x), None)
    assert consensus.agree == 4 and not consensus.found
    # One look a pitch off: the count starts again, the median holds.
    consensus.see("locked", estimate(12.54), None)
    assert consensus.agree == 0 and consensus.best is not None and consensus.best.center[0] == pytest.approx(10.025, abs=0.03)
    # A pose that is not locked counts as a look, not against the run.
    consensus.see("lost", None, None)
    for x in (10.02, 9.98, 10.0, 10.04, 10.01):
        consensus.see("locked", estimate(x), None)
    assert consensus.found and consensus.agree >= boardlook.NEED
    state = consensus.to_dict()
    assert state["found"] is True and state["looks"] == 11 and state["locked"] == 10
    assert state["spread_mm"] < 0.1 and state["estimate"]["center"][0] == pytest.approx(10.01, abs=0.03)
    # Turns near half a turn agree across the wrap.
    turned = Consensus()
    for rotation in (179.8, -179.9, 179.95, -179.7, 180.0):
        turned.see("locked", estimate(0.0, 0.0, rotation), None)
    assert turned.found and abs(abs(turned.best.rotation) - 180.0) < 0.3


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
