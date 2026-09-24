"""The height map, the compensation a run takes from it, and the probe geometry."""

from __future__ import annotations

import json
import math
import re

import pytest
from spinny_laser import polar

from spinny_web.heightmap import (
    MAX_SPAN,
    Compensation,
    Grid,
    HeightMap,
    HeightMapStore,
    check_covers,
    job_extent,
)
from spinny_web.jobs import Group, Job
from spinny_web.kinematics import Streamer, board_of
from spinny_web.link import parse_probe, parse_status
from spinny_web.prober import ProbeSettings, probe_joint

WORD = re.compile(r"([A-Z])(-?\d+(?:\.\d+)?)")


def plane(x: float, y: float) -> float:
    return -1.5 + 0.01 * x - 0.02 * y


def probed(grid: Grid, surface=plane, focus_offset: float = 0.0) -> HeightMap:
    heightmap = HeightMap.empty(grid)
    for iy, y in enumerate(grid.ys):
        for ix, x in enumerate(grid.xs):
            heightmap.heights[iy][ix] = surface(x, y)
    heightmap.focus_offset = focus_offset
    heightmap.focus_set = True
    return heightmap


def words(line: str) -> dict[str, float]:
    return {letter: float(value) for letter, value in WORD.findall(line)}


# --- the grid and the map ------------------------------------------------------


def test_the_grid_is_checked_and_walked_row_by_row_back_and_forth():
    grid = Grid(x0=-10, y0=-5, x1=10, y1=5, nx=3, ny=2)
    grid.check()
    assert grid.xs == [-10, 0, 10]
    assert grid.ys == [-5, 5]
    assert grid.order() == [(0, 0), (1, 0), (2, 0), (2, 1), (1, 1), (0, 1)]
    assert grid.spacing == 10
    for bad in (
        Grid(x0=1, y0=0, x1=1, y1=1),
        Grid(x0=0, y0=2, x1=1, y1=1),
        Grid(x0=0, y0=0, x1=1, y1=1, nx=1),
        Grid(x0=0, y0=0, x1=1, y1=1, ny=51),
        Grid(x0=-2e6, y0=0, x1=1, y1=1),
    ):
        with pytest.raises(ValueError):
            bad.check()


def test_a_plane_is_reproduced_between_the_points_and_held_past_the_edge():
    grid = Grid(x0=-10, y0=-10, x1=10, y1=10, nx=3, ny=4)
    heightmap = probed(grid)
    for x, y in [(0, 0), (3.3, -7.1), (-10, 10), (9.99, 0.5)]:
        assert heightmap.height_at(x, y) == pytest.approx(plane(x, y), abs=1e-12)
    # Outside the grid the nearest edge holds.
    assert heightmap.height_at(15, 0) == pytest.approx(plane(10, 0))
    assert heightmap.height_at(-15, -20) == pytest.approx(plane(-10, -10))


def test_between_points_the_surface_is_bilinear_not_the_nearest_point():
    grid = Grid(x0=0, y0=0, x1=1, y1=1, nx=2, ny=2)
    heightmap = HeightMap(grid=grid, heights=[[0.0, 1.0], [2.0, 5.0]], focus_set=True)
    assert heightmap.height_at(0.5, 0.5) == pytest.approx(2.0)
    assert heightmap.height_at(1.0, 0.5) == pytest.approx(3.0)
    assert heightmap.focus_at(0.0, 0.0) == 0.0
    heightmap.focus_offset = 1.25
    assert heightmap.focus_at(0.0, 0.0) == 1.25


def test_a_map_is_only_followed_when_complete_focused_and_plausible():
    grid = Grid(x0=0, y0=0, x1=10, y1=10, nx=2, ny=2)
    heightmap = HeightMap.empty(grid)
    heightmap.heights[0] = [0.0, 0.1]
    with pytest.raises(ValueError, match="2 of 4"):
        heightmap.usable()
    with pytest.raises(ValueError, match="not complete"):
        heightmap.height_at(5, 5)
    heightmap.heights[1] = [0.2, 0.3]
    with pytest.raises(ValueError, match="focus offset"):
        heightmap.usable()
    heightmap.focus_set = True
    heightmap.usable()
    heightmap.heights[1][1] = MAX_SPAN + 1.0
    with pytest.raises(ValueError, match="spans"):
        heightmap.usable()


def test_a_map_with_the_wrong_shape_is_refused():
    grid = Grid(x0=0, y0=0, x1=10, y1=10, nx=2, ny=2)
    with pytest.raises(ValueError, match="2 rows of 2"):
        HeightMap(grid=grid, heights=[[0.0, 0.0]]).check()


def test_the_store_keeps_the_map_in_a_file(tmp_path):
    path = tmp_path / "heightmap.json"
    store = HeightMapStore(path)
    assert store.get() is None
    heightmap = probed(Grid(x0=0, y0=0, x1=10, y1=10, nx=2, ny=2), focus_offset=0.5)
    store.put(heightmap)
    assert json.loads(path.read_text())["focus_offset"] == 0.5
    again = HeightMapStore(path).get()
    assert again == heightmap
    # What the store hands out is a copy.
    again.focus_offset = 9.0
    assert store.get().focus_offset == 0.5
    store.put(None)
    assert not path.exists() and store.get() is None
    path.write_text("{not json")
    assert HeightMapStore(path).get() is None


