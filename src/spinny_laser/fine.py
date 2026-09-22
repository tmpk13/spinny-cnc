"""The fine centering pattern: crossings that amplify what is left.

Every point the beam lands on is displaced from where it was commanded by
the same two errors, the radius zero error along the rail and the cross
slide error across it, turned to the table angle of the moment. Two marks
burnt from the same side of the axis are displaced alike, so between them
they can never show more than the errors themselves: the coarse pattern
reads them straight off, to within the width of a burnt line, and no
arrangement of near-side marks can do better.

Burnt from the far side of the axis, with the head run past it and the
table half a turn on, the same board point gets the same displacement with
the sign reversed. Two straight marks that meet at a small angle, one from
each side, then cross not where they were meant to but 2 * error / tan
(angle) along the line from there: at three degrees a hundredth of a
millimetre becomes four tenths, which a rule reads.

The pattern is:

- a rail line through the axis with the table at 0: one radial move from
  minus the reach to plus it, the table still, so it lies the cross slide
  error off the axis along its whole length
- two arms, straight lines tilted by the angle, one on each side of the
  axis, the one at table angle 180 burnt from the near side and the one at
  table angle 0 from the far side, so that both are displaced against the
  rail line; the rail line crosses them where the offsets add, and the
  two crossings move apart by 4 * (cross slide error) / tan(angle)
- a rail line through the axis with the table at 90, the reference the
  spirals are read against
- two spirals about the axis, one turn each, one burnt outward from the
  near side and one inward from the far side, crossing on that reference
  line when the radius zero is right; the crossing moves around the axis
  by 2 * (radius zero error) / tan(angle), and the near spiral is cut
  short at both ends so the two can be told apart
- optionally the reference ring, the absolute check the coarse pattern has

Two lines of width w crossing at a small angle merge into one for w /
tan(angle) either side of the crossing, so what is read is the middle of
the merged stretch. The amplification does not sharpen that: it turns a
judgement of a fraction of a line width into a length a rule reads.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from . import polar, preview
from .polar import Joint, Point

# The near spiral is cut this much shorter at each end than the far one,
# so the two can be told apart on the coupon.
TRIM_DEG = 12.0
# Share of the table's rate a turning feature is paced at, so it is not
# riding on the limit with nothing left for the ramps.
HEADROOM = 0.95
# How finely a joint move is sampled when the burn is simulated: fine
# enough that a crossing found on the samples is within a few microns of
# the true one.
SAMPLE_MM = 0.02
SAMPLE_DEG = 0.2
# How far a crossing may be moved by the arms' own straightness. An arm is
# a board line cut as joint moves, which stray from it by up to the chord
# tolerance, and at a shallow crossing a stray across the line moves the
# crossing along it by the stray over tan(angle). The arms are subdivided
# to whatever tolerance keeps that under this.
CROSSING_SLACK = 0.005


@dataclass(frozen=True)
class Design:
    """The pattern's dimensions, all in mm and degrees."""

    # The rail lines run from -reach to +reach.
    reach: float = 7.0
    # The angle the crossing lines meet at.
    angle: float = 3.0
    # Where the arms cross the rail line, either side of the axis.
    cross: float = 4.0
    # Half the length of an arm.
    arm: float = 2.5
    # Mean radius of the spirals; 0 leaves them out.
    spiral: float = 5.0
    # Reference ring radius; 0 leaves it out.
    ring: float = 0.0
    trim: float = TRIM_DEG

    def __post_init__(self) -> None:
        if not 0.0 < self.angle <= 30.0:
            raise ValueError("--angle must be between 0 and 30 degrees")
        if self.arm <= 0.0:
            raise ValueError("--arm must be > 0")
        if self.cross - self.arm <= 0.0:
            raise ValueError("--cross must be larger than --arm, so the arms stay off the axis")
        if self.reach < self.cross + self.arm:
            raise ValueError(
                f"--reach must be at least --cross plus --arm ({self.cross + self.arm:g} mm),"
                " so the rail line reaches both crossings"
            )
        if self.spiral < 0.0 or self.ring < 0.0:
            raise ValueError("--spiral and --ring cannot be negative")
        if self.spiral > 0.0 and self.spiral + self.pitch / 2.0 > self.reach:
            raise ValueError(
                f"the spirals reach {self.spiral + self.pitch / 2.0:.2f} mm, past --reach:"
                " a smaller --spiral or a larger --reach"
            )
        if self.spiral > 0.0 and not 0.0 <= self.trim < 90.0:
            raise ValueError("the trim must be between 0 and 90 degrees")

    @property
    def pitch(self) -> float:
        """Spiral advance per turn that makes the two spirals cross at the angle."""
        return 2.0 * math.pi * self.spiral * math.tan(math.radians(self.angle) / 2.0)

    @property
    def gain(self) -> float:
        """How far a crossing moves along its lines per unit of error."""
        return 2.0 / math.tan(math.radians(self.angle))

    def arm_tolerance(self, tolerance: float) -> float:
        """Chord tolerance for the arms that keeps their crossings in place."""
        return min(tolerance, CROSSING_SLACK * math.tan(math.radians(self.angle)))

    @property
    def far_reach(self) -> float:
        """How far past the axis the head is sent."""
        far = max(self.reach, self.cross + self.arm)
        if self.spiral > 0.0:
            far = max(far, self.spiral + self.pitch / 2.0)
        return far

    @property
    def extent(self) -> float:
        """How far from the axis the pattern reaches."""
        return max(self.far_reach, self.ring)


