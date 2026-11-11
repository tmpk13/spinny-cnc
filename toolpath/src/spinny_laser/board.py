"""Which layer of a board a job is read from, and the gerber that holds it.

A job is cut from one layer of a board: a copper layer to isolate or to
deposit, or the paste layer, whose openings a stencil cuts out of a film.
kicad-cli names the gerber it plots for a layer after the layer, F.Paste
as board-F_Paste, and gives it the layer's Protel extension: .gtl for the
front copper, .gtp for the front paste, .gto for the front silk, .gm1 for
the outline, .gbr for a layer without one. A layer name it does not know,
or a layer the board does not have, is skipped with exit code 0 and
nothing plotted; an enabled layer with nothing on it is plotted empty.

`read` is the one reader of a board for every job made from one: the
Jobs page's import and a CAM profile's both start from what it returns.
"""

from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_LAYER = "F.Cu"
OUTLINE_LAYER = "Edge.Cuts"

Point = tuple[float, float]
Polyline = list[Point]
# A drill file's hole: its center, its diameter, and the far end of its
# run for a slot, None for a round hole.
Hole = tuple[Point, float, Point | None]

# The files a board layer comes as: KiCad's own extension and the Protel
# ones kicad-cli gives the copper, mask, paste, silk and outline layers.
GERBER_SUFFIXES = (".gbr", ".gtl", ".gbl", ".gts", ".gbs", ".gtp", ".gbp", ".gto", ".gbo", ".gm1")

# A KiCad layer name as a board file spells it: F.Cu, In2.Cu, B.Paste,
# Dwgs.User, User.9, Margin.
_LAYER_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)?$")
MAX_LAYER_LENGTH = 32

# The name KiCad shows a layer by where it is not the layer's own: a
# board file names its layers F.SilkS or Dwgs.User, while kicad-cli names
# the gerber it plots after the name shown, board-F_Silkscreen.gto and
# board-User_Drawings.gbr. A board may give a layer a name of its own as
# well, which its layer table carries.
SHOWN_NAMES = {
    "F.SilkS": "F.Silkscreen",
    "B.SilkS": "B.Silkscreen",
    "F.Adhes": "F.Adhesive",
    "B.Adhes": "B.Adhesive",
    "F.CrtYd": "F.Courtyard",
    "B.CrtYd": "B.Courtyard",
    "Dwgs.User": "User.Drawings",
    "Cmts.User": "User.Comments",
    "Eco1.User": "User.Eco1",
    "Eco2.User": "User.Eco2",
}
_OWN_NAMES = {shown.replace(".", "_"): own for own, shown in SHOWN_NAMES.items()}

# The layer a gerber's name ends with, the way kicad-cli names them.
_NAMED = re.compile(
    r"(?:^|-)("
    r"(?:F|B|In[0-9]+)_(?:Cu|Paste|Mask|SilkS|Adhes|Fab|CrtYd|Silkscreen|Adhesive|Courtyard)"
    r"|(?:Dwgs|Cmts|Eco[12])_User|User_(?:Drawings|Comments|Eco[12])|Edge_Cuts|User_[0-9]+|Margin"
    r")$"
)

# One entry of a board file's layer table: (5 "F.SilkS" user "F.Silkscreen"),
# or with the names bare as older files write them.
_TABLE_ENTRY = re.compile(r'\(\s*-?[0-9]+\s+("[^"]*"|[^\s()"]+)\s+[A-Za-z_]+(?:\s+("[^"]*"|[^\s()"]+))?\s*\)')

# What a layer draws, for the labels of the groups cut from it.
_WORDS = {"Cu": "copper", "Paste": "paste", "Mask": "mask", "SilkS": "silk"}


class LayerError(ValueError):
    """Not a layer name, or no gerber of the layer where one was looked for."""


class ReadError(ValueError):
    """The board cannot be read: kicad-cli is missing or failed, the board
    has no such layer, or a gerber or drill file is not one."""


