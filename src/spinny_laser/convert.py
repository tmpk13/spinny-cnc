"""spinny-polar: rewrite an X/Y laser job for the rotary table.

Absolute millimetre `G0`/`G1` moves are read into paths with the `S` and `F`
they ran at, and written back out as radius and angle moves through the same
emitter the isolation command uses. Arcs, inches, relative moves, coordinate
offsets and feeds other than mm/min are refused; export arcs as line
segments.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

from laser_sweep.postprocess import REFUSED_G, Line, parse_line

from . import __version__, gcode, machine, preview
from .polar import Point

CENTER, KEEP = "center", "keep"


class ConvertError(ValueError):
    """The file contains something the conversion cannot follow."""


@dataclass
class Path2D:
    points: list[Point]
    power: float
    speed: float


def read_paths(text: str) -> list[Path2D]:
    """Cut paths in the file: runs of G1 moves at non zero power."""
    lines = [parse_line(raw) for raw in text.splitlines()]
    paths: list[Path2D] = []
    position: Point | None = None
    modal: str | None = None
    power = 0.0
    speed: float | None = None
    spindle_on = False
    current: Path2D | None = None

    def close() -> None:
        nonlocal current
        if current is not None and len(current.points) > 1:
            paths.append(current)
        current = None

    for index, line in enumerate(lines):
        _refuse(line, index)
        m_code = line.value("M")
        # A feed or a motion word counts whichever line it shares: `M4 S500
        # F900` on its own line sets the feed of the cuts that follow.
        if line.has("F"):
            speed = line.value("F")
        if line.motion is not None:
            modal = line.motion
        # S is modal whatever line it shares: `M5 S0` leaves the next bare
        # `M3` dark.
        if line.has("S"):
            power = line.value("S") or 0.0
            if power == 0.0:
                close()
        if m_code is not None:
            code = int(m_code)
            if code in (3, 4):
                spindle_on = True
            elif code == 5:
                spindle_on = False
            if code in (3, 4, 5) and not line.xy:
                if power == 0.0 or not spindle_on:
                    close()
                continue
        if not line.xy:
            continue
        if modal is None:
            raise ConvertError(f"line {index + 1}: axis words before any G0 or G1")
        if position is None and not (line.has("X") and line.has("Y")):
            raise ConvertError(f"line {index + 1}: the first move must give both X and Y")
        here = position if position is not None else (0.0, 0.0)
        x = line.value("X")
        y = line.value("Y")
        target = (x if x is not None else here[0], y if y is not None else here[1])
        if modal == "G1" and spindle_on and power > 0.0:
            if position is None:
                raise ConvertError(f"line {index + 1}: a cut before any rapid")
            if speed is None or speed <= 1.0:
                raise ConvertError(f"line {index + 1}: a cut with no usable feed rate")
            if current is None or current.power != power or current.speed != speed:
                close()
                current = Path2D([position], power, speed)
            current.points.append(target)
        else:
            close()
        position = target
    close()
    return paths


# Feed modes that change what F means; the reader takes F as mm/min.
REFUSED_FEED = {
    93: "inverse time feed, export in G94 mm/min",
    95: "feed per revolution, export in G94 mm/min",
}


def _refuse(line: Line, index: int) -> None:
    for letter, value, _ in line.words:
        if letter != "G":
            continue
        code = int(value)
        reason = REFUSED_G.get(code) or REFUSED_FEED.get(code)
        if reason is not None:
            raise ConvertError(f"line {index + 1}: G{code} is {reason}")


def group_paths(paths: list[Path2D]) -> list[gcode.PathGroup]:
    """Consecutive paths at one power and feed become one group."""
    groups: list[gcode.PathGroup] = []
    for path in paths:
        if groups and groups[-1].power == path.power and groups[-1].speed == path.speed:
            groups[-1].paths.append(path.points)
        else:
            groups.append(
                gcode.PathGroup(
                    label=f"S{path.power:g} F{path.speed:g}",
                    paths=[path.points],
                    power=path.power,
                    speed=path.speed,
                )
            )
    return groups


def place(paths: list[Path2D], anchor: str, offset: Point) -> None:
    dx, dy = offset
    if anchor == CENTER:
        xs = [x for path in paths for x, _ in path.points]
        ys = [y for path in paths for _, y in path.points]
        dx -= (min(xs) + max(xs)) / 2.0
        dy -= (min(ys) + max(ys)) / 2.0
    for path in paths:
        path.points = [(x + dx, y + dy) for x, y in path.points]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spinny-polar",
        description="Rewrite an X/Y laser job as radius and angle moves for the rotary table.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("input", type=Path, help="gcode with absolute mm G0/G1 moves")
    place_group = parser.add_argument_group("placement")
    place_group.add_argument(
        "--anchor", choices=(CENTER, KEEP), default=CENTER,
        help="center puts the middle of the cut extent on the rotation axis,"
        " keep treats the file's origin as the axis",
    )
    place_group.add_argument("--offset", default="0,0", metavar="X,Y", help="mm to shift the job")
    place_group.add_argument("--spot", type=float, default=0.1, help="beam diameter, for the preview")
    machine.add_machine_arguments(parser)
    machine.add_output_arguments(parser, "<input>.polar.gcode")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if not args.input.exists():
            raise ConvertError(f"{args.input} does not exist")
        options = machine.options_from(args)
        parts = [part.strip() for part in args.offset.split(",")]
        if len(parts) != 2:
            raise ValueError(f"--offset expects X,Y, got {args.offset!r}")
        offset = (float(parts[0]), float(parts[1]))
        paths = read_paths(args.input.read_text())
        if not paths:
            raise ConvertError(f"{args.input} has no cuts")
        place(paths, args.anchor, offset)
    except (ConvertError, ValueError) as exc:
        parser.error(str(exc))

    groups = group_paths(paths)
    header = [
        f"Polar rewrite of {args.input.name}",
        f"Paths:        {len(paths)} in {len(groups)} group(s)",
        f"Placement:    {args.anchor} on the rotation axis, offset {offset[0]:g}, {offset[1]:g} mm",
        *machine.header_lines(options),
        "",
    ]
    job = gcode.generate(groups, options, header)
    summary = [f"source     {args.input}", f"groups     {len(groups)}", *machine.summary_lines(job)]
    warnings = machine.warnings_for(job)

    written: list[Path] = []
    if not args.dry_run:
        out = args.output or args.input.with_suffix(".polar.gcode")
        svg = preview.render(
            [], [(group.label, group.paths) for group in groups],
            spot=args.spot, min_radius=args.min_radius,
        )
        sim = machine.sim_document(options, groups, [], [], args.spot)
        written = machine.write_outputs(args, job, out, args.input.name, svg, sim, warnings)

    print("\n".join(summary))
    for path in written:
        print(f"wrote      {path}")
    if args.dry_run:
        print("dry run, nothing written")
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
