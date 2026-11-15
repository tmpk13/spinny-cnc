# Finding the rotation axis

## Finding the rotation axis

A cut cannot tell a radius zero error from a rail that misses the axis:
both put the beam somewhere other than where the polar coordinates say.
`spinny-center` separates them by using what each kind of move is made of.

A radial cut holds the table and moves the head, so the mark it leaves is
the rail, a straight line at the rail's own miss distance from the axis.
At table angle `t` the board sees that line rotated by `-t`, so four cuts
a quarter turn apart land at `y = +-z` and `x = +-z` in board
coordinates: a square of side `2z` centered on the axis, whatever the
radius zero error happens to be. A full turn with the head still is the
other extreme, all rotation, and burns a ring centered on the axis
exactly. The ring is therefore the reference and the square is the
measurement.

Two details the pattern has to respect. The lines start at radius zero,
where the emitter reopens the beam two coordinate quanta out, so the
inner ends sit a couple of microns off the axis; that is a hundredth of
what is being measured. And the ring is all rotation, so the table's rate
caps its surface speed: asking for more only turns slower, which in
constant power mode is a heavier burn on the one feature whose width is
being read. The ring is paced at 95 percent of what the table can hold at
its radius instead.

A trace was written only when a client disconnected, which made a file
from the run before indistinguishable from this one's: reading a stale
trace is what sent the first look at the centering pattern chasing a laser
that was never off. It is now written whenever the machine comes to rest
as well, so it is current after every job.

## Amplifying what the centering pattern leaves

The coarse pattern reads the two errors to about the width of a burnt
line, and no other pattern burnt the usual way can do better. Every point
the beam lands on is the commanded point plus one vector, the radius zero
error along the rail and the cross slide error across it, turned to the
table angle of the moment. Two marks at the same place are displaced
alike, and two marks anywhere differ by at most twice that vector, so the
best a near-side pattern can do is put two marks half a turn apart and
show the offset once over: the square of the coarse pattern.

Burnt with the head past the axis and the table half a turn on, a board
point is the same point but the vector is reversed. That is the only new
thing the far side gives, and it is enough: two straight marks that meet
at a small angle, one from each side, cross 2 * error / tan(angle) along
the line from where they were meant to. At three degrees the gain is 38.
`spinny-center --fine` is that pattern, and it needed three things the
machine did not have.

- `go` and `cut` refused a negative radius, on the argument that a job's
  polar words cannot mean the far side. They still cannot, and the host
  never writes one; the refusal was moved out of the firmware and into
  the fact that only a joint-space group can ask for it.
- A job group may carry `joints`, polylines in joint space streamed as
  they are, since board coordinates cannot say which side a mark is burnt
  from. Its `paths` are only what the preview draws, and it cannot be
  given an offset.
- The runner reported a job done on a polled status that could predate
  the run: a short job is acked in full before the poll comes round, and
  the slower debug build of the virtual firmware showed the machine still
  cutting after "done". The drain now asks for a status of its own.

Choices in the pattern itself:

- The crossing lines for the cross slide error cannot both be rail lines
  through the axis. Every rail line passes the axis at the same distance,
  so two of them meet at the axis whatever the angle, and the two crossings
  the reading needs would sit on top of each other, merged into one lens
  for any error under a quarter of the line width. The arms are board
  lines away from the axis instead, and the rail line is the one straight
  mark through it.
- The arms are joint moves subdivided from a board line, and a 0.005 mm
  chord tolerance moves a crossing at three degrees by 0.1 mm, an eighth
  of what a hundredth of a millimetre of error moves it. They are cut to a
  tolerance scaled by tan(angle) so the crossing stays within 0.005 mm.
- The spirals for the radius zero error are single joint moves, radius
  linear in angle, so they are exact; the pitch is 2 pi r tan(angle / 2)
  so that they meet at the angle. The cross slide error turns the near and
  the far spiral opposite ways by the same amount and drops out of their
  crossing; the reference line, being a rail line, carries it once, which
  is one part in the gain of the reading.
- The near spiral is cut short at both ends: near and far cannot be told
  apart on the coupon otherwise, and the sign of the radius zero error is
  in which way the crossing moved along the near one.
- The sign of the cross slide error comes out in board coordinates, and
  the tool cannot say which way that is on the slide, since that is the
  machine's direction setting. The note says to move by the amount and
  read the next burn; the relation holds from then on.
