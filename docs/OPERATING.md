# Operating the machine

From the first connection to a probed, compensated run. The wiring and the bring-up order are in `firmware/rp2040/README.md`; the page's panels are described in `web/frontend/README.md`.

## Connecting and first moves

| `web/frontend` | the page | `cd web/frontend && bun install && bun run build` |

The line protocol is `docs/PROTOCOL.md`, the web API `docs/WEB_API.md`.
A board upload isolates its copper by default; with Board set to deposit,
for a process that lays copper down, it burns the copper itself and
nothing past its edge. With Board set to stencil it cuts a solder paste
stencil out of a film laid where the board would be: once round the
inside of every paste opening, shrunk first by Margin mm on every side,
so each piece drops out and leaves its hole; picking stencil turns a
Layer of F.Cu into F.Paste. The preview draws every pad with its cut
inside it, the margin being the band between them, and the job's margin
row cuts the stencil again for another margin where it lies. With Board
set to on the lines it cuts the layer where it is drawn: every line along
its middle and every filled shape round its edge, so Edge.Cuts cuts a part
out on its outline, a silk screen or a user layer is burnt as drawn. The
Layer field picks the layer a KiCad board is read from: a copper layer,
F.Paste, or any layer to cut on its lines. A `.kicad_pcb` picked or
dropped is not sent at once: its own layers are offered first, each with
what is drawn on it, and picking a drawing (Edge.Cuts, a silk screen, a
fab or user layer) sets Board to on the lines; Import sends it, Cancel or
Escape leaves it. A gerber is its own layer.
A click on a path in the preview picks it (shift or ctrl adds one or takes
it back, *Box select* picks every path inside a dragged box, a click on a
group's name in the Jobs panel all of its paths); the Jobs panel then moves
the picked paths into a group of their own, which takes the first one's
settings and can be given its own power, speed, passes or focus, or into a
group the job has, or deletes them. *Array* copies the picked paths: in a
*Linear* row stepped by x and y, or *Circular* round a center (*Middle* of
the picked paths, the *Origin*, or typed) through a sweep, a whole turn
spreading them evenly; the count takes the picked paths in, the copies are
drawn on the preview as the fields change, and *Make array* keeps them,
each at the end of its path's group, picked, so *Delete paths* takes them
back. A job made from a file or on the Plot page is then no longer made
again from it, which would lose the copies. Each job in the list carries a
small drawing of itself; checking two or more and pressing *Combine* makes
one new job of them, cut in the order they were checked, each group's name
led by its job's (the jobs themselves stay; jobs made for different tools
do not combine). The *Job JSON* panel under the preview
shows the job with a path a line: the path and point under the caret are
drawn on the preview, a picked path brings the caret to its line, an edit
is drawn as it is typed and kept with *Apply*.
The preview's *Top view* looks straight down, the board square to the
canvas, and *CCW 90* and *CW 90* turn it a quarter. The run controls (Run,
the height map choice, Hold, Resume, Stop, the progress and the pickup of
a stopped run) are the Run panel at the foot of the right column, kept in
view while the jobs and their groups scroll under it. Every number field
takes arithmetic (`25.4/2`, `1/8 in`; see the Plot page below).
Both camera panels have the camera log: *log every look* keeps every
picture the cameras' routines look at (finding the mark, centering the
nozzle, looking at a part, a G-code device's run), each as it was and with
what the finder found drawn on it, so a routine that went wrong can be
followed look by look; *Photo* keeps one now with what the finder sees.
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
and an optional tool output), and beside them the list of every key a
file can set with the board's value next to the file's.

### Probing and the height map

An optional focus axis (`H`, the E driver socket unless `$sockets` moves
it, `$h_axis=1`) carries a
touch probe on the Z-STOP input. The Height map panel probes a grid over
the board, and a run can then follow it: the focus axis tracks the board
under the beam, or, without a focus axis, the power is raised where the
board sits out of focus.

