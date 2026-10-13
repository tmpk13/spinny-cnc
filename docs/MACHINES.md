# Machine configuration files

A machine is a TOML file in `machines/`: its axes with their scales,
rates and limits, the kinematics (the rail as the radius over a turning
table, or as X beside the cross slide as Y), the tool on the output (a
laser, or a spindle with the focus axis as its depth) and the controls
the page draws for it. Loading a file
writes every firmware setting, so swapping files swaps machines. The same
files start the virtual firmware, and give the gcode tools their defaults.

| Where | How |
| --- | --- |
| Web page | The *Config* tab: pick a file, edit it in the TOML editor (read as it is typed, and whole by *Check*), *Save* it and press *Load to board*; *Save to flash* keeps it over a restart. The panel names the file the live settings are, or says they are no file's, and the live firmware settings sit beside it. |
| Backend | `GET /api/machines`, `GET`, `PUT` and `DELETE /api/machines/{id}`, `POST /api/machines/{id}/check`, `POST /api/machines/{id}/apply` ([WEB_API.md](WEB_API.md)); `spinny-web --machines DIR` reads another directory |
| Virtual firmware | `spinny-virtual --machine machines/cartesian-mill.toml`; `--settings` after it overrides single values |
| Gcode tools | `spinny-iso --machine machines/polar-laser.toml ...`: the axis rates, the power scale and the chord tolerance stand in for the defaults; a flag given still wins |
| Code | `spinny_laser.machines` (Python), `firmware/virtual/src/machine.rs` (Rust); the virtual firmware's tests load the shipped files, so the two stay one schema |

The shipped files: `polar-laser` (the firmware's defaults, every key
spelled out), `polar-laser-focus` (the focus axis fitted),
`cartesian-laser` (rail X, slide Y, the table holding) and
`cartesian-mill` (cartesian with a spindle and the focus axis as depth).
Copy the one nearest your machine, name it, and change what differs. A
file that cannot be read is listed by the backend as a problem and shown
on the page; the others still load.

## Schema

Every key is optional; what a file leaves out stays at the firmware's
default. Numbers are checked against the firmware's own bounds, unknown
keys are refused with the file and key named, and a file is applied all
or nothing.

