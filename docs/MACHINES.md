# Machine configuration files

A machine is a TOML file in `machines/`: its axes with their scales,
rates and limits, the kinematics (the rail as the radius over a turning
table, or as X beside the cross slide as Y) and the tool on the output (a
laser, or a spindle with the focus axis as its depth). Loading a file
writes every firmware setting, so swapping files swaps machines. The same
files start the virtual firmware, and give the gcode tools their defaults.

| Where | How |
| --- | --- |
| Web page | Settings panel, *Machine*: pick a file and press *Load*; *Save to flash* keeps it over a restart. The select names the file the live settings are, or says they are no file's. |
| Backend | `GET /api/machines`, `POST /api/machines/{id}/apply` ([WEB_API.md](WEB_API.md)); `spinny-web --machines DIR` reads another directory |
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

[focus]                         # H, mm: optional, on the E socket
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
invert = false                  # true: input active high  -> probe_invert
brake_ms = 20                   # 0 to 160                 -> probe_ms

[output]                        # the laser PWM, or the spindle on it
pwm_hz = 5000                   # 100 to 100000            -> laser_hz
s_max = 1000                    # S for full duty          -> s_max
s_min = 0                       # dyn mode floor           -> s_min
invert = false                  # true: active low         -> laser_invert
test_ms = 5000                  # default T for laser      -> laser_ms

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
```

## How a load works

The backend reads the file, maps it onto all 46 settings and writes the
ones that differ from the machine's, one `$name=value` line each, all or
nothing: a value the firmware refuses has the ones sent before it put back.
The host values are stored once the firmware's part is through. Nothing is
saved to flash unless asked (`{"save": true}`, or *Save to flash* on the
page), so a load can be tried and undone with a power cycle. A load is
refused while a run or probing owns the machine, like any settings write.

Which file the live settings are is decided on every settings read by
comparing all 46 values, so a setting changed by hand at the console or in
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
