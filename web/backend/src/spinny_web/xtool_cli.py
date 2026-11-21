"""`spinny-xtool`: a job written for an xTool galvo, handed over, the
machine read or stopped, before the page drives one.

    spinny-xtool info                          the machine's info and state, its firmware held to the file
    spinny-xtool write JOB [-o FILE]           a job (its id, or its JSON file) as the machine's G-code file
    spinny-xtool send FILE --at-the-laser      a written file handed over; the machine's own button starts it
    spinny-xtool lines LINE... --at-the-laser  G-code lines on the G-code port, each written once the last is answered
    spinny-xtool stop                          stops whatever the machine runs

The machine file is the spinny home's machines/xtool-f1.toml unless
--machine names another; --host and the port options put the machine
elsewhere, a virtual F1 among them. `send` and `lines` reach a laser, so
each asks to be told someone is at it, and both refuse a firmware the
file has not been tried with.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from spinny_laser import home
from spinny_laser import machines as machine_files

from .jobs import Job
from .xtool import XtoolJobError, XtoolMachine, machine_of, write
from .xtool_link import XtoolError, check_firmware, transport_for

MACHINE = "xtool-f1.toml"


def _machine(path: str | None) -> XtoolMachine:
    found = Path(path) if path else home.root() / "machines" / MACHINE
    return machine_of(machine_files.load(found), str(found))


def _job(name: str) -> Job:
    """A job's JSON file, or the id of a job the page keeps."""
    path = Path(name)
    if not path.is_file():
        path = home.root() / "var" / "jobs" / f"{name}.json"
    try:
        return Job.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise XtoolJobError(f"no job {name!r}: neither a file nor one of the page's jobs ({exc.strerror})") from exc
    except ValueError as exc:
        raise XtoolJobError(f"{path} is not a job: {exc}") from exc


def _offset(text: str | None) -> tuple[float, float] | None:
    if text is None:
        return None
    try:
        x, y = (float(part) for part in text.split(","))
    except ValueError:
        raise XtoolJobError(f"--offset {text!r} must be X,Y in mm") from None
    return (x, y)


def _clock(seconds: float) -> str:
    minutes, rest = divmod(int(round(seconds)), 60)
    return f"{minutes}:{rest:02d}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spinny-xtool", description="A job written for an xTool galvo and handed over; the machine read or stopped.")
    parser.add_argument("--machine", help=f"the machine file (default: machines/{MACHINE} in the spinny home)")
    parser.add_argument("--host", help="the machine's address, for one elsewhere than the file says")
    parser.add_argument("--gcode-port", type=int, help="its G-code port, for one elsewhere")
    parser.add_argument("--http-port", type=int, help="its HTTP port, for one elsewhere")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("info", help="the machine's info and state; refuses a firmware the file has not been tried with")
    writing = commands.add_parser("write", help="a job as the machine's G-code file")
    writing.add_argument("job", help="a job's id (as the page keeps it) or its JSON file")
    writing.add_argument("-o", "--output", help="where the file goes (default: var/out/<job>-<machine>.gcode in the spinny home)")
    writing.add_argument("--source", help="the source to cut with (default: the file's first)")
    writing.add_argument("--offset", help="X,Y mm added to the job's points before they are mirrored into the field (default: the job centered)")
    sending = commands.add_parser("send", help="hand a written file over; the machine's own button starts it")
    sending.add_argument("file", help="the G-code file `write` made")
    sending.add_argument("--at-the-laser", action="store_true", help="someone is at the machine, its lid closed and its stop in reach")
    lining = commands.add_parser("lines", help="G-code lines on the G-code port, each written once the last is answered")
    lining.add_argument("line", nargs="+", help="a G-code line")
    lining.add_argument("--at-the-laser", action="store_true", help="someone is at the machine, its lid closed and its stop in reach")
    commands.add_parser("stop", help="stop whatever the machine runs")
    args = parser.parse_args(argv)

    try:
        machine = _machine(args.machine)
        if args.command == "write":
            job = _job(args.job)
            written = write(job, machine, args.source, _offset(args.offset))
            out = Path(args.output) if args.output else home.root() / "var" / "out" / f"{job.id or 'job'}-{machine.id}.gcode"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(written.text, encoding="ascii")
            x0, y0, x1, y1 = written.bounds
            print(f"{out}: {written.lines} lines, about {_clock(written.seconds)} with the {written.source} source")
            print(f"in the field: X {x0:.3f} to {x1:.3f}, Y {y0:.3f} to {y1:.3f} (offset {written.offset[0]:.3f}, {written.offset[1]:.3f})")
            return 0
        link = transport_for(machine, args.host, args.gcode_port, args.http_port)
        if args.command == "info":
            info = link.info()
            state = link.state()
            size = f"{info.size[0]:g} x {info.size[1]:g} mm" if info.size else "not said"
            print(f"{machine.name} at {link.host}: firmware {info.firmware}, type {info.machine_type}, field {size}, sources {', '.join(info.sources)}")
            print(f"state: {state.mode}{' ' + state.sub_mode if state.sub_mode else ''}, alarm {state.alarm}")
            # The machine says its field as a 32 bit float (121.97999572753906).
            if info.size and any(abs(a - b) > 0.005 for a, b in zip(machine.size, info.size)):
                print(f"the file's field is {machine.size[0]:g} x {machine.size[1]:g} mm: set [field] size to what the machine says")
            check_firmware(info, machine)
            print("firmware: tried with this file")
            return 0
        if args.command == "stop":
            print(f"stopped ({link.stop()} {link.http_port})")
            return 0
        if not args.at_the_laser:
            print(f"{args.command} reaches a laser: run it again with --at-the-laser once someone is at the machine, its lid closed and its stop in reach", file=sys.stderr)
            return 2
        check_firmware(link.info(), machine)
        if args.command == "lines":
            for line, answer in zip(args.line, link.send_lines(args.line)):
                print(f"{line} -> {answer!r}")
            return 0
        path = Path(args.file)
        text = path.read_text(encoding="ascii")
        state = link.state()
        if not state.idle:
            raise XtoolError(f"{machine.name} is not at rest ({state.mode}): stop it or let it finish first")
        sent = link.send_job(text, path.name)
        print(f"handed over {sent['bytes']} bytes at {sent['path']}; the machine answered {sent['answer']!r}")
        print("start it with the machine's own button; spinny-xtool stop stops it")
        return 0
    except (XtoolError, XtoolJobError, machine_files.MachineError, OSError, UnicodeError) as exc:
        print(f"spinny-xtool: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
