# Machine files and the cartesian machines

## The cross slide

The rail has to pass over the table's rotation axis, and the cross slide
`Z` is what moves it there. It is a setup axis: it never takes part in a
cut, it moves alone, only from `Idle`, with the beam off, and a `Z` word
on a line with `R` or `A` is a bad word rather than a three-axis move.

That keeps it out of the coordinated motion core entirely. `AXES` is
still 2, the planner and the stepper are untouched, and `slide.rs` is its
own small trapezoid: a step count, a cruise rate and a ramp, with no
lookahead and no junction to plan against. One move is

    v(i) = min(cruise, sqrt(2 a (i + 1/2)), sqrt(2 a (total - i - 1/2)))

read at the middle of step `i`, all in steps a second. Taking the speed
from the step index rather than integrating it means the move ends on the
step it was asked for however the arithmetic rounds, and the form is
conservative: the acceleration it actually produces is always a little
under `z_accel`, never over.

It is stepped from the main loop rather than from the step timer, because
nothing is tied to its timing. The price is jitter, which a rate cap of
20 kHz makes irrelevant: a 500 us loop carries about ten steps a pass,
and a late pass emits at most 32 before handing the loop back, so a
stalled poll cannot turn into a long blocking burst and trip the
watchdog. Step periods are rounded up to whole microseconds so the rate
reached is never above the rate asked for.

A jog cancel brakes it by shortening the move to the braking distance and
letting the same ramp run out; a reset or a disconnect drops it where it
stands. Either way the position is the steps actually pulsed, so stopping
it never costs a position and never raises an alarm.

The settings blob gained six fields, which still fit the 128 byte sector
with its CRC. The version byte went to 2 so a blob written by the older
firmware is thrown away rather than read with every field after `r_max`
four words out of place, which would pass the CRC and hand back rates and
currents nobody stored.

## Cartesian mode and a spindle

- "Radius and x adjuster" read as the rail (R) and the cross slide (Z):
  the slide carries the rail across the axis, so the two are an X/Y pair
  when the table holds. There was no other axis it could mean.
- The slide became a fourth joint (`AXES = 4`) rather than a remap of the
  table's slot in cartesian mode. The remap would have kept the arrays at
  three but made `J`'s second number mean degrees or mm by mode and needed
  the port to reroute step bits. With four joints the planner, interrupt
  and settings arrays just grow; polar mode never moves joint 3 because
  `Z` words there still go to `Slide`.
- The surface length is `hypot(dr, r_mean * da, dz)` in both modes: `dz`
  is 0 on a polar machine and `da` on a cartesian `go`/`cut` (refused), so
  no mode switch is needed in the planner.
- The settings blob keeps version 4's field order (the slide's values in
  their old scalar places) and appends the new fields, so a version 4
  blob is still read with defaults for the rest.
- Switching `cartesian` hands the slide position over in mm read under
  the old settings: `$defaults` changes `z_steps` along with the mode, and
  a handover read after it lost the position (caught by a test).
- The board frame in cartesian mode is `(R, Z)` turned by the table
  angle, so board coordinates stay attached to the board and a polar
  placement carries over. `Z0` must be set with the rail over the axis
  for the two frames to agree.
- The spindle keeps turning through a hold: stopping it and resuming into
  the work with a still tool would break the bit. Reset, disconnect and
  alarms stop it. `laser off` stops it too, so a panicked `laser off` at
  the console does what it says.
- `S`/`M` on `cut` are refused with a spindle, so a laser job sent to a
  milling machine fails on its first cut instead of running at focus
  height with the tool off.
- Milling reuses `passes` as the step-down count and the height map's
  focus offset as the touch-off; `power` compensation is refused for a
  spindle.
- The prober reported done once the last rise was queued (`ok` means
  queued); the e2e test that read H right after was flaky. It now waits
  for `Idle`.
- A headless Firefox screenshot exits 0 and writes nothing when a desktop
  Firefox is running (the command goes to that instance); `--no-remote
  --profile <dir under home>` gives it its own, and the snap needs the
  output under home too.

## Machine files (2026-10-03)

The schema is structured TOML (sections per axis) rather than a flat
`[settings]` table of firmware names, because the point is to read a
machine at a glance and swap axis arrangements; the cost is a mapping in
two languages (spinny_laser.machines and virtual/src/machine.rs). The
end to end test in web/backend/tests/test_machines.py starts the virtual
firmware with --machine for each shipped file and asserts the backend
names that file, which pins the two mappings to each other; the Rust
tests also assert that loading the shipped polar-laser.toml leaves
Settings::default() unchanged, so that file is where a changed default
shows up. Values from the firmware compare as f32 printed to three
decimals, hence `close()` with abs_tol 5e-4. A file sets every setting it
does not name to the firmware default, so a machine is always all 46 and
a load is deterministic. The virtual firmware applies a file onto a copy
and only commits when every value passed, as the backend's write does.

