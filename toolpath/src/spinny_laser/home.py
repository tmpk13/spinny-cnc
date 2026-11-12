"""Where the programs keep their files.

Run from a checkout of the repository, the files are where the repository
has them: the runtime files (jobs, config, height map, gcode out) in
`var/`, the machine files in `machines/` (a G-code pick and place
machine's among them) and the CAM profiles in `cam/`, all at the root.

Installed anywhere else (a release bundle, a wheel) there is no repository
around the package, so the same three live under one home directory
instead: SPINNY_HOME when it is set, else the platform's directory for a
user's data (`~/.local/share/spinny` on Linux). SPINNY_HOME wins in a
checkout too.

A directory of configuration files that does not exist yet is filled from
the copies a release ships inside the package (`seed`); one that exists is
the user's and is never written by it.
"""

from __future__ import annotations

import os
import shutil
import sys
from collections.abc import Mapping
from pathlib import Path

ENV = "SPINNY_HOME"
NAME = "spinny"
# The repository root when this file is toolpath/src/spinny_laser/home.py.
CHECKOUT = Path(__file__).resolve().parents[3]


def checkout(root: Path = CHECKOUT) -> Path | None:
    """The repository this package runs from, or None when it is installed."""
    marked = (root / "toolpath" / "src" / "spinny_laser").is_dir() and (root / "machines").is_dir()
    return root if marked else None


def user_data(environ: Mapping[str, str] = os.environ, platform: str = sys.platform) -> Path:
    """The platform's directory for this user's data, with `spinny` under it."""
    home = Path(environ.get("HOME") or Path.home())
    if platform == "win32":
        local = environ.get("LOCALAPPDATA", "")
        base = Path(local) if local else home / "AppData" / "Local"
    elif platform == "darwin":
        base = home / "Library" / "Application Support"
    else:
        # The XDG base directory spec ignores a relative XDG_DATA_HOME.
        xdg = environ.get("XDG_DATA_HOME", "")
        base = Path(xdg) if xdg and Path(xdg).is_absolute() else home / ".local" / "share"
    return base / NAME


def root(environ: Mapping[str, str] = os.environ, repo: Path | None = None) -> Path:
    """The directory var/, machines/ and cam/ are in."""
    named = environ.get(ENV, "").strip()
    if named:
        return Path(named).expanduser()
    found = checkout() if repo is None else checkout(repo)
    return found if found is not None else user_data(environ)


def seed(target: Path, shipped: Path) -> bool:
    """Fills `target` with a copy of `shipped` when `target` does not exist
    and `shipped` is a directory; says whether it did."""
    if target.exists() or not shipped.is_dir():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(shipped, target)
    return True