- Amplification does not sharpen the reading. Two lines of width w at
  angle a merge for w / tan(a) either side of their crossing, so the
  crossing is still judged to a fraction of that stretch; what changes is
  that the fraction is of millimetres a rule reads, not of a tenth.

## Centering test in the web page

- The backend reuses `spinny_laser.center.build` and `fine.build` rather than
  shelling out; the coarse ring note moved into `center.all_notes` so the CLI
  and the route share it.
- The table rate is the backend's `rates.a_rate` (deg/min, the lower of the
  setting and the step ceiling), standing in for `--rotary-max-rate`.
- `show_error` only moves the fine job's preview `paths`; the streamed
  `joints` stay the commanded ones.
- A pydantic field named `fine` shadows the `fine` module inside the class
  body, so the modules are imported as `coarse_pattern` / `fine_pattern`.

## Lines burnt at a wrong angle, some runs only (2026-09-27)

One or two lines of a test pattern came out rotated, on some runs and not
others. The cause was a loose lead screw coupler (or table): the screw
slipped and the radius came up short. A cut that moves R and A together
lands at the right angle but the wrong radius, so it looks rotated.
The centering job on the virtual firmware (fast and real clock, varied
start angles) put every mark within 0.0001 mm of its spoke, which cleared
the host and the core. The firmware counts the steps it sends, so slip
never shows in the reported position. Check whether the later lines share
the offset (position lost, so mechanical) before looking at the software.

## Material and depth tests (2026-11-02)

Every patch is a group, so the groups table is the legend and a patch can
be cut again alone. The material test is refused on a spindle machine and
the depth test on a laser. A focus ladder was left out: a laser group has
no focus height (H only comes from height map compensation), and adding
one touches the laser streamer, `compensate()` and the mock's streamer.

## Focus per group and the focus ladder (2026-11-05)

A group's `focus` is relative, not an absolute H: the map's focus height
when the run follows it by focus, else the H the run starts at
(`Streamer.focus_base`, set by the runner from its idle status, kept in
the resume record as `start_h` so a pick-up plans the same lines). A
relative number is the only one that means the same thing with and
without a map, and the ladder's workflow is "focus by eye, then run". The
first group's height is said on its first move even when it is the
start's, because `Streamer.approach` takes the last H the plan said before
the line picked up: without it, a run stopped in a +1 group and picked up
in an earlier 0 group would cut that at +1. A group starting where the
last ended has no rapid to carry the H, so it gets a `go H` lift of its
own. Following the map by power is refused with a group focus: that mode
holds the head still and scales the power for the defocus, and moving the
head under it would make the scaling wrong. The CAM gcode export ignores
the field.

## Focus per group after a stop or a frame change (2026-11-09)

A group's focus counts from `start_h`, the height the run began at, and
the record keeps the focus axis `frame` it was read in (a per-session id
and the frame count). A pickup counts from `start_h` only in that frame;
otherwise it answers 409 unless `focus_here` gives the operator's word.
Without the map, Run answers 409 when the same job's last run did not
finish and the head is not at `start_h` (a stop leaves it at the stopped
group's height, so each re-run walked the lens by that group's focus) or
the frame changed; `go H` back or Focused here. A run of another job
still counts from where the head is, the documented focus-by-eye. Following
the map by focus, a cut that starts a group of another focus gets a dark
`go H` first, as without the map; the mock does the same.

## The camera pattern (2026-11-12)

- Calibration test offers "camera pattern" (kind "dots") on a laser and a
  mill: 21 x 15 dots 2 mm apart by default, the top right dot left out
  (breaks the grid's turn and mirror symmetry for a non-square grid; a
  square grid stays mirror-ambiguous along the diagonal). Laser dots:
  outline half a spot inside the edge, then an Archimedean spiral a spot
  apart, one path a dot. Mill dots: one-point paths (a plunge each).
  The answer's `svg` is the sheet at true size with a 10 mm bar.
- The Test picker now always shows (it used to show only for a laser with
  a focus axis), since every laser and mill has two or three tests.
- Distortion measurement not built: pcbv's spot gives one blob; options
  written in docs/CALIBRATION.md. The cheapest needs no pcbv change: one
  dot moved across the picture by the machine, found place against the
  place the moves predict (a camera routine).