```toml
name = "Polar laser"            # shown on the page; default: the file name
description = "..."             # shown beside the pick
kinematics = "polar"            # polar | cartesian        -> $cartesian
tool = "laser"                  # laser | spindle          -> $spindle

[rail]                          # R, mm: the radius, or X when cartesian
steps_per_mm = 10240            # -> r_steps
max_rate = 560                  # mm/min                   -> r_rate
accel = 50                      # mm/s^2                   -> r_accel
jerk = 3                        # mm/s at a corner         -> r_jerk
jog_rate = 300                  # mm/min without F         -> jog_r
limit = 0                       # mm either side, 0 = none -> r_max
invert = false                  # direction                -> dir_invert bit 0
current_ma = 800                # -> tmc_r_ma
microsteps = 256                # 1, 2, 4 ... 256          -> tmc_r_micro
socket = "X"                    # driver socket: X, Y, Z or E, each once -> sockets

[table]                         # A, degrees
steps_per_deg = 14222.222       # -> a_steps
max_rate = 400                  # deg/min                  -> a_rate
accel = 50                      # -> a_accel
jerk = 2                        # -> a_jerk
jog_rate = 200                  # -> jog_a
invert = false                  # -> dir_invert bit 1
current_ma = 800                # -> tmc_a_ma
microsteps = 256                # -> tmc_a_micro

[slide]                         # Z, mm: a setup axis when polar, Y when cartesian
steps_per_mm = 10240            # -> z_steps
max_rate = 560                  # -> z_rate
accel = 50                      # -> z_accel
jerk = 3                        # -> z_jerk
jog_rate = 120                  # -> jog_z
limit = 0                       # -> z_max
invert = false                  # -> dir_invert bit 2
current_ma = 800                # -> tmc_z_ma
microsteps = 256                # -> tmc_z_micro

[focus]                         # H, mm: optional, on the E socket unless socket says otherwise
fitted = false                  # -> h_axis
steps_per_mm = 6400             # -> h_steps
max_rate = 600                  # -> h_rate
accel = 50                      # -> h_accel
jerk = 1                        # -> h_jerk
jog_rate = 120                  # jog and probe rate       -> jog_h
invert = false                  # -> dir_invert bit 3
current_ma = 600                # -> tmc_h_ma
microsteps = 256                # -> tmc_h_micro

[probe]
invert = false                  # true: input active high  -> probe_invert; wrong way round when the readout says down with the tip free
brake_ms = 20                   # 0 to 160                 -> probe_ms
pin = 25                        # GPIO: 25 Z-STOP, 22 PROBE, 4 X-STOP, 3 Y-STOP, 16 E-STOP -> probe_pin

[output]                        # the laser PWM, or the spindle on it
pwm_hz = 5000                   # 100 to 100000            -> laser_hz
s_max = 1000                    # S for full duty          -> s_max
s_min = 0                       # dyn mode floor           -> s_min
invert = false                  # true: active low         -> laser_invert
test_ms = 5000                  # default T for laser      -> laser_ms
pin = 20                        # GPIO: 20 FAN3, 17 FAN1, 18 FAN2, 23 HE, 21 BED, 29 SERVO -> laser_pin

[enable]                        # an output that follows the tool; see Pins below
fitted = false                  # -> tool_out
pin = 17                        # GPIO, FAN1; not the output's or the probe's -> tool_pin
invert = false                  # true: active low         -> tool_invert

[drivers]
enable_invert = false           # -> en_invert
idle_ms = 0                     # motors off after idle    -> idle_ms
step_us = 2                     # 1 to 20                  -> step_us
hold_pct = 50                   # 0 to 100                 -> tmc_hold_pct
stealth = true                  # stealthChop              -> tmc_stealth

[host]                          # the host's own settings, not the firmware's
tolerance = 0.005               # chord tolerance, mm, (0, 10]
clearance = 2.0                 # milling: travel height over the surface, mm, (0, 100]
spinup = 2.0                    # milling: dwell after the spindle starts, s, [0, 600]
speed_control = true            # milling: false runs the spindle full on (S = s_max), never at a group's rpm

[controls]                      # the page's jog panel and readout; left out: the defaults below
pad = true                      # a board X/Y pad, on the arrow keys when no field has the focus
pad_steps = [0.1, 1, 10]        # mm, 1 to 8 steps; an axis without steps of its own uses the pad's
pad_step = 1                    # picked at the start; left out: the middle one
feed = true                     # a feed field (mm/min, blank = the firmware's jog rate) for the pad and the axes that take it
center = { r = 0 }              # where Center sends the joints; left out: no button

[[controls.axes]]               # one per joint shown, in this order
axis = "r"                      # the firmware's joint: r, a, z or h (h needs [focus] fitted)
letter = "R"                    # 1 to 3 characters: the readout's, and in "Set R=0 here"
label = "Radius"                # the bar's title
steps = [0.1, 1, 10]            # deg for a, mm otherwise; left out or []: the pad's step
step = 1                        # left out: the middle one
buttons = ["Radius -", "Radius +"]  # minus and plus
feed = true                     # the feed field applies; false: the firmware's jog rate for the axis
goto = true                     # a field in the joint goto row
zero = true                     # a "Set R=0 here" button, which asks with the hint
zero_hint = "..."
keys = []                       # two key names for minus and plus, such as ["PageDown", "PageUp"]
note = ""                       # under the bar's title
```

## Driver sockets

Each axis section takes `socket`, the SKR Pico driver socket its motor is
plugged into. Left out, an axis is on its labeled socket: rail X, table Y,
slide Z, focus E. Every socket is used once, so moving one axis means
moving whichever axis held that socket too. The four go to the firmware as
one setting, `sockets`, a digit per axis (rail, table, slide, focus;
1 X, 2 Y, 3 Z, 4 E). `cartesian-mill` is wired as a three axis mill:
rail X, slide Y, focus Z as depth, and the table on E with `current_ma = 0`
so its empty driver is left alone.

## Pins

