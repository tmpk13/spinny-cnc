"""spinny-center: a pattern that shows where the rotation axis really is.

Two things can be out on this machine, and a cut cannot tell them apart
until they are drawn. The radius zero may sit short of or past the axis,
and the rail may pass to one side of it, which no radius offset can
correct: that is what the cross slide is for.

The pattern separates them. A radial cut holds the table still and runs
the head along the rail, so what it burns is the rail itself, a straight
line lying the rail's own miss distance away from the axis. Four of them a
quarter turn apart land on the four sides of a square centered on the
axis, and the square's side is twice that miss distance. A full turn with
the head still burns a ring centered on the axis exactly, whatever is out,
which is the reference everything else is measured from.

So the burn reads as:

- the ring's center is the rotation axis
- the square the four lines bound is centered there too, and its side is
  twice the cross slide error
- each line starts at radius zero, so the distance from the square's
  center to a line's inner end, along the line, is the radius zero error

Cut it in constant power mode: the dose at the start of a line matters
here, and under dynamic power the beam fades where the move begins, which
is the end being measured.

This reads the errors to within the width of a burnt line. `--fine` burns
the pattern in `fine.py` instead, which crosses marks burnt from the two
sides of the axis at a shallow angle so that what is left moves a crossing
by many times itself.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

from . import __version__, fine, gcode, machine, preview
from .polar import Point

# Angle between samples around the reference ring. At the default radius
# the chord is a tenth of a millimetre and its sagitta a thousandth of
# one, so the ring is round well inside anything measurable on the board.
RING_STEP_DEG = 1.0
# Share of the table's rate the ring is paced at, so it is not riding on
# the limit with nothing left for the ramp at either end.
RING_HEADROOM = 0.95


def spoke(angle_deg: float, inner: float, outer: float) -> list[Point]:
    """One radial line, cut from `inner` out to `outer` at a table angle."""
    theta = math.radians(angle_deg)
    direction = (math.cos(theta), math.sin(theta))
    return [
        (inner * direction[0], inner * direction[1]),
        (outer * direction[0], outer * direction[1]),
    ]


def spokes(count: int, inner: float, outer: float) -> list[list[Point]]:
    """Radial lines spread evenly around the axis, starting at angle zero.

    None at all is allowed: the ring alone measures the radius zero error,
    and it is the only part of the pattern a wrong table scale cannot
    distort, since sweeping the wrong angle still sweeps one radius.
    """
    if count == 0:
        return []
    if count < 2:
        raise ValueError("a pattern needs at least two lines to bound anything")
    return [spoke(360.0 * i / count, inner, outer) for i in range(count)]


def ring(radius: float, step_deg: float = RING_STEP_DEG) -> list[Point]:
    """A closed circle about the axis, sampled finely enough to be round."""
    if radius <= 0:
        raise ValueError("the ring needs a radius")
    steps = max(8, int(math.ceil(360.0 / step_deg)))
    points = []
    for i in range(steps + 1):
        theta = 2.0 * math.pi * i / steps
        points.append((radius * math.cos(theta), radius * math.sin(theta)))
    return points


def ring_speed(radius: float, speed: float, rotary_max_rate: float | None) -> float:
    """Surface speed the table can actually hold around a ring.

    A ring is all rotation, so the table's own rate caps it: asking for
    more only turns slower, and in constant power mode that is a heavier
    burn than asked for, on the one feature whose width is being measured.
    """
    if not rotary_max_rate or radius <= 0:
        return speed
    return min(speed, RING_HEADROOM * math.radians(rotary_max_rate) * radius)


def build(
    lines: int,
    reach: float,
    ring_radius: float,
    power: float,
    speed: float,
    rotary_max_rate: float | None = None,
) -> list[gcode.PathGroup]:
    groups = []
    drawn = spokes(lines, 0.0, reach)
    if drawn:
        groups.append(
            gcode.PathGroup(
                label=f"{lines} radial lines from the axis to {reach:g} mm",
                paths=drawn,
                power=power,
                speed=speed,
            )
        )
    if ring_radius > 0:
        around = ring_speed(ring_radius, speed, rotary_max_rate)
        groups.append(
            gcode.PathGroup(
                label=f"reference ring at {ring_radius:g} mm",
                paths=[ring(ring_radius)],
                power=power,
                speed=around,
            )
        )
    return groups


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spinny-center",
        description="A burn that shows where the rotation axis really is:"
        " radial lines that bound a square around it and a ring centered on it.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=__version__)
    pattern = parser.add_argument_group("pattern")
    pattern.add_argument(
        "--lines", type=int, default=4,
        help="radial lines, spread evenly; 0 burns the ring alone, which is"
        " the reading a wrong table scale cannot distort",
    )
    pattern.add_argument(
        "--reach", type=float, default=None,
        help="how far the lines run, mm (default 6, or 7 with --fine)",
    )
    pattern.add_argument(
        "--ring", type=float, default=None,
        help="reference ring radius, mm; 0 leaves it out (default 8, or none with --fine)",
    )
    pattern.add_argument("--spot", type=float, default=0.1, help="beam diameter, for the preview")
    fine_pattern = parser.add_argument_group(
        "fine pattern",
        "with --fine: marks burnt from both sides of the axis cross at a shallow"
        " angle, so what is left moves a crossing by 2 / tan(angle) times itself;"
        " written as a job for the web interface, since the head runs past the axis",
    )
    fine_pattern.add_argument("--fine", action="store_true", help="burn the fine pattern")
    fine_pattern.add_argument(
        "--angle", type=float, default=fine.Design.angle, help="crossing angle, degrees"
    )
    fine_pattern.add_argument(
        "--cross", type=float, default=fine.Design.cross,
        help="where the arms cross the rail line, mm either side of the axis",
    )
    fine_pattern.add_argument(
        "--arm", type=float, default=fine.Design.arm, help="half the length of an arm, mm"
    )
    fine_pattern.add_argument(
        "--spiral", type=float, default=fine.Design.spiral,
        help="mean radius of the spirals, mm; 0 leaves them out",
    )
    fine_pattern.add_argument(
        "--show-error", metavar="E,Z",
        help="draw the preview as a machine burns it with the radius zero E mm out"
        " along the rail and the rail Z mm off the axis, and print what it would read",
    )
    burn = parser.add_argument_group("burn settings")
    burn.add_argument("--power", type=float, default=400.0, help="S for the pattern")
    burn.add_argument("--speed", type=float, default=200.0, help="surface speed, mm/min")
    machine.add_machine_arguments(parser)
    machine.add_output_arguments(parser, "out/center.gcode, or out/center-fine.json with --fine")
    return parser


def notes_for(lines: int) -> list[str]:
    ring_only = [
        "The ring alone measures the radius zero error: half its diameter"
        " less the radius it was cut at is how far past the axis the head"
        " sits at radius zero, wider meaning short of it and narrower"
        " meaning past it. Sweeping the wrong angle still sweeps one"
        " radius, so this is the reading a table scale that is out cannot"
        " distort.",
    ]
    if lines == 0:
        return ring_only
    return [
        "Cut this in constant power mode (`mode const`): the inner end of"
        " each line is what gets measured, and dynamic power fades where a"
        " move begins.",
        "The ring's center is the rotation axis. The square the lines bound"
        " is centered on it, and its side is twice the distance the rail"
        " misses the axis by: halve it and take it out on the cross slide.",
        "Each line starts at radius zero, so once the square has closed to a"
        " point, the gap left between opposing lines is twice the radius"
        " zero error. Move the head half the gap and set the radius zero"
        " there.",
        "The line ends carry the same error, and are on the coupon even when"
        " the ring is not. They lie on a circle of their own at the reach"
        " plus the radius zero error, so the longest distance across the"
        " pattern from one end to another is twice that: longer than twice"
        " the reach means the head at radius zero sits outside the axis,"
        " shorter means short of it.",
        "The ring measures that error with its sign, which the lines cannot:"
        " it is burnt at a known radius, so half its diameter less that"
        " radius is how far past the axis the head sits at radius zero."
        " Larger than asked for means the head is short of the axis there,"
        " smaller means it is past it.",
    ]


def all_notes(
    lines: int, ring_radius: float, speed: float, rotary_max_rate: float | None
) -> list[str]:
    """How to read the pattern, and what about this one differs from what was asked."""
    notes = notes_for(lines)
    if ring_radius > 0:
        notes.append(
            f"The ring lands at the radius zero error away from {ring_radius:g} mm,"
            f" so give it a coupon comfortably wider than {2 * ring_radius:g} mm"
            " or it will run off the edge before it has been measured."
        )
    around = ring_speed(ring_radius, speed, rotary_max_rate)
    if ring_radius > 0 and around < speed:
        notes.append(
            f"The ring runs at {around:.0f} mm/min, not {speed:g}: that is"
            f" all the table can turn at {ring_radius:g} mm. The lines are"
            " unaffected, being radial."
        )
    return notes


# The arguments the fine pattern reads; the rest belong to the coarse
# pattern and its gcode output.
FINE_ARGS = frozenset(
    {
        "fine", "reach", "angle", "cross", "arm", "spiral", "ring", "power", "s_max", "speed",
        "show_error", "output", "spot", "dry_run", "want_map", "map_path", "want_preview",
        "preview_path", "min_radius", "rotary_max_rate", "tolerance",
    }
)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.reach is None:
        args.reach = fine.Design.reach if args.fine else 6.0
    if args.ring is None:
        args.ring = 0.0 if args.fine else 8.0
    if args.fine:
        # The fine pattern has its own geometry and writes joint-space
        # lines; a flag for the coarse pattern or the gcode dialect would
        # be taken and silently ignored.
        for name in sorted(vars(args)):
            if name not in FINE_ARGS and getattr(args, name) != parser.get_default(name):
                parser.error(f"--{name.replace('_', '-')} does not apply with --fine")
        return fine.run(args, parser)
    try:
        if args.lines == 0 and args.ring <= 0:
            raise ValueError("--lines 0 needs a --ring to measure")
        if args.reach <= 0:
            raise ValueError("--reach must be > 0")
        if args.power > args.s_max:
            raise ValueError(f"power {args.power:g} is over --s-max {args.s_max:g}")
        if args.speed <= 0:
            raise ValueError("--speed must be > 0")
        options = machine.options_from(args)
        groups = build(
            args.lines, args.reach, args.ring, args.power, args.speed, args.rotary_max_rate
        )
    except ValueError as exc:
        parser.error(str(exc))

    header = [
        "Centering pattern for the rotation axis",
        f"Lines:        {args.lines} radial, out to {args.reach:g} mm",
        f"Ring:         {f'{args.ring:g} mm' if args.ring > 0 else 'none'}",
        f"Burn:         S{args.power:g} at {args.speed:g} mm/min surface speed",
        *machine.header_lines(options),
        "",
    ]
    job = gcode.generate(groups, options, header)
    notes = all_notes(args.lines, args.ring, args.speed, args.rotary_max_rate)
    summary = [
        f"pattern    {args.lines} lines to {args.reach:g} mm"
        + (f", ring at {args.ring:g} mm" if args.ring > 0 else ""),
        *machine.summary_lines(job),
    ]

    written: list[Path] = []
    if not args.dry_run:
        out = args.output or Path("out") / "center.gcode"
        svg = preview.render(
            [],
            [(group.label, group.paths) for group in groups],
            spot=args.spot,
            min_radius=args.min_radius,
        )
        sim = machine.sim_document(options, groups, [], [], args.spot)
        written = machine.write_outputs(args, job, out, "centering pattern", svg, sim, notes)

    print("\n".join(summary))
    for path in written:
        print(f"wrote      {path}")
    if args.dry_run:
        print("dry run, nothing written")
    for note in notes:
        print(f"note: {note}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