# --- covering the job ----------------------------------------------------------


def test_a_job_past_the_probed_area_is_refused():
    heightmap = probed(Grid(x0=-10, y0=-10, x1=10, y1=10, nx=3, ny=3))
    inside = Job(groups=[Group(label="a", paths=[[(-10.5, 0.0), (10.5, 0.0)]])])
    check_covers(heightmap, inside)
    outside = Job(groups=[Group(label="a", paths=[[(-5.0, 0.0), (12.0, 0.0)]])])
    with pytest.raises(ValueError, match="does not cover"):
        check_covers(heightmap, outside)
    # A disabled group is not cut and does not count.
    outside.groups[0].enabled = False
    check_covers(heightmap, outside)


def test_a_joint_space_group_is_measured_on_the_board():
    job = Job(groups=[Group(label="j", joints=[[(5.0, 90.0), (-5.0, 90.0)]])])
    x0, y0, x1, y1 = job_extent(job)
    assert (x0, x1) == pytest.approx((0.0, 0.0), abs=1e-9)
    assert (y0, y1) == pytest.approx((-5.0, 5.0))


# --- compensation --------------------------------------------------------------


def square_job() -> Job:
    square = [(-8.0, -8.0), (8.0, -8.0), (8.0, 8.0), (-8.0, 8.0), (-8.0, -8.0)]
    radial = [(1.0, 0.0), (9.0, 0.0)]
    return Job(
        id="j",
        groups=[
            Group(label="square", power=400, min_power=100, speed=300, paths=[square]),
            Group(label="spoke", power=500, speed=300, paths=[radial]),
        ],
    )


def test_focus_mode_puts_the_focus_height_on_every_line_and_keeps_the_path():
    heightmap = probed(Grid(x0=-10, y0=-10, x1=10, y1=10, nx=5, ny=5), focus_offset=2.0)
    compensation = Compensation(heightmap=heightmap, mode="focus")
    streamer = Streamer()
    job = square_job()
    plain = list(streamer.job_pieces(job, (0.0, 0.0)))
    pieces = list(streamer.job_pieces(job, (0.0, 0.0), compensation))
    assert len(pieces) > len(plain)
    step = compensation.step
    assert step == pytest.approx(1.25)
    for piece in pieces:
        w = words(piece.line)
        assert "H" in w, piece.line
        x, y = board_of(piece.joint)
        assert w["H"] == pytest.approx(heightmap.focus_at(x, y), abs=6e-5)
        if piece.kind == "cut":
            # Split no longer than the step, and each piece on the joint
            # line the unsplit cut ran along.
            assert piece.length <= step + 1e-9
            assert w["F"] == 300
    # The same cuts in total: the ends of the unsplit cuts are all there,
    # in order, and nothing is burnt twice.
    ends = [p.joint for p in plain if p.kind == "cut"]
    split_ends = [p.joint for p in pieces if p.kind == "cut"]
    at = 0
    for end in ends:
        at = split_ends.index(end, at)
    assert sum(p.length for p in pieces) == pytest.approx(sum(p.length for p in plain))
    # The floor rides along as it did.
    square = [p for p in pieces if p.group == 0 and p.kind == "cut"]
    assert all(words(p.line)["M"] == 100 for p in square)


def test_a_split_cut_stays_on_the_joint_line():
    heightmap = probed(Grid(x0=-10, y0=-10, x1=10, y1=10, nx=9, ny=9))
    compensation = Compensation(heightmap=heightmap, mode="focus")
    job = Job(groups=[Group(label="arc", paths=[[(9.0, 0.0), (0.0, 9.0)]])])
    streamer = Streamer(tolerance=10.0)
    plain = [p for p in streamer.job_pieces(job, (0.0, 0.0)) if p.kind == "cut"]
    split = [p for p in streamer.job_pieces(job, (0.0, 0.0), compensation) if p.kind == "cut"]
    for piece in split:
        owner = next(p for p in plain if _between(piece.joint, p.start, p.joint))
        assert owner is not None


def _between(joint, a, b) -> bool:
    """`joint` lies on the straight joint line from a to b."""
    dr, da = b[0] - a[0], b[1] - a[1]
    t = ((joint[0] - a[0]) * dr + (joint[1] - a[1]) * da) / (dr * dr + da * da)
    if not -1e-9 <= t <= 1 + 1e-9:
        return False
    return math.isclose(a[0] + dr * t, joint[0], abs_tol=1e-6) and math.isclose(a[1] + da * t, joint[1], abs_tol=1e-6)