## Config defined controls

The jog panel and the DRO used to hardcode R/A/Z/H and switch labels on
`isCartesian`/`isMilling`. They now draw a `[controls]` table from the
machine file. Choices made:

- The controls travel in the settings response, not the state snapshot:
  the snapshot goes out at 10 Hz over the websocket and the controls are
  a kilobyte or two that change only with the machine. The page already
  reads the settings again whenever the profile in the snapshot moves, so
  a changed machine redraws within one settings round trip. Until the
  settings arrive the page draws the defaults for the snapshot's profile,
  which are what it drew before, so nothing flashes.
- Defaults are derived from kinematics, tool and focus axis in Python
  (`spinny_laser.controls.default_controls`) with a TypeScript twin in
  `web/frontend/src/controls.ts`. The twin exists because the mock has to
  answer like the backend and the page needs a fallback; the shipped
  machine files spell the defaults out, a Python test checks the files
  against the Python defaults, and a Bun test checks the TypeScript
  defaults against the files, which ties the two together without a
  cross-language fixture.
- A file that lists an axis fills in the keys it leaves out from the
  default for that joint, except that a renamed axis without `buttons`
  gets `<letter>-`/`<letter>+` rather than the default's words.
- The virtual firmware (`machine.rs`) only checks that `[controls]` is a
  table. Typos inside it are the Python reader's to catch, which is where
  a load happens anyway.
- The mock's TOML reader learned `[[a.b]]` one level deep and inline
  tables so the Bun test can read the shipped files.

## Which file's controls the page draws

The backend tells the loaded machine file by its settings: a file is the
machine when every live setting equals the file's. That is exact on
purpose (a load writes all 52 settings), but as the only source of the
page's controls it was brittle: one `$a_rate=300` typed at the console,
or a board on firmware without the newest keys, and the jog panel fell
back to the defaults for the profile, with the bars the file had taken
out back on screen. The fix keeps the exact match as the first choice and
falls back by kind of machine (kinematics, tool, focus axis), which the
live settings always give: the file last loaded from this host
(`last_machine` in var/config.json) when it is that kind, then the one
file of that kind, then the defaults. The kind check matters: a loaded
polar file must not lend its controls to a board that has since been made
cartesian at the console. `controls_from` in the settings says which was
taken, so the Config tab can say so rather than leave the operator
guessing why a bar is there.

The page's copy of the defaults (`src/controls.ts`) was cross-checked
against the shipped machine files, which spelled the defaults out. Once
a shipped file is edited that check fails for the wrong reason, so both
sides now compare against a JSON fixture the Python defaults print
(`mise run controls-fixture`); the Python test fails with that command
in its message when the defaults move without it.

## Mill X/Y moved 0.8x the commanded distance (2026-10-12)

`$tmc` read back 256 microsteps on every driver, so the firmware was exact; the X and Y screws are 4 mm per turn, not 5. `cartesian-mill.toml` now says 12800 steps/mm for the rail and slide and 10240 for the depth axis (measured exact; the file had 6400). Its controls are X/Y/Z joint bars with no pad, no table and no Center.

## Mill at 32 microsteps (2026-10-27)
At 256 microsteps the 100 kHz step ceiling held X/Y to ~470 mm/min (12800 steps/mm). The TMC2209s run with intpol, so any MRES is interpolated to 256 internally: 32 microsteps moves just as smoothly, 0.6 um per step is far below a stepper's microstep accuracy (~5% of a 20 um full step), and the ceiling rises to ~3750 mm/min. Switching MRES during motion was rejected: a switch off the coarse grid snaps MSCNT and loses position, and a UART write cannot be timed against the step interrupt. The dispenser file still runs X/Y at 256.

## K40 machine file (2026-10-29)

`machines/k40.toml` is a K40 with the SKR Pico in place of its M2 Nano,
untested on hardware. FAN3's switched pin is not a bare open drain: its
indicator LED and a 10K tie it to the fan rail, so it idles near 24 V.
The supply's active-low `L` therefore takes it through a series diode
(anode at `L`), and `H` (fire on high) stays empty. The four STOP headers
are buffered (74LVC2G34, 5 V on pin 3), but PROBE is not, and PROBE is the
slide's default endstop pin, so the K40's back switch goes on Y-STOP.
Each motor is on its labeled socket (`sockets` 1324, the empty table on
Z). +Y points to the back so a board is not mirrored, which puts the back
switch at the max end with `home_pos` set to the depth. `limit` is a box
around zero, not the travel, so it is set to the travel: it then refuses
no move on the bed wherever the zero is, only a runaway.

