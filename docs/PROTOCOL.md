# Firmware line protocol

The firmware is a joint-space motion controller: it moves the radius motor
(`R`, mm) and the table motor (`A`, degrees) along straight lines in joint
space and drives the laser. Board geometry never reaches it; the host turns
board paths into short joint moves (see `spinny_laser.polar`) and streams
them. Everything is ASCII text over USB CDC.

## Transport

- One command per line, terminated by `\n` (`\r` is ignored).
- A line is at most 96 bytes. Longer lines are rejected with `error:8`.
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
  alarm is raised, `<...>` status only in answer to `?`.

## Realtime bytes

Acted on the moment they arrive, even in the middle of a line, and never
part of the line.

| Byte | Action |
| --- | --- |
| `?` | one status line |
| `!` | hold: decelerate to a stop, laser off, state `Hold`; a beam lit by `laser` is closed from any state |
| `~` | resume from `Hold` |
| `0x18` | reset: stop at once, flush everything, laser off; `Alarm:1` if it was moving, else `Idle` |
| `0x85` | jog cancel: decelerate, discard the rest of the jog, `Idle` |

## Motion commands

Queued. `ok` is sent when the move is in the planner. A missing axis word
keeps that axis where it is.

| Command | Effect |
| --- | --- |
| `go [R<mm>] [A<deg>]` | rapid, laser off, each axis at its max rate; both axes arrive together |
| `cut [R<mm>] [A<deg>] [F<mm/min>] [S<power>]` | line at surface speed `F` with laser power `S`; `F` and `S` are modal for later `cut` lines |
| `jog [R<mm>] [A<deg>] [F<mm/min>]` | relative move, laser off, cancelable; without `F` at the `jog_r`/`jog_a` rates |
| `jogto [R<mm>] [A<deg>] [F<mm/min>]` | absolute jog |
| `dwell T<ms> [S<power>]` | wait after motion (`T` at most 600000); with `S` the laser is on at constant `S` for the dwell (a spot burn) |

Surface speed: the length of a joint move on the board is taken as
`hypot(dr, r_mean * da_rad)` with `r_mean = (r0 + r1) / 2`. A move whose
surface length is under 1 um (a turn on the axis) runs at the max rates with
the laser off. Speed is capped by `r_rate` and `a_rate`; under `mode dyn`
the laser power follows the achieved speed so the dose per mm holds.

Jogs are accepted in `Idle` and `Jog` only. `R` under 0 is refused
(`error:4`); with `r_max` set, `R` over it is refused too. The angle is not
limited and keeps counting, but one move may not cover more than 2^28 steps
on an axis (`error:4`): about 18878 degrees or 26214 mm at the default
scales, past which the step generator's counters would wrap.

The step generator emits at most 100000 steps a second, which at a fine
enough `r_steps` or `a_steps` binds before `r_rate` or `a_rate` do. The
planner caps the speed by whichever comes first, so a move commanded
faster simply runs at the rate the axis can be stepped at, and under `mode
dyn` the laser power follows it down. The ceiling in units per minute is
`6000000 / steps`: at the defaults that is 586 mm/min and 422 deg/min.

## Laser

| Command | Effect |
| --- | --- |
| `mode dyn` | default: `cut` power is `S * achieved / requested` speed, off when stopped |
| `mode const` | `cut` power is `S` while moving |
| `laser S<power> [T<ms>]` | constant beam, `Idle` only, off after `T` ms (default `laser_ms`, max 60000) |
| `laser off` | beam off |

The beam is off during `go`, jogs, holds, alarms, after a reset, when the
USB host disconnects, and when the planner runs dry. `S` is 0 to `s_max`
and maps linearly to PWM duty; in `dyn` mode a computed power below `s_min`
is set to 0.

## Position and state

| Command | Effect |
| --- | --- |
| `set [R<mm>] [A<deg>]` | declare the current position (`Idle` only); `set R0` after driving the beam over the axis |
| `enable` / `disable` | motor enable pins; any motion enables them; `disable` loses the microstep position |
| `unlock` | clear an alarm |
| `mode`, `laser`, `set`, `enable`, `disable` | sync commands: they wait until queued motion is done |
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
| `$defaults` | factory values in RAM (`Idle` only) |
| `$tmc` | driver status lines from the TMC2209 UART |

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
| `r_max` | mm | 0 | soft limit, 0 = off |
| `jog_r` | mm/min | 300 | jog rate without `F` |
| `jog_a` | deg/min | 200 | |
| `dir_invert` | mask | 0 | bit 0 radius, bit 1 table |
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
| `tmc_stealth` | 0/1 | 1 | stealthChop, else spreadCycle |

Changing a `tmc_*` setting re-sends the driver configuration.

## Status line

```
<Idle|J:12.345,90.1234|V:0|L:0|Q:32,16|M:dyn|E:1>
```

| Field | Meaning |
| --- | --- |
| state | `Idle`, `Run`, `Jog`, `Hold`, `Alarm:<code>` |
| `J` | joint position from the executed steps: radius mm, angle deg |
| `V` | surface speed of the move in progress, mm/min |
| `L` | laser duty in permille, as driven |
| `Q` | free planner blocks, free line slots |
| `M` | power mode |
| `E` | motors enabled |

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
| `error:9` | flash write failed |
| `ALARM:1` | reset while moving, the position may be off; `unlock` clears it |

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
<Run|J:7.512,135.0000|V:300|L:400|Q:30,16|M:dyn|E:1>
```
