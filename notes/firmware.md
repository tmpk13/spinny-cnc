# Controller firmware

## Own firmware instead of grblHAL

The SKR Pico firmware (`firmware/`) is a joint-space controller, not a gcode
interpreter. Once the controller is ours there is no reason to push board
X/Y through it and then fight the controller's own segmentation: the host
already has a tested kinematics module (`polar.py`) that subdivides a board
line until linear joint interpolation stays within tolerance and that turns
an axis crossing into radial in, turn, radial out. So the wire format is
short joint lines (`cut R<mm> A<deg>`), the firmware plans and steps them
with a grbl-style lookahead planner, and the laser follows the speed the
steppers actually reach. Board geometry (gerber, KiCad, SVG, old gcode)
lives entirely in the web backend, which imports it into one job model.

Consequences:

- Surface speed still rules: `F` on a `cut` is mm/min on the board, and the
  firmware takes the board length of a joint line as `hypot(dr, r_mean *
  da)`, exact for turns and radial moves and close for the short spirals the
  host streams. Under `mode dyn` the power scales by achieved over requested
  speed, so an axis-limited piece near the axis burns the same dose per mm.
- Independent axis moves are native: `jog R1` moves the head alone,
  `jog A90` turns the table alone. Board jogs are converted by the backend.
- The firmware never sees a negative radius; a point on the other side of
  the axis is the angle plus a half turn, and the host's unwrapping decides.
- A turn on the axis has no board length, so it runs as a rapid with the
  beam off; no hop trick is needed, unlike with grblHAL's Cartesian input.

## Firmware layout

`firmware/core` is a no_std crate with the parser, settings, planner,
stepper and machine state, tested on the host. `firmware/rp2040` wraps it
in embassy for the SKR Pico and `firmware/virtual` wraps it in a TCP
server with a virtual clock, so the web interface and its tests run
against the real control logic without a board. The RP2040 crate is
excluded from the workspace and keeps its own `.cargo/config.toml`: a
`build.target` there would otherwise capture the host crates, and cargo
has no way to unset it from a child directory.

The step timer is TIMER alarm 1 on the RP2040, one interrupt per tick at
the highest priority; embassy's time driver keeps alarm 0. The interrupt
half of the stepper only consumes a lock-free ring of segments that the
main loop fills a few ten milliseconds ahead, so a slow USB packet or a
flash write cannot stretch a step.

## Motion engine (planner and stepper)

The planner is grbl's: blocks in a ring, a jerk-rule junction speed, a
backward pass from the last block (exit zero) and a forward pass. The
block being executed belongs to the stepper: the stepper writes the speed
and the progress it has reached back into that block after every segment,
so a block appended later is planned from the real state, and the stepper
reads its exit speed again for every segment. That is how grbl handles the
same case (`st_update_plan_block_parameters`), without a recompute flag.

Segments are not the grbl ramp state machine. Every segment is planned
from the speed at the end of the previous one and the whole events left
in the block: target speed a segment of acceleration away, bounded by the
ramp down to the exit speed, and by what the acceleration allows over the
segment's own distance (short blocks). Events are whole integers taken off
the block's exact count, so nothing is carried as a float remainder and a
3600 degree turn ends on the step.

A hold decelerates from the last produced segment, not from the segment
the interrupt is in: up to a full ring (150 ms) of planned motion runs
first, as in grbl. Resume shortens the block by the events not yet sliced;
the steps left per axis come from the closed form of the interrupt's
Bresenham (`math::bresenham_done`), which is the only reason the counter
starts at half the event count and compares with `>=`. Change one and the
other.

Tick periods carry a 1/256 us fraction across ticks. Without it 18 deg/s
(62.5 us) would round to 63 us, 0.8 percent slow, and the dose with it.

Abort is two-step because only the interrupt owns the ring consumer: the
front sets the flag and asks for a kick while the interrupt is idle; the
interrupt drains and clears the flag; the front copies the executed
position into the planner on its next `prep` or `flush`.

## Machine module and the virtual firmware

One line gets exactly one `ok` or `error:`, which decides where each
command is executed. Commands that need nothing but the machine's own
state answer from `submit`. Everything else becomes the single pending
request that `poll` finishes: a motion line waits for planner room, a sync
command (`dwell`, `mode`, `laser`, `set`, `enable`, `disable`) waits for
the queue to drain, and `$save`/`$load` wait for the next `poll` because
that is where the store is. While a request is pending the port stops
feeding lines, so the answer order can never slip.