## Full steps beside steps_per_mm (2026-11-02)

The user asked for steps per mm without microstepping. Changing what
`steps_per_mm` means would have moved every existing file (the user's
K40 at 160 = 10 x 16) 16 to 256 times too far with no error, so the full
steps got their own key, `full_steps_per_mm` (`full_steps_per_deg`), and
the old key keeps its meaning; a section may not give both. Microsteps
alone now scale the default (they used to leave it, the same trap). The
shipped files were converted; the table is `55.5555546875`, exactly
14222.222 / 256, because the Rust test compares the polar file with
`Settings::default()` as f32 and 55.5555547 lands one ulp off in Python's
exact dict compare. The user's uncommitted K40 and mill edits were kept
out of the commit by staging a converted HEAD blob (`git hash-object -w`
plus `git update-index --cacheinfo`) and converting the working copy too.

## Reading a board and writing settings, bug sweep (2026-11-09)

- Read from board compares a scale in full steps, after dividing each
  side by its own microsteps: the same steps per mm at other microsteps
  (changed at the console) are other full steps, and the same full steps
  at other microsteps need only the microsteps line. The key list marks
  a scale row as differing by the full steps it shows.
- The firmware checks s_min <= s_max on every line, so a settings write
  that lowers s_max under the s_min in force sends s_min first. A refused
  write is put back last first, so the board steps back through states it
  held; a line whose answer was lost on the link goes back after them,
  since a link that fails ends the putting back (the first version put
  it first and test_app's lost-setting test caught it).
- The file reader bounds the product full_steps x microsteps (the
  firmware's 1e7) and home_pos (1e7 either side), as the Rust reader did.
- The mock: sockets must be the four sockets once each, a socket map
  change takes back the map's focus offset, and speed_control is kept
  (s_max for every spindle line when off), all as the backend does.

## Servos in machine files (2026-11-13)

- `[servo.1]` to `[servo.4]`, not `[[servo]]`: an array cannot fit servo 2
  without servo 1, and the key list and Read from board work per section
  (`set_key`/`has_key`). Read from board takes the other of pin and
  channel out when it writes one. `servoN_out` has no key of its own: it
  is which of the two the section gives.
- `name` and `positions` are the page's (served as `servos` with the
  settings, from the controls' file); the jog panel draws a bar for every
  servo the live settings fit, "Servo N" when the file says nothing.
- Refused, since the firmware cannot judge pairs: STOP header pins, a
  servo pin another output, the probe or another servo has, the laser's
  PWM slice, another servo's PWM channel, two servos on one PCA9685
  channel, a bus of two I2C blocks or on another's pin (only with a servo
  on the PCA9685), and a fitted endstop on any of these pins.

## Camera keys in G-code machine files, release offers (2026-11-14)

Built by an agent (todo-config), cherry-picked.

- `[up_camera] roll` and `mirror` work like `[top_camera] roll`: they
  stand while the kept scale is 0 (`_up_place` takes the file's values when
  `mm_per_px <= 0`, so a place set by hand, with no scale, keeps the file's
  roll).
- A G-code file's camera keys (`device`, `size`, `fps`, `pcbv`, shades)
  are applied at connect, not used as defaults: a camera's kept settings
  are written whole (`model_dump`) on any change, so defaults would stop
  applying after the first PNP-tab edit. `take_camera_settings` from
  `_gcode_connect`, mirroring a load putting `[camera]` into the head
  camera; keys the file leaves out keep the camera's own.
- Release offers (spinny_web.shipped): what each copy was made from is
  kept in `var/shipped/machines/`, written at the first start and whenever
  an offer is taken or left, so the merge is three-way; copies from before
  merge two-way (additions in, every local value kept). Values compared
  per (table path, key), an array of tables one value. A key the release
  adds comes with the comment lines just above it, a new table with the
  comments leading its header; the merged text is read again to check
  every expected value. A dotted key or an inline table has no line of
  its own to copy, so that file becomes a problem offer instead of a
  guess. The routes live under `/api/update/machines`: "updates" is a
  valid machine id, which `GET /api/machines/{id}` would shadow.
  Comment-only changes are not offered. CAM profiles are not offered yet
  (QUESTIONS.md).