@dataclass
class BoardLayer:
    """One layer of a board as read, in the file's own millimeters, nothing
    placed or flipped yet: the drawing, the area it fills, and the outline
    and drill holes that came with it."""

    # The board file's or the gerber's name without its suffix.
    name: str
    # "kicad" for a board file plotted through kicad-cli, "gerber" else.
    source: str
    # The layer read; for a gerber the layer its name says, None when it
    # does not say.
    layer: str | None
    # The name of the gerber the layer was read from, for messages.
    file: str
    # The layer's gerber image (laser_sweep.gerber.Image): its strokes,
    # flashes and regions as drawn, for what the filled area loses (a
    # stroke's middle, a pad, a line drawn with no width).
    image: Any
    # The filled area as closed contours; empty for a layer that only
    # draws lines with no width.
    copper: list = field(default_factory=list)
    outline: list[Polyline] = field(default_factory=list)
    holes: list[Hole] = field(default_factory=list)
    # What reading left out, one line each.
    notes: list[str] = field(default_factory=list)

    @property
    def word(self) -> str:
        return layer_word(self.layer)


def read(path: Path | str, layer: str = DEFAULT_LAYER) -> BoardLayer:
    """A board's `layer` with its outline and drill holes.

    A KiCad board is plotted through kicad-cli into a folder of its own,
    the layer, Edge.Cuts and the drill files, and read from there. A gerber
    is the layer its name says, whatever `layer` is, with the outline and
    drill files looked for in the folder beside it. A layer that fills
    nothing is returned empty: what to make of that is the caller's.
    """
    from laser_sweep import excellon, geom, gerber, isocli

    from . import outline as board_outline

    path = Path(path)
    temporary: tempfile.TemporaryDirectory | None = None
    try:
        if path.suffix.lower() == ".kicad_pcb":
            check_layer(layer)
            temporary = tempfile.TemporaryDirectory(prefix="spinny-board-")
            into = Path(temporary.name)
            isocli.export_board(path, layer, outline=True, drill=True, into=into)
            plotted = find_plotted(into, layer, path)
            source = "kicad"
            read_layer: str | None = layer
        else:
            plotted = path
            into = path.parent
            source = "gerber"
            read_layer = layer_of(path)
        image = gerber.read(plotted)
        try:
            outline_path: Path | None = find_layer(into, OUTLINE_LAYER)
        except LayerError:
            outline_path = None
        outline = board_outline.read(outline_path) if outline_path is not None else []
        stem = path.stem.split("-")[0]
        drill_paths, others = drill_files(into, stem) if into.is_dir() else ([], [])
        holes: list[Hole] = []
        for drill_path in drill_paths:
            for hole in excellon.read(drill_path).holes:
                end = (float(hole.end[0]), float(hole.end[1])) if hole.end else None
                found = ((float(hole.at[0]), float(hole.at[1])), float(hole.diameter), end)
                # The same hole in two of the files is drilled once.
                if found not in holes:
                    holes.append(found)
        return BoardLayer(
            name=path.stem,
            source=source,
            layer=read_layer,
            file=plotted.name,
            image=image,
            copper=geom.copper(image),
            outline=[[(float(x), float(y)) for x, y in piece] for piece in outline],
            holes=holes,
            notes=[f"{other.name} is not read: {path.stem}'s drill files start with {stem!r}" for other in others],
        )
    except (isocli.SourceError, LayerError, gerber.GerberError, OSError) as exc:
        raise ReadError(str(exc)) from exc
    finally:
        if temporary is not None:
            temporary.cleanup()


def drill_files(directory: Path, stem: str) -> tuple[list[Path], list[Path]]:
    """The board's drill files in the folder, and the others there.

    KiCad writes the plated holes and the unplated ones (mounting holes)
    to two files, <board>-PTH.drl and <board>-NPTH.drl, unless asked for
    one <board>.drl, so every file whose name starts with the board's
    stem is read; with none named so, every drill file is.
    """
    found = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == ".drl")
    named = [p for p in found if p.name.startswith(stem)]
    taken = named or found
    return taken, [p for p in found if p not in taken]