The laser is written from the machine only for a constant beam and to
force it off; during motion the step interrupt sets the duty per segment.
That split is what keeps the beam tied to real speed: nothing in the main
loop can leave it lit after the steppers stop, and a hold, a reset, a
disconnect or a dry planner all close it from the machine side as well.

`firmware/virtual` is the same core with counting ports and a clock that
either follows the wall or jumps to the next deadline. Free-running time
stands still while the machine is quiet (`Machine::is_quiet` says when
nothing is pending, timed or moving), so an idle simulator costs nothing
and a job runs as fast as the host can step it: the quarter circle in the
tests takes 5 seconds of machine time and 0.3 seconds of real time.

The trace it writes is the burn as the beam would leave it. Marks are
sampled on every tick but kept only when the duty changes, the beam has
moved 0.05 mm, or 2 ms have passed, which bounds a long job to a readable
file. The burnt length is summed between kept marks on purpose: the axes
step one at a time, so summing step by step measures the staircase the
microsteps trace out, about a fifth longer than the line. The first
version of the summary did exactly that and reported 74 mm for a 59 mm
square.

Lines from a client that spends more than its 16 credits wait for room
rather than being dropped, which is what the board does when the endpoint
stops accepting packets; realtime bytes are extracted before that queue,
so `?`, `!` and the reset byte still get through a full line queue.

## Beam and counter safety

Four things the first version of the firmware got wrong, all found by
walking every path that can leave the beam lit or lose the position.

A hold only turned the beam off from the machine side. The segments
already in the stepper ring, and the whole deceleration ramp written
after the hold, still carried their planned duty, and the interrupt
re-applies a segment's duty every time it loads one. In `mode const` at
`S1000` the beam came back 7 ms after the hold and burnt at full power
for 347 ms while the machine slowed down. `Shared::laser_off` now says a
hold is in force; the interrupt drives the off duty for any segment it
loads while it is set, and `prep` clears it once the hold, cancel or
abort is over. It is cleared there rather than where the hold ends so an
abort keeps running dark until the interrupt has emptied the ring.

A `dwell T S` queued behind a cut could fire during a hold. The sync
commands wait for the planner to drain and the stepper to stop, and a
hold that catches the tail of the last block satisfies both: the dwell
lit the beam, set the state back to `Run`, and left the stepper's own
`Hold::Stopped` behind, which no later resume clears. The machine went
idle with a stepper that would never step again. A dwell now waits for
the hold as well.

`$load` adopted its settings inside `poll`'s pending-request step, which
ran after the step that pushes a changed polarity to the ports, so a
load that set `laser_invert` left the laser output at its old level for
a whole loop pass: a full-power beam on an active-low output, and an
enable pin the wrong way round for the drivers. Both ports are now
written after the pending step.

The step interrupt shifts the block's event count left by `MAX_AMASS`
and adds an axis's shifted step count to a counter kept below it, so
twice the shifted event count has to fit a u32. Nothing checked it:
`go A450000` wrapped the counter mid-move (a panic in a debug build, a
silent wrong step pattern in the release build, which has
`overflow-checks = false`). `stepper::MAX_EVENTS` states the bound and
the machine refuses a longer move with `error:4`.

Board start-up: `board::init` can only claim the laser pin low, which is
the lit state when `laser_invert` is set, so the stored settings are read
and `Machine::drive_laser` is called before the USB and driver tasks
start, rather than waiting for the first poll. After a watchdog reset the
pin returns to an input, so an active-low laser input needs a pull-up and
an active-high one a pull-down on the board itself; firmware cannot cover
that window.

## The laser's resting level at boot

The pin is claimed low, which is the lit level once `laser_invert` is
set, and the earlier note said the output was driven from the stored
settings before the USB and driver tasks started. It was only driven by
the first poll, a millisecond or so later. It is now driven as the note
says, and the tasks start after it.

## Driver sockets (2026-10-07)

- One setting, not four: a socket swap is two axes changing at once, and
  four separate settings would pass through a state with two joints on one
  socket. `sockets=1234` digits follow the `dir_invert` bit order (rail,
  table, slide, focus), not the core's joint order (R A H Z).