@dataclass
class JointGroup:
    """Joint-space polylines that share one power and feed."""

    label: str
    joints: list[list[Joint]]
    power: float
    speed: float


def paced(radius: float, speed: float, rotary_max_rate: float | None) -> float:
    """Surface speed the table can hold going round at a radius."""
    if not rotary_max_rate or radius <= 0.0:
        return speed
    return min(speed, HEADROOM * math.radians(rotary_max_rate) * radius)


# --- the features -------------------------------------------------------------


def rail_line(table_angle: float, reach: float) -> list[Joint]:
    """One radial move through the axis with the table still."""
    return [(-reach, table_angle), (reach, table_angle)]


def arm_points(design: Design, side: int) -> list[Point]:
    """Board ends of the arm on one side of the axis, inner end first.

    The arm passes through (side * cross, 0) tilted by the angle, its inner
    end below the rail line and its outer end above it, so the two arms
    make a V that is symmetric about the line across the axis.
    """
    slope = math.tan(math.radians(design.angle))
    inner = side * (design.cross - design.arm)
    outer = side * (design.cross + design.arm)
    return [(x, slope * (side * x - design.cross)) for x in (inner, outer)]


def to_joints(
    points: list[Point], tolerance: float, previous_angle: float, far: bool = False
) -> list[Joint]:
    """A board polyline as joint targets, from the near or the far side of the axis."""
    kinematics = polar.Kinematics(tolerance)
    joint = polar.joint_of(points[0], previous_angle)
    out = [joint]
    point = points[0]
    for target in points[1:]:
        for next_point, next_joint in polar.subdivide(point, target, joint, kinematics):
            out.append(next_joint)
            point, joint = next_point, next_joint
    if far:
        out = [polar.far_side(j) for j in out]
    return out


def spirals(design: Design) -> tuple[list[Joint], list[Joint]]:
    """The near spiral, outward with the angle and cut short, and the far one, inward.

    Both start and end on the line across the axis at table angle 270 and
    would meet at 90, on the reference line, with the radius zero right.
    """
    radius, pitch, trim = design.spiral, design.pitch, design.trim

    def outward(angle: float) -> float:
        return radius + pitch * (angle - 90.0) / 360.0

    near = [(outward(-90.0 + trim), -90.0 + trim), (outward(270.0 - trim), 270.0 - trim)]
    inward = [(radius + pitch / 2.0, -90.0), (radius - pitch / 2.0, 270.0)]
    return near, [polar.far_side(joint) for joint in inward]


