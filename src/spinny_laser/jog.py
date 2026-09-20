"""spinny-jog: MDI lines for setting the machine up in grblHAL polar mode.

Jog buttons send board X/Y, and the controller turns those into a radius and
an angle, so a jog never moves one motor on its own: crossing the center
sends the radius motor back out with a half turn of the table. These
commands print the rapid moves that do move one thing at a time, worked out
from the board position the DRO shows.

Rapids are not segmented by the controller, so a rapid between two points
at the same radius is a pure rotation. Turns are split into steps of at
most a quarter turn: the controller unwraps every angle to the nearest
representative, and a step under half a turn can only go the intended way.
"""

from __future__ import annotations

import argparse
import math

from laser_sweep.backlash import format_coord

from . import __version__, polar
from .polar import Point

MAX_STEP = 90.0


class JogError(ValueError):
    """The requested move cannot be expressed as board moves."""


def parse_point(text: str) -> Point:
    parts = [part.strip() for part in text.split(",")]
    if len(parts) != 2:
        raise JogError(f"expected X,Y, got {text!r}")
    try:
        return (float(parts[0]), float(parts[1]))
    except ValueError as exc:
        raise JogError(f"{text!r} is not a pair of numbers") from exc


def angle_at(point: Point, fallback: float = 0.0) -> float:
    """Board angle of a point; on the axis there is none, so `fallback`."""
    if polar.radius_of(point) < polar.AXIS_EPSILON:
        return fallback
    return math.degrees(math.atan2(point[1], point[0]))


def radial(start: Point, radius: float, angle: float | None = None) -> list[Point]:
    """One move along the rail to `radius`, keeping the direction."""
    if radius < 0:
        raise JogError("a radius cannot be negative; turn the table instead")
    theta = angle_at(start, 0.0 if angle is None else angle)
    if angle is not None:
        theta = angle
    return [polar.cartesian((radius, theta))]


def turn(start: Point, degrees: float, step: float = MAX_STEP) -> list[Point]:
    """Points at the start's radius that turn the table by `degrees` in steps.

    Positive degrees increase the board angle under the beam, which is the
    table turning clockwise seen from above.
    """
    radius = polar.radius_of(start)
    if radius < polar.AXIS_EPSILON:
        raise JogError("the head is over the axis, where a turn moves nothing;"
                       " move out to a radius first")
    if not 0 < step <= 180.0:
        raise JogError("step must be between 0 and 180 degrees")
    if degrees == 0:
        return []
    count = max(1, math.ceil(abs(degrees) / step - 1e-9))
    piece = degrees / count
    theta = angle_at(start)
    return [polar.cartesian((radius, theta + piece * (i + 1))) for i in range(count)]


def describe(start: Point, target: Point, previous_angle: float) -> tuple[str, float]:
    """What the motors do for one rapid, and the angle the table ends at."""
    r0 = polar.radius_of(start)
    r1, a1 = polar.joint_of(target, previous_angle)
    delta = a1 - previous_angle
    note = f"radius {r0:.3f} -> {r1:.3f} mm, table {delta:+.1f} deg to {a1:.1f}"
    if abs(abs(delta) - 180.0) < 1e-6:
        note += " (a half turn: the table may go either way)"
    return note, a1


def lines(start: Point, targets: list[Point], decimals: int) -> list[str]:
    out: list[str] = []
    angle = angle_at(start)
    here = start
    for target in targets:
        note, angle = describe(here, target, angle)
        out.append(f"; {note}")
        out.append(
            f"G0 X{format_coord(target[0], decimals)} Y{format_coord(target[1], decimals)}"
        )
        here = target
    return out


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spinny-jog",
        description="Print MDI rapids that move the head radially or turn the table"
        " on a grblHAL polar machine, from the board position the DRO shows.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument(
        "--from", dest="start", default="0,0", metavar="X,Y",
        help="board position now, as the DRO shows it",
    )
    parser.add_argument("--decimals", type=int, default=3)
    commands = parser.add_subparsers(dest="command", required=True)

    r = commands.add_parser("radius", help="head to a radius along the current direction")
    r.add_argument("radius", type=float, help="mm from the axis")
    r.add_argument(
        "--angle", type=float,
        help="board angle to run out along instead, needed when starting on the axis",
    )

    t = commands.add_parser("turn", help="turn the table, head standing still")
    t.add_argument(
        "degrees", type=float,
        help="positive turns the table clockwise seen from above (board angle up)",
    )
    t.add_argument("--step", type=float, default=MAX_STEP, help="largest single move, deg")

    commands.add_parser("center", help="head back over the axis")

    to = commands.add_parser("to", help="any board point, with what the motors will do")
    to.add_argument("point", metavar="X,Y")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        start = parse_point(args.start)
        if args.command == "radius":
            if polar.radius_of(start) < polar.AXIS_EPSILON and args.angle is None:
                raise JogError("starting on the axis: give --angle to say which way to run out")
            targets = radial(start, args.radius, args.angle)
        elif args.command == "turn":
            targets = turn(start, args.degrees, args.step)
        elif args.command == "center":
            targets = [(0.0, 0.0)]
        else:
            targets = [parse_point(args.point)]
    except JogError as exc:
        parser.error(str(exc))

    for line in lines(start, targets, args.decimals):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
