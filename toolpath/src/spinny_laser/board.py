"""Which layer of a board a job is read from, and the gerber that holds it.

A job is cut from one layer of a board: a copper layer to isolate or to
deposit, or the paste layer, whose openings a stencil cuts out of a film.
kicad-cli names the gerber it plots for a layer after the layer, F.Paste
as board-F_Paste, and gives it the layer's Protel extension: .gtl for the
front copper, .gtp for the front paste, .gto for the front silk, .gm1 for
the outline, .gbr for a layer without one. A layer name it does not know,
or a layer the board does not have, is skipped with exit code 0 and
nothing plotted; an enabled layer with nothing on it is plotted empty.
"""

from __future__ import annotations

import re
from pathlib import Path

DEFAULT_LAYER = "F.Cu"

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
    `board_file`, under whatever name the board shows the layer by."""
    try:
        table = layer_table(Path(board_file).read_text(encoding="utf-8", errors="replace"))
    except OSError:
        table = {}
    return find_layer(directory, layer, table)
