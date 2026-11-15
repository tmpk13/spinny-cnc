"""A search's stops measured before pcbv is asked: an empty picture ends
its stop at once, a quick scan of a bed asks pcbv only where the pictures
look like board, a check goes where the board is dense, and a camera
whose pcbv stopped ends the search."""

from __future__ import annotations

import math
import time

import numpy as np
import pytest
from test_posterior import DESIGN, MIDDLE, OUTLINE, PADS, SCALE, SIZE, FakePcbv, truth_middle

from spinny_web import boardlook
from spinny_web import camera as camera_module
from spinny_web.boardlook import BoardLook, PictureFrame, quick_first, search, search_stops
from spinny_web.vision import VisionError

VIEW = (SIZE[0] * SCALE, SIZE[1] * SCALE)


class BusyCamera:
    """The fake pcbv where the mover puts the picture's center, its
    pictures as luma: stripes where the picture holds three of the board's
    pads or more, a few where `clutter` says, flat elsewhere. After `dead_after` poses its service
    stops."""

    def __init__(self, pcbv: FakePcbv, dead_after: int | None = None, clutter=lambda center: False) -> None:
        self.pcbv = pcbv
        self.clutter = clutter
        self.center = (0.0, 0.0)
        self.running = True
        self.dead_after = dead_after
        self.poses = 0
        self.asked_at: list = []

    def pose(self) -> dict:
        self.poses += 1
        if self.dead_after is not None and self.poses > self.dead_after:
            raise VisionError("the service has stopped")
        self.asked_at.append(self.center)
        return self.pcbv.pose(self.center)

    def request(self, cmd, timeout=None, **fields):
        if self.dead_after is not None and self.poses > self.dead_after:
            raise VisionError("the service has stopped")
        return {"ok": True}

    def gray(self, width=None):
        picture = np.full((180, 320), 30, dtype=np.uint8)
        if self.pcbv.in_view(self.center) >= 3:
            picture[:, ::6] = 220
        elif self.clutter(self.center):
            # A few edges, as a feeder's tape shows: more than an empty
            # picture, less than board.
            picture[:, ::40] = 220
        return {"width": 320, "height": 180, "frame": self.poses, "age_ms": 0, "format": "gray"}, picture.tobytes()

    def frame(self, width=None, overlay=False, quality=80):
        return {"width": 320, "height": 180, "frame": 0, "age_ms": 0}, b"\xff\xd8 picture \xff\xd9"


class Mover:
    def __init__(self, camera: BusyCamera) -> None:
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
    monkeypatch.setattr(camera_module, "SETTLE_SECONDS", 0.0)


def started(camera: BusyCamera) -> BoardLook:
    look = BoardLook(lambda: camera, publish=lambda: None, paused=lambda: True)
    look.start("j1", DESIGN.board_to_job, MIDDLE, lambda captured: "the watcher is held off", features=PADS, outline=OUTLINE)
    return look


def checks(look_features=PADS):
    return lambda found: boardlook.check_places(found, MIDDLE, OUTLINE, list(look_features), VIEW)


def test_a_quick_scan_of_a_bed_asks_pcbv_only_where_pictures_look_like_board(quick):
    middle = truth_middle()
    camera = BusyCamera(FakePcbv(), clutter=lambda center: center[0] < middle[0] - 50.0)
    look = started(camera)
    bed = (middle[0] - 120.0, middle[1] - 100.0, middle[0] + 80.0, middle[1] + 90.0)
    start = (bed[0], bed[1])
    coarse = boardlook.QUICK_SHARE * 30.0
    stops = search_stops(bed, VIEW, start, coarse)
    first = quick_first(bed, VIEW, coarse)
    assert first[0] < len(stops)
    mover = Mover(camera)
    began = time.monotonic()
    try:
        found = search(
            look, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError,
            checks=checks(), quick=first,
        )
    finally:
        look.stop()
    assert math.dist(found.center, middle) < 0.1
    # pcbv was asked only over the board (three pads in the picture or
    # more), never over the clutter the scan passed first.
    assert camera.asked_at and all(camera.pcbv.in_view(place) >= 3 for place in camera.asked_at)
    assert any(camera.clutter(place) for place in mover.places)
    # Every empty stop ended at once: the whole bed in well under the lock time a stop.
    empties = sum(1 for place in mover.places if camera.pcbv.in_view(place) < 3)
    assert empties > 10 and time.monotonic() - began < empties * boardlook.LOCK_SECONDS


def test_a_search_checks_where_the_board_is_dense_and_far_from_where_it_was_found(quick):
    middle = truth_middle()
    camera = BusyCamera(FakePcbv())
    look = started(camera)
    box = (middle[0] - 30.0, middle[1] - 25.0, middle[0] + 30.0, middle[1] + 25.0)
    stops = search_stops(box, VIEW, (box[0], box[1]))
    mover = Mover(camera)
    try:
        found = search(
            look, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError,
            checks=checks(),
        )
    finally:
        look.stop()
    assert math.dist(found.center, middle) < 0.1
    # The check (the last place) holds pads and lies inside the edge margin.
    check = mover.places[-1]
    assert camera.pcbv.in_view(check) >= 3


def test_a_camera_whose_pcbv_stopped_ends_the_search_at_once(quick):
    middle = truth_middle()
    camera = BusyCamera(FakePcbv(), dead_after=0)
    look = started(camera)
    box = (middle[0] - 30.0, middle[1] - 25.0, middle[0] + 30.0, middle[1] + 25.0)
    stops = search_stops(box, VIEW, middle)
    mover = Mover(camera)
    try:
        with pytest.raises(RuntimeError, match="can answer no more"):
            search(look, mover, stops, (0.0, 0.0), lambda point: PictureFrame(point, 0.0, False), lambda: False, lambda index, count: None, RuntimeError)
    finally:
        look.stop()
    assert len(mover.places) <= 2
