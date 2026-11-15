# Axes out of square on a G-code machine

## The decision (Q48, answered A on 2026-11-15)

The LumenPnP's X and Y are 0.12 to 0.16 degrees out of square (Measure
camera from head moves; the survey's affine fit 89.86 to 89.89; the
mosaic's refit 0.121). Asked how to take it out: A, the G-code link from a
machine file key; B, Marlin's SKEW_CORRECTION (M852); C, leave it. The user
answered A and asked for B as an option in the config. So `[motion] skew`
(the factor) and `skew_by` ("link", the default, or "firmware"), and
`[gcode] skew` (the line, `M852 I{skew}`; empty for a build with the factor
compiled in). The LumenPnP file got `skew = 0.0023` (tan 0.13 deg).

Why A by default: the stock Lumen Marlin has no M852 (B means a rebuilt
and flashed firmware), and the link's correction holds for every
controller. Cost the user accepted: every place kept in machine numbers
moves by the change times Y (up to 0.9 mm at Y 400) and is measured again
once. Places were not converted automatically: the measured ones live in
var/config.json (the bottom camera's place) as well as in the file.

## Conventions, checked against both firmwares

- `skew` = how far the head's Y travel leans toward +X, mm of X per mm of
  Y: uncorrected, a head sent to X Y stands at X + skew * Y. It is
  tan(90 - angle from +X to +Y). Measure camera's `skew_deg` is that angle
  less 90, so 89.88 degrees reads -0.12 and means skew +0.0021.
- Marlin: planner skew() sends motors X - xy * Y and unskew() reads
  X + xy * Y, and XY_SKEW_FACTOR = tan(90 - angle DAB): the same factor
  and sign, so one number serves both `skew_by` values.
- OpenPnP 2: ReferenceLinearTransformAxis on X, transformed = factorX * X
  + factorY * Y (raw to transformed): factor-y is our skew. OpenPnP 1's
  GcodeDriver non-squareness-factor went transformed to raw (X + f * Y
  out), so its migration negates it; the import does too. OpenPnP's
  stored places are transformed (square) ones, which is why the import
  must carry the factor.

## Traps met

- On skewed axes the controller's X holds Y: a move or G92 that names
  only X or only Y must name both (move_line takes `here`; G92 of one
  axis reads the place first and declares the other again where it is),
  and a position reply with X but no Y is no place (read_position drops
  the X).
- Marlin answers an unknown command with `echo:Unknown command: "..."`
  and then `ok`, not an error: the link would take M852 as done. The
  backend looks for "unknown command" in the reply and refuses the
  connect (502), since a firmware that was to correct and cannot would
  put every place up to 1 mm off.
- M852 changing the factor makes Marlin re-derive its numbers from the
  motors (the head does not move, its X numbers do): read the place after
  it, never before. The connect sends it before its first M114.
- The firmware's factor is state the file does not hold: the link keeps
  `skew_told` per connection, and every gate that sends the head lines
  (`_gcode_movable`, `_placing_idle`) and a file write while idle tell
  the firmware when the file's wanted factor differs (0 when the file
  gives the skew back to the link). Across a backend restart that memory
  is gone: a firmware told a factor keeps it in RAM until it resets.
- The virtual LumenPnP models it: `skew` (its own lean) and
  `skew_gcode` (M852 known); bed = numbers + origin, X + (skew - factor)
  * Y; an M852 change moves the X numbers by the change times Y.
- Measure camera measures the axes through whatever skew is taken out
  now, so it says file skew + (-tan skew_deg); keeping it is left to the
  operator (it moves every stored place).