1. Jog the head up until the probe clears the board, or type a *Travel H*
   in the Jog panel: probing travels at the higher of the two, and the
   probe's depth counts down from there. Set the probe's offset from the
   beam under *Probe*.
2. *Fit to job* (the preview shows the grid), then *Probe*.
3. Jog the beam over the board, focus it by eye with the focus axis, and
   press *Focus here*.
4. Run with *height map: auto*. The chip beside the choice says what Run
   will do with the map before it is pressed (*map on: focus axis*, *map
   off*, or why the run would be refused, such as *focus not set* or *map
   short of job*); the Height map panel's head says the same for the
   selected job, and while a run lasts the status bar shows what it
   follows.

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

### The Plot page

The *Plot* tab is the machine used like a manual mill: the position, the
jog panel (its keys jog while the tab shows), the spindle, the markers
and a preview beside simple operations, one or several in a job. On a
laser machine the same operations are burnt instead: the fields are the
spot, the power and the passes (each the whole path again), a point is
marked with a ring the spot across, and a board hole is cut along its
inside edge so the plug drops out, or with *clear* on burnt away in rings.
Focus the beam instead of zeroing a depth.

1. Zero the depth on the surface (touch off, *Set H=0 here* or the jog
   panel's zero), as for any milled job.
2. Pick the operation: *Drill* points, *Holes* of a board job, *Line*
   through points, *Face* a rectangle, or a *Pocket* or *Profile* of a
   rectangle or a circle.
3. Give its corners, center or points: typed, *Here* for where the head is,
   or a marker from the list beside each pair. A rectangle is given *By*
   its two *Corners* or by its *Center and size* (width and height); a
   pocket's or profile's rectangle takes a *Corner R* to round its
   corners. Points are one `x, y` a line; *Add here*, *add marker* and
   *All markers* append to them. Every number field takes arithmetic:
   `25.4/2`, `3*(4+1.5)`, `1/8 in`, `sqrt(2)*10`, `sin(30)` (degrees);
   leaving the field shows the value, and the arrow keys step it.
4. Set the bit, the depth, the step down (the passes are as many as it
   takes), the stepover of a face or pocket, the feeds and the spindle
   speed, and climb or conventional. The job is planned as it is typed and
   drawn on the preview with the bit's width, the operation's sizes over
   it as a sketch shows them (width and height, corners or center, the
   corner radius, a circle's diameter, the points and the legs of a line),
   its notes and any problem below the fields.
5. *New job* makes a job of the operation, selected; *Add to job* puts it
   at the end of the selected Plot job, so one job can hold a pocket, the
   holes beside it and the outline round both. The job's operations are
   listed over the fields: a click puts one in the fields, *Apply* puts the
   fields back in its place, *Up* cuts one before the one above it and
   *Remove* takes it out. The mark beside the job's name says whether the
   fields are one of its operations as kept (*applied*), changed since
   (*changed*, also counted on the tab), or not in it. All of a job's
   operations cut with one bit or spot.
6. *Run* in the panel beside it (or the Run panel on the Jobs page) cuts
   the selected job.

A job moved or turned on the Jobs page keeps its place when its
operations change: they are typed where they were before the move, and
the plan, the sizes and the job are put where the job now is.

*Holes* takes a job imported with its drill file: one group a hole size,
smallest first, each checked size taken. A hole wider than the bit is
bored out in rings when *bore* is on, else drilled with the bit; turn off
the groups a different bit is for, and run the job once per bit. A
profile has no tabs: hold the part down, or leave a skin under the depth.
A rectangular pocket refuses a stepover over 0.85, where its loops would
leave the corners between them standing.

### Markers

The *Markers* panel (Jobs and Plot tabs) keeps named positions:
*Mark here* saves where the head is, under the name typed or the next M
number, *Add* a typed x and y; a name used again moves that marker. *Go*
rises to the travel height and goes there, *Here* moves the marker to the
head. Every preview draws them, and the backend keeps them in its config
for every page and browser.

### Another bit for a job

The job details have the width the job is cut for (*Tool mm* on a mill,
*Spot mm* on a laser). *Re-cut* makes a board job again from its kept
file for the new width and puts it where the job is now, alignment and
moves included, so a second bit's isolation lands on the copper the
first cut; a Plot page job is built again with the new bit. The groups
keep their settings. A drawing's paths stay as they are and *Set* only
changes the number. A board imported before its file was kept, a CAM job
or a job loaded from JSON cannot be cut again: import it again.

### The preview's grid

*Grid* in a preview's head draws a square grid of X and Y with its lines
labeled along both axes instead of the rings about the axis. Until it is
pressed a cartesian machine gets the grid and the polar one the rings; the
choice holds on every page and is remembered in the browser.

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

### Setup steps

The Setup panel at the top of the Jobs page shows a common setup as a
row of numbered circles: *Probe and follow a height map*, *Mill a board*
or *Measure the camera offset* (only the ones the machine has what for,
once it is connected). A step fills in when the page sees it done (a job
picked, a travel height set, the map probed, the focus taken, the map on
for the run), the next one is ringed and said in words under the row,
and a press on any step goes to the panel that does it.

### Edits not applied

The machine file is the one place a machine's settings are written: an
edit in its editor counts until *Save* (or *Write to board*, which saves
first), and the board line says when the board runs settings no file has
or has values not saved to its flash, with *Save to flash* for those. The
camera settings and the CAM profile editors count their edits the same
way, and every tab shows the count of edits not applied on its page;
leaving the page with any asks first.

### The travel height

*Travel H* in the Jog panel (on a machine with a focus axis) is an H the
head rises to before the page moves it across the board: a goto of the
board or of a joint across it, probing, *Probe nearest* and the camera
routines. A head already higher stays where it is, a goto that names its
own H is left alone, and jogs and runs keep their own heights (a milling
run travels at its clearance over the surface). Blank turns it off. It is
a host value: `[host] travel` in a machine file, `host.travel` in
`PUT /api/settings`.

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
Camera panel on the Jobs page starts it, shows its picture with a
crosshair at the center, and, with *Look for board* on a job imported
from a KiCad file, where on the board the picture is and how well it is
locked.

The panel's *Camera* list holds the cameras attached: the ones on the
backend's computer, under their stable `/dev/v4l/by-id` names, and the
streams of a Pi forwarded here (below). They are listed when the panel
comes into view; *Detect* lists them again after one is plugged in.
Picking one fills *Device*, *Size* and *fps* (the size kept when the
camera has it, else 1280x720 or the nearest below; the fps lowered only
past what the camera gives), and *Start* sends what the fields show
before starting. A device can still be typed into *Device* by hand.
*Apply* on a running camera with another device, size or fps starts it
again on them. The Up camera panel on the PNP page has the same list,
and each list says which camera the other one is set to.

The camera is useful once the machine knows where it looks from the tool:

1. Put a piece of scrap, or a board edge, under the tool and press *Make
   mark* (a spindle machine: a short plunge at the depth and plunge rate
   given, run as a one point job named `camera mark`; on another machine
   make a mark by hand, or use a hole, and press *Mark is here* over it).
2. Press *Find mark*. The head lifts to the travel height (the milling
   clearance as an H when none is set), goes where the
   camera should see the mark by the offset in force (zero at first: have
   the camera's field of view cover the tool's position then, or type a
   rough offset into the settings first), takes the darkest spot nearest
   the picture's center for the mark, moves 2 mm along X and back to
   measure the picture's scale and turn against the machine, and moves
   the head until the center sits on the mark. The offset, roll and scale
   are saved in the camera settings; copy them into the machine file to
   keep them with it. A camera that is moved on the head, or a tool that
   is changed, wants the routine run again.

A camera plugged into a Pi that is a bridge is streamed from there:
deploy with `mise run deploy-pi -- --camera /dev/v4l/by-id/<name> user@host`
(the deploy lists the names it finds, the `video-index0` one is the
picture; `<name>@640x480@15` picks another mode than 1280x720 at 30 fps;
a second `--camera`, the up camera, gets the next port), keep
`mise run relay-pi -- user@host` running, and pick `stream on port 2325`
in the Camera list, which is `http://127.0.0.1:2325/snapshot` (the second
one 2326; the backend looks at the ports relay-pi forwards, the ones in
`SPINNY_CAMERA_PORTS` when that is set where the backend runs). The size
is the one deployed; the fps in the settings is how often a picture is
asked for: 10 leaves a Pi Zero's WiFi room for the controller's lines, and
`<name>@640x480` a quarter of the bytes per picture. (`/stream` instead
pushes every frame and falls seconds behind on a slow link.) While the
camera is unplugged the picture is ustreamer's NO SIGNAL card.
`mise run pi-logs -- user@host` shows the camera units' journals.

### Pick and place

The PNP tab is for placing parts with a nozzle on the head of an X/Y
machine and a camera fixed to the machine, looking up at the nozzle. Its
Setup panel leads through it:

1. Start the up camera (picked in the Up camera panel's list, or its device typed in;
   the spots say whether the finder looks for something dark or bright).
2. Jog the nozzle over the camera until it shows in the picture and press
   *Center nozzle*: the head rises to the travel height, comes down to
   *Sharp at H* when that is set, moves the step along X and along Y to
   measure how the picture scales, turns and mirrors, and centers the
   nozzle. The head's R and Z there are the camera's place, kept for the
   next time, when the routine goes there by itself.
3. Pick a board job uploaded as a `.kicad_pcb`: its footprints are listed
   and drawn on the board; a press on a row or a dot picks one.
4. With a part on the nozzle, *Look at part* reads where its center sits
   against the nozzle's. *Go to part* takes the nozzle over the picked
   part's place at the travel height, or, ticked, the part's center.

The routines need `$cartesian=1`; the vacuum and the nozzle's turn are not
driven yet.

### Placing with a G-code machine (OpenPnP compatible)

*Place with: a G-code device* on the PNP tab hands the parts to another
pick and place machine, one whose controller takes the G-code OpenPnP's
GcodeDriver sends. Its setup steps:

1. Pick a device profile (`pnp/openpnp-marlin.toml` is shipped) and set
   its `[port] url`, the dialect's commands as its firmware names them
   (the vacuum's on and off, the dwell, the stop), the heights and the
   feeders, then Save.
2. Connect, and Home.
3. Pick the board job, jog the device's nozzle over a part's place (the
   line field sends any G-code), pick that part and press *Here*; a second
   part gives the board's turn too, else type it in *Turned deg*.
4. *Plan* lists what is placed from which feeder and what is left out and
   why, and shows the G-code; *Download* saves it; *Run* sends it a line
   at a time, and *Stop* sends the quickstop at once. Each part placed
   counts against its feeder; *Count feeders again* once they are refilled.

Feeders can be tape strips, trays (`columns`, `row_pitch`) or feeders
told to advance (`feed`, one line or several). With the up camera fixed
to the device, start it in the Up camera panel, jog the nozzle over it
and press *Center nozzle* under *Up camera on the device*; then parts of
a feeder marked `vision = true` are looked at over it after the pick and
placed where their center lands.

Nothing here has run against a real machine yet: check the profile's
commands against the firmware before the first run, with the vacuum line
disconnected and the nozzle well above the board.

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
   logged as news; a fault is an error the first time only. After a link
   that failed on its own, the next connect compares the board's uptime
   (`diag up`) with the failure: a board that started since and booted
   from power on is named *lost power*, with how long it was off (its
   supply went away or was switched off: check the supply, its terminals
   and what else it feeds, not the firmware); one reset through its RUN
   pin names the reset button or noise on that line; one up through the
   failure says the USB link dropped, not the board.
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
