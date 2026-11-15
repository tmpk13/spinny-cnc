# Focus axis, probing and the height map

## Focus axis, probe and height map

- `H` is a third joint (`AXES = 3`) in the planner and the step
  interrupt rather than a setup axis like the cross slide: a cut has to
  move it along with R and A to follow the board. The planning metric
  now counts it; `F` stays the board surface speed, and a move with no
  board length but some `H` takes `F` as the `H` speed (jogs, probes).
- `dir_invert` bit 2 already belonged to the cross slide, so the focus
  axis is bit 3 and `Settings::joint_dir_invert` folds it onto joint bit
  2 for the step port. The settings blob had 3 spare bytes: it is 256
  bytes and version 3, so a board flashed with the new firmware comes up
  on defaults once (a changed layout is discarded, not migrated).
- Probe latch: the interrupt reads the input every tick of a probe block
  and latches the H steps at the first active read; the main loop brakes
  like a jog cancel. A brake only reaches segments not yet written, and
  with the full 16-segment ring a 1 mm/s probe pressed on 0.2 mm past the
  contact. Probe blocks keep 2 segments (20 ms) queued; overtravel is now
  a few hundredths.
- `probe` is answered only when it ends and holds everything behind it,
  so a host's retract cannot be queued behind the probe and then thrown
  away by the brake's flush. A miss raises `Alarm:2`: whatever was sent
  next would move a head that is lower than planned.
- `go` is refused while a jog runs, so the prober retracts with `go H`,
  never `jogto H`, before its next `go R A`.
- A probe tip off the rail by `across` traces circles no smaller than
  that about the axis, so a grid point at the axis is unreachable. Such a
  point is probed from the nearest reachable spot when that is within
  half a grid spacing, and refused otherwise.
- Compensation splits a cut along its joint line (lerp in joint space),
  which is exactly the path the firmware would have moved, so splitting
  changes nothing but where H or S changes. Split to a quarter of the
  grid spacing, 0.25 to 2 mm.
- Power fallback: S times `sqrt(1 + (dz / zR)^2)`, the Gaussian spot's
  growth, capped at `s_max`; approximate, since the line also widens.
- A compensated run reads the machine settings fresh: the 1 s cache let a
  run start in focus mode just after `h_axis` had been turned off.
- The focus offset must be set explicitly (`focus_set`): with 0 a focus
  run would put the head at probe contact height.
- The in-page mock follows the backend's checks and texts for probing,
  focus and compensated runs, but its console `probe` answers at once
  (so it is refused unless Idle), probing spends a fixed 0.25 s of mock
  time per point with the head jumping between them, a hold does not
  pause it, `$tmc` still lists three drivers, and power compensation is
  checked but does not change the mock's power.
- The probe queue is the `probe_ms` setting (0 to 160 ms, default 20,
  whole 10 ms segments). The segment being stepped is not in the ring's
  count, so the head runs up to `probe_ms + 10` ms before the brake
  starts; at 1 mm/s the measured overtravel was 0.039 mm at 20 ms and
  0.03 at 10. `probe_ms` 0 halts in the interrupt at the contact tick:
  it drops the ring and keeps dropping whatever arrives while
  `probe_halt && probe_hit` stand (the front may enqueue one segment in
  the race), and the machine ends the probe with `Front::abort`, whose
  `forget` clears the halt. Stopping dead is only allowed when the probe
  feed is within `h_jerk`; a faster probe brakes from one segment. The
  reported height never depended on the queue: it is latched per tick.

## Probe nearest (2026-10-13)

A touch that ties the map must land on copper the map measured, not in a
cut: a probe in a groove reads the floor and shifts the whole map by the
cut depth with nothing to flag it. "Nearest clear point" avoids every cut
of the job, not only the ones already made: the run's progress maps to
lines only through the compensation the run used, which needs the map
tied (the very thing being done), so cuts made vs. cuts to come is not
knowable here without the circular dependency. Avoiding all cuts is a
subset and always safe. The point must also read the map from a cell with
all four corners probed (`cell_probed`), the same test the touch applies
afterwards, so a plan never offers a point the touch would refuse.

## Tie accumulation and runs without the map (2026-10-13)

On hardware every tie added the same +2.33 mm to the offset (4.49, 6.81,
9.13, 11.46, 13.78): the tie measured the shift against the map's heights,
which never change, and added it to an offset that already held it. The
offset is now modeled as gap + shift, with the gap (focus or touch-off
over the probe's contact, frame independent) stored on the map; a tie
replaces the shift. A focus by eye in a frame the heights are not in
leaves the gap unknown (None) until the next tie measures the frame and
keeps that offset. A mill with the tool as probe gets gap 0 when nothing
is known, so a legacy map ties right on the first touch.

The air cut itself was the resume running with the map off, as the
stalled run had: it takes H 0 for the copper, and after the power cycle
the copper read H -15.25. The backend remembers where a probe last found
the copper, per frame, and refuses a spindle's run without the map when
that is more than 1 mm from H 0.

## Going on with a height map after a missed probe (2026-10-27)

A miss stops with the head `depth` below the travel height. Going on used to take the travel height from wherever the head was, so every later move ran below the copper: the tip (or the mill's tool) was dragged through the board and the rest of the map was junk. The map now keeps `travel`, the height probing began at; going on uses the higher of that and the head's height, and rises to it before the first sideways move. The missed point is probed again from there with the current depth, so a real miss needs a deeper probe.