def build(
    design: Design,
    power: float,
    speed: float,
    rotary_max_rate: float | None = None,
    tolerance: float = 0.005,
) -> list[JointGroup]:
    straight = design.arm_tolerance(tolerance)
    groups = [
        JointGroup(
            label=f"rail line through the axis, table at 0, {design.reach:g} mm each way",
            joints=[rail_line(0.0, design.reach)],
            power=power,
            speed=speed,
        ),
        JointGroup(
            label=f"arms {design.angle:g} deg off the rail line, crossing it {design.cross:g} mm"
            " either side: near side at table angle 180, far side at table angle 0",
            joints=[
                to_joints(arm_points(design, -1), straight, 180.0),
                to_joints(arm_points(design, 1), straight, 0.0, far=True),
            ],
            power=power,
            speed=speed,
        ),
    ]
    if design.spiral > 0.0:
        near, far = spirals(design)
        groups.append(
            JointGroup(
                label=f"rail line through the axis, table at 90, {design.reach:g} mm each way:"
                " the spirals' reference",
                joints=[rail_line(90.0, design.reach)],
                power=power,
                speed=speed,
            )
        )
        groups.append(
            JointGroup(
                label=f"spirals at {design.spiral:g} mm, {design.pitch:.3f} mm per turn:"
                " near side outward and cut short, far side inward",
                joints=[near, far],
                power=power,
                speed=paced(design.spiral - design.pitch / 2.0, speed, rotary_max_rate),
            )
        )
    if design.ring > 0.0:
        groups.append(
            JointGroup(
                label=f"reference ring at {design.ring:g} mm",
                joints=[[(design.ring, 0.0), (design.ring, 360.0)]],
                power=power,
                speed=paced(design.ring, speed, rotary_max_rate),
            )
        )
    return groups


def cut_length(groups: list[JointGroup]) -> float:
    """Board length of the cuts, as the firmware reckons a joint move."""
    total = 0.0
    for group in groups:
        for poly in group.joints:
            for a, b in zip(poly, poly[1:]):
                arc = (a[0] + b[0]) / 2.0 * math.radians(b[1] - a[1])
                total += math.hypot(b[0] - a[0], arc)
    return total


# --- what the coupon shows ----------------------------------------------------


def drawn(groups: list[JointGroup]) -> list[tuple[str, list[list[Point]]]]:
    """The pattern as board polylines, as a centered machine burns it."""
    return burnt(groups, 0.0, 0.0)


def burnt(
    groups: list[JointGroup], along: float, across: float
) -> list[tuple[str, list[list[Point]]]]:
    """Where the pattern lands on a machine that is out.

    The head at commanded radius r sits `along` further out on the rail and
    `across` off it, and the board sees that turned to the table angle.
    """
    out = []
    for group in groups:
        paths = []
        for poly in group.joints:
            joints = polar.interpolate_joints(poly, SAMPLE_MM, SAMPLE_DEG)
            paths.append([polar.displaced(joint, along, across) for joint in joints])
        out.append((group.label, paths))
    return out


def intersections(a: list[Point], b: list[Point]) -> list[Point]:
    """Where two polylines cross, in order along the first."""
    boxes = []
    for p, q in zip(b, b[1:]):
        boxes.append((min(p[0], q[0]), min(p[1], q[1]), max(p[0], q[0]), max(p[1], q[1]), p, q))
    found: list[Point] = []
    for p0, p1 in zip(a, a[1:]):
        x0, y0 = min(p0[0], p1[0]), min(p0[1], p1[1])
        x1, y1 = max(p0[0], p1[0]), max(p0[1], p1[1])
        for bx0, by0, bx1, by1, q0, q1 in boxes:
            if bx0 > x1 or bx1 < x0 or by0 > y1 or by1 < y0:
                continue
            hit = _segments_cross(p0, p1, q0, q1)
            if hit is not None and (not found or math.dist(found[-1], hit) > 1e-9):
                found.append(hit)
    return found


