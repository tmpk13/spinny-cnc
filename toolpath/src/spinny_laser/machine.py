"""Machine description shared by the commands: axis letters, limits, the output set."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import gcode, machines, report
from .gcode import GRBLHAL, INVERSE, JOINT, SCALED, Job, PolarOptions


def add_machine_arguments(parser: argparse.ArgumentParser) -> None:
    machine = parser.add_argument_group("machine")
    machine.add_argument(
        "--machine",
        type=Path,
        metavar="FILE",
        help="a machine file, as in machines/: its axis rates, power scale and chord tolerance"
        " stand in for the defaults of the options below, which still win when given",
    )
    machine.add_argument(
        "--controller",
        choices=(GRBLHAL, JOINT),
        default=GRBLHAL,
        help="grblhal writes board X/Y for grblHAL polar kinematics to transform;"
        " joint writes the radius on X and the angle on --rotary-axis itself",
    )
    joint = parser.add_argument_group("joint controller", "only with --controller joint")
    joint.add_argument(
        "--rotary-axis", default="A", help="gcode letter of the table axis, in degrees"
    )
    joint.add_argument(
        "--invert-rotary",
        action="store_true",
        help="negate the angle word, for a table that turns the other way",
    )
    joint.add_argument(
        "--axis-x",
        type=float,
        default=0.0,
        help="machine X reading with the beam over the rotation axis",
    )
    joint.add_argument(
        "--feed-mode",
        choices=(INVERSE, SCALED),
        default=INVERSE,
        help="inverse emits G93 with F per segment; scaled stays in G94 and"
        " scales F by joint length over board length",
    )
    joint.add_argument(
        "--rotary-scale",
        type=float,
        default=1.0,
        help="controller units per degree, only for --feed-mode scaled",
    )
    machine.add_argument(
        "--tolerance",
        type=float,
        default=0.005,
        help="mm the joint-space path may stray from the straight line",
    )
    # The limits default to what the simulator assumes, so the estimate
    # and the playback agree unless the machine is described otherwise.
    machine.add_argument(
        "--rotary-max-rate",
        type=float,
        default=3600.0,
        help="deg/min the table can do; segments that need more are reported"
        " and the estimate slows down for them (default 3600)",
    )
    machine.add_argument(
        "--x-max-rate", type=float, default=3000.0, help="mm/min the X axis can do (default 3000)"
    )
    machine.add_argument(
        "--rotary-rapid", type=float, default=3600.0, help="deg/min for G0 in the estimate"
    )
    machine.add_argument(
        "--rapid-rate", type=float, default=3000.0, help="X mm/min for G0 in the estimate"
    )
    machine.add_argument(
        "--min-radius",
        type=float,
        default=0.5,
        help="mm: paths that come closer to the axis than this are counted as"
        " a warning, since the table has to spin hardest there",
    )
    machine.add_argument("--s-max", type=float, default=1000.0, help="max S value")
    machine.add_argument(
        "--laser-mode",
        choices=(gcode.M4_DYNAMIC, gcode.M3_CONSTANT),
        default=gcode.M4_DYNAMIC,
        help="M4 scales power with speed, M3 holds it constant",
    )
    machine.add_argument("--decimals", type=int, default=3, help="X decimals")
    machine.add_argument("--angle-decimals", type=int, default=4)
    machine.add_argument("--no-return-home", dest="return_home", action="store_false")
    machine.add_argument("--preamble", action="append", default=[])
    machine.add_argument("--postamble", action="append", default=[])


def parse_args(parser: argparse.ArgumentParser, argv: list[str] | None) -> argparse.Namespace:
    """Parses the command line with the machine file's values, when one is
    named, as the defaults: a flag given beats the file, the file beats
    the built-in defaults."""
    args = parser.parse_args(argv)
    if getattr(args, "machine", None) is not None:
        try:
            parser.set_defaults(**machines.cli_defaults(machines.load(args.machine)))
        except machines.MachineError as exc:
            parser.error(str(exc))
        args = parser.parse_args(argv)
    return args


def add_output_arguments(parser: argparse.ArgumentParser, default: str) -> None:
    output = parser.add_argument_group("output")
    output.add_argument("-o", "--output", type=Path, help=f"default: {default}")
    output.add_argument("--map", dest="map_path", type=Path, help="markdown map")
    output.add_argument("--preview", dest="preview_path", type=Path, help="SVG preview")
    output.add_argument("--no-map", dest="want_map", action="store_false")
    output.add_argument("--no-preview", dest="want_preview", action="store_false")
    output.add_argument(
        "--no-sim", dest="want_sim", action="store_false",
        help="skip the .sim.json the simulator draws the board from",
    )
    output.add_argument(
        "-n", "--dry-run", action="store_true", help="report but write nothing"
    )


def options_from(args) -> PolarOptions:
    return PolarOptions(
        controller=args.controller,
        rotary_axis=args.rotary_axis.upper(),
        invert_rotary=args.invert_rotary,
        axis_x=args.axis_x,
        feed_mode=args.feed_mode,
        rotary_scale=args.rotary_scale,
        tolerance=args.tolerance,
        s_max=args.s_max,
        laser_mode=args.laser_mode,
        decimals=args.decimals,
        angle_decimals=args.angle_decimals,
        x_rapid=args.rapid_rate,
        rotary_rapid=args.rotary_rapid,
        x_max_rate=args.x_max_rate,
        rotary_max_rate=args.rotary_max_rate,
        min_radius=args.min_radius,
        return_home=args.return_home,
        preamble=tuple(args.preamble),
        postamble=tuple(args.postamble),
    )


def header_lines(options: PolarOptions) -> list[str]:
    if options.cartesian:
        lines = [
            "Controller:   grblHAL polar kinematics, board X/Y with the rotation"
            " axis at machine X 0",
            "Feed:         G94, F is the surface speed; the controller scales it"
            f" per {gcode.GRBLHAL_SEGMENT:g} mm piece",
            f"Tolerance:    {options.tolerance:g} mm chord error, segments pre-split"
            " so the controller's pieces hold it",
        ]
    else:
        lines = [
            f"Axes:         X is the radius ({options.axis_x:g} over the axis),"
            f" {options.rotary_axis} is the table angle in degrees"
            + (", inverted" if options.invert_rotary else ""),
            f"Feed:         {'G93 inverse time, F per segment' if options.feed_mode == INVERSE else 'G94, F scaled per segment'}",
            f"Tolerance:    {options.tolerance:g} mm chord error",
        ]
    if options.rotary_max_rate:
        lines.append(f"Rotary limit: {options.rotary_max_rate:g} deg/min")
    return lines


def summary_lines(job: Job) -> list[str]:
    options = job.options
    assert options is not None
    lines = [
        f"paths      {job.path_count} in {job.segment_count} segments",
        f"cut        {job.cut_length:.1f} mm",
        f"rotation   {job.total_rotation:.0f} deg total, ends at {job.final_angle:.1f}",
        f"axis       closest {job.min_radius:.3f} mm" if job.min_radius is not None else "axis       no cuts",
        f"rotary     peak {job.peak_rotary_rate:.0f} deg/min wanted",
    ]
    if options.rotary_max_rate or options.x_max_rate:
        share = job.limited_length / job.cut_length * 100.0 if job.cut_length else 0.0
        lines.append(
            f"limited    {job.limited_length:.1f} mm ({share:.0f}%) held below F"
            + (f", slowest {job.slowest_speed:.0f} mm/min" if job.slowest_speed else "")
        )
    lines.append(f"estimate   {job.seconds / 60.0:.1f} min")
    return lines


def warnings_for(job: Job) -> list[str]:
    options = job.options
    assert options is not None
    warnings = []
    if job.near_axis_paths:
        warnings.append(
            f"{job.near_axis_paths} path(s) pass within {options.min_radius:g} mm of the"
            " rotation axis, where the table has to spin fastest; under M4 the"
            " power follows the slowdown, but consider shifting the board with --offset"
        )
    return warnings


def sim_document(
    options: PolarOptions,
    groups: list[gcode.PathGroup],
    copper: list,
    outline: list,
    spot: float,
) -> dict:
    """What the simulator needs to draw the board under the beam."""
    reach = 1.0
    for contour in copper:
        reach = max(reach, max((x * x + y * y) ** 0.5 for x, y in contour))
    for path in outline:
        reach = max(reach, max((x * x + y * y) ** 0.5 for x, y in path))
    for group in groups:
        for path in group.paths:
            reach = max(reach, max((x * x + y * y) ** 0.5 for x, y in path))
    return {
        "controller": options.controller,
        "rotary_axis": options.rotary_axis,
        "invert_rotary": options.invert_rotary,
        "axis_x": options.axis_x,
        "s_max": options.s_max,
        # The simulator takes a rate of 0 as no limit, like the estimate; a
        # missing one would leave it at its own default instead.
        "x_rapid": options.x_rapid or 0.0,
        "rotary_rapid": options.rotary_rapid or 0.0,
        "x_max_rate": options.x_max_rate or 0.0,
        "rotary_max_rate": options.rotary_max_rate or 0.0,
        "rotary_scale": options.rotary_scale,
        "spot": spot,
        "radius": round(reach, 3),
        "copper": [[[round(x, 4), round(y, 4)] for x, y in contour] for contour in copper],
        "outline": [[[round(x, 4), round(y, 4)] for x, y in path] for path in outline],
    }


def write_outputs(
    args,
    job: Job,
    out: Path,
    source_name: str,
    preview_text: str,
    sim: dict | None,
    notes: list[str] | None = None,
) -> list[Path]:
    written: list[Path] = []
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(job.text, encoding="ascii")
    written.append(out)
    if args.want_map:
        map_path = args.map_path or out.with_suffix(out.suffix + ".map.md")
        map_path.parent.mkdir(parents=True, exist_ok=True)
        map_path.write_text(report.render(job, out.name, source_name, notes), encoding="ascii")
        written.append(map_path)
    if args.want_preview:
        preview_path = args.preview_path or out.with_suffix(out.suffix + ".preview.svg")
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview_path.write_text(preview_text, encoding="ascii")
        written.append(preview_path)
    if args.want_sim and sim is not None:
        sim_path = out.with_suffix(out.suffix + ".sim.json")
        sim_path.write_text(json.dumps(sim, separators=(",", ":")), encoding="ascii")
        written.append(sim_path)
    return written
