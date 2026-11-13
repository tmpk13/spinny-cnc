# Machine configuration files

A machine is a TOML file in `machines/`: its axes with their scales,
rates and limits, the kinematics (the rail as the radius over a turning
table, or as X beside the cross slide as Y), the tool (a laser, a
spindle with the focus axis as its depth, or a solder paste dispenser
whose plunger takes the table's driver), the camera on the head, if any,
and the controls the page draws for it. Loading a file
writes every firmware setting, so swapping files swaps machines. The same
files start the virtual firmware, and give the gcode tools their defaults.
A machine whose own controller takes G-code, a pick and place machine's
Marlin, is a file here too ([G-code machines](#g-code-machines)): it is
connected from the Connection tab and jogged, homed and stopped like the others.

| Where | How |
| --- | --- |
| Web page | The *Config* tab: pick a file, edit it in the TOML editor (read as it is typed, and whole by *Check*), *Save* it and press *Write to board*, which writes every setting and saves it to the board's flash in one step (saving an edited text first). *Read from board* writes the board's values into the text where they differ, for a look before *Save*. A line says what the board runs and whether its flash has it; *Save to flash* shows only when something written past the file (the console, a page control) left flash behind. Beside the editor, *Settings* lists every key a file can set with the file's value next to the board's, the differences marked, a fuzzy search over key, firmware setting and help; a click goes to the key in the editor, adding it with the file's value when the file leaves it out. |
| Backend | `GET /api/machines`, `GET`, `PUT`, `PATCH` and `DELETE /api/machines/{id}`, `POST /api/machines/{id}/check`, `POST /api/machines/{id}/apply` ([WEB_API.md](WEB_API.md)); `spinny-web --machines DIR` reads another directory |
| Virtual firmware | `spinny-virtual --machine machines/cartesian-mill.toml`; `--settings` after it overrides single values |
| Gcode tools | `spinny-iso --machine machines/polar-laser.toml ...`: the axis rates, the power scale and the chord tolerance stand in for the defaults; a flag given still wins |
| Code | `spinny_laser.machines` (Python), `firmware/virtual/src/machine.rs` (Rust); the virtual firmware's tests load the shipped files, so the two stay one schema |

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

[controls]                      # the page's jog panel and readout; left out: the defaults below
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
of [PROTOCOL.md](PROTOCOL.md). Left out, a key keeps the firmware's
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
[firmware/rp2040/README.md](../firmware/rp2040/README.md#pins) lists
with the headers' GPIOs. The firmware takes the pins one setting at a time,
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
[PROTOCOL.md](PROTOCOL.md#endstops-and-homing), the page's *Home* and
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
page's readout and jog panel show the plunger as `E` in mm (the defaults;
`[controls]` may say otherwise), and a board imported with mode `dispense`
lays a dot of paste on every pad of a layer. What a dot is made of is the
host's, under `[host]`: `gap`, `retract`, `output`, `extrude_rate` and
`dwell_ms` (the schema above says what each is), with `clearance` as the
travel height between dots and the retract at `[dispenser] max_rate`; the
run that lays the dots is in [WEB_API.md](WEB_API.md#jobs). The shipped
`cartesian-dispenser` has the plunger on the E socket beside the mill's
rail, slide and depth axis.

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
mill leaves the board pad out, since its X and Y bars are the rail and the
slide).

An entry fills in what it leaves out from the default for its joint; an
entry given a `letter` or a `label` but no `buttons` is labeled
`<letter>-` and `<letter>+` rather than with the default's words. The
step picked with a control is kept while the page is up; the keys of an
axis jog it by that step, and `Escape` or the jog panel's *Cancel*
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
axis as the controller counts it, so the jog panel, the readout and the
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
home = "G28"             # the jog panel's Home, with the axes' letters when it names some
position = "M114"        # answered with X:... Y:... Z:... (A:...): read at the connect, once a second, before a jog
stop = "M410"            # the Stop and jog cancel, sent ahead of anything in flight; empty sends nothing
motors_on = "M17"        # the jog panel's Motors; empty: refused
motors_off = "M18"
light_on = []            # the cameras' lights, a line or a list; the cameras' routines switch them on first
light_off = []

[motion]
feed_xy = 6000           # mm/min across, and of a jog or goto without a feed of its own
feed_z = 1200            # mm/min up and down
safe_z = 0               # needed: the height every move across goes at, gone to from above or below (a seesaw Z lowers its other nozzle above it)
place_z = -20            # needed: the tip with a part on it at the board's top
pick_dwell_ms = 200
place_dwell_ms = 150
pick_tries = 3           # pockets tried for one part before it is left out, 1 to 20
park = [40.0, 400.0]     # X Y where Park takes the head
discard = [10.0, 10.0, -15.0]  # X Y Z where a part that failed a check is let go; left out, back in its pocket

[vacuum]                 # a sensor: read after each pick and place when it has ranges
read = "M105"            # the line, or lines; the reading is in the last one's answer
pattern = "T:\\s*(-?[0-9]+(?:\\.[0-9]+)?)"  # a group around the reading; OpenPnP's (?<Value>...) reads too
part_on = [40.0, 100.0]  # low and high with a part held; left out, read by hand only
part_off = [0.0, 10.0]   # with the nozzle empty

[up_camera]              # the PNP tab's bottom camera, when it is fixed to this machine
position = [150.0, 30.0] # the head's place with the nozzle over its picture's center, as designed; Center nozzle measures it
z = -15                  # the height the nozzle tip is seen sharp at over it; left out, the safe height
crop = 3.0               # mm from the picture's center a part is looked for; left out, pcbv's own reach
max_offset = 1.0         # mm a part's center may sit off the nozzle's
max_turn = 15            # degrees a part may sit off its angle
size_tolerance = 0.3     # fraction a part's length or width may differ from the one expected; 0 checks no size
leave = 2.0              # a jog taking the nozzle from within this many mm of the camera to farther, off the safe height, goes up to it first; left out, jogs never rise

[top_camera]             # a camera on the head looking down
z = 0                    # the height the head looks from; left out, the safe height
offset = [40.0, 0.0]     # its picture's center from the nozzle as designed; Measure offset finds it
fiducial = "bright"      # how a fiducial looks to it
within = 2.0             # mm from where it is expected that a fiducial, mark or part is looked for
home_fiducial = [60.0, 170.0]  # a fiducial fixed on the bed, as the nozzle's place over it: Home by fiducial finds it with this camera; left out, none

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
```

A feeder bus (`[bus]`, `[[slot]]`, and a feeder's `bus_id`, `slot`,
`offset` and `advance` in place of `at`, `pitch` and `count`) carries
packets to smart feeders through the controller: its keys, and what a
run does with them, are in [WEB_API.md](WEB_API.md#placing-with-a-g-code-machine),
the LumenPnP file spelling out Opulo's Photon feeders.

The Connection tab lists every serial port with the G-code machine whose file
claims it (its `url` is the port's, or one of its `match` words is in
the port's USB names), and a G-code machine whose `url` no port is
listed under (a socket) as an entry of its own; Connect opens a claimed
port as that machine, anything else as this project's firmware. The
connect sends `init`, asks M115 for the firmware's name and reads the
head's place. A jog reads the place first and is answered once queued, so
jogs pressed quickly add up; a goto moves only the axes it names, rises to
`safe_z` only to go across, puts the height last, and is answered once its
moves have run. The console sends lines as typed; Stop sends `stop`. What
needs this project's firmware (the laser, the spindle, runs, probing,
settings, the head camera's routines) answers that the machine is a G-code
one. The PNP tab places with it (see OPERATING.md), and the Config page
imports one from OpenPnP's `machine.xml`.

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