def _segments_cross(p0: Point, p1: Point, q0: Point, q1: Point) -> Point | None:
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    ex, ey = q1[0] - q0[0], q1[1] - q0[1]
    denominator = dx * ey - dy * ex
    if abs(denominator) < 1e-15:
        return None
    fx, fy = q0[0] - p0[0], q0[1] - p0[1]
    t = (fx * ey - fy * ex) / denominator
    u = (fx * dy - fy * dx) / denominator
    if -1e-9 <= t <= 1.0 + 1e-9 and -1e-9 <= u <= 1.0 + 1e-9:
        return (p0[0] + dx * t, p0[1] + dy * t)
    return None


def readings(design: Design, groups: list[JointGroup], along: float, across: float) -> dict:
    """The distances the coupon would show for a machine that is out.

    `arms` is the distance between the rail line's two crossings with the
    arms; `spiral` is how far the spirals' crossing sits from the reference
    line, positive toward the short spiral's inner end. The reference line
    itself lies the cross slide error off the axis, which is in that
    reading as one part in the gain of the true offset.
    """
    marks = dict(burnt(groups, along, across))
    labels = [group.label for group in groups]
    rail = marks[labels[0]][0]
    left, right = marks[labels[1]]
    crossings = intersections(rail, left) + intersections(rail, right)
    out: dict = {"crossings": crossings}
    if len(crossings) == 2:
        out["arms"] = math.dist(crossings[0], crossings[1])
    if design.spiral > 0.0:
        reference = marks[labels[2]][0]
        near, far = marks[labels[3]]
        meet = intersections(near, far)
        out["spiral_crossings"] = meet
        if len(meet) == 1:
            # Signed distance from the reference line, positive on the side
            # the short spiral's inner end lies: the reference runs from the
            # table's 90 direction out along it, and the inner end sits
            # toward smaller angles.
            start, end = reference[0], reference[-1]
            ux, uy = end[0] - start[0], end[1] - start[1]
            length = math.hypot(ux, uy)
            ux, uy = ux / length, uy / length
            # Across the line, toward smaller polar angle: turn the line's
            # direction by -90 degrees.
            vx, vy = uy, -ux
            out["spiral"] = (meet[0][0] - start[0]) * vx + (meet[0][1] - start[1]) * vy
    return out


# --- outputs ------------------------------------------------------------------


def job_document(groups: list[JointGroup], name: str, spot: float) -> dict:
    """The pattern as a job the web interface imports."""
    return {
        "name": name,
        "source": "json",
        "spot": spot,
        "offset": {"x": 0.0, "y": 0.0},
        "groups": [
            {
                "label": group.label,
                "power": group.power,
                "speed": round(group.speed, 3),
                "enabled": True,
                "paths": [
                    [[round(x, 4), round(y, 4)] for x, y in polar.sample_joints(poly)]
                    for poly in group.joints
                ],
                "joints": [[[round(r, 4), round(a, 4)] for r, a in poly] for poly in group.joints],
            }
            for group in groups
        ],
        "outline": [],
        "copper": [],
        "stats": {
            "length_mm": round(cut_length(groups), 3),
            "seconds": 0.0,
            "max_radius": round(max(abs(r) for g in groups for poly in g.joints for r, _ in poly), 3),
            "min_radius": 0.0,
            "limited_fraction": 0.0,
            "moves": sum(len(poly) for g in groups for poly in g.joints),
        },
    }