The laser (or spindle) PWM output, the probe input and the tool output
are on whichever GPIOs `[output] pin`, `[probe] pin` and `[enable] pin`
name: any of the board's but the driver sockets' STEP, DIR and EN pins
and the driver UART (GP2, GP5 to GP15, GP19 and GP28). The headers are
FAN1 GP17, FAN2 GP18, FAN3 GP20, HE GP23, BED GP21, SERVO GP29 and RGB
GP24 for outputs, and X-STOP GP4, Y-STOP GP3, Z-STOP GP25, E-STOP GP16
and PROBE GP22 for inputs; the laser's slice of the PWM block follows
from its pin. The firmware takes the pins one setting at a time, so a
pin named twice is refused here, where the whole file is seen: the probe
may not share the output's pin, and a fitted tool output may share
neither. The pins and `[enable] fitted` are read from flash at boot, so a
load that changes one wants *Save to flash* and a restart of the board;
the page says so after such a load.

`[enable]` is an output that follows the tool: driven while a job runs, a
beam is lit, a dwell burns or the spindle turns, for a laser supply
relay, an air assist or a spindle's run input. `invert` makes it active
low; off (`fitted = false`) it rests at its inactive level whatever the
tool does.

Every `invert` is checked the same way, by what the machine does, not by
how it is wired: an axis's `invert` is wrong when a positive jog moves it
the other way than its `[controls]` buttons say (the page's X+ must move
the head toward board +X, Y+ toward +Y, Z+ or H+ up, and a positive turn
counterclockwise seen from above); `[probe] invert` is wrong when the
readout says *down* with the tip free and *up* when it touches; `[output]
invert` is wrong when the beam or the spindle is on with nothing asked for
(and dangerous, so it is the first thing to check at power on); `[enable]
invert` when the relay is on while the machine is idle. Flip the one that
is wrong in the file, load it again and check again.

## The controls

The jog panel and the position readout draw what `[controls]` says, so
a machine with other joints, names, steps or keys needs no change to the
page. The backend sends the controls with the settings (`GET
/api/settings`): the file's whose settings the live ones are, every one
of them, or, for settings that are no file's (one changed by hand, or
firmware older than the file's newest keys), the file last loaded from
this host when it describes this kind of machine (kinematics, tool, focus
axis), else the one file that does, else the defaults for what the
settings say the machine is. `controls_from` names the file, and the
Config tab says under the file whose controls the jog panel draws. A file
edited by hand shows after *Reload* there, or a page reload. Every
control is a bar: its letter and title, a note, the step choices with a
field for any other step, the minus and plus buttons and the zero button.
The defaults
are the board's X and Y bars on the arrow keys, a *Radius* and a *Table*
bar, the cross slide's bar (as the Y axis, stepping with the pad's steps
at the feed given, when cartesian; a setup axis at the firmware's rate
otherwise, with no goto field), the focus axis's bar when fitted (the
depth axis with a spindle), a Center button to `R 0` (and `Z 0` when
cartesian), and a zero button per joint. `polar-laser.toml` spells those
defaults out with a comment on each key, which is where to start a file
of your own; the other shipped files say what differs for their kind (the
mill leaves the rail's bar out: the rail is X there, which the pad's X
bar moves).

An entry fills in what it leaves out from the default for its joint; an
entry given a `letter` or a `label` but no `buttons` is labeled
`<letter>-` and `<letter>+` rather than with the default's words. The
step picked with a control is kept while the page is up; the keys of an
axis jog it by that step, and `Escape` or the jog panel's *Cancel*
stops whatever the controls are. `place`, which older files say, is
still taken and means nothing now. The virtual firmware checks only that
`[controls]` is a table: the controls are the page's, not the machine's.

## How a load works

The backend reads the file, maps it onto all 52 settings and writes the
ones that differ from the machine's, one `$name=value` line each, all or
nothing: a value the firmware refuses has the ones sent before it put back.
The host values are stored once the firmware's part is through. Nothing is
saved to flash unless asked (`{"save": true}`, or *Save to flash* on the
page), so a load can be tried and undone with a power cycle. A load is
refused while a run or probing owns the machine, like any settings write.

Which file the live settings are is decided on every settings read by
comparing all 52 values, so a setting changed by hand at the console or in
the table turns the pick to "settings of no file" until a file is loaded
again. Values are compared as the firmware reports them: a 32 bit float
printed with three decimals.

## Adding an axis arrangement

The files only name what the firmware has: four joints, two kinematics,
two tools. A new arrangement is a firmware change first (a setting, a
joint, a mode), then a key in the schema in both implementations, then a
file. The shipped `polar-laser.toml` spells out every default, and the
virtual firmware's tests check that loading it leaves the defaults as they
are, so that file is also where a changed default shows up.
