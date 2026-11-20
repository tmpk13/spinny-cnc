# Machine configuration files

A machine is a TOML file in `machines/`: its axes with their scales,
rates and limits, the kinematics (the rail as the radius over a turning
table, or as X beside the cross slide as Y), the tool (a laser, a
spindle with the focus axis as its depth, or a solder paste dispenser
whose plunger takes the table's driver), the camera on the head, if any,
the servos it drives, and the controls the page draws for it. Loading a file
writes every firmware setting, so swapping files swaps machines. The same
files start the virtual firmware, and give the gcode tools their defaults.
A machine whose own controller takes G-code, a pick and place machine's
Marlin, is a file here too ([G-code machines](#g-code-machines)): it is
connected from the Connection panel and jogged, homed and stopped like the others.

| Where | How |
| --- | --- |
| Web page | The Setup side's *Machines* page: in its *Machine file* panel pick a file (the one in use is named under the pick, and marked in it; the Connection panel and the top bar name it too), *Use this machine* to make it the machine in use (a G-code machine's file connects it on the port its file claims, the machine connected let go first; another is written to the board, the board connected first when its port is listed; with nothing to connect, it is remembered as the one in use), edit it in the TOML editor (read as it is typed, and whole by *Check*), *Save* it and press *Write to board*, which writes every setting and saves it to the board's flash in one step (saving an edited text first). *Read from board* writes the board's values into the text where they differ, for a look before *Save*. A line says what the board runs and whether its flash has it; *Save to flash* shows only when something written past the file (the console, a page control) left flash behind. Beside the editor, the *Settings* panel lists every key a file can set (a G-code machine's file: its own tables) with the file's value next to the board's, or a camera's for its keys, the differences marked, a fuzzy search over key, firmware setting, help and the other words a key goes by (a camera's `roll` is found as rotation, turn or angle; the vacuum's keys as suction); a click goes to the key in the editor, adding it with the file's value when the file leaves it out. A row's *Insert* writes the board's (or the camera's) value into the text at its key, and *Copy* puts the key on the clipboard as TOML under its table; *Copy all* does that for the rows shown. The find over the editor (Ctrl+F in it) marks a word in the file and steps through it; *all files* lists the lines of every machine file that hold it, a press opening that file there. |
| Backend | `GET /api/machines`, `GET`, `PUT`, `PATCH` and `DELETE /api/machines/{id}`, `POST /api/machines/{id}/check`, `POST /api/machines/{id}/apply` ([WEB_API.md](WEB_API.md)); `spinny-web --machines DIR` reads another directory |
| Virtual firmware | `spinny-virtual --machine machines/cartesian-mill.toml`; `--settings` after it overrides single values |
| Gcode tools | `spinny-iso --machine machines/polar-laser.toml ...`: the axis rates, the power scale and the chord tolerance stand in for the defaults; a flag given still wins |
| Code | `spinny_laser.machines` (Python), [`virtual/src/machine.rs`](https://github.com/tmpk13/spinny-firmware/blob/main/virtual/src/machine.rs) of spinny-firmware (Rust), `web/frontend/src/mock/machines.ts` (the page's mock); the backend's end to end tests start the virtual firmware with the shipped files and check that it comes up as the machine Python reads, so the three stay one schema |

The shipped files: `polar-laser` (the firmware's defaults, every key
spelled out), `polar-laser-focus` (the focus axis fitted),
`cartesian-laser` (rail X, slide Y, the table holding),
`cartesian-mill` (cartesian with a spindle and the focus axis as depth),
`cartesian-dispenser` (the mill's axes with a paste dispenser's
plunger on the table's socket and a camera on the head), `k40` (a K40
CO2 laser with the board in place of its M2 Nano, its connections in
[K40.md](K40.md)), and three G-code pick and place machines:
`openpnp-marlin` (Marlin as OpenPnP's GcodeDriver drives it, every key
commented), `opulo-lumen-rev5` (an Opulo LumenPnP with the Rev05
board, from Opulo's stock OpenPnP setup) and `virtual-pnp` (the LumenPnP
that `mise run virtual-pnp` plays, [OPERATING.md](OPERATING.md#a-virtual-lumenpnp)).
Copy the one nearest your machine, name it, and change what differs. A
file that cannot be read is listed by the backend as a problem and shown
on the page; the others still load.

## Schema

Every key is optional; what a file leaves out stays at the firmware's
default. Numbers are checked against the firmware's own bounds, unknown
keys are refused with the file and key named, and a file is applied all
or nothing.

An axis's scale is best given as `full_steps_per_mm` (`full_steps_per_deg`
for the table): the motor's full steps per unit, 200 over the mm per turn
for a 1.8 degree motor on a screw or a belt. The firmware steps that times
`microsteps`, so a change of microsteps keeps every distance. The older
`steps_per_mm` (`steps_per_deg`) is the firmware's number itself,
microsteps counted, and stays as it was: a file with it moves as before,
and has to be changed with its `microsteps`. A section may give one or the
other, not both; one that gives `microsteps` and neither scales the
default with them.

```toml
name = "Polar laser"            # shown on the page; default: the file name
description = "..."             # shown beside the pick
kinematics = "polar"            # polar | cartesian        -> $cartesian
tool = "laser"                  # laser | spindle | dispenser -> $spindle, $dispenser (a dispenser needs cartesian)

[rail]                          # R, mm: the radius, or X when cartesian
full_steps_per_mm = 40          # the motor's full steps per mm, microsteps not counted -> r_steps = this * microsteps
# steps_per_mm = 10240          # or the firmware's number itself, microsteps counted -> r_steps; not both
max_rate = 560                  # mm/min                   -> r_rate
accel = 50                      # mm/s^2                   -> r_accel
jerk = 3                        # mm/s at a corner         -> r_jerk
jog_rate = 300                  # mm/min without F         -> jog_r
limit = 0                       # mm either side, 0 = none -> r_max
invert = false                  # direction                -> dir_invert bit 0
current_ma = 800                # -> tmc_r_ma
microsteps = 256                # 1, 2, 4 ... 256          -> tmc_r_micro
socket = "X"                    # driver socket: X, Y, Z or E, each once -> sockets
endstop = "none"                # none, min, max, both: which ends have a switch -> r_stop
endstop_pin = 4                 # GPIO: 4 X-STOP, 3 Y-STOP, 16 E-STOP, 22 PROBE, 25 Z-STOP -> r_stop_pin
endstop_invert = false          # true: the input is active high -> stop_invert bit 0
endstop_halt = false            # true: a move that closes the switch halts, ALARM:4 -> limits bit 0
home_pull = 1                   # mm a home backs off the switch, and ends from it -> r_home_pull
home_pos = 0                    # mm the switch reads as (the negative one of two) -> r_home_pos
home_travel = 200               # mm between the ends; a home seeks a tenth further -> r_home_travel

[table]                         # A, degrees
full_steps_per_deg = 55.5555546875  # -> a_steps = this * microsteps; or steps_per_deg = 14222.222
max_rate = 400                  # deg/min                  -> a_rate
accel = 50                      # -> a_accel
jerk = 2                        # -> a_jerk
jog_rate = 200                  # -> jog_a
invert = false                  # -> dir_invert bit 1
current_ma = 800                # -> tmc_a_ma
microsteps = 256                # -> tmc_a_micro
                                # endstop, endstop_pin (3 Y-STOP), endstop_invert, endstop_halt,
                                # home_pull, home_pos, home_travel (400 deg) as under [rail]: a_stop ...

[dispenser]                     # in place of [table], with tool = "dispenser": the same driver turns the plunger, A in mm
full_steps_per_mm = 100         # -> a_steps = this * microsteps (200 steps on a 2 mm lead)
max_rate = 300                  # mm/min: the retract, and the Extrude and Retract buttons' ceiling -> a_rate
accel = 50                      # -> a_accel
jerk = 1                        # -> a_jerk
jog_rate = 60                   # mm/min of the Extrude and Retract buttons -> jog_a
invert = false                  # -> dir_invert bit 1
current_ma = 600                # -> tmc_a_ma
microsteps = 16                 # -> tmc_a_micro
socket = "E"                    # -> sockets; endstop keys as under [rail]: a_stop ...

[slide]                         # Z, mm: a setup axis when polar, Y when cartesian
full_steps_per_mm = 40          # -> z_steps = this * microsteps; or steps_per_mm
max_rate = 560                  # -> z_rate
accel = 50                      # -> z_accel
jerk = 3                        # -> z_jerk
jog_rate = 120                  # -> jog_z
limit = 0                       # -> z_max
invert = false                  # -> dir_invert bit 2
current_ma = 800                # -> tmc_z_ma
microsteps = 256                # -> tmc_z_micro
                                # endstop, endstop_pin (22 PROBE), endstop_invert, endstop_halt,
                                # home_pull, home_pos, home_travel (200 mm) as under [rail]: z_stop ...

[focus]                         # H, mm: optional, on the E socket unless socket says otherwise
fitted = false                  # -> h_axis
full_steps_per_mm = 25          # -> h_steps = this * microsteps; or steps_per_mm
max_rate = 600                  # -> h_rate
accel = 50                      # -> h_accel
jerk = 1                        # -> h_jerk
jog_rate = 120                  # jog and probe rate       -> jog_h
invert = false                  # -> dir_invert bit 3
current_ma = 600                # -> tmc_h_ma
microsteps = 256                # -> tmc_h_micro
                                # endstop, endstop_pin (16 E-STOP), endstop_invert, endstop_halt,
                                # home_pull, home_pos, home_travel (50 mm) as under [rail]: h_stop ...

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
interpolate = true              # each microstep to 256    -> tmc_intpol
toff = 3                        # 1 to 15; see Driver tuning -> tmc_toff
tbl = 2                         # 0 to 3                   -> tmc_tbl
hstrt = 5                       # 0 to 7                   -> tmc_hstrt
hend = 0                        # 0 to 15                  -> tmc_hend
hold_delay = 10                 # 0 to 15                  -> tmc_hold_delay
tpowerdown = 20                 # 0 to 255                 -> tmc_tpowerdown
tpwmthrs = 0                    # 0 to 1048575, 0 = stealthChop at every speed -> tmc_tpwmthrs

[pca9685]                       # a PCA9685 servo driver on the board's I2C bus; see Servos
sda = 0                         # data line: an even GPIO, 0 TX on the UART header -> i2c_sda
scl = 1                         # clock line: the odd GPIO of the same I2C block, 1 RX -> i2c_scl
address = 0x40                  # 0x40 to 0x7F as the module's address pads set it -> pca_addr

[servo.1]                       # servo.1 to servo.4, each one the file fits; see Servos
name = "Pen"                    # the page's bar; default: Servo 1
pin = 29                        # GPIO of the board, 29 SERVO -> servo1_out = 1, servo1_pin
# channel = 0                   # or a PCA9685 channel, 0 to 15 -> servo1_out = 2, servo1_chan; not both
min_us = 1000                   # pulse at 0 degrees, 200 to 3000 -> servo1_min_us
max_us = 2000                   # pulse at the far end of the range -> servo1_max_us
range = 180                     # degrees from min_us to max_us, (0, 360] -> servo1_range
start = 90                      # degrees at power on, within the range; left out: no pulse until moved -> servo1_start
positions = { up = 30, down = 120 }  # the page's buttons, at most 8, within the range; nothing of it reaches the firmware

[host]                          # the host's own settings, not the firmware's
tolerance = 0.005               # chord tolerance, mm, (0, 10]
clearance = 2.0                 # milling: travel height over the surface, mm, (0, 100]
travel = 5.0                    # the H the page's moves and probing rise to before going across, mm, [-100, 100]; left out: off
spinup = 2.0                    # milling: dwell after the spindle starts, s, [0, 600]
speed_control = true            # milling: false runs the spindle full on (S = s_max), never at a group's rpm
gap = 0.1                       # dispensing: the needle's height over the pad while a dot is laid, mm, (0, 10]
retract = 0.2                   # dispensing: how far the plunger is pulled back after each dot, mm, [0, 50]
output = 100                    # dispensing: mm^3 of paste per mm of plunger travel, (0, 100000]
extrude_rate = 60               # dispensing: plunger speed while a dot is pushed out, mm/min, (0, 10000]
dwell_ms = 200                  # dispensing: wait after the push, before the retract, ms, [0, 60000]

[camera]                        # a camera on the head, read by the backend through pcb-vision; nothing of it reaches the firmware
device = "/dev/video0"          # a V4L2 device; http://host:port/snapshot (one JPEG a request, at most fps a second: a bridge Pi's camera) or /stream (MJPEG); socket://host:port of a pcbv serve elsewhere; or a picture or a directory to replay
size = "1280x720"               # capture size, WIDTHxHEIGHT
fps = 30
pcbv = "pcbv"                   # the pcbv program: a name on PATH or a path; left out, ../pcb-vision/target is looked in
side = "front"                  # front | back: the side the camera sees
finish = "masked"               # masked | bare: whether solder mask hides the copper
offset = [0.0, 0.0]             # the picture's center from the tool, board mm along X and Y; the camera offset routine measures it
roll = 0.0                      # degrees from the picture's x axis to board +X, counterclockwise seen from above; measured with the offset
mm_per_px = 0.0                 # mm per picture pixel at the board; 0 until measured, or taken from a lock

[controls]                      # the Machine panel's jog and readout; left out: the defaults below
pad = true                      # a board X/Y pad, on the arrow keys when no field has the focus
pad_steps = [0.1, 1, 10]        # mm, 1 to 8 steps; an axis without steps of its own uses the pad's
pad_step = 1                    # picked at the start; left out: the middle one
feed = true                     # a feed field (mm/min, blank = the firmware's jog rate) for the pad and the axes that take it
center = { r = 0 }              # where Center sends the joints; left out: no button
centering = true                # the Tests panel's Centering test, which burns where the rail crosses the rotation axis; left out: true when polar

[[controls.axes]]               # one per joint shown, in this order
axis = "r"                      # the firmware's joint: r, a, z or h (h needs [focus] fitted; a is the plunger with tool = dispenser)
letter = "R"                    # 1 to 3 characters: the readout's, and in "Set R=0 here"
label = "Radius"                # the bar's title
steps = [0.1, 1, 10]            # deg for a (mm on a dispenser), mm otherwise; left out or []: the pad's step
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

## Driver tuning

`[drivers]` sets, besides the enable pin, the step pulse and the hold
current, the TMC2209 register fields every driver is given alike:
`interpolate` and the keys named as the datasheet names the fields,
`toff`, `tbl`, `hstrt`, `hend`, `hold_delay` (IHOLDDELAY), `tpowerdown`
and `tpwmthrs`. What each one does and its range is in the settings table
of [PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md). Left out, a key keeps the firmware's
default, which is what the firmware wrote before these were settings, so a
file without them runs the drivers as before.

`interpolate` on, a driver moves its motor in 256ths of a full step
whatever `microsteps` it is given, which keeps 16 microsteps smooth and
quiet; off, it moves in the steps it is given.

`tpwmthrs` is the speed at which a driver leaves stealthChop for
spreadCycle when `stealth` is on, as a TSTEP: the time between two 1/256
microsteps in the driver's 12 MHz clocks, whatever the microsteps. A speed
of v mm/s (or deg/s) on an axis with `full_steps_per_mm` F is a TSTEP of
46875 / (v * F): 10 mm/s on a 5 mm screw (F = 40) is 117. A larger value
is a lower speed. One value serves all four drivers, so the change comes
at the same full steps per second on every axis; it comes about 7 %
above that speed on the way up and at it on the way down (the datasheet's
hysteresis of a sixteenth of the TSTEP). 0, the default, keeps stealthChop
at every speed.

After its last step a driver waits 87 ms to find the motor at rest, keeps
the run current for `tpowerdown` times 21.8 ms, then lowers it to
`hold_pct` of it a step of the current scale at a time, `hold_delay` times
21.8 ms a step. `toff`, `tbl`, `hstrt` and `hend` shape the chopper:
`toff` the off time both modes use, `hstrt` and `hend` spreadCycle's
hysteresis.

The firmware takes its settings one at a time and holds each to its own
field. The datasheet (TMC2209 Rev 1.09) also rules out some pairs, which
a file is refused for, since it is seen whole: `toff = 1` with `tbl`
below 2; `hstrt + hend` above 18, where the hysteresis, `hstrt + 1` plus
`hend - 3`, would pass 16; and `tpowerdown` below 2 with `stealth` on,
which leaves stealthChop no time at rest to tune itself. A value set at
the console is not checked against the others.

## Pins

The laser (or spindle) PWM output, the probe input and the tool output
are on whichever GPIOs `[output] pin`, `[probe] pin` and `[enable] pin`
name, and an axis's switch on its `endstop_pin`: any GPIO but the driver
sockets' and the UART's, which
[rp2040/README.md](https://github.com/tmpk13/spinny-firmware/blob/main/rp2040/README.md#pins) of spinny-firmware lists
with the headers' GPIOs. An output (the laser's, a fitted tool output's, a
servo's) may not be a STOP header's either (GP3, GP4, GP16, GP25): their
signals reach the chip through an input buffer, which would drive against
it. The firmware takes the pins one setting at a time,
so a pin named twice is refused here, where the whole file is seen: the
probe may not share the output's pin, and a fitted tool output may share
neither. An axis's `endstop_pin` is an input like the probe's: two axes
may share one, and an axis may share the probe's, but a fitted endstop
(`endstop` other than `none`) may not sit on the output's or the tool
output's pin. The pins and `[enable] fitted` are read at boot, so a write
that changes one takes effect after a restart of the board (*Write to
board* has saved it already); the page says so after such a write.
`endstop` itself applies at once.

The endstops: `endstop` says which ends of the axis have a switch, on the
one input when both do. `home` seeks it, and `endstop_halt` makes it halt
a move that closes it. `home_pos` is what the axis reads at the switch,
the negative one of two, the positive switch of a two-ended axis reading
`home_pos + home_travel`; `home_travel` is the distance between its ends,
which bounds the seek, and `home_pull` how far a home backs off the
switch. The cycle and the halt are in
[PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md#endstops-and-homing), the page's *Home* and
*Homed* in [OPERATING.md](OPERATING.md#endstops-and-homing).

`[enable]` is an output that follows the tool: driven while a job runs, a
beam is lit, a dwell burns or the spindle turns, for a laser supply
relay, an air assist or a spindle's run input. `invert` makes it active
low; off (`fitted = false`) it rests at its inactive level whatever the
tool does.

Every `invert` is checked the same way, by what the machine does, not by
how it is wired. With the head clear of the board, jog each axis one
step: its `invert` is wrong when a positive jog moves it the other way
than its `[controls]` buttons say (the page's X+ must move the head
toward board +X, Y+ toward +Y, Z+ or H+ up, and a positive turn
counterclockwise seen from above). `[probe] invert` is wrong when the
readout says *down* with the tip free and *up* when it touches, and left
so the first probe drives the head into the board; `[output] invert` is
wrong when the beam or the spindle is on with nothing asked for (and
dangerous, so it is the first thing to check at power on); `[enable]
invert` when the relay is on while the machine is idle. Flip the one that
is wrong in the file, load it again and check again.

## Dispenser

A solder paste dispenser is a syringe, or an auger valve, whose plunger a
stepper drives. The machine is the X/Y machine with the focus axis as the
needle's height, and the plunger takes the table's place: `tool =
"dispenser"` sets `$dispenser=1` (and needs `kinematics = "cartesian"`),
and `[dispenser]` describes the plunger on the table's settings in
millimeters: `full_steps_per_mm` for the screw behind it (200 steps on a 2
mm lead is 100, 1600 at 16 microsteps), `max_rate` for the retract and the
ceiling of a plunger jog, `jog_rate` for the page's *Extrude* and
*Retract* buttons. `[table]` and `[dispenser]` do not go in one file. The
Machine panel's readout and jog show the plunger as `E` in mm (the defaults;
`[controls]` may say otherwise), and a board imported with mode `dispense`
lays a dot of paste on every pad of a layer. What a dot is made of is the
host's, under `[host]`: `gap`, `retract`, `output`, `extrude_rate` and
`dwell_ms` (the schema above says what each is), with `clearance` as the
travel height between dots and the retract at `[dispenser] max_rate`; the
run that lays the dots is in [WEB_API.md](WEB_API.md#jobs). The shipped
`cartesian-dispenser` has the plunger on the E socket beside the mill's
rail, slide and depth axis.

## Servos

Up to four servos, `[servo.1]` to `[servo.4]`, each on a pin of the board
(`pin`), whose PWM slice gives it a pulse every 20 ms, or on a channel of
a PCA9685 PWM driver on the board's I2C bus (`channel`), never both. A
servo the file leaves out has no output (`servoN_out` 0), so a file with
none takes them all off, and the file says how many the machine has by
the sections it gives: the Machine panel draws a bar for those only. The
slots are fixed because the firmware keeps each one's seven settings in
its stored settings record, whose layout is fixed; four were picked as
enough for a pen, a shutter, a probe and a gate while keeping that record
and the settings list short (a slot no file fits costs only its settings). The pulse runs from `min_us` at 0 degrees to
`max_us` at `range` degrees in a straight line; a servo that turns the
other way gets the longer pulse as `min_us`. `start` is the angle the
board drives it to at power on; left out, it gets no pulse until it is
moved, and hangs loose meanwhile. `name` and `positions` are the page's:
a bar per servo in the Machine panel with its angle, a field to move it to
any angle in its range, a button per named position and *Off*, which lets
it go. The firmware's side, the `servo` line and how a servo rides through
holds and resets, is [PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md#servos); the wiring and the
supply, [rp2040/README.md](https://github.com/tmpk13/spinny-firmware/blob/main/rp2040/README.md#servos) of spinny-firmware.

`[pca9685]` says where that chip is: its I2C bus's data line `sda` (an
even GPIO) and clock line `scl` (an odd one), which must be one I2C
block's (data on GP0, 20 or 24 with clock on GP1, 17, 21 or 29 for I2C0,
or GP18, 22 or 26 with GP23 or 27 for I2C1), and its `address`, 0x40 with
every address pad open. The bus is started only for a servo with a
channel. The SKR Pico's UART header carries GP0 and GP1, the default; the
SERVOS (GP29) and RGB (GP24) headers reach the chip directly as well.

A file is refused for what the board could not drive, since the firmware
takes the settings one at a time: a servo's pin or a bus line on a STOP
header (GP3, GP4, GP16, GP25), whose input buffer would drive against it;
a servo's pin that is the laser's, the probe's, a fitted tool output's or
another servo's, or that is on the laser's PWM slice (GP20 and GP21 with
the laser on FAN3), whose rate is the laser's, or on another servo's PWM
channel (GPIO n and n + 16 share one); two servos on one channel of the
PCA9685; and, with a servo on it, a bus whose lines are not one block's
or are another output's or the probe's. A fitted endstop may not sit on a
servo's pin or a bus line either. The pins, the channels and the bus are
read at boot, so a write that changes one takes effect after a restart of
the board; the span, the range and the start apply at once (the start at
the next power on).

## Camera

`[camera]` is a camera on the head looking at the board. The backend reads
it through `pcbv serve` from the sibling pcb-vision repository, which
finds the board of a KiCad file in the picture; nothing of it reaches the
firmware. A load puts the table's values into the backend's camera
settings (`GET /api/camera`), and the page starts and stops the camera.
`offset`, `roll` and `mm_per_px` are what the camera offset routine on the
page measures: a mark made with the tool is found in the picture and the
picture's center is put on it. Write them back into the file to keep
them; a camera that is moved, or a tool that is changed, wants them
measured again.

## The controls

The Machine panel's jog and position readout draw what `[controls]` says, so
a machine with other joints, names, steps or keys needs no change to the
page. The backend sends the controls with the settings (`GET
/api/settings`): the file's whose settings the live ones are, every one
of them, or, for settings that are no file's (one changed by hand, or
firmware older than the file's newest keys), the file last loaded from
this host when it describes this kind of machine (kinematics, tool, focus
axis), else the one file that does, else the defaults for what the
settings say the machine is. `controls_from` names the file, and the
Machine file panel says under the file whose controls the Machine panel draws. A file
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
mill leaves the board pad out, since its X and Y bars are the rail and the
slide).

An entry fills in what it leaves out from the default for its joint; an
entry given a `letter` or a `label` but no `buttons` is labeled
`<letter>-` and `<letter>+` rather than with the default's words. The
step picked with a control is kept while the page is up; the keys of an
axis jog it by that step, and `Escape` or the Machine panel's *Cancel*
stops whatever the controls are. `place`, which older files say, is
still taken and means nothing now. The virtual firmware checks only that
`[controls]` is a table: the controls are the page's, not the machine's.

## G-code machines

A machine whose own controller takes the G-code OpenPnP's GcodeDriver
sends (Marlin, Smoothieware, RepRapFirmware, Grbl), a line at a time,
each answered `ok`, says `controller = "gcode"`. None of this project's
firmware settings are its: the sections above other than `[controls]`
are refused in it, and it is never written to a board (*Write to board*
and *Read from board* are locked for it); it is connected instead. Its
tool is a vacuum nozzle (`tool = "nozzle"`, the only one it takes, as
`kinematics = "cartesian"`), and its joints are the cartesian machine's:
`r` is X, `z` is Y, `h` is Z (the nozzle's height) and `a` the rotation
axis as the controller counts it, so the Machine panel's jog, readout and
goto rows draw and drive it as any machine, its `[controls]` (left out:
X and Y on the pad and as bars, the nozzle's height and its turn, with no
Center and no zero button on Z or the turn) naming the bars. Its own
tables, read by the backend (`spinny_web.openpnp`) and the page's mock
alike, each key checked and named when wrong:

```toml
name = "OpenPnP Marlin"
description = "..."
controller = "gcode"

[port]
url = ""                 # a serial device (/dev/ttyACM1) or socket://host:port that is this machine's
match = ["lumen"]        # words in a port's USB names (product, maker, description, any case) that make it this machine's
baud = 115200
wait_ms = 2000           # a board that resets when its port opens boots this long before the first line
timeout = 60             # s a line may take to be answered; a home gets three times this

[gcode]
init = ["G21", "G90"]    # sent at the connect and before a placing run
end = []                 # sent after a run
move = "G0"              # the move word; every move carries its F
x = "X"                  # axis letters, four different capitals, not F
y = "Y"
z = "Z"
rotation = "A"
rotation_cw = false      # true when a positive rotation turns the nozzle clockwise seen from above
wait = "M400"            # answered once the moves queued have run: after a goto, before every vacuum switch
pick = "M106"            # vacuum on: a line or a list (a pump and a valve take one each)
place = "M107"           # vacuum off
dwell = "G4 P{ms}"       # {ms} or {s} for the time; empty for none
home = "G28"             # the Machine panel's Home, with the axes' letters when it names some
position = "M114"        # answered with X:... Y:... Z:... (A:...): read at the connect, once a second, before a jog
stop = "M410"            # the Stop and jog cancel, sent ahead of anything in flight; empty sends nothing
motors_on = "M17"        # the Machine panel's Motors; empty: refused
motors_off = "M18"
light_on = []            # the cameras' lights, a line or a list; the cameras' routines switch them on first
light_off = []
skew = "M852 I{skew}"    # tells the firmware [motion] skew when skew_by = "firmware", {skew} for the factor; empty: a build with its factor in it, nothing sent

[motion]
feed_xy = 6000           # mm/min across, and of a jog or goto without a feed of its own
feed_z = 1200            # mm/min up and down
safe_z = 0               # needed: the lowest height a move across goes at; a nozzle below it rises to it first, one above it stays there
seesaw = false           # true: one Z motor drives two nozzles, the first down below safe_z and the second above it (the LumenPnP): moves across come to safe_z from either side, and Z jogs stop at it; false: a plain Z, a nozzle above safe_z stays there; left out: moves across come to safe_z from either side, jogs go where sent
place_z = -20            # needed: the tip with a part on it at the board's top
pick_dwell_ms = 200
place_dwell_ms = 150
pick_tries = 3           # pockets tried for one part before it is left out, 1 to 20
park = [40.0, 400.0]     # X Y where Park takes the head
travel = [0.0, 0.0, 433.0, 487.0]  # how far the head reaches, x0 y0 x1 y1 as places of the nozzle (the controller's soft limits): the Machine view panel (Cameras page) draws the machine as this box; nothing moves by it; left out, the view boxes the places the file names
discard = [10.0, 10.0, -15.0]  # X Y Z where a part that failed a check is let go; left out, back in its pocket
skew = 0.0023            # the axes out of square (below): the head's Y travel leans this many mm toward +X a mm, -0.02 to 0.02; left out, 0 (square)
skew_by = "link"         # who takes it out: "link", this backend on every move and place read; "firmware", the controller told by [gcode] skew at the connect

[vacuum]                 # a sensor: read after each pick and place when it has ranges
read = "M105"            # the line, or lines; the reading is in the last one's answer
pattern = "T:\\s*(-?[0-9]+(?:\\.[0-9]+)?)"  # a group around the reading; OpenPnP's (?<Value>...) reads too
part_on = [40.0, 100.0]  # low and high with a part held; left out, read by hand only
part_off = [0.0, 10.0]   # with the nozzle empty

[up_camera]              # the bottom camera, when it is fixed to this machine
position = [150.0, 30.0] # the head's place with the nozzle over its picture's center, as designed; Center nozzle measures it
z = -15                  # the height the nozzle tip is seen sharp at over it; left out, the safe height
crop = 3.0               # mm from the picture's center a part is looked for; left out, pcbv's own reach
max_offset = 1.0         # mm a part's center may sit off the nozzle's
max_turn = 15            # degrees a part may sit off its angle
size_tolerance = 0.3     # fraction a part's length or width may differ from the one expected; 0 checks no size
leave = 2.0              # a jog taking the nozzle from within this many mm of the camera to farther, off the safe height, goes up to it first; left out, jogs never rise
roll = 0                 # degrees from the picture's x axis to +X, counterclockwise seen from above, as mounted; used until Center nozzle measures the scale, roll and mirror; left out, the measured one or 0
mirror = true            # the picture shows the machine mirrored, as a camera looking up sees it; false when its driver flips the picture; used until measured like roll
device = "/dev/video2"   # the camera itself, taken by the bottom camera as the machine connects (below): its device as [camera]'s,
size = "1280x720"        # its capture size,
fps = 30                 # its rate,
pcbv = "pcbv"            # the pcbv program,
nozzle_spot = "dark"     # how the nozzle's bore looks to it,
part_spot = "dark"       # and a part on the nozzle

[up_camera.crops]        # the parts of the bottom camera's picture its tasks look in (below); a task left out looks at the whole picture
nozzle = [0.35, 0.3, 0.65, 0.7]  # Center nozzle and Measure runout: the tip only inside
part = [0.2, 0.1, 0.8, 0.9]      # a part on the nozzle, inside this box and the circle of its crop

[top_camera]             # a camera on the head looking down
z = 0                    # the height the head looks from; left out, the safe height
offset = [40.0, 0.0]     # its picture's center from the nozzle as designed; Offset by bottom camera, or Measure offset from a mark, finds it
roll = 180               # degrees from the picture's x axis to +X, counterclockwise seen from above, as mounted (180: upside down); used until Measure offset measures the scale and roll; left out, the measured one or 0
bed = [20.0, 60.0, 450.0, 550.0]  # where boards lie, x0 y0 x1 y1 of the places the picture's center goes over: a search with no place known and no box drawn scans it on a lattice spaced by the board's size, then halfway between; left out, a square the board's diagonal on a side about the head
board_area = [40.0, 80.0, 200.0, 200.0]  # where a board is expected, x0 y0 x1 y1 in the frame of bed and inside it: a search with nothing known looks there first, then the rest of the bed; drawn and set on the Machine view panel; left out, the whole bed
board_area_only = false  # true: boards are only ever placed inside board_area, so a search never looks outside it
mm_per_px = 0.016        # its scale as designed, mm a pixel of the full size picture at the size it runs at: until a scale is measured or seen locked, a search plans its stops by it and pcbv's search keeps within 1.5 times of it either way; left out, none
fiducial = "bright"      # how a fiducial looks to it
within = 2.0             # mm from where it is expected that a fiducial, mark or part is looked for
home_fiducial = [60.0, 170.0]  # a fiducial fixed on the bed, as the nozzle's place over it: Home by fiducial finds it with this camera; left out, none
device = "/dev/video4"   # the camera itself, taken by the top camera as the machine connects: device, size, fps and pcbv as [up_camera]'s,
mark_spot = "dark"       # and how the mark Measure offset centers looks to it

[top_camera.crops]       # the parts of the top camera's picture its tasks look in (below); a task left out looks at the whole picture
board = [0.0, 0.0, 1.0, 1.0]     # the board look, its searches and scans: pcbv keeps to the pads and holes it sees inside
spot = [0.3, 0.25, 0.7, 0.75]    # Find mark, Measure offset, Find fiducials, Home by fiducial, Look once
edges = [0.1, 0.1, 0.9, 0.9]     # Corner by edges and the edge view: edges whose middle lies inside
measure = [0.1, 0.1, 0.9, 0.9]   # Measure camera and the empty picture test: only these pixels are compared

[[feeder]]               # a part is picked from the first one whose words its value and footprint all hold
id = "r-10k-0603"
match = "10k 0603"       # or refs = ["R1", "R2"], the parts by reference, which outdo the words
at = [100.0, 50.0, -22.0]  # the first part's place, X Y Z
pitch = [4.0, 0.0]       # from one part to the next along the tape, or from column to column of a tray
count = 50               # parts in it; 0 for one that presents every part at `at`
columns = 0              # with row_pitch, a tray taken row by row
rotation = 0             # the parts' angle as they sit in it
# place_z, feed (lines before each pick), vision (looked at over the bottom camera), size,
# pocket (its shade to the top camera), marks and mark, crop

[[part_class]]           # parts by size, each looked at over the bottom camera within its own crop
name = "0402"            # the class's name, as the page lists it
match = "0402"           # words a part's value and footprint must all hold, any case; the first class that matches is the part's
crop = 1.0               # mm from the picture's center its parts are looked for: a small part close in, a large one with room for its body
```

The cameras' own keys (`device`, `size`, `fps`, `pcbv` and the shades
their routines look for) are put into the bottom and top cameras' settings
when the machine is connected, as a load puts a `[camera]` table into the
head camera's: what the file leaves out keeps what the Cameras page set, and a
camera given a new device starts again on it. The places, rolls and
mirror are first guesses instead, which the cameras' routines measure and
keep. So a machine's cameras come with it: the virtual LumenPnP's file
names its two cameras' addresses, and connecting it sets both up.

A part looked at over the bottom camera keeps to a circle about the
picture's center: its feeder's `crop`, else its `[[part_class]]`'s, else
`[up_camera] crop`, else pcbv's own reach (a third of the picture's
height). The bottom camera view rings the crop of the class picked under
it, and its *Look once* at a part keeps to that crop.

A camera's `crops` table gives each of its tasks a box of the picture to
look in: `[x0, y0, x1, y1]` in shares of the picture's width and height
from its top left corner, `0 <= x0 < x1 <= 1` and `0 <= y0 < y1 <= 1`, so
another capture size keeps it. The bottom camera's tasks are `nozzle` and
`part` (the part's box and its circle both hold); the top camera's are
`board`, `spot`, `edges` and `measure`. A task left out looks at the whole
picture, and an unknown task is refused with the known ones named. A spot
is taken only when its center lies inside, an edge when its middle does,
the board look keeps to the pads and holes pcbv sees inside (pcbv is told
the `board` box at every camera start and board load, and when the file
is written; the posterior counts a picture's pads in the box, and a
search's checks put the box over the pads they look at), and Measure
camera and the empty picture test compare only
the pixels inside. A spot look's circle is clipped to the farthest corner
of the box. A pcbv built before crops takes none: the camera says so once
and looks at the whole picture. Each camera picture's View menu draws a
task's box and saves it here ([OPERATING.md](OPERATING.md)); a search
record keeps the crops it looked with.

A machine's X and Y axes are rarely square. `[motion] skew` says how far
the head's travel along Y leans toward +X, in mm of X per mm of Y: the
tangent of how far the angle from +X to +Y falls short of 90 degrees
(0.13 degrees is 0.0023, 0.23 mm across a 100 mm board), the factor
Marlin's `M852 I` takes and the Y factor of the X axis OpenPnP transforms
for non-squareness. Uncorrected, a head sent to X Y stands at X + skew * Y.
With `skew_by = "link"` (or left out) the backend takes it out: every
move goes to the controller as X less skew * Y, every place it reports
reads back as X plus skew * Y, and a move or G92 naming one of X and Y
names both (on skewed axes the controller's X holds Y too), so the page,
the cameras and every place in the file are square. With
`skew_by = "firmware"` the controller does it, as Marlin built with
`SKEW_CORRECTION` and `SKEW_CORRECTION_GCODE` does: the connect sends
`[gcode] skew` with the factor after the firmware's name is asked, a
placement's program starts with it, and a file written while connected
tells the firmware its new factor (0 when the file gives the skew back
to the link) before the next move. A firmware that answers the line as
unknown (the stock Lumen build says `echo:Unknown command`, then `ok`)
is not connected, with why. Measure camera (OPERATING.md) says the skew
that squares the axes, from the head's moves through the skew taken out
now. Changing the skew moves every place kept in machine numbers by the
change times its Y (up to 0.9 mm at the far end of a LumenPnP's Y):
measure the cameras' places, offsets, feeders and fiducials again. The
OpenPnP import carries OpenPnP's own non-squareness, its places being
square ones. The console's lines go out as typed.

A feeder bus (`[bus]`, `[[slot]]`, and a feeder's `bus_id`, `slot`,
`offset` and `advance` in place of `at`, `pitch` and `count`) carries
packets to smart feeders through the controller: its keys, and what a
run does with them, are in [WEB_API.md](WEB_API.md#placing-with-a-g-code-machine),
the LumenPnP file spelling out Opulo's Photon feeders.

The Connection panel lists every serial port with the G-code machine whose file
claims it (its `url` is the port's, or one of its `match` words is in
the port's USB names), and a G-code machine whose `url` no port is
listed under (a socket) as an entry of its own; Connect opens a claimed
port as that machine, anything else as this project's firmware. The
connect sends `init`, asks M115 for the firmware's name and reads the
head's place. A jog reads the place first and is answered once queued, so
jogs pressed quickly add up; a goto moves only the axes it names, rises to
`safe_z` only to go across and only from below it (a nozzle above it stays
there; with `seesaw` it comes down to it too), puts the height last, and is
answered once its moves have run. Nozzle to Part, Camera to Part, Park, the camera swaps and
the cameras' routines go across by the same rule, and a seesaw's Z jog
stops at `safe_z`, both nozzles up, rather than go past it. The console sends lines as typed; Stop sends `stop`. What
needs this project's firmware (the laser, the spindle, runs, probing,
settings, the head camera's routines) answers that the machine is a G-code
one. The page places parts with it (see OPERATING.md), and the Machines page's
*Import from OpenPnP* makes one from OpenPnP's `machine.xml`, its feeders' parts' sizes and
heights from its `parts.xml` and `packages.xml`.

## A release's machine files

A release ships these files inside its package, and its first start copies
them into your machines directory, which from then on is yours: nothing
writes it unasked. When a later release ships a file changed (a key added,
a value corrected) or a file you have no copy of, the Machine file panel offers it
under the file pick: each offer lists its changes and shows the
difference it makes to your copy; *Take* writes it, *Keep mine* leaves your
copy as it is, and neither is offered again for that release.

The offer is your copy with the release's changes merged in. What each
copy was made from (the file as shipped when it was copied in, or when you
last took or left a release's) is kept in `var/shipped/machines/`, so a
value only the release changed becomes the release's, a value you changed
stays yours, also when the release changed it too (listed as kept), a key
the release added goes in with its own lines and comments, and one it took
out goes unless you changed it. An array of tables (`[[feeder]]`,
`[[controls.axes]]`) is one value: the release's tables replace yours only
where you left them as shipped. A copy made before a release kept that
record is merged two-way: what the release adds goes in, and every value of
yours stays, the ones that differ listed. A merge the backend would refuse
is shown with why, to leave or to mend your copy first. A checkout of the
repository updates its files with git and is offered nothing.

## How a load works

The backend reads the file, maps it onto every firmware setting and writes the
ones that differ from the machine's, one `$name=value` line each, all or
nothing: a value the firmware refuses has the ones sent before it put back.
The host values are stored once the firmware's part is through. Through
the API nothing is saved to flash unless asked (`{"save": true}`), so a
load there can be tried and undone with a power cycle; the page's *Write
to board* always saves. A load is
refused while a run or probing owns the machine, like any settings write.

Which file the live settings are is decided on every settings read by
comparing every value, so a setting changed by hand at the console or by
a page control turns the pick to "settings of no file" until a file is loaded
again. Values are compared as the firmware reports them: a 32 bit float
printed with three decimals.

## Adding an axis arrangement

The files only name what the firmware has: four joints, two kinematics,
two tools. A new arrangement is a firmware change first (a setting, a
joint, a mode), then a key in the schema in both implementations, then a
file. The shipped `polar-laser.toml` spells out every default, and the
virtual firmware's tests check that loading it leaves the defaults as they
are, so that file is also where a changed default shows up.
