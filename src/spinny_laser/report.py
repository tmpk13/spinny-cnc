"""Markdown map of a polar job: what it burns, how the table moves, how long it takes."""

from __future__ import annotations

import math

from .gcode import INVERSE, Job


def render(job: Job, gcode_name: str, source: str, notes: list[str] | None = None) -> str:
    options = job.options
    assert options is not None
    lines = [
        f"# {gcode_name}",
        "",
        f"Source: `{source}`",
        "",
        "## Machine",
        "",
        "| Setting | Value |",
        "| --- | --- |",
        f"| Radius axis | X, {options.axis_x:g} at the rotation axis |",
        f"| Rotary axis | {options.rotary_axis}, degrees,"
        f" {'inverted' if options.invert_rotary else 'positive with the board angle'} |",
        f"| Feed mode | {'G93 inverse time' if options.feed_mode == INVERSE else 'G94, F scaled per segment'} |",
        f"| Chord tolerance | {options.tolerance:g} mm |",
        f"| Laser | {options.laser_mode}, S max {options.s_max:g} |",
    ]
    if options.rotary_max_rate:
        lines.append(f"| Rotary max rate | {options.rotary_max_rate:g} deg/min |")
    if options.x_max_rate:
        lines.append(f"| X max rate | {options.x_max_rate:g} mm/min |")

    lines += [
        "",
        "## Job",
        "",
        "| Quantity | Value |",
        "| --- | --- |",
        f"| Paths | {job.path_count} |",
        f"| Segments | {job.segment_count} |",
        f"| Cut length | {job.cut_length:.1f} mm |",
        f"| Table rotation | {job.total_rotation:.0f} deg, {job.total_rotation / 360.0:.1f} turns |",
        f"| Final angle | {job.final_angle:.1f} deg |",
        f"| Closest to axis | {_mm(job.min_radius)} |",
        f"| Paths inside {options.min_radius:g} mm | {job.near_axis_paths} |",
        f"| Peak rotary rate wanted | {job.peak_rotary_rate:.0f} deg/min |",
        f"| Peak X rate wanted | {job.peak_x_rate:.0f} mm/min |",
    ]
    if options.rotary_max_rate or options.x_max_rate:
        share = job.limited_length / job.cut_length * 100.0 if job.cut_length else 0.0
        slowest = f"{job.slowest_speed:.0f} mm/min" if job.slowest_speed else "none"
        lines += [
            f"| Cut held below F by an axis limit | {job.limited_length:.1f} mm ({share:.0f}%) |",
            f"| Slowest surface speed | {slowest} |",
        ]
    lines += [
        f"| Cut time | {_clock(job.cut_seconds)} |",
        f"| Travel time | {_clock(job.travel_seconds)} |",
        f"| Total | {_clock(job.seconds)} |",
    ]

    if job.records:
        lines += [
            "",
            "## Groups",
            "",
            "| Group | Paths | Segments | S | F | Length | Time |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
        for record in job.records:
            lines.append(
                f"| {record['label']} | {record['paths']} | {record['segments']}"
                f" | {record['power']:g} | {record['speed']:g}"
                f" | {record['length']:.1f} mm | {_clock(record['seconds'])} |"
            )
        lines += ["", *_timeline(job)]

    if notes:
        lines += ["", "## Notes", ""]
        lines += [f"- {note}" for note in notes]
    return "\n".join(lines) + "\n"


def _timeline(job: Job) -> list[str]:
    # Durations are rounded to whole seconds before the starts accumulate, so
    # the printed bars meet instead of leaving phantom gaps.
    lines = [
        "```mermaid",
        "gantt",
        "    title Job timeline (seconds)",
        "    dateFormat X",
        "    axisFormat %M:%S",
        "    section Cuts",
    ]
    start = 0
    per_group_travel = job.travel_seconds / max(1, len(job.records))
    for record in job.records:
        travel = int(round(per_group_travel))
        cut = max(1, int(round(record["seconds"])))
        label = record["label"].replace(":", " ")
        lines.append(f"    {label} :{start + travel}, {cut}s")
        start += travel + cut
    lines.append("```")
    return lines


def _clock(seconds: float) -> str:
    seconds = int(round(seconds))
    return f"{seconds // 60:d}:{seconds % 60:02d}"


def _mm(value: float | None) -> str:
    if value is None or math.isinf(value):
        return "n/a"
    return f"{value:.3f} mm"