def notes_for(design: Design, spot: float, speed: float, groups: list[JointGroup]) -> list[str]:
    gain = design.gain
    per = 0.01
    notes = [
        f"The head runs to R {-design.far_reach:.1f}, past the axis, for every rail line"
        " and for the far arm and spiral. Make sure the rail allows that before"
        " starting, or set r_max.",
        "Cut this in constant power mode (`mode const`). Nothing is read at the"
        " start of a move, and each feature is paced at what the table can hold"
        " for it, so the widths match where lines cross.",
        f"Two lines crossing at {design.angle:g} degrees merge into one for about"
        f" {spot / math.tan(math.radians(design.angle)):.1f} mm either side of the"
        " crossing: read the middle of the merged stretch, not where it starts.",
        f"Cross slide: the rail line burnt with the table at 0 crosses the two arms."
        f" Centered, the crossings are {2 * design.cross:g} mm apart; every"
        f" {per:g} mm the rail misses the axis by moves them {2 * gain * per:.2f} mm"
        f" further apart or closer together. Distance between the crossings, less"
        f" {2 * design.cross:g}, divided by {2 * gain:.1f}, is the cross slide error."
        " Which way to move the slide the burn cannot say in the slide's own"
        " terms: move it that far, and if the next burn's crossings are further"
        " from the nominal still, it went the wrong way. From then on the"
        " direction is known.",
    ]
    if design.spiral > 0.0:
        notes.append(
            "Radius zero: the two spirals cross on the rail line burnt with the"
            " table at 90 when the radius zero is right. Every"
            f" {per:g} mm of radius zero error moves the crossing {gain * per:.2f} mm"
            f" along the spirals, so its distance from that line divided by {gain:.1f}"
            " is the error. The short spiral is the one burnt from the near side:"
            " when the crossing lies toward its inner end the head at radius zero"
            " sits past the axis by that much, and toward its outer end it is short"
            " of it. Jog the head to R minus the error (past the axis means"
            " a negative R) and `set R0` there. The reference line lies the"
            " cross slide error off the axis itself, which is in this reading"
            f" as the error over {gain:.0f}: nothing once the cross slide is close."
        )
    if design.ring > 0.0:
        notes.append(
            f"The ring at {design.ring:g} mm is the absolute check: half its measured"
            " diameter less that radius is the radius zero error with its sign,"
            " wider meaning the head is short of the axis and narrower past it."
        )
    slow = [g for g in groups if g.speed < speed - 1e-9]
    for group in slow:
        notes.append(
            f"The {group.label.split(',')[0].split(' at ')[0]} run at {group.speed:.0f} mm/min,"
            f" not {speed:g}: that is all the table can turn there."
        )
    notes.append(
        f"The pattern reaches {design.extent:g} mm from the axis: give it a coupon"
        f" comfortably wider than {2 * design.extent:g} mm."
    )
    return notes


def render_map(
    name: str, design: Design, groups: list[JointGroup], notes: list[str], power: float
) -> str:
    lines = [
        f"# {name}",
        "",
        "Fine centering pattern: crossings that amplify what the coarse pattern"
        " leaves. Import the job into the web interface and run it in `mode const`.",
        "",
        "## Pattern",
        "",
        "| Feature | Where |",
        "| --- | --- |",
        f"| Rail lines | through the axis, {design.reach:g} mm each way, table at 0 and 90 |",
        f"| Arms | {design.angle:g} deg off the rail line, crossing it {design.cross:g} mm"
        f" either side, {2 * design.arm:g} mm long |",
    ]
    if design.spiral > 0.0:
        lines.append(
            f"| Spirals | at {design.spiral:g} mm, {design.pitch:.3f} mm per turn, one turn each |"
        )
    if design.ring > 0.0:
        lines.append(f"| Ring | {design.ring:g} mm |")
    lines += [
        f"| Gain | {design.gain:.1f}: a crossing moves that many times the error |",
        f"| Head | to R {-design.far_reach:.1f}, past the axis |",
        f"| Cut length | {cut_length(groups):.1f} mm at S{power:g} |",
        "",
        "## Groups",
        "",
        "| Group | mm/min | Moves |",
        "| --- | --- | --- |",
    ]
    for group in groups:
        lines.append(f"| {group.label} | {group.speed:.0f} | {sum(len(p) - 1 for p in group.joints)} |")
    lines += ["", "## Reading it", ""]
    lines += [f"- {note}" for note in notes]
    lines.append("")
    return "\n".join(lines)


