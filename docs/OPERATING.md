# Operating the machine

From the first connection to a probed, compensated run. The wiring and the bring-up order are in `firmware/rp2040/README.md`; the page's panels are described in `web/frontend/README.md`.

## Connecting and first moves

| `web/frontend` | the page | `cd web/frontend && bun install && bun run build` |

The line protocol is `docs/PROTOCOL.md`, the web API `docs/WEB_API.md`.
A board upload isolates its copper by default; with Board set to deposit,
for a process that lays copper down, it burns the copper itself and
nothing past its edge. The Layer field picks the layer a KiCad board is
read from: a copper layer, or F.Paste, which with deposit burns the paste
openings out of a film laid where the board would be, a solder paste
stencil. A gerber is its own layer.
Open `http://localhost:8000`, connect to the board (or to
`socket://127.0.0.1:2323` for the virtual firmware, or to
`socket://127.0.0.1:2324` for a controller on a Pi forwarded by `mise run
relay-pi -- user@host`), jog the beam over the
axis with the radius buttons, press "Set R=0 here", then turn the table
with the turn buttons: a positive turn must swing the point under the beam
counterclockwise seen from above, otherwise set `$dir_invert`. Check steps
per unit at low speed before the first job. Every axis is a bar in the
jog panel, with its step choices and a field for any other step; *Cancel*
in the panel's head, or Escape, stops a move. The *Config* tab holds the
machine files, where the pins are set too (the laser output, the probe
and an optional tool output), and the live firmware settings.

### Probing and the height map

An optional focus axis (`H`, the E driver socket unless `$sockets` moves
it, `$h_axis=1`) carries a
touch probe on the Z-STOP input. The Height map panel probes a grid over
the board, and a run can then follow it: the focus axis tracks the board
under the beam, or, without a focus axis, the power is raised where the
board sits out of focus.

1. Jog the head up until the probe clears the board: probing travels at
   that height. Set the probe's offset from the beam under *Probe*.
2. *Fit to job* (the preview shows the grid), then *Probe*.
3. Jog the beam over the board, focus it by eye with the focus axis, and
   press *Focus here*.
4. Run with *height map: auto*.

Wiring and bring-up are in `firmware/rp2040/README.md`; nothing of this has
run on hardware yet.

### Cartesian and spindle

Two optional modes use the same machine; both are firmware settings, off
by default, and the page follows them. The quickest way between them is
the *Config* tab, which edits and loads a whole file from
`machines/` ([MACHINES.md](MACHINES.md)): `cartesian-laser` and
`cartesian-mill` are the two modes below with the slide's travel set to
30 mm either side; copy one and change the limit to yours. The settings
named below are what such a file writes.

`$cartesian=1` makes it an X/Y machine: the rail is X, the cross slide Y,
interpolated together, and the table holds its angle. Board X/Y is turned
by that angle, so a board placed for a polar job is cut in the same place.

1. With the polar machine centered, jog the cross slide until the rail
   passes over the axis and press *Set Z=0 here*.
2. Set `$z_max` to the slide's travel either side of that, then
   `$cartesian=1`.

`$spindle=1` puts a spindle on the laser output and uses the focus axis
(`$h_axis=1`) as its depth axis. A job is milled: the tool rises to the
travel height, the spindle starts and spins up, and every path is a plunge,
the cuts at depth and a rise, each pass of a group a step deeper. Groups
carry a depth and a plunge rate; the host keeps the travel clearance and
the spin-up (the Config tab's settings panel).

1. Touch the tool to the copper and press *Set H=0 here*: without a height
   map H 0 is the surface.
2. Or probe a height map (the tool can be its own probe, touching grounded
   copper, tip offsets 0), jog the tool down until it touches the copper,
   press *Touch off here*, and run with *height map: auto*: the cuts then
   follow the board.

FAN3 is a low side switch on the fan rail, not a logic output: see the
spindle note in `firmware/rp2040/README.md` before connecting one.

### Dispensing solder paste

A paste dispenser is a syringe whose plunger a stepper pushes, on the
table's driver socket: load `cartesian-dispenser` (or your copy of it,
[MACHINES.md](MACHINES.md)), which makes the machine an X/Y machine with
the focus axis as the needle's height and the plunger as `E` in mm. The
jog panel's *Extrude* and *Retract* push and pull the plunger by its step,
for priming the needle and checking the flow.

