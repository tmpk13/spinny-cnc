"""What the backend's parts share: settings read as numbers, the picture
widths a camera route takes, the probe tip's board point, a G-code
device's port check, and the probing distances."""

from __future__ import annotations

import math

from spinny_laser.align import turn


FRAME_MIN_WIDTH, FRAME_MAX_WIDTH = 160, 4096

# How far a touch that ties the map keeps from a cut, mm, over half the
# job's spot: a probe down in a cut reads its floor as the copper's height.
TOUCH_CLEARANCE = 1.0

# How far from H 0 a probe may have found the copper, mm, for a spindle's
# run without the height map to go ahead: more than a board's relief, so
# a Z 0 set at one corner of the board passes, and a frame with the copper
# millimeters away does not.
SURFACE_TOLERANCE = 1.0


def _setting(values: dict, name: str) -> float:
    """A setting as a number: 0 where it is unset, or not a finite number."""
    value = values.get(name, 0)
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0.0


def _soft_limits(values: dict) -> tuple[float, float]:
    """The r_max and z_max settings, 0 (no limit) where unset or not a
    finite number."""
    return _setting(values, "r_max"), _setting(values, "z_max")


def _s_max(values: dict) -> float | None:
    """The S that drives the output at full duty, when the settings give
    one above 0."""
    s_max = values.get("s_max")
    return float(s_max) if isinstance(s_max, (int, float)) and s_max > 0 else None


def _check_frame_width(width: int) -> None:
    """Refuses a picture width outside what the page asks for."""
    if not (FRAME_MIN_WIDTH <= width <= FRAME_MAX_WIDTH):
        raise ValueError(f"width must be {FRAME_MIN_WIDTH} to {FRAME_MAX_WIDTH}")


def _tip_point(status, offset: tuple[float, float], cartesian: bool, table_angle: float) -> tuple[float, float]:
    """The board point under the probe tip: the head's place along the rail
    and across it plus the tip's offset in those directions, turned by the
    table's angle, which the caller gives (a dispenser's `A` is its
    plunger). On the polar machine the head sits on the rail (across 0),
    on a cartesian one at the cross slide's position."""
    return turn((status.r + offset[0], (status.z if cartesian else 0.0) + offset[1]), table_angle)