- The TMC side is indexed by socket, not by joint, so `Links` keeps
  tracking the same physical driver across a remap; each socket carries the
  letter of its joint for the messages. The board keeps per joint pin
  tables in atomics, rewritten each main loop pass like the step width;
  settings only change at rest, so the step interrupt never sees a half
  written table.
- `sockets` is a frame setting in the backend: the height map is dropped
  when it changes, as a motor swap moves every measured point.

## Wiring settings survive $defaults

`$defaults` puts the tuning back but not the wiring: the four polarities,
and since 2026-10-11 the socket map, the pins and the tool output's
polarity. The test that guards this (`defaults_keep_the_wiring_polarities`)
lists every kept setting; a new setting that describes how the board is
wired (a pin, a polarity, a mapping) goes into both the `defaults`
literal in `machine.rs` and that test, or a `$defaults` typed to clear a
tuning drives an output to its active level or steps another axis's
motor.

## The brake runs dark by its own duty

A hold darkens the beam through a flag the interrupt reads when it loads
a segment, and the resume clears that flag as soon as the ramp has been
written, which can be before it has run. The ramp segments are therefore
written with the dark duty themselves, so nothing queued dark can be lit
by an early resume; the pre-hold segments still queued then run lit at
the speed they were planned for, which is the cut they belong to. The
stretch braked through is not cut again on the resume; PROTOCOL.md says
so under `!`.

## An unnamed axis stays on its step

The planner takes targets in units and re-quantizes every axis. Far from
zero (a table unwrapped past about 1024 degrees at 14222 steps/deg) the
f32 units of a step do not round back to the same step, so a line that
left an axis unnamed moved it a step. The planner now keeps an axis on
its step when its target equals the units it reads as, which is exactly
what `queue_motion` passes for an axis without a word.

## Endstops and homing (2026-10-13)

- Settings per axis: `<x>_stop` (which ends have a switch), `<x>_stop_pin`,
  `<x>_home_pull`, `<x>_home_pos`, `<x>_home_travel`, and two masks,
  `stop_invert` and `limits`, in the `dir_invert` bit order; `joint_bits`
  folds all three masks into the joint order the same way. Blob version 8
  appends 58 bytes; 11 are left before the CRC. The pins are claimed at
  boot for every axis, switch or not, so `<x>_stop` applies without a
  restart; one on an output's pin reads open.
- A home block is the probe mechanism generalized: `StepBlock::watch` is
  `Probe` or `Stop(joint)`, the same latch (`probe_hit`, `probe_at`) and
  the same `probe_ms` queue cap, and the main loop brakes it. `Feed::Axis`
  gives one joint its own units a minute: `Feed::Surface` would take the
  table's rate as a board speed at the radius, zero on the axis.
- The position is declared after the seek as well as after the locate, so
  the locate runs from an absolute pull-off to twice the pull-off and a
  switch with a millimeter of overtravel is never driven through, whatever
  the seek's overtravel was.
- The cycle is a phase machine in `poll_home`, not a queue of pending
  commands: every phase ends with the joint at rest and the planner empty,
  which is also what makes the position declaration safe between phases.