1. Upload the board with mode *dispense*: a dot on every pad of its paste
   layer (`F.Paste`; a copper layer's pads are its flashes), the paste
   thickness over a pad (0.12 mm by default) in the upload form and in
   the group's *thickness* afterwards. A dot's volume is the pad's area
   times the thickness, and the plunger pushes it out over the *output*
   setting, mm^3 of paste per mm of plunger, which depends on the syringe
   and is worth measuring once by weight: the Config tab's host settings
   hold it with the needle's *gap* over the pad, the *retract* after each
   dot, the *extrude rate* and the *dwell* before the retract.
2. Line the job up with the board ([below](#lining-a-job-up-with-the-board)).
3. Touch the needle to a pad and press *Set H=0 here*, or probe the pads
   ([below](#probing-the-pads)) and run with *height map: auto* so the
   needle keeps its gap over every pad of a warped board.
4. Run. The head travels at the clearance, lowers the needle to the gap
   over each pad, pushes the dot out plus the last retract, waits, pulls
   the plunger back, and lifts; the plunger ends every dot retracted. A
   run picks up at a line like any other, the plunger declared where the
   plan had it.

### Probing less: around the cuts, and one point

Probing every point of a grid over a sparse board measures mostly bare
board. Under the grid fields, *around the job's cuts* probes only the
points a cut of the selected job comes within the margin of (the corners
of every grid cell a cut passes through) and leaves the rest out: the
preview shows which, and the estimate beside it says how many points and
about how long. A run following such a map is refused where a cut would
land in a cell nobody probed, so probe with the job you will run.
Probing that was stopped goes on with *Continue*, which probes only the
points the map still lacks; the time left is shown as it goes.

*Probe here* lowers the probe where the head is and comes back up. *Tie
map* reads the surface against what the map says there and moves the
map's offset by the difference, so a map probed before a power cycle, a
restart or a position set follows the board again without being probed
anew: put the tip over copper the map covers, not in a cut. *Probe
nearest* finds that spot for you: it picks the probed point nearest the tip
that the loaded job's cuts (or the last run's) keep clear of, says where
it is and how far, and on a yes goes there, probes and ties the map. *Set
H 0* (Z 0 on a mill) makes the surface found H 0, for milling without a
map.

### Probing the pads

A probe that has to land on copper, the tool itself touching grounded
copper or a conductive tip, finds nothing on the bare board between the
pads. *Probe pads* in the Height map panel probes the selected job's pads
instead of a grid: every pad of at least the least area given (half a
square millimeter by default, so a tip has room), and when the board has
more pads than the most points asked for, the most spread out of them,
in a short tour. *Plan* says how many and about how long. The map is then
a pad map: its heights sit at the pads, exact there, and between pads the
surface is a plane through every probed pad plus the nearest pads'
deviations from it, so a warp shows where it is measured and fades
between. A run follows a pad map as it follows a grid, *Tie map* ties it
the same way, and *Continue* goes on with the pads it still lacks. A board
job carries its pads from the layer it was imported from; a drawing or a
gcode file has none to probe.

### The camera and its offset

A camera on the head ([MACHINES.md](MACHINES.md), `[camera]`) is read by
the backend through `pcbv serve` from the sibling pcb-vision repository
(`mise run build-pcbv` builds it; on a Raspberry Pi that runs the
backend, build it there or point `pcbv` at a binary built for it). The
Camera panel on the Machine page starts it, shows its picture with a
crosshair at the center, and, with *Look for board* on a job imported
from a KiCad file, where on the board the picture is and how well it is
locked. The camera is useful once the machine knows where it looks from
the tool:

1. Put a piece of scrap, or a board edge, under the tool and press *Make
   mark* (a spindle machine: a short plunge at the depth and plunge rate
   given, run as a one point job named `camera mark`; on another machine
   make a mark by hand, or use a hole, and press *Mark is here* over it).
2. Press *Find mark*. The head lifts to the clearance, goes where the
   camera should see the mark by the offset in force (zero at first: have
   the camera's field of view cover the tool's position then, or type a
   rough offset into the settings first), takes the darkest spot nearest
   the picture's center for the mark, moves 2 mm along X and back to
   measure the picture's scale and turn against the machine, and moves
   the head until the center sits on the mark. The offset, roll and scale
   are saved in the camera settings; copy them into the machine file to
   keep them with it. A camera that is moved on the head, or a tool that
   is changed, wants the routine run again.

### Lining a job up with the board

A job imported from a board is placed about the axis; the board on the
table is wherever it was clamped. The Align panel pairs points of the job
with where the machine finds them, and turns and shifts the job to match
(its paths, outline, pads and holes move; the job's *rotation* and
*offset* record it):

- Without a camera: put the tool's tip over a hole or a pad of the board
  and press *Mark here* with *nearest hole* or *nearest pad* (the job's
  nearest within the distance given is paired; a typed X Y pairs any
  design point). Two marks far apart give the turn and the shift, one
  mark a shift only; more marks are fitted by least squares, and the
  residuals and the scale the marks imply show a mistaken pairing.
- With a camera locked on the board: *Capture* pairs the picture's center
  with where it is on the machine, with the board's turn from the
  picture's angle and the camera's roll. One capture lines the job up;
  two, far apart, do without the roll.

*Apply* moves the job and clears the marks. Check the result in the
preview, and probe the pads or tie the height map after a large move,
since the map is in board coordinates too.

### Picking a run up where it stopped

A run that stopped short, this session's or an earlier one's, shows a
*Resume from line* row under its job with the count of lines done filled
in. The backend writes `var/resume.json` as a run goes, so the count
survives the host as well as the controller.

1. If the controller lost its position (it was powered down, or reset
   while moving), tell it where the head is first: *Here is* in the Jog
   panel declares the joints without moving them, and *Last known* fills
   in the last position the machine reported before the link closed,
   run or no run. The head sits where the run left
   it, so the X/Y screws keep that position across a power cycle; the
   depth axis may have sunk under the spindle's weight.
2. With a height map, tie it to the new frame: *Probe nearest: tie map*,
   or *Probe here: tie map* over copper the map covers (the map's offset
   is taken back by every position set, as a safeguard). Tying again in
   the same frame changes nothing: the map keeps the gap over the
   contact and a tie only remeasures the frame. The *Height map* select
   in the run row says how the pickup follows the board; untouched, it
   is the way the stopped run did.
   Without the map (the stopped run was *off*), the run takes H 0 for the
   copper, so set that first: *Probe here: set Z 0* on the copper. A
   pickup without the map is refused when a probe in this frame found the
   copper more than 1 mm from H 0, which is what a power cycle with the
   head raised looks like.
   When nothing moved the axes since the offset was set (the link dropped
   and came back to a board that did not restart: `diag` at the connect
   shows its `up` time still counting), the banner under the status bar
   offers *Keep* for the dropped offset instead of a tie. Nothing checks
   that, so keep it only when you know the head was not moved.
3. *Plan* says which line the run starts at, how the head gets there and
   what goes out first; *Resume from line* does it after a confirmation.
   Leave *from the start of its path* on: the run then redoes the path the
   line belongs to from its rapid, so a count one line off cannot leave a
   gap in a trace. A spindle rises to the travel height, goes over the
   point, starts at the job's speed there, spins up and plunges before the
   first cut.

A machine that stops answering is given up by the link after 3 s of
silence: the state badge first shows the age of its last report, then the
run ends as an error with the reason and the link closes. Reconnect, and
pick the job up as above; the console's *Log* shows the backend's log,
which keeps what happened when no page was open.

A link closed with `bridge ... gone: No such device` while `diag` at the
next connect shows `lockups` counted at that moment is the board's USB
lockup guard (RP2040 erratum E15): the controller stopped answering, the
board dropped off the bus to reset it and came back within a second. The
board stops the run as for any host that goes away (`Alarm:1` with the
spindle or beam off) but keeps its position, so the pickup can keep the
focus offset.

### Checking the directions and the probe

Every `invert` in the machine file is checked by what the machine does.
With the head clear of the board, jog each axis one step: X+ must move the
head toward board +X, Y+ toward +Y, Z+ or H+ up, and a positive turn must
swing the point under the beam counterclockwise seen from above; an axis
that goes the other way wants `invert = true` in its section
(`$dir_invert`). Then watch the *Probe* readout: it must say *up* with the
tip free and *down* while the tip touches; the other way round wants
`invert = true` under `[probe]` (`$probe_invert`), or the first probe
drives the head into the board. Load the file again after a change.

### Endstops and homing

An axis with a switch at one end or both (`endstop` under its section in
the machine file, with `endstop_pin`) can be homed: *Home* in the jog
panel, or `home`, `home R` or `home R+` in the console, seeks each switch
at the jog rate, backs off, finds it again slowly and declares the axis
to read `home_pos` there, ending the pull-off (`home_pull`) from it. The
readout's *Homed* field names the joints homed since the position was
last lost; a position set, a reset while moving, a lost motor supply or
an endstop halt unhome them.

Before the first home, check each switch as the probe is checked: close
it by hand and watch the console's `?` line, which has no field for the
switches but refuses a `home` that starts on a closed one. Set
`home_travel` to the axis's real travel: a home that finds no switch
within a tenth more than that stops with `ALARM:5` after driving the axis
into its end. With `endstop_halt = true` the switch also halts any move
that closes it, with `ALARM:4` and the position lost, so a job that runs
into an end stops short of the hard stop; a switch an axis sits on at
rest does not halt the move that takes it off.

A home renumbers the axis, so the height map's focus offset is taken
back as it is by a position set: tie the map again (*Probe here* or
*Focus here*) before a compensated run.

### When the machine goes quiet

The backend gives a machine up after 3 s without an answer to its status
polls, fails the run with that reason, and with `--connect` tries again
every few seconds. What to read, in order:

1. The console's *Log* (or `var/spinny.log`): the `link ... closed` line
   says how long the link had been open, how many lines were sent and
   unanswered, when the machine was last heard and what it last said,
   and its last status report. `machine: boot ...` lines say why the
   board started every time it was connected: a power-on, the reset pin,
   the watchdog (the main loop stalled), a panic with its location, a hard
   fault with its `pc`, or a forced reset after flashing. The board says
   it at every open of its port, so the same line at a later connect is
   logged as news; a fault is an error the first time only.
2. The console's *Wire* (or `var/wire.log`): every line each way with the
   time to the millisecond, the polls marked. The last `rx` line is the
   last thing the machine said; what follows is what was sent into the
   silence.
3. `mise run usb-log` here, or `mise run usb-log -- user@host` for a Pi:
   the kernel's view. A board that reset shows a disconnect and a new
   device; one whose firmware only stopped answering shows nothing.
4. `mise run pi-logs -- user@host` when the controller hangs off a Pi:
   the bridge's journal says when each client came and went, which device
   it opened and why the session ended, such as `took nothing for 3 s`
   for a board that stopped taking bytes; a Pi running the backend shows
   its journal and both log tails instead. With socat standing in for
   the bridge, its terminal prints each connection, open and error.

A board that stays on the bus, answers nothing, and greets no open with
its banner, while the kernel logs nothing at all, is most likely a USB
controller lockup (RP2040 erratum E15: a bus error during a transfer to
the host leaves the controller deaf until a bus reset). `usbmon` on the
host shows every transfer, control ones included, failing at once with
-71. Firmware from 2026-10-27 on notices within 100 ms, stops what was
running as an unplug would, and drops off the bus for the host to
enumerate it again; `diag` counts these as `lockups`. Older firmware
needs `mise run usb-reset -- user@host` (or with no host, here), which
brings it back without a reset of the board.

Bring a board that stopped answering back with its RESET button rather
than a power cycle when you can: the record of its last life survives
the one and not the other, and the next connect logs it. `diag` typed at
the console prints the boot reason and the counters at any time.
