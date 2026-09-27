# Firmware line protocol

The firmware is a joint-space motion controller: it moves the radius motor
(`R`, mm) and the table motor (`A`, degrees) along straight lines in joint
space and drives the laser. Board geometry never reaches it; the host turns
board paths into short joint moves (see `spinny_laser.polar`) and streams
them. Everything is ASCII text over USB CDC.

Two settings change what the machine is, and both are off by default:
`cartesian` makes the cross slide `Z` a joint, so the radius is X and the
slide Y of an X/Y machine (see [Cartesian](#cartesian)), and `spindle`
turns the laser output into a spindle's (see [Spindle](#spindle)).

## Transport

- One command per line, terminated by `\n` (`\r` is ignored). A byte
  outside 0x20..0x7E inside a line is read as a literal `?` and a tab as
  a space, so UTF-8 or a control byte in a line ends in `error:2`.
- A line is at most 96 bytes. Longer lines are rejected with `error:8`.
- An empty line, or one that is only a `;` comment, is answered `ok` and
  spends a credit like any other.
- Keyword first, then words: a letter directly followed by a decimal number
  (`R12.5`, `A-90`, `F400`, `S500`, `T250`). Words are separated by spaces.
  Case does not matter. Text after `;` is ignored.
- Every line is answered with exactly one `ok` or `error:<code> <text>` line
  once the command has been accepted (motion: queued in the planner;
  sync commands: executed).
- The firmware keeps 16 lines waiting behind the planner. The host may have
  at most 16 unanswered lines in flight. Beyond that the USB endpoint stalls
  and realtime bytes cannot get through either, so the credit must be kept.
- Unsolicited lines: `[spinny v<version> lines:16 blocks:32]` at connect and
  after a reset, `[MSG:<text>]` for notes, `ALARM:<code> <text>` when an
  alarm is raised, `<...>` status only in answer to `?`. `[PRB:<h>:<0|1>]`
  comes just before the answer to a `probe`, as part of it.

## Realtime bytes

Acted on the moment they arrive, even in the middle of a line, and never
part of the line.

| Byte | Action |
| --- | --- |
| `?` | one status line |
| `!` | hold: decelerate to a stop, laser off, state `Hold`; the report says `Hold` only once the brake has finished and keeps `Run`/`Jog` until then, so a reset sent on seeing `Hold` loses no steps; a hold that finds the machine idle with a motion line taken in or waiting is kept for that line and applied as it starts (a `laser S` it was kept for is answered and stays dark, a cross slide jog ends before its first step, and a `spindle S` waits in `Hold` for the resume); a beam lit by `laser` is closed from any state |
| `~` | resume from `Hold`; a probe braking at its contact finishes the brake and ends as a contact whatever `~` asks |
| `0x18` | reset: stop at once, flush everything, laser off, and forget the modal state (`F`, `S`, `mode` back to `dyn`); prints `[MSG:reset]`, then `ALARM:1 reset while moving, position may be off` if it was moving, then the banner; `Alarm:1` if it was moving, else `Idle`; an alarm already raised stays until `unlock` |
| `0x85` | jog cancel: decelerate, discard the rest of the jog, `Idle`; a `probe` waiting behind the jog is ended unrun with `[PRB:<h>:0]` and `ok` |

## Motion commands

Queued. `ok` is sent when the move is in the planner. A missing axis word
keeps that axis where it is.

| Command | Effect |
| --- | --- |
| `go [R<mm>] [A<deg>] [H<mm>]` | rapid, laser off, each axis at its max rate; the axes arrive together |
| `cut [R<mm>] [A<deg>] [H<mm>] [F<mm/min>] [S<power>] [M<power>]` | line at surface speed `F` with laser power `S`; `F` and `S` are modal for later `cut` lines; `M` is the least power in `dyn` mode, for this line only |
| `jog [R<mm>] [A<deg>] [H<mm>] [F<mm/min>]` | relative move, laser off, cancelable; without `F` at the `jog_r`/`jog_a`/`jog_h` rates |
| `jogto [R<mm>] [A<deg>] [H<mm>] [F<mm/min>]` | absolute jog |
| `dwell T<ms> [S<power>]` | wait after motion (`T` at most 600000); with `S` the laser is on at constant `S` for the dwell (a spot burn) |

With `cartesian` set the moves also take `Z`, and `go` and `cut` no longer
take `A`.

Surface speed: the length of a joint move on the board is taken as
`hypot(dr, r_mean * da_rad)` with `r_mean = (r0 + r1) / 2`. On a cartesian
machine the head sits `hypot(R, Z)` from the rotation axis, so it is
`hypot(dr, dz, hypot(r_mean, z_mean) * da_rad)` there: a jog that turns the
table to line a board up takes `F` as the speed the board passes under the
head, as on a polar machine. A move whose
surface length is under 1 um (a turn on the axis) runs at the max rates with
the laser off. Speed is capped by `r_rate` and `a_rate`; under `mode dyn`
the laser power follows the achieved speed so the dose per mm holds.

Which commands each state takes:

| State | Accepted |
| --- | --- |
| `Idle` | everything but `unlock` |
| `Run` | `go`, `cut`, `dwell`, `probe`, `spindle` |
| `Jog` | jogs, `probe`, `spindle off` |
| `Hold` | `go`, `cut`, `dwell` and `spindle S` in a hold of a run, `probe` in any hold: they are taken in and wait for the resume |
| `Alarm` | `unlock`, `spindle off` |

Queries (`?`, `status`, `version`, `help`, `$`, `$<name>`, `$tmc`) are
answered at once in every state. `mode`, `enable` and `laser off` are taken
in every state and answered once queued motion is done, so in a hold with
moves queued they wait for the resume. `set`, `disable`, `laser S`,
`$<name>=<value>`, `$save`, `$load` and `$defaults` are taken in `Idle`
only. Anything a row does not name is `error:5` in that state.

`unlock` outside `Alarm` is `error:5`, and any move is `error:5` while the
cross slide moves or a jog cancel is still braking. Jogs are accepted in
`Idle` and `Jog` only. Any move may take `R` past
the axis and out the far side, and `set R<negative>` declares the head
parked there. A jog goes there to be lined up with the axis, stepping
through zero. A `go` or `cut` goes there to reach a board point from the
far side: it is the same board point half a turn away, but the head's
offset from the axis is mirrored there, which is what a calibration burn
compares. A job written in board coordinates never asks for it; the host
sends a negative radius only for a joint-space group that says so. With
`r_max` set, a move further out than it is refused on either side. The
angle is not limited and keeps counting, but one move may not cover more
than 2^28 steps
on an axis (`error:4`): about 18878 degrees or 26214 mm at the default
scales, past which the step generator's counters would wrap. A position
is counted in 32-bit steps, so a target or a `set` past 2^31 steps from
zero (about 150995 degrees or 209715 mm at the default scales) is refused
the same way rather than moved to short of where it says.

The step generator emits at most 100000 steps a second, which at a fine
enough `r_steps` or `a_steps` binds before `r_rate` or `a_rate` do. The
planner caps the speed by whichever comes first, so a move commanded
faster simply runs at the rate the axis can be stepped at, and under `mode
dyn` the laser power follows it down. The ceiling in units per minute is
`6000000 / steps`: at the defaults that is 586 mm/min and 422 deg/min.
The step pulse is held inside that tick, so a `step_us` above 4 stretches
the tick to about `1.5 * step_us + 3` microseconds and lowers the ceiling
with it: at `step_us` 10 to 55000 steps a second, at 20 to 30000. `F`
below 0.001 is refused (`error:4`).

## The focus axis and the probe

`H` is the focus axis: the head's height in mm, up positive. It is
optional, and fitted only when `h_axis` is 1; without it any `H` word, and
`probe`, is `error:2`, and the status line leaves its fields off. Unlike
the cross slide it is a joint like `R` and `A`: it takes part in `go`,
`cut` and jogs, and moves along with them, so a cut can follow the
board's height. `F` stays the board surface speed; a move that only
raises or lowers the head (nothing moves on the board) takes `F` as the
speed of `H` instead, and is dark. `r_rate`-style limits apply to it
through `h_rate`, `h_accel` and `h_jerk`.

| Command | Effect |
| --- | --- |
| `probe H<mm> [F<mm/min>]` | move the focus axis by up to `H` mm (relative, signed: negative is down) at `F` (default `jog_h`) until the probe input goes active |

`probe` is taken in `Idle`, `Run`, `Jog` and `Hold`, waits for the motion
queued before it (and for the resume of a hold), and is answered only
when it ends; nothing runs behind it
meanwhile. The state is `Jog` while it moves.

- Contact: `[PRB:<h>:1]` then `ok`, with `<h>` the `H` position in mm, four
  decimals, when the input went active, read at every step: the queue
  below changes where the head stops, not the height reported. The head
  brakes from there: a probe keeps only `probe_ms` of motion queued
  (20 ms by default, in whole 10 ms segments), and with the segment being
  stepped it stops about `F / 60 * (probe_ms + 10) / 1000` mm plus the
  braking distance past the contact. With `probe_ms` 0 and `F / 60` within
  `h_jerk` (the speed the axis may change at once) there is no brake:
  the interrupt stops the axis at the step the contact was read on. A
  faster probe with `probe_ms` 0 brakes from one queued segment.
- No contact within the distance: `[PRB:<h>:0]`, `ALARM:2 probe missed,
  check the head before moving`, then `error:11 probe missed`. The machine
  stays in `Alarm:2` until `unlock`: the head went further down than
  whoever sent the line meant, and whatever they queued next would drag
  it across the board.
- Already active at the start: `error:10 probe active`, and nothing moves.
- A spindle turning when it would start (the probe may be the tool
  itself): `error:5 not now`, and nothing moves.
- `0x85` ends it like a jog: `[PRB:<h>:0]` (or `:1` if it had touched)
  and `ok`, no alarm. `!` holds it and `~` goes on with it. A reset ends
  it with no answer, as it does any line, and raises `Alarm:1` when it
  was moving.

The input's polarity is `probe_invert`: 0 is active low, as a switch or a
pin touching grounded copper pulls it down against the pull-up.

## The cross slide

`Z` is the cross slide that carries the rail across the rotation axis. On
a polar machine (`cartesian` 0, the default) it is a setup axis: it never
takes part in a cut, it moves on its own, and it is accepted only in
`Idle`. Nothing else moves while it does, and the state is `Jog` until it
stops. On a cartesian machine it is a joint instead; see
[Cartesian](#cartesian).

| Command | Effect |
| --- | --- |
| `jog Z<mm> [F<mm/min>]` | relative, at `jog_z` without `F` |
| `jogto Z<mm> [F<mm/min>]` | absolute |
| `set Z<mm>` | declare the position, as for `R` and `A` |

`Z` cannot be combined with `R`, `A` or `H` on one line (`error:2`): they
are not interpolated together, and `go` and `cut` do not take it at all.
With `z_max` set, a move to further than that from zero is refused
(`error:4`). The slide is stepped from the main loop at
most 20000 steps a second, so its rate ceiling is `1200000 / z_steps`,
117 mm/min at the default scale, and a `z_rate` or `jog_z` above that is
held to it. `0x85` cancels a `Z` jog like any other.
`!` also brakes it to a stop, but the state goes to `Idle` rather than
`Hold`: a setup move has no queue behind it for `~` to take up. A reset
stops it on the spot, and raises no alarm, because the slide counts its
own steps and its position is still good. The beam is off throughout.

## Cartesian

With `$cartesian=1` the cross slide is the fourth joint, stepped by the
same interrupt as the others: the radius is X, the slide Y, and the two
are interpolated with each other and with the focus axis, so `cut R3 Z4
F300` is a straight 5 mm line on the board at 300 mm/min. The table holds
its angle, so `go` and `cut` refuse `A` (`error:2`); a jog may still turn
it, to line a board up, and `set A` still declares it. `Z` then goes on
`go`, `cut`, `jog`, `jogto` and `set` like any joint word, takes part in
holds, resets and jog cancels like the others, and moves at `z_rate`,
`z_accel`, `z_jerk` and `jog_z` with the step interrupt's ceiling, not the
setup stepper's. `r_max` and `z_max` hold it to a box around zero.

Switching `cartesian` (from `Idle`, as any setting) hands the slide's
position over, so it stays where it was either way. Y is measured from
`Z0`: with `Z0` set where the rail passes over the rotation axis, board
X/Y turned by the table angle is the same frame a polar job uses. That
frame needs `+Z` 90 degrees counterclockwise of `+R` seen from above: at
`A0` with the head out on `R`, `jog Z1` carries the beam over the board
the same way a small positive `A` turn does. The other way round mirrors
every cartesian job and height map; bit 2 of `dir_invert` turns it, and
`Z0` has to be set again over the axis after that.

## Spindle

With `$spindle=1` the laser output drives a spindle's speed input and the
focus axis is its depth axis. `S` is the spindle's speed, mapped to duty
like a beam's power, `laser_invert` included.

| Command | Effect |
| --- | --- |
| `spindle S<speed>` | start the spindle, or change its speed, once queued motion is done; taken in `Idle` and `Run`, and during a hold of a run, where it waits for the resume |
| `spindle off` | stop it once queued motion is done; taken in any state |

The spindle keeps turning through `go`, `cut`, jogs, dwells, holds and the
end of motion: a hold stops the tool where it is and the resume drives it
on, still turning. `spindle off`, `laser off`, a reset, a USB disconnect
and an alarm (a missed probe) stop it. The step interrupt never writes the
output, and the status line's `L` is the spindle's duty. `S` and `M` on
`cut` and `S` on `dwell` are refused (`error:2`), so a laser job sent to a
spindle machine fails on its first cut rather than running, and so is
`laser S`; `spindle` on a laser machine is refused the same way. `cut` is
refused (`error:5`) while the spindle is stopped (never started, stopped
by `spindle off` or `laser off`, or started at `S0`): a job whose spindle
was stopped under it ends at its next cut rather than dragging a still
tool through the board. `go` and jogs still move. The host waits out the
spin-up with a `dwell` after `spindle S`.

## Laser

| Command | Effect |
| --- | --- |
| `mode dyn` | default: `cut` power is `S * achieved / requested` speed, but not below the line's `M`; off when stopped |
| `mode const` | `cut` power is `S` while moving |
| `laser S<power> [T<ms>]` | constant beam, `Idle` only, off after `T` ms (default `laser_ms`, max 60000) |
| `laser off` | beam off |

The beam is off during `go`, jogs, holds, alarms, after a reset, when the
USB host disconnects, and when the planner runs dry (a spindle is not; see
[Spindle](#spindle)). A USB disconnect is a
full reset: the queue is flushed, the modal state forgotten, and a machine
that was moving is left in `Alarm:1`. A disconnect is the bus going away (a
cable pulled, the host suspended or reset); a program that only closes the
serial port is not one, and leaves the queue, a beam or a spindle running,
so a host stops the output itself before it closes. `S` is 0 to `s_max`
and maps linearly to PWM duty; in `dyn` mode a computed power below `s_min`
is set to 0. `M` holds the beam up where the head slows for a corner: an `M`
above `S` counts as `S`, a turn on the axis stays dark, and `s_min` still
turns off a floor below it.

## Position and state

| Command | Effect |
| --- | --- |
| `set [R<mm>] [A<deg>] [H<mm>] [Z<mm>]` | declare the current position (`Idle` only); `set R0` after driving the beam over the axis; `Z` alone on a polar machine |
| `enable` / `disable` | motor enable pins; any motion enables them; `disable` loses the microstep position |
| `unlock` | clear an alarm |
| `mode`, `laser`, `spindle`, `set`, `enable`, `disable` | sync commands: they wait until queued motion is done |
| `version` | `[spinny v<version> ...]` |
| `status` | same as `?` |
| `help` | short command list |

## Settings

| Command | Effect |
| --- | --- |
| `$` | every setting as `name=value` lines, then `ok` |
| `$<name>` | one setting |
| `$<name>=<value>` | set in RAM (`Idle` only) |
| `$save` | write to flash (`Idle` only) |
| `$load` | reload from flash (`Idle` only) |
| `$defaults` | factory values in RAM (`Idle` only), except the wiring: `laser_invert`, `en_invert`, `probe_invert` and `dir_invert` keep their values, so an active-low laser is not lit by it |
| `$tmc` | `ok` at once, then, as the drivers answer over their UART, one line per driver, all four: `[MSG:tmc <axis> addr<n> ifcnt=<n> micro=<n> status=0x........]`, or `[MSG:tmc <axis> addr<n> no reply, is motor power on]`; a driver no axis uses (the focus axis's without `h_axis`) says `unused, ` after its address, and not answering is no fault for it. `micro` is the resolution the driver steps at, from the MS1/MS2 pins until the configuration selects the register; `ifcnt` counts the writes it took, 4 for each configuration. A host reads the report after the `ok`, not before it; `[MSG:tmc configured]` and `[MSG:tmc <axis> addr<n> refused config, retrying]` arrive unasked, and so does `[MSG:tmc <axis> addr<n> lost motor power, position may be off]`, after which the board resets itself as `0x18` does (`ALARM:1` if it was moving) and configures the drivers again: the motors held nothing meanwhile, so the position may be off even from `Idle` |

A value outside its bounds is `error:7`; an integer setting refuses
decimal text such as `5000.0`. Steps, rates, accelerations and jerks must
be above 0; `r_max` at least 0; `dir_invert` 0..15; `step_us` 1..20;
`laser_hz` 100..100000; `laser_ms` 1..60000; `s_max` above 0 and `s_min`
0..`s_max`; `tmc_*_ma` at most 2000; `tmc_hold_pct` at most 100; the
microsteps a power of two up to 256.

| Name | Unit | Default | Meaning |
| --- | --- | --- | --- |
| `r_steps` | steps/mm | 10240 | 200 steps * 256 microsteps over a 5 mm screw |
| `a_steps` | steps/deg | 14222.222 | 200 steps * 256 microsteps * 100:1 / 360 |
| `r_rate` | mm/min | 560 | max radius rate |
| `a_rate` | deg/min | 400 | max table rate |
| `r_accel` | mm/s^2 | 50 | |
| `a_accel` | deg/s^2 | 50 | |
| `r_jerk` | mm/s | 3 | allowed speed change at a corner |
| `a_jerk` | deg/s | 2 | |
| `r_max` | mm | 0 | soft limit on the distance from the axis, either side; 0 = off |
| `z_steps` | steps/mm | 10240 | cross slide |
| `z_rate` | mm/min | 560 | max cross slide rate |
| `z_accel` | mm/s^2 | 50 | |
| `jog_z` | mm/min | 120 | jog rate without `F` |
| `jog_r` | mm/min | 300 | jog rate without `F` |
| `jog_a` | deg/min | 200 | |
| `dir_invert` | mask | 0 | bit 0 radius, bit 1 table, bit 2 cross slide, bit 3 focus axis |
| `en_invert` | 0/1 | 0 | 1 = enable pin active high |
| `idle_ms` | ms | 0 | disable motors after idle, 0 = never |
| `step_us` | us | 2 | step pulse width |
| `laser_hz` | Hz | 5000 | PWM frequency |
| `s_max` | | 1000 | `S` for full duty |
| `s_min` | | 0 | dyn mode: below this the beam is off |
| `laser_invert` | 0/1 | 0 | 1 = active low output |
| `laser_ms` | ms | 5000 | default `T` for `laser` |
| `tmc_r_ma` | mA | 800 | run current, 0 leaves the driver untouched |
| `tmc_a_ma` | mA | 800 | |
| `tmc_hold_pct` | % | 50 | hold current as a share of run |
| `tmc_r_micro` | | 256 | microsteps |
| `tmc_a_micro` | | 256 | |
| `tmc_z_ma` | mA | 800 | cross slide run current |
| `tmc_z_micro` | | 256 | |
| `tmc_stealth` | 0/1 | 1 | stealthChop, else spreadCycle |
| `h_axis` | 0/1 | 0 | a focus axis is fitted |
| `h_steps` | steps/mm | 6400 | 200 steps * 256 microsteps over an 8 mm lead |
| `h_rate` | mm/min | 600 | max focus axis rate |
| `h_accel` | mm/s^2 | 50 | |
| `h_jerk` | mm/s | 1 | |
| `jog_h` | mm/min | 120 | jog and probe rate without `F` |
| `probe_invert` | 0/1 | 0 | 1 = probe input active high |
| `tmc_h_ma` | mA | 600 | focus axis run current; its driver is left alone while `h_axis` is 0 |
| `tmc_h_micro` | | 256 | |
| `probe_ms` | ms | 20 | motion queued during a probe, 0 to 160: how long the head goes on past contact before it brakes; 0 stops it dead when the probe is within `h_jerk` |
| `z_jerk` | mm/s | 3 | cross slide's allowed speed change at a corner, as a joint |
| `z_max` | mm | 0 | soft limit on the cross slide, either side of zero; 0 = off |
| `cartesian` | 0/1 | 0 | the cross slide is a joint: Y of an X/Y machine with the radius as X |
| `spindle` | 0/1 | 0 | the laser output drives a spindle |

Changing a `tmc_*` setting or `h_axis` re-sends the driver configuration.
Changing `spindle` stops whatever runs on the output.

Settings stored by a firmware from before `probe_ms` (the stored layout
changed, and the first focus axis firmware is one of them) are thrown away
at boot: set them again, `laser_invert` first, and `$save`. Until then the
output runs at the defaults' polarity, which lights an active-low module.
Settings stored before `z_jerk`, `z_max`, `cartesian` and `spindle` are
read, with those four at their defaults.

## Status line

```
<Idle|J:12.345,90.1234|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>
<Idle|J:12.345,90.1234|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000|H:-1.250|P:0>
```

The second form is with `h_axis` set.

| Field | Meaning |
| --- | --- |
| state | `Idle`, `Run`, `Jog`, `Hold`, `Alarm:<code>` |
| `J` | joint position from the executed steps: radius mm, angle deg |
| `V` | surface speed of the move in progress, mm/min |
| `L` | laser duty in permille, as driven; a spindle's duty with `spindle` |
| `Q` | free planner blocks, free line slots (the 16 credits less the lines received and not yet answered) |
| `M` | power mode |
| `E` | motors enabled |
| `Z` | cross slide position, mm, whether the setup stepper or the joints moved it |
| `H` | focus axis position, mm; only with `h_axis` |
| `P` | 1 while the probe input is active; only with `h_axis` |

## Errors and alarms

| Code | Meaning |
| --- | --- |
| `error:1` | unknown command |
| `error:2` | bad word or number |
| `error:3` | missing word |
| `error:4` | value out of range |
| `error:5` | not allowed in this state |
| `error:6` | unknown setting |
| `error:7` | bad setting value |
| `error:8` | line too long |
| `error:9` | flash failed: `$save` could not write, or `$load` found nothing valid stored |
| `error:10` | probe active: the probe input was already active when a `probe` was to start |
| `error:11` | probe missed: a `probe` went its whole distance without contact (with `ALARM:2`) |
| `ALARM:1` | reset while moving, the position may be off; `unlock` clears it |
| `ALARM:2` | probe missed: the head is lower than the probe was meant to take it; `unlock` clears it |

## Example session

```
[spinny v0.1.0 lines:16 blocks:32]
set R0 A0
ok
go R10
ok
cut A90 F300 S400
ok
cut A180
ok
go R0 A0
ok
?
<Run|J:7.512,135.0000|V:300|L:400|Q:30,16|M:dyn|E:1|Z:0.000>
```