- Limits are level-sampled in the interrupt with a 10 ms debounce summed
  from the tick periods, not edge-triggered: an edge on a bouncing release
  would false-trip. A switch closed when motion starts is masked until it
  opens (what grbl's pin-change interrupt gives for free), so an axis can
  leave the switch it sits on after a home or a power-on.
- The halt drops everything in the interrupt as a probe halt does, and the
  main loop treats it as a lost motor supply: reset, `ALARM:4`, banner.
  The banner is what makes the host's link fail the lines it had sent.
- The polar cross slide is homed and limited from the main loop at the
  poll period: its contact is read once a poll, 0.5 ms, sub-micron at the
  locate rate.
- A simulated switch must sit in physical space: the virtual ports and the
  test rigs count signed steps from start, because a home re-declares the
  reported position mid-cycle, and a switch placed in reported coordinates
  would move with it and never be found again.
- The status line's `D` field appears only once some axis has a switch, as
  `H` and `P` do with `h_axis`, so a host of a machine without any sees no
  change. A home takes the height map's focus offset back on the backend,
  as a `set` does.

## Driver tuning settings (2026-11-08)

`tmc_intpol`, `tmc_toff`, `tmc_tbl`, `tmc_hstrt`, `tmc_hend`,
`tmc_hold_delay`, `tmc_tpowerdown` and `tmc_tpwmthrs` (machine file
`[drivers]` keys `interpolate`, `toff`, `tbl`, `hstrt`, `hend`,
`hold_delay`, `tpowerdown`, `tpwmthrs`) are one value for all four drivers.
Their defaults reproduce the constants written before exactly (pinned by
a test: CHOPCONF 0x14030053, IHOLD_IRUN 0x000A190C for 800 mA at 16
microsteps, TPOWERDOWN 20, TPWMTHRS 0). Done by a subagent in a worktree;
the Rev 1.09 datasheet PDF could not be fetched, so fields and ranges were
checked against the `tmc2209` crate's register docs, which quote it.

- TSTEP counts 12 MHz clocks between 1/256 microsteps whatever MRES is, so
  TPWMTHRS = 46875 / full steps per second (10 mm/s on a 5 mm lead: 117).
  One value for every driver switches at the same full-step rate on every
  axis, not the same mm/s; with the 1/16 hysteresis it leaves stealthChop
  about 7% above that rate and comes back at it.
- The datasheet rules out pairs: TOFF 1 only with TBL 2 or 3; HSTRT + HEND
  (register sum at most 18); TPOWERDOWN at least 2 for stealthChop's
  automatic tuning. The firmware takes settings one at a time, so a pair
  check there would refuse good files by write order: the pairs are
  checked in the machine file readers (`_check_tuning` and its mock twin),
  as pin clashes are. Console writes are not checked against each other.
- A configuration is six writes now (GSTAT clear, GCONF, IHOLD_IRUN,
  CHOPCONF, TPOWERDOWN, TPWMTHRS); `apply` compares IFCNT with the
  datagrams' count.
- Blob version 10, and the blob is full: the fields end at the CRC (offset
  252). The next setting needs a longer blob with the CRC's place taken
  from the version (the sector is 4096 bytes). A version 9 blob reads with
  the tuning at its defaults; its zero padding read as version 10 would be
  TOFF 0 and lose the whole blob, wiring included, which a test covers.
- Downgrading after a `$save` on version 10 discards the stored settings,
  wiring included: an active-low laser comes back at the default polarity.
  Every machine file carries all the settings, so loading one onto older
  firmware is refused.
- TBL 2 and TPWMTHRS 0 are what a part with unprogrammed OTP comes up
  with; a part with OTP programmed now gets 0 written.
- Left out, worth a look later: StallGuard (SGTHRS with TCOOLTHRS) for
  sensorless homing, CoolStep (COOLCONF), PWMCONF, CHOPCONF dedge (steps on
  both edges, half the step rate needed).

## Servos (2026-11-13)

- Four slots, `servoN_out/pin/chan/min_us/max_us/range/start`, and the bus
  (`i2c_sda`, `i2c_scl`, `pca_addr`). Version 10 had filled the 256 byte
  blob, so version 11 is 512 bytes with the CRC's place taken from the
  version (`blob_len`). The flash read is `BLOB_LEN` long, so an old blob
  arrives with the erased sector (0xFF) behind it, which `from_blob`
  ignores by the version's own length; tests build old blobs with
  `old_blob`, never by patching the version byte of a new one (the CRC
  would be at the wrong place).
- `servo` is a sync command like `spindle S`: it waits for queued motion,
  is taken in Idle, Run and a hold of a run, and a hold latched from idle
  waits for it in Hold. Its `T` is a dwell without a beam (state Run, so
  the tool output follows it as it follows a plain dwell).
- Servos keep their angle through holds, resets, alarms, a lost supply
  and disconnects: no hazard like a beam, and one holding a tool clear
  must not drop it (QUESTIONS.md Q7). A wiring change (out, pin, channel)
  clears the angle instead of jumping the servo to the old one on the new
  output; a span or range change re-drives the angle at once.
- `$defaults` keeps every servo and bus setting: a mechanism set up
  narrower than 1000 to 2000 us would be driven against its stops at once.
- Rules joining two settings stay out of the firmware (writes come one at
  a time): a start past the range is held to it at use, and the bus pair
  is only held to SDA even and SCL odd; the block match is the machine
  file's, and the board's at boot.
- The STOP headers' GPIOs (3, 4, 16, 25) reach the chip through a
  74LVC2G34, so a servo or bus pin there would drive against the buffer:
  `output_pin_valid` refuses them for servo pins and the bus. The laser and
  tool pins are refused them only by machine files (16bce86): in
  `is_valid` a stored blob with one would be thrown away, wiring included.
