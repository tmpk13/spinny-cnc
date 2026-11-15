"""Stitching (stitch.py) and part checks (inspect.py) on small synthetic
pictures whose geometry is known exactly."""

import math

import numpy as np
import pytest

from spinny_web import inspect as ins
from spinny_web import stitch


def texture(x, y):
    """A board-like pattern defined everywhere on the machine (mm): blobs
    and stripes of several sizes, so any window of a few mm registers."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    v = 100.0 + 40.0 * np.sin(2.1 * x + 0.3 * y) * np.cos(1.7 * y - 0.5 * x)
    v += 30.0 * np.sin(5.3 * x + 4.1 * y) + 25.0 * np.cos(7.9 * y - 2.2 * x)
    v += 20.0 * np.sin(11.0 * x) * np.sin(13.0 * y)
    v += 20.0 * np.sin(40.0 * x + 31.0 * y) + 20.0 * np.cos(47.0 * y - 13.0 * x)
    return v


def picture_at(camera, head, true_shift=(0.0, 0.0)):
    """What a camera shows with the head at `head`, the head really standing
    `true_shift` mm away from it."""
    ys, xs = np.mgrid[0:camera.height, 0:camera.width].astype(np.float64)
    mx, my = camera.offset_of(xs, ys)
    return texture(mx + head[0] + true_shift[0], my + head[1] + true_shift[1]).astype(np.float32)


def small_camera(**terms):
    return stitch.Camera.measured(200, 140, 0.02, terms.pop("roll", 180.4), **terms)


def test_lens_round_trip():
    cam = small_camera(k1=0.0166, k2=0.01)
    px = np.array([0.0, 13.5, 100.0, 199.0, 57.0])
    py = np.array([0.0, 139.0, 70.0, 3.0, 88.8])
    ux, uy = cam.undistort(px, py)
    bx, by = cam.distort(ux, uy)
    assert np.allclose(bx, px, atol=1e-7) and np.allclose(by, py, atol=1e-7)
    # pcbv's correction pushes a corner out by k1 + k2 of its radius.
    cx, cy = cam.center
    ux, uy = cam.undistort(0.0, 0.0)
    assert math.hypot(ux - cx, uy - cy) == pytest.approx(cam.radius * (1.0 + 0.0166 + 0.01))


def test_pixel_and_offset_round_trip_and_signs():
    cam = stitch.Camera.measured(200, 140, 0.02, 0.0)
    # Roll 0: right in the picture is +X, down is -Y.
    mx, my = cam.offset_of(cam.center[0] + 10.0, cam.center[1])
    assert (float(mx), float(my)) == pytest.approx((0.2, 0.0))
    mx, my = cam.offset_of(cam.center[0], cam.center[1] + 10.0)
    assert (float(mx), float(my)) == pytest.approx((0.0, -0.2))
    turned = small_camera(k1=0.01, skew=0.13)
    px, py = turned.pixel_of(np.array([0.3, -0.7]), np.array([0.2, 0.9]))
    mx, my = turned.offset_of(px, py)
    assert np.allclose(mx, [0.3, -0.7], atol=1e-9) and np.allclose(my, [0.2, 0.9], atol=1e-9)


def test_describe_recovers_the_measured_numbers():
    cam = stitch.Camera.measured(1280, 720, 0.0161, 180.4, skew=0.13, aspect=1.004)
    d = cam.describe()
    assert d["mm_per_px_x"] == pytest.approx(0.0161, rel=1e-6)
    assert d["mm_per_px_y"] == pytest.approx(0.0161 * 1.004, rel=1e-6)
    assert d["roll"] == pytest.approx(180.4, abs=1e-6)
    assert d["skew_deg"] == pytest.approx(0.13, abs=1e-6)


def survey(camera, errors, step=(1.6, 1.2)):
    heads = np.array([(10.0 + c * step[0], 20.0 + r * step[1]) for r in range(3) for c in range(3)])
    pictures = np.array([picture_at(camera, h, e) for h, e in zip(heads, errors)])
    return heads, pictures


def test_seams_vanish_with_the_true_camera_and_show_head_errors():
    cam = small_camera(k1=0.02, skew=0.13)
    errors = np.zeros((9, 2))
    heads, pictures = survey(cam, errors)
    windows = stitch.overlap_windows(heads, cam, 48, 0.02, 0.6)
    assert windows
    stitch.register(pictures, heads, cam, windows, 48, 0.02)
    ok = stitch.good(windows, min_peak=0.05, min_busy=0.0)
    assert len(ok) > 0.8 * len(windows)
    assert stitch.spread(w.size_mm for w in ok)["max"] < 0.004
    # A head that stood 0.06 mm off shows in every seam it is part of.
    errors[4] = (0.06, -0.04)
    heads, pictures = survey(cam, errors)
    stitch.register(pictures, heads, cam, windows, 48, 0.02)
    ok = stitch.good(windows, min_peak=0.05, min_busy=0.0)
    touching = [w for w in ok if 4 in (w.i, w.j)]
    assert touching
    for w in touching:
        sign = 1.0 if w.i == 4 else -1.0
        # j puts a feature where it is less j's error, i the same.
        assert w.residual[0] == pytest.approx(sign * 0.06, abs=0.004)
        assert w.residual[1] == pytest.approx(-sign * 0.04, abs=0.004)
    shifts = stitch.adjust_shifts(len(heads), ok)
    found = shifts - shifts.mean(axis=0)
    truth = errors - errors.mean(axis=0)
    assert np.allclose(found, truth, atol=0.003)


def test_camera_fit_finds_lens_and_backlash():
    true = small_camera(k1=0.03)
    directions = np.array([1, 1, 1, -1, -1, -1, 1, 1, 1], dtype=float)
    backlash = 0.05
    errors = np.array([(backlash / 2.0 * d, 0.0) for d in directions])
    heads, pictures = survey(true, errors)
    guess = small_camera(k1=0.0)
    windows = stitch.overlap_windows(heads, guess, 40, 0.02, 0.4)
    stitch.register(pictures, heads, guess, windows, 40, 0.02)
    ok = stitch.good(windows, min_peak=0.05, min_busy=0.0, max_mm=0.3)
    matches = stitch.matches_of(ok, heads, guess)
    fit = stitch.fit_camera(matches, heads, guess, free_axes=True, free_lens=(True, False), directions=directions, robust=None)
    assert fit.camera.k1 == pytest.approx(0.03, abs=0.006)
    assert fit.backlash == pytest.approx(backlash, abs=0.006)
    assert float(np.sqrt(np.mean(fit.residuals ** 2))) < 0.004


def test_compose_places_pictures_and_leaves_gaps_empty():
    cam = small_camera()
    heads = np.array([(0.0, 0.0), (1.5, 0.0)])
    pictures = np.array([np.full((140, 200), 50.0), np.full((140, 200), 50.0)])
    mosaic = stitch.compose(pictures, heads, cam, (-1.5, -1.0, 6.0, 1.0), 0.05)
    assert np.nanmax(np.abs(mosaic - 50.0)) < 1e-3
    assert np.isnan(mosaic[:, -1]).all()
    nearest = stitch.compose(pictures, heads, cam, (-1.5, -1.0, 6.0, 1.0), 0.05, nearest=True)
    assert np.nanmax(np.abs(nearest - 50.0)) < 1e-3


def test_box_blur_and_flat_field_even_out_light():
    light = np.outer(np.linspace(0.5, 1.5, 30), np.ones(40))
    pictures = np.array([light * 100.0 for _ in range(3)])
    gain = stitch.flat_field(pictures, blur=5)
    evened = pictures[0] * gain
    assert evened[5:-5, 5:-5].std() < 2.0
    assert np.allclose(stitch.box_blur(np.ones((9, 9)), 3), 1.0)


BOARD = """(kicad_pcb (version 20260206)
 (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (at 10 20 90)
  (property "Reference" "R1") (property "Value" "10k")
  (attr smd)
  (fp_rect (start -0.8 -0.4) (end 0.8 0.4) (layer "F.Fab"))
  (fp_rect (start -1.5 -0.7) (end 1.5 0.7) (layer "F.CrtYd"))
  (pad "1" smd roundrect (at -0.8 0 90) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste"))
  (pad "2" smd roundrect (at 0.8 0 90) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste")))
 (footprint "Diode_SMD:D_SOD-323" (layer "F.Cu") (at 30 20 0)
  (property "Reference" "D1") (property "Value" "1N4148")
  (fp_rect (start -0.9 -0.7) (end 0.9 0.7) (layer "F.Fab"))
  (pad "1" smd rect (at -1.1 0) (size 0.6 0.5) (layers "F.Cu" "F.Mask"))
  (pad "2" smd rect (at 1.1 0) (size 0.6 0.5) (layers "F.Cu" "F.Mask")))
 (footprint "Package_TO_SOT_SMD:SOT-23" (layer "B.Cu") (at 50 20 0)
  (property "Reference" "Q1") (property "Value" "x")
  (pad "1" smd rect (at -1 1) (size 0.6 0.7) (layers "B.Cu"))
  (pad "2" smd rect (at 1 1) (size 0.6 0.7) (layers "B.Cu"))
  (pad "3" smd rect (at 0 -1) (size 0.6 0.7) (layers "B.Cu")))
 (footprint "TestPoint:TP" (layer "B.Cu") (at 70 20 0)
  (property "Reference" "TP1") (property "Value" "x")
  (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask"))))
"""


def test_parts_of_reads_pads_boxes_and_classes():
    parts = {p.ref: p for p in ins.parts_of(BOARD)}
    r1 = parts["R1"]
    assert (r1.kind, r1.side, r1.rotation, len(r1.pads)) == (ins.PASSIVE, "front", 90.0, 2)
    assert r1.body == (-0.8, -0.4, 0.8, 0.4) and r1.courtyard == (-1.5, -0.7, 1.5, 0.7)
    # The pad's own angle is the board file's less its footprint's: none.
    xs = sorted(p[0] for p in r1.pads[0])
    assert xs[0] == pytest.approx(-1.2) and xs[-1] == pytest.approx(-0.4)
    assert parts["D1"].kind == ins.POLARIZED
    assert parts["Q1"].side == "back" and parts["Q1"].kind == ins.IC
    front = ins.board_pads(list(parts.values()))
    # R1's two pads turned 90 degrees on the board: pad 1 lies 0.8 mm
    # below its origin (KiCad's y down), D1's two, TP1's through-hole pad
    # from the back; Q1's surface pads are not on the front.
    assert len(front) == 5
    centers = sorted((round(float(np.mean([p[0] for p in pad])), 3), round(float(np.mean([p[1] for p in pad])), 3)) for pad in front)
    assert (10.0, 20.8) in centers and (10.0, 19.2) in centers and (70.0, 20.0) in centers


def test_raster_covers_a_polygon_by_its_area():
    square = [(0.2, 0.2), (1.2, 0.2), (1.2, 0.7), (0.2, 0.7)]
    cover = ins.raster([square], 0.0, 0.0, 0.05, (30, 40))
    assert cover.sum() * 0.05 * 0.05 == pytest.approx(0.5, rel=0.01)


def test_board_map_follows_the_truth():
    board = ins.BoardMap.truth(90.0, (100.0, 200.0))
    x, y = board.apply(1.0, 2.0)
    # (x, -y) = (1, -2), turned 90 degrees: (2, 1).
    assert (float(x), float(y)) == pytest.approx((102.0, 201.0))


def pattern(n=64):
    """An asymmetric test crop: a bar, a dot off to one side, texture."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    img = 60.0 + 10.0 * np.sin(xx / 3.0) * np.cos(yy / 5.0)
    img[24:40, 12:52] = 200.0
    img[44:52, 14:22] = 160.0
    return img.astype(np.float32)


def test_compare_finds_turns_shifts_and_a_missing_part():
    golden = pattern()
    mask = np.ones(golden.shape, dtype=bool)
    same = ins.compare(golden, golden, mask, 0.02)
    assert same.golden_ncc == pytest.approx(1.0) and same.quarter == 0 and same.offset_mm < 1e-6
    assert abs(same.angle) < 0.1
    turned = ins.compare(np.rot90(golden, 3), golden, mask, 0.02)
    # Three quarters counterclockwise as seen: the part lies turned 270.
    assert turned.quarter == 270
    moved = ins.compare(ins.shift_image(golden, 5.0, -2.0), golden, mask, 0.02)
    assert moved.offset[0] == pytest.approx(0.1, abs=0.01) and moved.offset[1] == pytest.approx(-0.04, abs=0.01)
    tilted = ins.compare(ins.rotate(golden, 4.0, fill=60.0), golden, mask, 0.02)
    assert tilted.angle == pytest.approx(4.0, abs=0.6)
    rng = np.random.default_rng(1)
    missing = ins.compare(60.0 + rng.normal(0.0, 5.0, golden.shape).astype(np.float32), golden, mask, 0.02)
    assert missing.golden_ncc < 0.2


def test_compare_aligns_the_board_before_the_part():
    n = 96
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    board = 60.0 + 25.0 * np.sin(xx / 2.5) * np.cos(yy / 3.5) + 15.0 * np.cos((xx + 2 * yy) / 4.0)
    golden = board.copy()
    golden[38:58, 30:66] = 200.0
    region = np.zeros((n, n), dtype=bool)
    region[30:66, 30:66] = True
    context = ~ins.region_mask_box(region, 6)
    # The whole test crop lies 3 px right of the golden's (the stitching's
    # error), and its part 4 px further down.
    test = board.copy()
    test[42:62, 30:66] = 200.0
    test = ins.shift_image(test, 3.0, 0.0)
    verdict = ins.compare(test, golden, region, 0.02, context=context)
    assert verdict.board[0] == pytest.approx(0.06, abs=0.01) and abs(verdict.board[1]) < 0.01
    assert verdict.offset[1] == pytest.approx(0.08, abs=0.015) and abs(verdict.offset[0]) < 0.015


def test_sprite_paste_and_bare():
    part = ins.parts_of(BOARD)[1]
    size = ins.crop_size(part, 0.02)
    luma, cover = ins.sprite(part, size, 0.02)
    assert cover.max() > 0.99 and np.isfinite(luma).all()
    pads = ins.own_raster(part, part.pads, size, 0.02)
    view = 80.0 + 150.0 * pads
    region = ins.region_mask(part, size, 0.02)
    placed = ins.paste(view, luma, cover)
    # The body covers the pads' inner ends: the crop no longer looks like
    # bare pads.
    assert ins.ncc(view, pads, region) > 0.99
    assert ins.ncc(placed, pads, region) < 0.9
    painted = ins.bare(view, pads, region)
    assert abs(ins.ncc(painted, pads, region)) < 0.2
    assert float(np.percentile(np.abs(painted - 80.0)[region], 99)) < 2.0
    # Turned 180 degrees, a diode's band moves to the other end.
    turned = ins.paste(view, luma, cover, degrees=180.0)
    assert ins.ncc(turned, placed, region) < 0.99


def test_phase_shift_near_keeps_to_small_shifts():
    rng = np.random.default_rng(3)
    base = ins.gaussian_blur(rng.normal(0.0, 40.0, (96, 96)).astype(np.float32), 1.5)
    # A copy 2 px off, weaker than one 20 px off: the near search finds
    # the 2 px one, the whole search the 20 px one.
    b = 0.4 * ins.shift_image(base, 2.0, 0.0) + ins.shift_image(base, 20.0, 0.0)
    near = stitch.phase_shift_near(base, b, 6.0)
    assert near[0] == pytest.approx(2.0, abs=0.3) and abs(near[1]) < 0.3
    far = stitch.phase_shift_near(base, b, 40.0)
    assert far[0] == pytest.approx(20.0, abs=0.3)


def test_relief_reads_between_its_nodes():
    relief = stitch.Relief(0.0, 0.0, 2.0, np.array([[0.0, 0.01], [0.02, 0.03]]))
    assert float(relief.at(1.0, 1.0)) == pytest.approx(0.015)
    assert float(relief.at(0.0, 2.0)) == pytest.approx(0.02)
    assert float(relief.at(-5.0, -5.0)) == pytest.approx(0.0)


def test_fit_camera_finds_a_tilted_board():
    """A board 1% nearer the camera per 2 mm along X shows larger there;
    a relief fitted with the seams finds that slope where a camera alone
    cannot."""
    cam = small_camera()
    slope = 0.005

    def nearer(x):
        return slope * (np.asarray(x) - 11.6)

    heads = np.array([(10.0 + c * 1.6, 20.0 + r * 1.2) for r in range(3) for c in range(3)])
    pictures = []
    for h in heads:
        ys, xs = np.mgrid[0:cam.height, 0:cam.width].astype(np.float64)
        mx, my = cam.offset_of(xs, ys)
        # A point at X shows at (X - H)(1 + r(X)): solve for X by iteration.
        x, y = h[0] + mx, h[1] + my
        for _ in range(6):
            grow = 1.0 + nearer(x)
            x, y = h[0] + mx / grow, h[1] + my / grow
        pictures.append(texture(x, y).astype(np.float32))
    pictures = np.array(pictures)
    windows = stitch.overlap_windows(heads, cam, 40, 0.02, 0.4)
    stitch.register(pictures, heads, cam, windows, 40, 0.02)
    ok = stitch.good(windows, min_peak=0.05, min_busy=0.0, max_mm=0.3)
    matches = stitch.matches_of(ok, heads, cam)
    plain = stitch.fit_camera(matches, heads, cam, free_axes=True, free_lens=(False, False), robust=None)
    relief = stitch.Relief.over(heads, 1.0, 2.0)
    fitted = stitch.fit_camera(matches, heads, cam, free_axes=True, free_lens=(False, False), relief=relief, smooth=0.5, robust=None)
    assert float(np.sqrt(np.mean(fitted.residuals ** 2))) < 0.5 * float(np.sqrt(np.mean(plain.residuals ** 2)))
    # The relief rises along X at about the slope (its mean is the
    # camera's scale, held at zero).
    left, right = float(fitted.relief.at(10.4, 21.2)), float(fitted.relief.at(12.8, 21.2))
    assert (right - left) / 2.4 == pytest.approx(slope, rel=0.35)


def test_layout_raster_shows_holes_and_covered_pads_under_openings():
    pad = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    hole = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)]
    covered = [(2.0, 0.0), (3.0, 0.0), (3.0, 1.0), (2.0, 1.0)]
    opening = [(2.5, 0.0), (3.5, 0.0), (3.5, 1.0), (2.5, 1.0)]
    out = ins.layout_raster([pad], [hole], 0.0, 0.0, 0.05, (20, 80), blur=0.0, covered=[covered], openings=[opening])
    assert out[4, 4] == pytest.approx(1.0) and out[10, 10] == pytest.approx(0.0)
    # The covered pad shows only where the opening lies over it.
    assert out[10, 44] == pytest.approx(0.0) and out[10, 56] == pytest.approx(1.0)


def test_hole_outline_follows_the_drill_offset():
    node = ins.parse_sexp('(pad "1" thru_hole rect (at 1 2 0) (size 3 1) (drill oval 2 0.5 (offset 0 0.2)) (layers "*.Cu"))')[0]
    hole = ins.hole_outline(node, 0.0)
    ys = [p[1] for p in hole]
    xs = [p[0] for p in hole]
    assert (min(xs) + max(xs)) / 2.0 == pytest.approx(1.0) and (min(ys) + max(ys)) / 2.0 == pytest.approx(2.2)
    assert max(xs) - min(xs) == pytest.approx(2.0, abs=0.01)


def test_cutout_and_under_move_a_real_part():
    part = ins.parts_of(BOARD)[0]
    size = ins.crop_size(part, 0.02)
    pads = ins.own_raster(part, part.pads, size, 0.02)
    view = 60.0 + 140.0 * pads
    luma, cover = ins.cutout(view, part, size, 0.02)
    background = ins.under(view, cover, pads, 200.0, 60.0)
    # Nothing was on the pads: the background is the view where the cover
    # is whole.
    whole = cover > 0.999
    assert np.allclose(background[whole], view[whole], atol=1e-3)
    moved = ins.paste(background, luma, cover, dx=5.0)
    assert not np.allclose(moved, view)
