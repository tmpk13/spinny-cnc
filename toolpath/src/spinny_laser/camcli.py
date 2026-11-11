"""spinny-cam: a design through a CAM profile, gcode out.

    spinny-cam cam/mill-3axis.toml board.kicad_pcb
    spinny-cam cam/mill-3axis.toml board-F_Cu.gbr -o var/out/board.nc
    spinny-cam cam/cartesian-laser.toml sweep.gcode --name coupon
    spinny-cam cam/cartesian-laser.toml panel.dxf
    spinny-cam cam/mill-3d.toml bracket.stl

The board (a KiCad file, or a copper gerber with its Edge.Cuts and drill
files beside it), an X/Y gcode file, a DXF drawing or an STL model goes
through every enabled operation of the profile, and the program is
written with a markdown report beside it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__, cam, camjob, home, post

# The repository's var/out in a checkout, else under the spinny home.
OUT_DIR = home.root() / "var" / "out"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spinny-cam",
        description="A board, an X/Y gcode design, a DXF drawing or an STL model through a CAM profile, gcode for its controller out.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("profile", type=Path, help="a CAM profile, cam/*.toml")
    parser.add_argument("design", type=Path, help="a .kicad_pcb, a copper gerber, an X/Y .gcode/.nc file, a .dxf drawing, or an .stl model")
    parser.add_argument("-o", "--output", type=Path, help="the gcode file to write (default: var/out/<design>.nc)")
    parser.add_argument("--name", help="the job's name in the file (default: the design's)")
    parser.add_argument("--tolerance", type=float, default=0.005, help="chord tolerance of rings and arcs, mm")
    parser.add_argument("--dry-run", action="store_true", help="print the report and write nothing")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        profile = cam.load(args.profile)
        design = camjob.read_design(args.design, profile.placement, args.tolerance)
        built = camjob.build(profile, design, args.name, tolerance=args.tolerance)
        program = post.post(built, profile)
    except (cam.CamError, camjob.DesignError, post.PostError, OSError) as exc:
        print(f"spinny-cam: {exc}", file=sys.stderr)
        return 1
    lines = [f"{built.name} through {profile.name}: {len([g for g in built.groups if g.enabled and g.has_cuts])} operations"]
    lines.extend(f"  {g.label}: {len(g.moves or g.paths)} paths, {'off' if not g.enabled else g.tool}" for g in built.groups)
    lines.extend(f"  note: {note}" for note in built.notes)
    lines.extend(f"  {line}" for line in program.report.summary_lines())
    print("\n".join(lines))
    if args.dry_run:
        return 0
    output = args.output or OUT_DIR / f"{built.name}.nc"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(program.text, encoding="utf-8")
    report = output.with_suffix(".md")
    report.write_text(
        "\n".join([f"# {built.name}", "", f"Profile: {profile.name} ({args.profile})", "", *("- " + line.strip() for line in lines[1:]), ""]),
        encoding="utf-8",
    )
    print(f"wrote {output} and {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
