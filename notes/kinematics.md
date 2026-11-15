# Polar kinematics

## Kinematics

Board point `(x, y)` maps to joint `(r, theta)` with `r = hypot(x, y)` and
`theta = atan2(y, x)` in degrees. The laser sits on the rail at machine angle
zero, so bringing `theta` under the beam means the table has physically
turned by `-theta` (clockwise from above). The word emitted is `+theta`;
which way the motor has to turn is a wiring question, so `--invert-rotary`
and the direction pin both exist.

Angles are unwrapped: each new angle is the representative nearest the
previous one, so a move never swings more than half a turn and a loop around
the axis simply keeps counting. Isolation loops all run counterclockwise, so a
job whose copper surrounds the axis winds up several turns. Return home goes
to the nearest multiple of 360 rather than unwinding. Soft limits on the
rotary axis therefore have to be off or huge.

### Straight lines are spirals

Linear interpolation in joint space between two board points traces an
Archimedean spiral, not a line. Each segment is bisected until linear joint
interpolation stays within `tolerance` of the chord, checked at the quarter
points. For a line at distance `R` from the axis the error of a segment of
length `L` is about `L^2 / (8R)`, so at `R = 20` mm and 5 micron tolerance
segments come out about 0.9 mm long; at `R = 2` mm about 0.3 mm. That is a
few to a few tens of segments a second at 400 mm/min, well inside what
FluidNC plans.

### The axis

A point within a micron of the axis has no angle; it keeps the previous one,
so the move in to the axis is purely radial and exact. A segment that leaves
the axis can never be straightened by bisection (the spiral error only halves
with each level), so it is split into a turn on the spot followed by a radial
move. A segment through the axis therefore becomes: radial in, half a turn at
radius zero, radial out. The turn has no board length, so it is written as a
`G0` with the beam closed (`M4 S0`) and reopened after: under `M4` a cut with
zero surface speed would dwell at full power on one point.

Bisection also stops at 1 micron segments and 24 levels, which bounds the
segment count where a line passes close to, but not through, the axis.

## grblHAL polar kinematics

The controller moved from FluidNC to grblHAL built with `POLAR_ROBOT`
(`kinematics/polar.c`, v0.03), which changes who does the transform. Read
from the source:

- Input is board X/Y. `RADIUS_AXIS` is the X motor, `POLAR_AXIS` is the Y
  motor in degrees, so `$101` is steps per degree and `$111` degrees per
  minute. The rotary letter in the file is fixed: it is `Y`.
- `segment_line` splits a cut longer than `MAX_SEG_LENGTH_MM` (0.5) into
  equal pieces and plans each as one joint move. Rapids are never split, so
  a `G0` across the board is one spiral; harmless under `M4`.
- Per piece it multiplies `F` by joint distance over board distance, floored
  at 0.5, so `F` in the file is the surface speed and stays in `G94`. `G93`
  must not be used: each piece would be planned as its own inverse-time
  block and a move would take as many times longer as it has pieces.
- The angle is unwrapped to the nearest turn and kept unchanged at radius
  zero, the same rules as `polar.py`.
- `rate_multiplier` only feeds the real-time rate report; `M4` power still
  uses programmed against current rate in joint units, which is consistent.
- The X work offset is subtracted twice and added back around the transform
  with a `//??` in the source, so machine `X = 0` has to be the axis and the
  X work offset zero. There is no homing, so the position is wherever the
  controller reset.

What that means here: the default emitter writes board X/Y in `G94` with
`F` on the first move of each path, and the joint emitter is kept behind
`--controller joint`. The kinematics module still runs, for three reasons.
The estimate and the rotary-bound report need the joint moves. The 0.5 mm
pieces are off by `L^2 / 8R`, 31 microns at 1 mm radius and 6 at 5 mm, so
segments are pre-split with the same bisection and the controller's own
split can only shorten them further. And a cut leaving the axis spirals in
the controller, which cannot turn on the spot: the emitter closes the beam,
hops out with a `G0` and reopens.

The hop has a trap. Board X/Y is written to three decimals, so a point one
micron from the axis rounds to an angle in steps of 45 degrees, and the cut
after it spiralled by 23 microns in the test. The hop is now two quanta out,
rounded first, its real angle taken from the rounded point, and the rest of
the segment is subdivided again from there, which adds one short segment
while the angle catches up. The beam misses the first two microns from the
axis, well under the spot.