def parse_error(text: str) -> tuple[float, float]:
    """`along,across` in mm: the radius zero error and the cross slide error."""
    try:
        along, across = (float(part) for part in text.split(","))
    except ValueError as exc:
        raise ValueError("--show-error takes two numbers, the radius zero error"
                         " along the rail and the cross slide error across it, as E,Z") from exc
    return along, across


def run(args, parser) -> int:
    """The `--fine` half of spinny-center."""
    try:
        design = Design(
            reach=args.reach,
            angle=args.angle,
            cross=args.cross,
            arm=args.arm,
            spiral=args.spiral,
            ring=args.ring,
        )
        if args.power > args.s_max:
            raise ValueError(f"power {args.power:g} is over --s-max {args.s_max:g}")
        if args.speed <= 0:
            raise ValueError("--speed must be > 0")
        error = parse_error(args.show_error) if args.show_error else None
        groups = build(design, args.power, args.speed, args.rotary_max_rate, args.tolerance)
    except ValueError as exc:
        parser.error(str(exc))
        return 2

    out = args.output or Path("out") / "center-fine.json"
    notes = notes_for(design, args.spot, args.speed, groups)
    summary = [
        f"pattern    fine: rail lines {design.reach:g} mm each way, arms crossing at"
        f" {design.cross:g} mm, {design.angle:g} deg"
        + (f", spirals at {design.spiral:g} mm" if design.spiral > 0 else "")
        + (f", ring at {design.ring:g} mm" if design.ring > 0 else ""),
        f"gain       {design.gain:.1f}: 0.01 mm of error moves a crossing"
        f" {design.gain * 0.01:.2f} mm, the arm crossings {2 * design.gain * 0.01:.2f} mm apart",
        f"head       to R {-design.far_reach:.1f}, past the axis",
        f"cuts       {cut_length(groups):.1f} mm",
    ]
    shown = drawn(groups)
    if error is not None:
        along, across = error
        shown = burnt(groups, along, across)
        seen = readings(design, groups, along, across)
        summary.append(
            f"shown      as burnt with the radius zero {along:g} mm out and the rail"
            f" {across:g} mm off the axis"
        )
        if "arms" in seen:
            summary.append(f"           arm crossings {seen['arms']:.2f} mm apart")
        if "spiral" in seen:
            summary.append(f"           spiral crossing {seen['spiral']:.2f} mm from its line")

    written: list[Path] = []
    if not args.dry_run:
        out.parent.mkdir(parents=True, exist_ok=True)
        document = job_document(groups, out.stem, args.spot)
        out.write_text(json.dumps(document, separators=(",", ":")), encoding="ascii")
        written.append(out)
        if args.want_map:
            map_path = args.map_path or out.with_suffix(out.suffix + ".map.md")
            map_path.parent.mkdir(parents=True, exist_ok=True)
            map_path.write_text(render_map(out.name, design, groups, notes, args.power), encoding="ascii")
            written.append(map_path)
        if args.want_preview:
            preview_path = args.preview_path or out.with_suffix(out.suffix + ".preview.svg")
            preview_path.parent.mkdir(parents=True, exist_ok=True)
            svg = preview.render([], shown, spot=args.spot, min_radius=args.min_radius)
            preview_path.write_text(svg, encoding="ascii")
            written.append(preview_path)

    print("\n".join(summary))
    for path in written:
        print(f"wrote      {path}")
    if args.dry_run:
        print("dry run, nothing written")
    import sys

    for note in notes:
        print(f"note: {note}", file=sys.stderr)
    return 0