def check_layer(layer: object) -> None:
    if not isinstance(layer, str) or len(layer) > MAX_LAYER_LENGTH or not _LAYER_NAME.match(layer):
        raise LayerError(f"layer must be a KiCad layer name such as F.Cu or F.Paste, not {layer!r}")


def layer_suffix(layer: str) -> str:
    """The layer as a gerber's name carries it: F.Paste is F_Paste."""
    return layer.replace(".", "_")


def layer_of(path: Path | str) -> str | None:
    """The layer a gerber's name says it is, by the name a board file gives
    it (F.SilkS for board-F_Silkscreen.gto), or None when the name does not
    say."""
    match = _NAMED.search(Path(path).stem)
    if not match:
        return None
    named = match.group(1)
    return _OWN_NAMES.get(named, named.replace("_", "."))


def layer_table(text: str) -> dict[str, str]:
    """The layers a KiCad board file's table lists, each by its name in the
    file and the name shown for it: the board's own name for the layer when
    it gives one, else KiCad's (F.Silkscreen for F.SilkS), else the layer's.
    Empty when the text has no table."""
    start = text.find("(layers")
    if start < 0:
        return {}
    # The table is the first (layers ...) at the top of the file: its
    # entries are lists, where a pad's layers are names.
    depth = 0
    end = start
    for index in range(start, len(text)):
        char = text[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                end = index
                break
    table: dict[str, str] = {}
    for match in _TABLE_ENTRY.finditer(text, start + 1, end):
        name = match.group(1).strip('"')
        shown = match.group(2).strip('"') if match.group(2) else ""
        table[name] = shown or SHOWN_NAMES.get(name, name)
    return table


def layer_names(layer: str, table: dict[str, str] | None = None) -> list[str]:
    """Every name a plotted gerber of the layer may be named after: the
    layer's own, the name the board's table shows it by, KiCad's."""
    names = [layer]
    for other in ((table or {}).get(layer), SHOWN_NAMES.get(layer)):
        if other and other not in names:
            names.append(other)
    return names


def is_bottom(layer: str | None) -> bool:
    """Whether the layer is on the board's back, cut with the board turned
    over: B.Cu, B.Paste, B.Mask, B.SilkS."""
    return layer is not None and layer.startswith("B.")


def layer_word(layer: str | None) -> str:
    """What the layer draws, as a label says it: copper, paste, mask, silk,
    or the layer's own name; a layer not known is taken for copper."""
    if layer is None:
        return _WORDS["Cu"]
    return _WORDS.get(layer.rsplit(".", 1)[-1], layer)


def find_layer(directory: Path, layer: str, table: dict[str, str] | None = None) -> Path:
    """The gerber of the layer in a directory of plotted files, whatever its
    extension, under the layer's own name or the name it is shown by (see
    `layer_names`); a job file or a drill file is never it."""
    files = sorted(
        path
        for path in Path(directory).iterdir()
        if path.is_file() and path.suffix.lower() not in (".gbrjob", ".drl")
    )
    for name in layer_names(layer, table):
        suffix = layer_suffix(name)
        named = [path for path in files if path.stem == suffix or path.stem.endswith(f"-{suffix}")]
        if named:
            return named[0]
    for name in layer_names(layer, table):
        suffix = layer_suffix(name)
        loose = [path for path in files if suffix in path.stem]
        if loose:
            return loose[0]
    raise LayerError(f"no {layer} gerber in {directory}")


def find_plotted(directory: Path, layer: str, board_file: Path | str) -> Path:
    """The gerber kicad-cli plotted into `directory` for the layer of
    `board_file`, under whatever name the board shows the layer by. With
    none there, the board has no such layer, which the LayerError says."""
    board_file = Path(board_file)
    try:
        table = layer_table(board_file.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        table = {}
    try:
        return find_layer(directory, layer, table)
    except LayerError:
        raise LayerError(f"{board_file.name} has no layer {layer}") from None