The `G1F1` dark trick stays, since the file is `G94` again.

## Feed rate (joint controller)

Inverse time (`G93`) is the default in joint mode because it makes the
surface speed independent of how the controller sums a linear and a rotary axis: `F` is
`speed / board_length` per minute and the move takes exactly that long.
Verified in FluidNC `GCode.cpp`: in `G93` every `G1`/`G2`/`G3` with axis words
needs its own `F` (error 22 otherwise), `G0` does not, and the feed is reset
after each block so nothing modal leaks. `Planner.cpp` multiplies the
inverse-time feed by the block's joint distance to get `programmed_rate`, and
`Stepper.cpp` scales `M4` laser power by `current_rate / programmed_rate`, so
dynamic power works unchanged under `G93`.

`scaled` mode keeps `G94` and sets `F = speed * joint_length / board_length`
with `joint_length = hypot(dr, dtheta * rotary_scale)`, which is right only if
the controller measures the rotary axis in the same units it uses for the
feed (FluidNC does, degrees configured as millimetres).

The `G1F1` dark trick from the Cartesian dialect is kept only in the `G94`
parts of the file (header, footer, scaled mode); in `G93` the feed is not
modal, so it has nothing to do.

## The table is the bottleneck

A tangential cut at radius `r` needs `speed / r` radians per minute. For
400 mm/min that is `22918 / r` degrees per minute. A stepper through a 100:1
harmonic drive at 300 motor rpm gives 1080 deg/min at the output, so full
surface speed is only available beyond 21 mm from the axis; at 50:1 beyond
10.6 mm. Inside that radius the controller caps the rate and, under `M4`,
drops the power in proportion, so the burn stays right and the job takes
longer. Very low duty cycles may drop a diode below threshold, which is worth
watching on the coupon.

The emitter accounts for this when given `--rotary-max-rate`: each segment's
time is the longer of the feed time and each axis's limit time, and the
summary reports how much cut length was held back and the slowest surface
speed reached. The simulator does the same sum from the sidecar, so its clock
matches the estimate. In grblHAL mode the simulator also reproduces the
controller's own 0.5 mm split and feed floor, so its pieces are the ones the
planner will see.

Resolution goes the other way: 20 arcsec is 0.0056 degrees, about 5 microns
at 50 mm radius, and a 200 step motor at 16 microsteps through 100:1 is
1 micron per step at 50 mm. Angle words are written to 4 decimals for that.

## Placement

Anchoring on the axis is the default because polar coordinates make the
middle of the table the natural home, but a pad on the axis is the worst
case: the loop around it is a circle of radius under a millimetre and every
line through it is a half turn. The fixture board has exactly that, hence
the near-axis warning and `--offset`. Placing the board so its nearest copper
is well outside the rotary-limited radius is the practical choice.

## Jogging in polar mode

A jog is a board move, so the X motor, which is the radius, can never be
sent negative: from the center every jog direction drives it out, and a jog
across the center is a half turn of the table. Seen from a sender that
looks like the X axis only ever going one way. `spinny-jog` prints rapids
instead, which the controller does not segment, so a rapid between two
points at the same radius is a pure rotation. Turns are split into steps of
at most 90 degrees because the controller unwraps to the nearest angle and
a half-turn step could go either way. A move with a feed would be split
into 0.5 mm board pieces and become a chord, so turns are always rapids.

## Jogging past the axis

The radius was refused below zero everywhere, on the grounds that a point
past the axis is the same board point half a turn away. That is true of a
job, and false of setup: the head at radius zero is rarely over the axis
to begin with, and finding it means stepping through zero and back while
watching where the beam lands. Being unable to cross meant redefining the
coordinate with `set` before every nudge in that direction.

A jog may now take the radius past the axis and `set R<negative>` declares
the head parked there. `go` and `cut` still refuse it, which keeps the
rule where it belongs: a job is written in polar words that cannot say
which side of the axis was meant, and a setup move is not. The soft limit
`r_max` became a limit on the distance from the axis rather than on the
radius, so it holds on both sides.

## A board jog from the far side

`on_axis` took any radius below a micron as the axis, a negative one
included, so a board jog from a head parked past the axis was split as if
it began on the axis: a turn with the head out on the far side, and a
streamer that believed the head was at the axis afterwards. A negative
radius is as far from the axis as the positive one; a board move from
there now returns along the rail to the axis first and leaves it the
usual way.
