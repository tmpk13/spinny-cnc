"""Markers: named positions on the board the operator saves (a corner of
the stock, where a hole goes, where the tool is changed), to go back to and
to take an operation's corners and points from. Kept in the backend's
config, so every page and browser sees the same ones."""

from __future__ import annotations

import math

from pydantic import Field

from .jobs import MAX_VALUE, Finite

MAX_MARKERS = 200
MAX_NAME = 40


class Marker(Finite):
    name: str
    # Where, board mm.
    x: float
    y: float


class MarkerList(Finite):
    markers: list[Marker] = Field(default_factory=list)


def checked(markers: list[Marker]) -> list[Marker]:
    """The markers with their names trimmed, or what is wrong with them:
    every one named, each name once, and on the board."""
    if len(markers) > MAX_MARKERS:
        raise ValueError(f"at most {MAX_MARKERS} markers")
    names: set[str] = set()
    out: list[Marker] = []
    for marker in markers:
        name = marker.name.strip()
        if not name or len(name) > MAX_NAME:
            raise ValueError(f"a marker's name is 1 to {MAX_NAME} characters")
        if name in names:
            raise ValueError(f"two markers are named {name!r}")
        if not all(math.isfinite(v) and abs(v) <= MAX_VALUE for v in (marker.x, marker.y)):
            raise ValueError(f"marker {name!r} must be within {MAX_VALUE:g} mm")
        names.add(name)
        out.append(Marker(name=name, x=marker.x, y=marker.y))
    return out


def from_config(value: object) -> list[Marker]:
    """The markers kept in the config; any that no longer read are dropped."""
    if not isinstance(value, list):
        return []
    out: list[Marker] = []
    for item in value:
        try:
            out.append(Marker.model_validate(item))
        except ValueError:
            continue
    try:
        return checked(out)
    except ValueError:
        return []
