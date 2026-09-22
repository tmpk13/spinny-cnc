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
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

from . import __version__, gcode, machine, preview
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
    """Radial lines spread evenly around the axis, starting at angle zero."""
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
    groups = [
        gcode.PathGroup(
            label=f"{lines} radial lines from the axis to {reach:g} mm",
            paths=spokes(lines, 0.0, reach),
            power=power,
            speed=speed,
        )
    ]
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
    pattern.add_argument("--lines", type=int, default=4, help="radial lines, spread evenly")
    pattern.add_argument("--reach", type=float, default=6.0, help="how far the lines run, mm")
    pattern.add_argument(
        "--ring", type=float, default=8.0, help="reference ring radius, mm; 0 leaves it out"
    )
    pattern.add_argument("--spot", type=float, default=0.1, help="beam diameter, for the preview")
    burn = parser.add_argument_group("burn settings")
    burn.add_argument("--power", type=float, default=400.0, help="S for the pattern")
    burn.add_argument("--speed", type=float, default=200.0, help="surface speed, mm/min")
    machine.add_machine_arguments(parser)
    machine.add_output_arguments(parser, "out/center.gcode")
    return parser


def notes_for() -> list[str]:
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
    ]


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
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
    notes = notes_for()
    around = ring_speed(args.ring, args.speed, args.rotary_max_rate)
    if args.ring > 0 and around < args.speed:
        notes.append(
            f"The ring runs at {around:.0f} mm/min, not {args.speed:g}: that is"
            f" all the table can turn at {args.ring:g} mm. The lines are"
            " unaffected, being radial."
        )
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
