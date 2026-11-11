"""The ASCII DXF reader, on the fixture drawings in tests/data/dxf."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from spinny_laser import dxf

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "data" / "dxf"


def read(name: str, tolerance: float = 0.005) -> dict[str, list[list[tuple[float, float]]]]:
    drawing = dxf.read_file(FIXTURES / name, tolerance)
    return {layer.name: layer.paths for layer in drawing.layers}


def near(a, b, within=1e-9) -> bool:
    return math.dist(a, b) <= within


def sag(points, center, radius) -> float:
    """How far a chord's middle falls inside a circle, the most of any chord."""
    worst = 0.0
    for p, q in zip(points, points[1:]):
        middle = ((p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0)
        worst = max(worst, radius - math.dist(middle, center))
    return worst


def test_lines_are_joined_into_paths_and_hidden_layers_left_out():
    layers = read("lines.dxf")
    # OFF is switched off, FROZEN frozen, and the invisible and paper
    # space lines, the text and the line of no length draw nothing.
    assert list(layers) == ["CUT", "MARK"]
    rectangle, l_shape = layers["CUT"]
    # Four lines, one drawn the other way round, are one closed loop.
    assert rectangle == [(20.0, 0.0), (20.0, 10.0), (0.0, 10.0), (0.0, 0.0), (20.0, 0.0)]
    assert l_shape == [(30.0, 0.0), (30.0, 5.0), (35.0, 5.0)]
    assert layers["MARK"] == [[(5.0, 5.0), (15.0, 5.0)]]


def test_curves_are_flattened_within_the_tolerance_in_the_drawing_s_unit():
    drawing = dxf.read_file(FIXTURES / "curves.dxf", 0.005)
    assert drawing.unit_mm == 25.4
    layers = {layer.name: layer.paths for layer in drawing.layers}
    (hole,) = layers["HOLES"]
    assert hole[0] == hole[-1]
    assert all(math.dist(p, (25.4, 25.4)) == pytest.approx(6.35, abs=1e-9) for p in hole)
    assert 0.0 < sag(hole, (25.4, 25.4), 6.35) <= 0.005
    # An arc and two lines meeting its ends close into a quarter disc.
    (quarter,) = layers["EDGE"]
    assert quarter[0] == quarter[-1] and near(quarter[0], (25.4, 0.0))
    arc_end = next(index for index, p in enumerate(quarter) if near(p, (0.0, 25.4), 1e-6))
    assert 0.0 < sag(quarter[: arc_end + 1], (0.0, 0.0), 25.4) <= 0.005
    assert quarter[arc_end + 1 :] == [(0.0, 0.0), (25.4, 0.0)]
    # The slot: two half circles from bulges, centers 25.4 apart.
    (slot,) = layers["SLOT"]
    assert slot[0] == slot[-1]
    xs = [x for x, _ in slot]
    ys = [y for _, y in slot]
    assert min(xs) == pytest.approx(50.8 - 6.35, abs=1e-6) and max(xs) == pytest.approx(76.2 + 6.35, abs=1e-6)
    assert min(ys) == pytest.approx(0.0, abs=1e-9) and max(ys) == pytest.approx(12.7, abs=1e-9)


def test_ellipses_and_polylines_and_an_extrusion_that_mirrors():
    layers = read("curves.dxf")
    whole, half = layers["ELLIPSE"]
    assert whole[0] == whole[-1]
    for x, y in whole:
        assert ((x - 127.0) / 25.4) ** 2 + ((y - 25.4) / 12.7) ** 2 == pytest.approx(1.0, abs=1e-9)
    # Standing up, from its top round its left side to its bottom.
    assert near(half[0], (127.0, 101.6)) and near(half[-1], (127.0, 50.8))
    assert min(x for x, _ in half) == pytest.approx(127.0 - 12.7, abs=1e-6)
    (poly,) = layers["POLY"]
    # A clockwise bulge of -0.5 between (0, 3) and (1, 3) inches, the
    # frame point at (0.5, 3.5) left out, then straight up to (1, 4).
    assert near(poly[0], (0.0, 76.2)) and near(poly[-1], (25.4, 101.6), 1e-6)
    assert all(not near(p, (12.7, 88.9), 1e-3) for p in poly)
    # The sagitta of a bulge b over a chord c is b c / 2: going east, a
    # clockwise arc rises over the chord (a counterclockwise one dips
    # under it).
    top = max(y for x, y in poly if x < 25.4 - 1e-6)
    assert top == pytest.approx(76.2 + 0.25 * 25.4, abs=0.006)
    (mirrored,) = layers["MIRROR"]
    assert near(mirrored[0], (-63.5, 76.2), 1e-6) and near(mirrored[-1], (-38.1, 76.2), 1e-6)
    assert all(y >= 76.2 - 1e-9 for _, y in mirrored)
    (wrap,) = layers["WRAP"]
    # 270 to 90 degrees runs through 0, on the right of its center.
    assert near(wrap[0], (254.0, -25.4), 1e-6) and near(wrap[-1], (254.0, 25.4), 1e-6)
    assert max(x for x, _ in wrap) == pytest.approx(279.4, abs=1e-6)


def test_blocks_are_inserted_scaled_turned_nested_in_arrays_and_mirrored():
    layers = read("blocks.dxf")
    assert list(layers) == ["PADS", "SILK", "ARRAY", "MIRROR"]
    # The pad's circle is on layer 0, so it takes the insert's layer; its
    # silk line keeps its own. PAIR is scaled 2 along its X, so its circles
    # are ellipses, 2 by 1 mm, turned 30 degrees.
    first, second = layers["PADS"]
    turn = math.radians(30.0)
    for path, (cx, cy) in zip((first, second), ((10.0, 10.0), (10.0 + 10.0 * math.cos(turn), 10.0 + 10.0 * math.sin(turn)))):
        for x, y in path:
            u = (x - cx) * math.cos(turn) + (y - cy) * math.sin(turn)
            v = -(x - cx) * math.sin(turn) + (y - cy) * math.cos(turn)
            assert (u / 1.0) ** 2 + (v / 0.5) ** 2 == pytest.approx(1.0, abs=1e-9)
    silk = layers["SILK"]
    assert len(silk) == 2 + 6 + 1
    assert near(silk[0][0], (10.0 - 2.0 * math.cos(turn), 10.0 - 2.0 * math.sin(turn)))
    # Three columns 4 mm apart and two rows 3 mm apart; the block's name is
    # matched whatever its case.
    centers = sorted((round(sum(x for x, _ in p[:-1]) / (len(p) - 1), 9), round(sum(y for _, y in p[:-1]) / (len(p) - 1), 9)) for p in layers["ARRAY"])
    assert centers == [(0.0, -10.0), (0.0, -7.0), (4.0, -10.0), (4.0, -7.0), (8.0, -10.0), (8.0, -7.0)]
    # An extrusion of -Z mirrors the insert in X.
    (mirrored,) = layers["MIRROR"]
    assert all(math.dist(p, (-20.0, 0.0)) == pytest.approx(0.5, abs=1e-9) for p in mirrored)


def test_splines_are_flattened_and_fit_points_joined():
    layers = read("splines.dxf")
    (curve,) = layers["CURVE"]
    # Clamped: it starts and ends on its end control points.
    assert near(curve[0], (0.0, 0.0)) and near(curve[-1], (7.0, 1.0))
    (arc,) = layers["ARC"]
    # The rational quadratic is a quarter of the unit circle, exactly.
    assert near(arc[0], (1.0, 0.0)) and near(arc[-1], (0.0, 1.0))
    assert all(math.hypot(*p) == pytest.approx(1.0, abs=1e-12) for p in arc)
    assert sag(arc, (0.0, 0.0), 1.0) <= 0.005
    (fit,) = layers["FIT"]
    assert fit == [(10.0, 0.0), (12.0, 1.0), (11.0, 3.0), (9.0, 2.0), (10.0, 0.0)]
    (clamped,) = layers["CLAMPED"]
    assert near(clamped[0], (20.0, 0.0)) and near(clamped[-1], (24.0, 0.0))
    assert len(clamped) > 4


def test_a_coarser_tolerance_takes_fewer_points():
    fine = sum(len(path) for paths in read("curves.dxf", 0.001).values() for path in paths)
    coarse = sum(len(path) for paths in read("curves.dxf", 0.05).values() for path in paths)
    assert coarse < fine


ENTITIES = "  0\nSECTION\n  2\nENTITIES\n{}  0\nENDSEC\n  0\nEOF\n"


def test_what_is_refused():
    with pytest.raises(dxf.DxfError, match="binary DXF"):
        dxf.decode(b"AutoCAD Binary DXF\r\n\x1a\x00\x00\x00")
    with pytest.raises(dxf.DxfError, match="not an ASCII DXF"):
        dxf.read("hello\nworld\n")
    with pytest.raises(dxf.DxfError, match="no ENTITIES"):
        dxf.read("  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n")
    with pytest.raises(dxf.DxfError, match="group 10 should be a number"):
        dxf.read(ENTITIES.format("  0\nLINE\n 10\n1,5\n 20\n0\n"))
    with pytest.raises(dxf.DxfError, match="no unit"):
        dxf.read("  0\nSECTION\n  2\nHEADER\n  9\n$INSUNITS\n 70\n99\n  0\nENDSEC\n" + ENTITIES.format(""))
    looped = "  0\nSECTION\n  2\nBLOCKS\n  0\nBLOCK\n  2\nA\n  0\nINSERT\n  2\nA\n  0\nENDBLK\n  0\nENDSEC\n" + ENTITIES.format("  0\nINSERT\n  2\nA\n")
    with pytest.raises(dxf.DxfError, match="inserts itself"):
        dxf.read(looped)
    # Nothing that draws: no layers, for the caller to refuse.
    assert dxf.read(ENTITIES.format("  0\nTEXT\n  1\nhi\n")).layers == []
    # A byte order mark and old code pages read.
    assert dxf.read(dxf.decode(b"\xef\xbb\xbf" + ENTITIES.format("  0\nLINE\n  8\nL\xe4\n 10\n0\n 20\n0\n 11\n1\n 21\n0\n").encode("latin-1"))).layers[0].paths == [[(0.0, 0.0), (1.0, 0.0)]]


def test_the_fixture_the_page_twin_is_checked_against_is_current():
    fixture = HERE / "data" / "dxf-samples.json"
    assert json.loads(fixture.read_text()) == json.loads(json.dumps(dxf.samples())), "run: mise run dxf-fixture"
