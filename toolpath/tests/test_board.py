"""The layer a board job is cut from, and the gerber that holds it."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from spinny_laser import board, camjob

DATA = Path(__file__).resolve().parent / "data"
BOARD = DATA / "board.kicad_pcb"

needs_kicad = pytest.mark.skipif(shutil.which("kicad-cli") is None, reason="kicad-cli not installed")


@pytest.mark.parametrize("layer", ["F.Cu", "B.Cu", "In12.Cu", "F.Paste", "B.Mask", "Dwgs.User", "User.9", "Margin"])
def test_a_kicad_layer_name_passes(layer):
    board.check_layer(layer)


@pytest.mark.parametrize("layer", ["", "F/Paste", "F.Paste,B.Cu", ".Cu", "F..Cu", "F.Cu ", 12, "x" * 33])
def test_anything_else_is_refused_as_a_layer(layer):
    with pytest.raises(board.LayerError, match="layer must be a KiCad layer name such as F.Cu or F.Paste"):
        board.check_layer(layer)


def test_a_gerber_names_its_layer_the_way_kicad_cli_does():
    assert board.layer_of("board-F_Cu.gbr") == "F.Cu"
    assert board.layer_of(Path("/x/test-gerbers-F_Paste.gtp")) == "F.Paste"
    assert board.layer_of("board-In1_Cu.g2") == "In1.Cu"
    assert board.layer_of("board-Edge_Cuts.gm1") == "Edge.Cuts"
    assert board.layer_of("board-User_10.gbr") == "User.10"
    # A name that does not say, or only looks like it, is not a layer.
    assert board.layer_of("my_board.gbr") is None
    assert board.layer_of("coupon.gtp") is None
    assert board.layer_of("F_Cu-notes.gbr") is None


def test_a_gerber_named_by_the_name_a_layer_is_shown_by_is_that_layer():
    # kicad-cli names the gerber after the name shown, not the board file's.
    assert board.layer_of("board-F_Silkscreen.gto") == "F.SilkS"
    assert board.layer_of("board-B_Silkscreen.gbo") == "B.SilkS"
    assert board.layer_of("board-User_Drawings.gbr") == "Dwgs.User"
    assert board.layer_of("board-B_Courtyard.gbr") == "B.CrtYd"
    assert board.layer_of("board-F_Adhesive.gbr") == "F.Adhes"


def test_a_board_files_layer_table_gives_each_layer_the_name_it_is_shown_by():
    table = board.layer_table(BOARD.read_text())
    assert table["F.Cu"] == "F.Cu"
    assert table["F.SilkS"] == "F.Silkscreen"
    assert table["Dwgs.User"] == "User.Drawings"
    assert table["Edge.Cuts"] == "Edge.Cuts"
    assert len(table) == 24
    # A layer the board names itself, and the bare names of older files.
    own = board.layer_table('(kicad_pcb (layers (0 F.Cu signal) (39 "User.1" user "Logo") (37 F.SilkS user)) (setup (stackup (layer "F.SilkS"))))')
    assert own == {"F.Cu": "F.Cu", "User.1": "Logo", "F.SilkS": "F.Silkscreen"}
    assert board.layer_table("(kicad_pcb (version 20240108))") == {}
    assert board.layer_names("User.1", own) == ["User.1", "Logo"]
    assert board.layer_names("F.SilkS") == ["F.SilkS", "F.Silkscreen"]


def test_a_layer_gerber_is_found_under_the_name_it_is_shown_by(tmp_path):
    for name in ("board-F_Silkscreen.gto", "board-User_Drawings.gbr", "board-Logo.gbr", "board-F_Cu.gtl"):
        (tmp_path / name).write_text("G04*")
    assert board.find_layer(tmp_path, "F.SilkS").name == "board-F_Silkscreen.gto"
    assert board.find_layer(tmp_path, "Dwgs.User").name == "board-User_Drawings.gbr"
    assert board.find_layer(tmp_path, "User.1", {"User.1": "Logo"}).name == "board-Logo.gbr"
    with pytest.raises(board.LayerError, match="no User.1 gerber"):
        board.find_layer(tmp_path, "User.1")


@needs_kicad
def test_a_silk_screen_of_a_board_file_is_found_as_kicad_cli_plots_it():
    design = camjob.read_board(BOARD, "F.SilkS")
    assert design.layer == "F.SilkS" and design.copper


def test_the_word_for_a_layer_is_what_it_draws():
    assert board.layer_word("F.Cu") == "copper"
    assert board.layer_word("In3.Cu") == "copper"
    assert board.layer_word("B.Paste") == "paste"
    assert board.layer_word("F.Mask") == "mask"
    assert board.layer_word("B.SilkS") == "silk"
    assert board.layer_word("Dwgs.User") == "Dwgs.User"
    assert board.layer_word(None) == "copper"


def test_the_layer_gerber_is_found_whatever_its_extension(tmp_path):
    for name in ("board-F_Cu.gtl", "board-F_Paste.gtp", "board-Edge_Cuts.gm1", "board-User_1.gbr", "board-User_10.gbr", "board-job.gbrjob", "board-PTH.drl"):
        (tmp_path / name).write_text("G04*")
    assert board.find_layer(tmp_path, "F.Paste").name == "board-F_Paste.gtp"
    assert board.find_layer(tmp_path, "F.Cu").name == "board-F_Cu.gtl"
    assert board.find_layer(tmp_path, "Edge.Cuts").name == "board-Edge_Cuts.gm1"
    # The exact name wins over one that only contains the layer.
    assert board.find_layer(tmp_path, "User.1").name == "board-User_1.gbr"
    with pytest.raises(board.LayerError, match="no B.Cu gerber"):
        board.find_layer(tmp_path, "B.Cu")
    # The job file is never the layer, however it is named.
    only_job = tmp_path / "job"
    only_job.mkdir()
    (only_job / "board-F_Cu.gbrjob").write_text("{}")
    with pytest.raises(board.LayerError):
        board.find_layer(only_job, "F.Cu")


def test_the_gerber_suffixes_cover_what_kicad_cli_plots():
    assert {".gtp", ".gbp", ".gto", ".gbo", ".gtl", ".gbl", ".gts", ".gbs", ".gm1", ".gbr"} <= set(board.GERBER_SUFFIXES)
    assert camjob.GERBER_SUFFIXES == board.GERBER_SUFFIXES


@needs_kicad
def test_a_board_is_read_on_its_paste_layer_for_a_stencil():
    design = camjob.read_board(BOARD, "F.Paste")
    assert design.source == "kicad" and design.layer == "F.Paste"
    assert design.copper and design.outline
    copper = camjob.read_board(BOARD, "F.Cu")
    assert copper.layer == "F.Cu"
    # Every paste opening sits on a pad: the stencil is no bigger than the copper.
    paste_box = _box(design.copper)
    copper_box = _box(copper.copper)
    assert copper_box[0] <= paste_box[0] and copper_box[1] <= paste_box[1]
    assert paste_box[2] <= copper_box[2] and paste_box[3] <= copper_box[3]


@needs_kicad
def test_a_layer_the_board_lacks_or_leaves_empty_is_refused():
    with pytest.raises(camjob.DesignError, match="board.kicad_pcb has no layer In1.Cu"):
        camjob.read_board(BOARD, "In1.Cu")
    with pytest.raises(camjob.DesignError, match="draws no paste"):
        camjob.read_board(BOARD, "B.Paste")
    with pytest.raises(camjob.DesignError, match="layer must be a KiCad layer name"):
        camjob.read_board(BOARD, "F.Paste,B.Paste")


def test_a_gerber_design_keeps_the_layer_its_name_says(tmp_path):
    design = camjob.read_board(DATA / "board-F_Cu.gbr")
    assert design.layer == "F.Cu"
    copy = tmp_path / "coupon.gbr"
    copy.write_bytes((DATA / "board-F_Cu.gbr").read_bytes())
    assert camjob.read_board(copy).layer is None


def _box(contours) -> tuple[float, float, float, float]:
    xs = [p[0] for contour in contours for p in contour]
    ys = [p[1] for contour in contours for p in contour]
    return min(xs), min(ys), max(xs), max(ys)


def test_a_gerber_is_read_with_the_outline_and_drill_file_beside_it():
    read = board.read(DATA / "board-F_Cu.gbr", "B.Paste")
    # The gerber's name says its layer, whatever layer was asked for.
    assert read.source == "gerber" and read.layer == "F.Cu" and read.word == "copper"
    assert read.name == "board-F_Cu" and read.file == "board-F_Cu.gbr"
    assert read.copper and read.outline and read.image.figures
    assert sorted(diameter for _, diameter, _ in read.holes) == [0.8, 0.8, 1.0]
    assert all(end is None for _, _, end in read.holes)
    assert read.notes == []


def test_a_layer_that_fills_nothing_is_read_empty_for_the_caller_to_judge(tmp_path):
    lines = tmp_path / "board-User_1.gbr"
    # One line drawn with a zero width aperture: a line, and no area.
    lines.write_text("%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.000*%\nD10*\nX0Y0D02*\nX10000000Y0D01*\nM02*\n")
    read = board.read(lines)
    assert read.layer == "User.1" and read.copper == [] and read.outline == [] and read.holes == []
    with pytest.raises(camjob.DesignError, match="board-User_1.gbr draws no User.1"):
        camjob.read_board(lines)


def test_what_cannot_be_read_is_a_read_error(tmp_path):
    with pytest.raises(board.ReadError):
        board.read(tmp_path / "missing-F_Cu.gbr")
    with pytest.raises(board.ReadError, match="layer must be a KiCad layer name"):
        board.read(BOARD, "F.Paste,B.Paste")


@needs_kicad
def test_a_board_file_is_read_with_its_outline_and_drills():
    read = board.read(BOARD, "F.Cu")
    assert read.source == "kicad" and read.layer == "F.Cu" and read.name == "board"
    assert read.copper and read.outline and read.file == "board-F_Cu.gtl"
    # The board has no holes: its drill file is plotted, and empty.
    assert read.holes == [] and read.notes == []
