"""spinny-iso: isolation gcode for the rotary table, from a board or a gerber.

The copper is read and the loops are cut by the Cartesian tool's engine; the
difference is where the board sits and how the moves are written. Board
coordinates are polar coordinates here, so the board is placed with the
rotation axis at its center unless told otherwise, and every loop is written
as a radius on X and an angle on the table.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from laser_sweep import excellon, geom, gerber, isolate
from laser_sweep.isocli import (
    AUTO,
    NONE,
    SourceError,
    outline_cut,
    outline_paths,
    resolve,
)
from laser_sweep.isolate import (
    ANCHOR_CENTER,
    ANCHOR_KEEP,
    MIRROR_NONE,
    MIRROR_X,
    MIRROR_Y,
    IsoConfig,
)
from laser_sweep.layout import INSIDE_OUT, OUTSIDE_IN

from . import __version__, gcode, machine, preview
from .clear import chains


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spinny-iso",
        description="Isolation gcode for a laser on X over a board on a rotary"
        " table: gerber or KiCad board in, radius and angle moves out.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("input", type=Path, help="a .kicad_pcb, or a copper layer gerber")
    parser.add_argument(
        "--layer",
        default="F.Cu",
        help="copper layer to isolate, for a board file or to pick a sibling gerber",
    )

    cut = parser.add_argument_group("isolation")
    cut.add_argument("--spot", type=float, default=0.1, help="beam diameter, mm")
    width = cut.add_mutually_exclusive_group()
    width.add_argument("--passes", type=int, default=1, help="isolation loops around every feature")
    width.add_argument("--clear", type=float, help="mm of copper to clear instead")
    cut.add_argument("--overlap", type=float, default=0.0, help="fraction of the spot adjacent loops share")
    cut.add_argument("--margin", type=float, default=0.0, help="extra mm between copper and the first loop")
    cut.add_argument("--order", choices=(INSIDE_OUT, OUTSIDE_IN), default=INSIDE_OUT)
    cut.add_argument(
        "--no-bridge-check", dest="bridge_check", action="store_false",
        help="skip the search for copper the beam cannot part",
    )

    place = parser.add_argument_group("placement")
    place.add_argument(
        "--mirror", choices=(MIRROR_NONE, MIRROR_X, MIRROR_Y), default=MIRROR_NONE,
        help="flip the layer, for cutting a bottom layer through the board",
    )
    place.add_argument(
        "--anchor", choices=(ANCHOR_CENTER, ANCHOR_KEEP), default=ANCHOR_CENTER,
        help="center puts the middle of the job on the rotation axis, keep"
        " leaves the gerber coordinates alone with the axis at their origin",
    )
    place.add_argument(
        "--offset", default="0,0", metavar="X,Y",
        help="mm to shift the placed board, to move a feature off the axis",
    )
    place.add_argument("--fit", type=float, metavar="R", help="fail unless the job stays inside this radius, mm")
    place.add_argument("--force", action="store_true", help="write the file even if --fit fails")

    burn = parser.add_argument_group("burn settings")
    burn.add_argument("--power", type=float, default=500.0, help="S for the isolation")
    burn.add_argument("--speed", type=float, default=400.0, help="surface speed for the isolation, mm/min")

    edge = parser.add_argument_group("board outline")
    edge.add_argument("--outline", default=NONE, help=f"{AUTO}, {NONE}, or a path to an Edge.Cuts gerber")
    edge.add_argument("--outline-offset", type=float, default=0.0, help="mm outside the profile to run the cut")
    edge.add_argument("--outline-passes", type=int, default=1)
    edge.add_argument("--outline-power", type=float, help="default: --power")
    edge.add_argument("--outline-speed", type=float, help="default: --speed")

    holes = parser.add_argument_group("drill marks")
    holes.add_argument("--drill", default=NONE, help=f"{AUTO}, {NONE}, or a path to a drill file")
    holes.add_argument(
        "--drill-marks", choices=(excellon.CROSS, excellon.CIRCLE, excellon.DOT),
        default=excellon.CROSS,
    )
    holes.add_argument("--drill-power", type=float, help="default: --power")
    holes.add_argument("--drill-speed", type=float, help="default: --speed")

    machine.add_machine_arguments(parser)
    machine.add_output_arguments(parser, "var/out/<board>.gcode")
    parser.add_argument(
        "--gerber-dir", type=Path,
        help="where to leave gerbers exported from a board file, default: a temporary directory",
    )
    return parser


def parse_offset(text: str) -> tuple[float, float]:
    parts = [part.strip() for part in text.split(",")]
    if len(parts) != 2:
        raise ValueError(f"--offset expects X,Y, got {text!r}")
    return float(parts[0]), float(parts[1])


def read_outline(path: Path, offset: float) -> list:
    """The board profile as drawn, or a loop `offset` mm outside it.

    A profile drawn as separate lines and arcs is plotted one stroke per
    piece, and only a closed path can be grown, so the pieces are joined
    first when there is an offset.
    """
    drawn = outline_paths(gerber.read(path))
    if offset:
        drawn = chains(drawn)
    return outline_cut(drawn, offset)


def check_burn(power_name: str, power: float, speed_name: str, speed: float, s_max: float) -> None:
    if not 0.0 <= power <= s_max:
        raise ValueError(f"{power_name} {power:g} is outside 0 to --s-max {s_max:g}")
    if not speed > 0.0:
        raise ValueError(f"{speed_name} must be > 0")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    temporary: list = []

    try:
        copper_path, outline_path, drill_path = resolve(args, temporary)
        offset = parse_offset(args.offset)
        config = IsoConfig(
            spot=args.spot,
            passes=args.passes,
            clear=args.clear,
            overlap=args.overlap,
            margin=args.margin,
            order=args.order,
            mirror=args.mirror,
            anchor=args.anchor,
            origin=offset,
        )
        isolate.offsets_for(config)
        options = machine.options_from(args)
        check_burn("--power", args.power, "--speed", args.speed, args.s_max)
        # An outline or drill setting that is not given follows the
        # isolation's; one that is given is used as it is, 0 included.
        outline_power = args.power if args.outline_power is None else args.outline_power
        outline_speed = args.speed if args.outline_speed is None else args.outline_speed
        drill_power = args.power if args.drill_power is None else args.drill_power
        drill_speed = args.speed if args.drill_speed is None else args.drill_speed
        check_burn("--outline-power", outline_power, "--outline-speed", outline_speed, args.s_max)
        check_burn("--drill-power", drill_power, "--drill-speed", drill_speed, args.s_max)
        if args.outline_passes < 1:
            raise ValueError("--outline-passes must be at least 1; --outline none leaves the outline out")

        image = gerber.read(copper_path)
        copper = geom.copper(image)
        if not copper:
            raise SourceError(f"{copper_path} draws no copper")
        outline = []
        if outline_path is not None:
            outline = read_outline(outline_path, args.outline_offset)
        drills = []
        holes = 0
        if drill_path is not None:
            found = excellon.read(drill_path)
            holes = len(found.holes)
            drills = excellon.marks(found, args.drill_marks, args.spot)
    except (SourceError, gerber.GerberError, ValueError) as exc:
        parser.error(str(exc))

    plan = isolate.build(
        copper, config, outline=outline, drills=drills,
        drill_holes=holes, check_bridges=args.bridge_check,
    )

    groups: list[gcode.PathGroup] = []
    for index in sorted({loop.index for loop in plan.loops}):
        members = [loop for loop in plan.loops if loop.index == index]
        groups.append(
            gcode.PathGroup(
                label=f"isolation loop {index + 1} at {members[0].offset:.3f} mm",
                paths=[list(loop.points) for loop in members],
                power=args.power,
                speed=args.speed,
            )
        )
    if plan.outline:
        for repeat in range(args.outline_passes):
            groups.append(
                gcode.PathGroup(
                    label=f"board outline pass {repeat + 1}",
                    paths=[list(path) for path in plan.outline],
                    power=outline_power,
                    speed=outline_speed,
                )
            )
    if plan.drills:
        groups.append(
            gcode.PathGroup(
                label=f"drill marks ({holes} holes)",
                paths=[list(path) for path in plan.drills],
                power=drill_power,
                speed=drill_speed,
            )
        )

    header = [
        f"Polar isolation for {copper_path.name}",
        f"Copper:       {plan.islands} islands",
        f"Spot size:    {config.spot:g} mm",
        f"Loops:        {len(plan.offsets)} at "
        + ", ".join(f"{value:.3f}" for value in plan.offsets) + " mm from the copper edge",
        f"Placement:    {config.anchor} on the rotation axis, offset {offset[0]:g}, {offset[1]:g} mm,"
        f" mirror {config.mirror}",
        f"Isolation:    S{args.power:g} at {args.speed:g} mm/min surface speed of {args.s_max:g}",
        *machine.header_lines(options),
        "",
    ]
    job = gcode.generate(groups, options, header)

    reach = max(
        (x * x + y * y) ** 0.5
        for group in groups for path in group.paths for x, y in path
    ) + args.spot / 2.0
    summary = [
        f"source     {args.input}" + (f" ({copper_path.name})" if copper_path != args.input else ""),
        f"copper     {plan.islands} islands",
        f"loops      {len(plan.loops)} in {len(plan.offsets)} pass(es)",
        f"radius     {reach:.2f} mm from the axis",
        *machine.summary_lines(job),
    ]

    warnings = machine.warnings_for(job)
    if plan.bridged_total:
        worst = plan.bridges[0] if plan.bridges else None
        detail = f", closest {worst.clearance:.3f} mm" if worst else ""
        warnings.append(
            f"{plan.bridged_total} group(s) of copper sit closer than the"
            f" {plan.offsets[0]:.3f} mm the first loop needs{detail}; they stay"
            " connected. Lower --spot or open the layout."
        )
    if "Bot" in image.file_function and args.mirror == MIRROR_NONE:
        warnings.append(
            f"{copper_path.name} is a bottom layer and --mirror is none, so the"
            " job comes out reversed unless the board is cut from below"
        )
    if args.fit is not None and reach > args.fit + 1e-9:
        message = f"job reaches {reach:.2f} mm from the axis, outside --fit {args.fit:g} mm"
        if not args.force:
            print("\n".join(summary), file=sys.stderr)
            parser.error(message + " (use --force to write it anyway)")
        warnings.append(message)

    written: list[Path] = []
    if not args.dry_run:
        out = args.output or Path("var", "out") / f"{copper_path.stem}.gcode"
        svg = preview.render(
            plan.copper,
            [(group.label, group.paths) for group in groups],
            outline=plan.outline,
            spot=args.spot,
            min_radius=args.min_radius,
            bridges=plan.bridges,
        )
        sim = machine.sim_document(options, groups, plan.copper, plan.outline, args.spot)
        written = machine.write_outputs(args, job, out, copper_path.name, svg, sim, warnings)

    print("\n".join(summary))
    for path in written:
        print(f"wrote      {path}")
    if args.dry_run:
        print("dry run, nothing written")
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    for holder in temporary:
        holder.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