def test_power_mode_raises_the_power_for_the_defocus_and_caps_it():
    heightmap = probed(Grid(x0=-10, y0=-10, x1=10, y1=10, nx=5, ny=5))
    # The head held at the focus height of the axis: the board falls away
    # toward -y and rises toward +x, so the spot grows away from there.
    compensation = Compensation(heightmap=heightmap, mode="power", head_h=plane(0, 0), rayleigh=0.1, s_max=1000)
    streamer = Streamer()
    pieces = list(streamer.job_pieces(square_job(), (0.0, 0.0), compensation))
    cuts = [p for p in pieces if p.kind == "cut"]
    for piece in cuts:
        w = words(piece.line)
        assert "H" not in w
        middle = board_of(((piece.start[0] + piece.joint[0]) / 2, (piece.start[1] + piece.joint[1]) / 2))
        base = 400 if piece.group == 0 else 500
        want = min(base * compensation.factor(middle), 1000)
        assert w["S"] == pytest.approx(want, abs=1e-3)
        if piece.group == 0:
            assert w["M"] <= w["S"] and w["M"] == pytest.approx(min(100 * compensation.factor(middle), w["S"]), abs=1e-3)
    assert max(words(p.line)["S"] for p in cuts) == 1000
    assert min(words(p.line)["S"] for p in cuts) < 1000
    # Rapids are left alone.
    assert all("H" not in p.line for p in pieces if p.kind != "cut")


def test_the_estimate_counts_the_lines_a_compensated_run_sends():
    heightmap = probed(Grid(x0=-10, y0=-10, x1=10, y1=10, nx=5, ny=5))
    compensation = Compensation(heightmap=heightmap, mode="focus")
    streamer = Streamer()
    job = square_job()
    stats = streamer.estimate(job, (0.0, 0.0), compensation)
    assert stats.moves == len(list(streamer.job_pieces(job, (0.0, 0.0), compensation)))
    assert stats.seconds == pytest.approx(streamer.estimate(job).seconds, rel=1e-9)


def test_the_step_follows_the_grid_within_bounds():
    coarse = Compensation(heightmap=probed(Grid(x0=0, y0=0, x1=100, y1=100, nx=2, ny=2)), mode="focus")
    fine = Compensation(heightmap=probed(Grid(x0=0, y0=0, x1=1, y1=1, nx=3, ny=3)), mode="focus")
    assert coarse.step == 2.0
    assert fine.step == 0.25


# --- the probe tip -------------------------------------------------------------


@pytest.mark.parametrize("offset", [(0.0, 0.0), (3.0, 0.0), (0.0, 4.0), (-2.5, -1.5), (12.0, 2.0)])
@pytest.mark.parametrize("point", [(10.0, 0.0), (-7.0, 3.0), (0.5, -9.0), (20.0, 20.0)])
def test_the_probe_tip_lands_on_the_point_asked_for(offset, point):
    joint = probe_joint(point, offset, previous_angle=0.0)
    tip = polar.displaced(joint, offset[0], offset[1])
    assert tip == pytest.approx(point, abs=1e-9)


def test_the_probe_angle_follows_the_table_and_a_point_off_its_reach_is_refused():
    r, a = probe_joint((0.0, 10.0), (0.0, 0.0), previous_angle=720.0)
    assert (r, a) == pytest.approx((10.0, 810.0))
    with pytest.raises(ValueError, match="cannot reach"):
        probe_joint((1.0, 0.0), (0.0, 2.0), 0.0)
    # Near enough, a point inside the tip's circle is probed from its edge.
    joint = probe_joint((1.0, 0.0), (0.0, 2.0), 0.0, slack=1.5)
    assert polar.displaced(joint, 0.0, 2.0) == pytest.approx((2.0, 0.0), abs=1e-9)
    joint = probe_joint((0.0, 0.0), (0.5, 1.0), 0.0, slack=1.0)
    assert math.hypot(*polar.displaced(joint, 0.5, 1.0)) == pytest.approx(1.0)
    assert probe_joint((0.0, 0.0), (1.5, 0.0), 33.0) == (-1.5, 33.0)


def test_probe_settings_are_checked():
    ProbeSettings().check()
    for bad in (
        {"depth": 0},
        {"feed": 0},
        {"slow": -1},
        {"backoff": 6},
        {"offset": (2000.0, 0.0)},
        {"rayleigh": 0},
    ):
        with pytest.raises(ValueError):
            ProbeSettings(**bad).check()
    ProbeSettings(slow=0).check()


# --- what the firmware says ----------------------------------------------------


def test_status_with_and_without_a_focus_axis():
    plain = parse_status("<Idle|J:1.000,2.0000|V:0|L:0|Q:32,16|M:dyn|E:0|Z:0.000>")
    assert plain.h is None and plain.probe is None
    focus = parse_status("<Jog|J:1.000,2.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000|H:-1.250|P:1>")
    assert focus.h == -1.25 and focus.probe is True


def test_probe_results_are_read_from_the_answer():
    assert parse_probe(["[PRB:-1.2500:1]"]) == (-1.25, True)
    assert parse_probe(["noise", "[PRB:3.0000:0]"]) == (3.0, False)
    assert parse_probe(["[PRB:x:1]", "ok"]) is None
    assert parse_probe([]) is None
