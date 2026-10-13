"""Which layer of a board a job is read from, and the gerber that holds it.

A job is cut from one layer of a board: a copper layer to isolate or to
deposit, or the paste layer, which with a deposit is a solder paste
stencil, the openings burnt out of a film. kicad-cli names the gerber it
plots for a layer after the layer, F.Paste as board-F_Paste, and gives it
the layer's Protel extension: .gtl for the front copper, .gtp for the front
paste, .gto for the front silk, .gm1 for the outline, .gbr for a layer
without one. A layer name it does not know, or a layer the board does not
have, is skipped with exit code 0 and nothing plotted; an enabled layer with
nothing on it is plotted empty.
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

# The layer a gerber's name ends with, the way kicad-cli names them.
_NAMED = re.compile(
    r"(?:^|-)("
    r"(?:F|B|In[0-9]+)_(?:Cu|Paste|Mask|SilkS|Adhes|Fab|CrtYd)"
    r"|(?:Dwgs|Cmts|Eco[12])_User|Edge_Cuts|User_[0-9]+|Margin"
    r")$"
)

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
    """The layer a gerber's name says it is, or None when the name does not say."""
    match = _NAMED.search(Path(path).stem)
    return match.group(1).replace("_", ".") if match else None


def layer_word(layer: str | None) -> str:
    """What the layer draws, as a label says it: copper, paste, mask, silk,
    or the layer's own name; a layer not known is taken for copper."""
    if layer is None:
        return _WORDS["Cu"]
    return _WORDS.get(layer.rsplit(".", 1)[-1], layer)


def find_layer(directory: Path, layer: str) -> Path:
    """The gerber of the layer in a directory of plotted files, whatever its
    extension; a job file or a drill file is never it."""
    suffix = layer_suffix(layer)
    files = sorted(
        path
        for path in Path(directory).iterdir()
        if path.is_file() and path.suffix.lower() not in (".gbrjob", ".drl")
    )
    named = [path for path in files if path.stem == suffix or path.stem.endswith(f"-{suffix}")]
    loose = [path for path in files if suffix in path.stem]
    found = named or loose
    if not found:
        raise LayerError(f"no {layer} gerber in {directory}")
    return found[0]
