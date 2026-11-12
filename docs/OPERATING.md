# Operating the machine

From the first connection to a probed, compensated run. The wiring and the bring-up order are in `firmware/rp2040/README.md`; the line protocol is `docs/PROTOCOL.md`, the web API `docs/WEB_API.md`.

## Connecting and first moves

Open `http://localhost:8000`, connect to the board on the *Connection*
tab (or to `socket://127.0.0.1:2323` for the virtual firmware, or to
`socket://127.0.0.1:2324` for a controller on a Pi forwarded by `mise run
relay-pi -- user@host`). The top bar shows only the machine's state (a
press on it opens the Connection tab) and the big *Stop*, always in view:
it stops a run or probing the way their own Stop does, else ends a camera
routine, cancels a jog or goto and turns the beam or spindle off; on a
G-code machine it sends the file's stop. One machine is connected at a
time; the Connection tab keeps a button for each machine connected lately
(up to four), which switches to it in one press, letting the one
connected go first. Then jog the beam over the
axis with the radius buttons, press "Set R=0 here", then turn the table
with the turn buttons: a positive turn must swing the point under the beam
counterclockwise seen from above, otherwise set `$dir_invert`. Check steps
per unit at low speed before the first job. Every axis is a bar in the
jog panel, with its step choices and a field for any other step; *Cancel*
in the panel's head, or Escape, stops a move (Escape also leaves a text
field, so the next arrow key jogs). *Fine* in the head jogs every bar by
its smallest step, as Shift held with a jog key does. Under *Hold to
move* a jog button or key held moves the axis until it is let go, the
step read as the distance per second: the page sends a piece of the move
every tenth of a second, and at the release this project's firmware
cancels the jog at once, while a G-code machine runs out the last piece. The *Config* tab holds the
machine files, where the pins are set too (the laser output, the probe
and an optional tool output), and beside them the list of every key a
file can set with the board's value next to the file's.

### Jobs, the preview and the Run panel

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

A drawing is cut on its lines: an SVG a group per stroke color, a DXF a
group per layer (its lines joined where their ends meet, blocks inserted,
curves flattened, in the unit its header gives, millimeters when it gives
none). Save a DXF as ASCII: a binary one is refused. The CAM page takes
a DXF too, its layers being what a paths operation's `match` picks.

A click on a path in the preview picks it (shift or ctrl adds one or takes
it back, *Box select* picks every path inside a dragged box, a click on a
group's name in the Jobs panel all of its paths); the Jobs panel then moves
the picked paths into a group of their own, which takes the first one's
settings (switched off if any group they come from is) and can be given
its own power, speed, passes or focus, or into a
group the job has, or deletes them. *Array* copies the picked paths: in a
*Linear* row stepped by x and y, or *Circular* round a center (*Middle* of
the picked paths, the *Origin*, or typed) through a sweep, a whole turn
spreading them evenly; the count takes the picked paths in, the copies are
drawn on the preview as the fields change, and *Make array* keeps them,
each at the end of its path's group, picked, so *Delete paths* takes them
back. A job made from a file or on the Plot page whose paths are moved,
deleted or copied (the page asks first), or changed in the *Job JSON*
panel, is no longer made again from it for another width, which would put
its paths back as the file or the operations make them. Each job in the list carries a
small drawing of itself; checking two or more and pressing *Combine* makes
one new job of them, cut in the order they were checked, each group's name
led by its job's (the jobs themselves stay; jobs made for different tools
do not combine). The *Job JSON* panel under the preview
shows the job with a path a line: the path and point under the caret are
drawn on the preview, a picked path brings the caret to its line, an edit
is drawn as it is typed and kept with *Apply*. A path picked on an edit
not yet applied is only found in the text: the Jobs panel moves, deletes
and copies the paths of the job as it is kept.

The preview's *Top view* looks straight down, the board square to the
canvas, and *CCW 90* and *CW 90* turn it a quarter. *Speed* draws every
cut by the speed it runs at, violet for the job's slowest through yellow
for its fastest, with a red halo under each move a machine rate holds
below its group's speed (on the polar machine the table near the axis),
and a key with the range and the share of the cut held back; it works
from the machine's rates once its settings are read, else from the
defaults and says so, each held to what the step generator pulses at the
axis's steps a unit, as the firmware holds it. The slider under the
preview steps through the job's paths in the order they are cut (*Back*
and *On* a path at a time): the paths cut so far are drawn, the last of
them marked, the rest faint; at its end the job is drawn whole.

The run controls (Run, the height map choice, Hold, Resume, Stop, the
progress and the pickup of a stopped run) are the Run panel at the foot
of the right column, kept in view while the jobs and their groups scroll
under it. Every number field takes arithmetic (`25.4/2`, `1/8 in`; see
the Plot page below).

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
2. *Fit to job* (the preview shows the grid), then *Probe*. The panel
   shows the heights as a map of the board seen from above, blue below the
   mean and red above it, the points left out hatched.
3. Jog the beam over the board, focus it by eye with the focus axis, and
   press *Focus here*; or type the offset into *Focus offset mm*, where it
   holds until *Set*.
4. Run with *height map: auto*, which the choice turns to by itself while
   a map is usable and back to off when none is, until it is changed by
   hand. The chip beside the choice says what Run will do with the map
   before it is pressed (*map on: focus axis*, *map off*, or why the run
   would be refused, such as *focus not set* or *map short of job*); the
   Height map panel's head says the same for the selected job, and while a
   run lasts the status bar shows what it follows.

The focus offset is dropped whenever the focus axis may count from other
numbers (Set H=0, a connect, the firmware restarting, a map loaded;
[WEB_API.md](WEB_API.md#height-map) has every case): the panel then asks
for *Focus here* (*Touch off here* on a mill) again before a run follows
the map, and a tie ([below](#probing-less-around-the-cuts-and-one-point))
sets it again from one probe.

Wiring and bring-up are in `firmware/rp2040/README.md`.

### Cartesian and spindle

Two optional modes use the same machine; both are firmware settings, off
by default, and the page follows them. The quickest way between them is
the *Config* tab, which edits and loads a whole file from
`machines/` ([MACHINES.md](MACHINES.md)): `cartesian-laser` and
`cartesian-mill` are the two modes below, the slide's travel either side
being their `[slide] limit` (30 mm in the one, 40 in the other); copy one
and change the limit to yours. The settings
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
the spin-up, the machine file's `[host] clearance` and `spinup`
([MACHINES.md](MACHINES.md#schema)).

1. Touch the tool to the copper and press *Set H=0 here*: without a height
   map H 0 is the surface.
2. Or probe a height map (the tool can be its own probe, touching grounded
   copper, tip offsets 0), jog the tool down until it touches the copper,
   press *Touch off here*, and run with *height map: auto*: the cuts then
   follow the board.

Since the tool may be the probe, the page locks probing while the spindle
turns, and the spindle's start while probing.

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
   *Remove* takes it out. The groups keep what the Jobs page set on them
   (turned off, a focus, a slower feed) unless the fields change that
   number. The mark beside the job's name says whether the fields are one
   of its operations as kept (*applied*), changed since (*changed*, also
   counted on the tab), or not in it. All of a job's operations cut with
   one bit or spot.
6. *Run* in the Run panel under the preview cuts the selected job. It is
   the Jobs page's Run panel (the height map choice is the same on both
   pages, and a stopped run is picked up the same way), with the job's
   length and time over the buttons.

A job moved or turned on the Jobs page keeps its place when its
operations change: they are typed where they were before the move, and
the plan, the sizes and the job are put where the job now is. *Here* and
the markers are taken into that frame, so they land where the head or the
marker is, and *New job* with such a job selected makes one put as it is,
where the plan showed it; the hint under the fields says so. A holes
operation keeps the holes it was made with; a board job picked again in
*Holes of* gives its holes where that job now is.

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
   thickness over a pad (0.12 mm by default) in the upload form and in the
   group's *thickness* afterwards; the preview draws each dot the size of
   its pad. A dot's volume is the pad's area times the thickness, and the
   plunger pushes it out over `output`, mm^3 of paste per mm of plunger,
   which depends on the syringe and is worth measuring once by weight. It
   and the rest of what a dot is made of (`gap`, `retract`,
   `extrude_rate`, `dwell_ms`) are `[host]` keys of the machine file
   ([MACHINES.md](MACHINES.md#dispenser)).
2. Line the job up with the board ([below](#lining-a-job-up-with-the-board)).
3. Touch the needle to a pad and press *Set H=0 here*, or probe the pads
   ([below](#probing-the-pads)) and run with *height map: auto* so the
   needle keeps its gap over every pad of a warped board.
4. Run: the head lays the dots pad by pad, the plunger ending each one
   retracted ([WEB_API.md](WEB_API.md#jobs) has the sequence). A dispenser
   lays dots only, so the Run panel says why it refuses a job of paths. A
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

### Panels, tabs and the page settings

Every panel's head has a fold button (the chevron before its name) and a
menu (the dots after it, or a right click on the head): fold, hide, move
up, down or to the next column, stack with the panel above or below,
stick to the panel above, lay stuck panels *Side by side* (and back *One
above another*), *Fit to screen*, and reset. A stack shows one of its
panels at a time under a row of tabs; panels stuck together are drawn as
one block and move together, one above another or side by side (a phone
shows them in one column either way). The Run panel stays at the foot of
its column unless it is stuck or stacked. On the wide layout a handle
under each panel holds it at a height (it then scrolls inside, with
buttons in its head to its top and its end), and a handle between two
columns sets their widths; a double click on either gives the size back.
*Fit to screen* holds a panel at the height its column shows. The PNP
parts list sizes by its lower right corner.

The gear at the right end of the tab bar opens the page settings: the
tab the page opens on, the tab bar folded to a thin strip that opens on
hover or a press, tabs kept out of the bar (they open from *More* at its
end), the panel layouts kept by name, *Edit panels*, a reset of the page
shown, and the hidden panels to show again. *Edit panels* puts a grip in
every head: drag a panel to another place, or onto another panel to
stack them, then press *Done editing* in the tab bar. While a panel is
hidden an eye shows beside the gear: pressed, the hidden panels show for
a while with a dashed edge (their menu has *Show for good*), and pressed
again they hide. The two arrows beside it scroll the column last pointed
at to its top or its end. A layout kept by name
covers every page; *Default* is the page as shipped and cannot be saved
over. Once one is kept, a pick beside the gear swaps layouts in one
step. The Setup, Align, Camera and Job JSON panels keep their own fold,
which a layout does not carry. All of this is kept in the browser, not
on the machine; a phone keeps the one-column order until its panels are
moved, and has no size handles.

Every button shows on hover what it does, a disabled one also why it is
off ("connect first"), and a key in the Config tab's machine file shows
what it sets. The small "i" beside some settings opens a drawing of what
they mean when pressed (not on hover), until pressed again, anything else
is pressed, or Escape. The magnifier in the tab bar (or "/" or Ctrl+K
with no field in use) finds a feature by a few letters of its name, in
order ("hmprb" finds the Height map's Probe), among every page, panel and
button: Enter or a press shows its page and panel, unfolded and pulsing,
and gives a button the focus without pressing it.

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
more pads than the most points asked for, the most spread out of them, in
a short tour. *Plan* says how many and about how long. The map is then a
pad map: its heights sit at the pads, exact there, and between pads the
surface is a plane through every probed pad plus the nearest pads'
deviations from it, so a warp shows where it is measured and fades
between. The map fills in as the pads are probed, and the preview draws
the pads, each filled once probed. A run follows a pad map as it follows a
grid, *Tie map* ties it the same way, and *Continue* goes on with the pads
it still lacks. A board job carries its pads from the layer it was
imported from; a drawing or a gcode file has none to probe.

### The camera and its offset

A camera on the head ([MACHINES.md](MACHINES.md), `[camera]`) is read by
the backend through `pcbv serve` from the sibling pcb-vision repository:
`mise run build-pcbv` builds it here, `mise run deploy-pi -- --web`
cross-builds it for a Raspberry Pi that runs the backend and installs it
there ([ARCHITECTURE.md](ARCHITECTURE.md#controller-on-a-raspberry-pi)),
and a release built beside pcb-vision carries it as `bin/pcbv`
([RELEASE.md](RELEASE.md#the-other-programs)). The
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
and each list says which camera the other one is set to. A pcbv that
leaves a request unanswered for 6 s (a stalled link to a Pi, a hung
program) or whose connection fails is closed, and the panel shows the
camera stopped: start it again once the link is back.

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

Both camera panels have the camera log: *log every look* keeps every
picture the cameras' routines look at (finding the mark, centering the
nozzle, looking at a part, a G-code machine's run), each as it was and with
what the finder found drawn on it, so a routine that went wrong can be
followed look by look; *Photo* keeps one now with what the finder sees.

A camera plugged into a Pi that is a bridge is streamed from there
([ARCHITECTURE.md](ARCHITECTURE.md#controller-on-a-raspberry-pi) says
how, and why a picture at a time): deploy with
`mise run deploy-pi -- --camera /dev/v4l/by-id/<name> user@host`
(the deploy lists the names it finds, the `video-index0` one is the
picture; `<name>@640x480@15` picks another mode than 1280x720 at 30 fps;
a second `--camera`, the up camera, gets the next port), keep
`mise run relay-pi -- user@host` running, and pick `stream on port 2325`
in the Camera list (the backend looks at the ports relay-pi forwards, the
ones in `SPINNY_CAMERA_PORTS` when that is set where the backend runs).
The size is the one deployed. An fps of 10 in the camera settings leaves
a Pi Zero's WiFi room for the controller's lines, and `<name>@640x480`
sends a quarter of the bytes per picture. While the camera is unplugged
the picture is ustreamer's NO SIGNAL card.
`mise run pi-logs -- user@host` shows the camera units' journals.

### Pick and place

The PNP tab works with the machine connected. On an X/Y machine on this
project's firmware it serves a nozzle on the head and a camera fixed to
the machine, looking up at the nozzle; a G-code pick and place machine
(next section) gets its own panels for placing. Its Setup panel leads
through it:

1. Start the up camera (picked in the Up camera panel's list, or its device typed in;
   the spots say whether the finder looks for something dark or bright).
2. Jog the nozzle over the camera until it shows in the picture and press
   *Center nozzle*: the head rises to the travel height, comes down to
   *Sharp at H* when that is set, moves the step along X and along Y to
   measure how the picture scales, turns and mirrors, and centers the
   nozzle. The head's R and Z there are the camera's place, kept for the
   next time, when the routine goes there by itself.
3. Pick a board job uploaded as a `.kicad_pcb`: its footprints are listed
   and drawn on the board with the head and the up camera; a press on a
   row or a dot picks one.
4. With a part on the nozzle, *Look at part* reads where its center sits
   against the nozzle's. *Go to part* takes the nozzle over the picked
   part's place at the travel height, or, ticked, the part's center.

The routines need `$cartesian=1`; the vacuum and the nozzle's turn are not
driven yet.

### Placing with a G-code machine (OpenPnP compatible)

A pick and place machine whose own controller takes the G-code OpenPnP's
GcodeDriver sends (Marlin, Smoothieware, RepRapFirmware, Grbl) is a
machine file with `controller = "gcode"` ([MACHINES.md](MACHINES.md#g-code-machines)),
used like the other machines: connected from the Connection tab, jogged and
homed in the Jog panel, read in the readout, sent lines in the Console,
stopped with *Reset* or the jog cancel. `machines/opulo-lumen-rev5.toml`
is an Opulo LumenPnP (Rev05 board, Opulo's Marlin) as Opulo's stock
OpenPnP setup drives it; `machines/openpnp-marlin.toml` is a plain Marlin
start to copy. A file is edited on the Config page like any machine file
(*Write to board* is locked for it: its controller keeps its own
settings), where *Import from OpenPnP* reads OpenPnP's `machine.xml` (and
a `.job.xml` with its `.board.xml` files) into a new one: every value read
has a box to keep or leave it, and the file shows as it will be saved. A
job's placements become references for the board job picked on the PNP
page. Its setup steps:

1. Connect: the Connection tab names the machine's port after its file (the
   LumenPnP's `MARLIN_OPULO_LUMEN_REV5 ... CDC in FS Mode` port by its
   `[port] match = ["lumen"]`, another machine by its file's `url` or
   words); pick it and press *Connect*. The status bar shows the
   firmware's name (M115) and the machine's.
2. Home, in the Jog panel.
3. Pick or upload the board (a `.kicad_pcb`) in the Parts panel, pick a
   part, put the nozzle over it with the Jog panel (or the top camera,
   *with the top camera* on *Go to part*), and press *Nozzle here* or
   *Camera here* in Board on the machine. The references are kept per job
   and map the whole board: one gives the shift (with *Turned deg*), two
   or more the turn too, and the panel says how far each one sits off the
   fit.
4. *Plan* makes the placement program from the references and the
   feeders and shows it; nothing moves (it works with the machine
   disconnected too, for the one last connected). *Run* places the
   parts; a run window shows its progress and its steps (each pick,
   look, place and retry) over the page, and *Stop* sends the quickstop
   at once. With *repeat* ticked, a run that finished asks for the next
   board and places it again; the boards are counted until *Reset*.

Moving it by hand: the Jog panel draws the file's bars (X, Y, the
nozzle's height Z and its turn A; the LumenPnP's say which way N1 goes on
its seesaw); a jog reads where the head is (M114) and moves by the step
from there, so jogs pressed quickly add up. A goto in the Jog panel moves
only the axes given: it goes up to the file's safe height only to go
across, from above or below, turns the nozzle on the way, and puts the
height last, so the nozzle goes down only over where it is going; the
line under the goto rows says what Go will move, from where to where, as
soon as a field is typed in. With `leave` in the file's `[up_camera]`, a
jog that takes the nozzle away from over the up camera with its tip off
the safe height goes up to it first, while small jogs over the lens stay
at the height they are at. The
Head panel on the PNP tab has *Light*, *Park*, *Nozzle over camera* (the
nozzle over the up camera at the height it is sharp at), *Nozzle to
camera spot* and *Camera to nozzle spot* (the head moved by the top
camera's offset), the vacuum, and *Tune the machine file*. *Go to part*
moves X and Y only, at the safe height. The Cameras panel shows the up
camera, the top camera or both; a drag on a picture moves the head so
the picture follows the pointer, a double-click brings a point to the
crosshair, and the wheel zooms. The dashed circle is how far from the
center a part is looked for (`[up_camera] crop`, or a feeder's `crop`).

On a seesaw Z like the LumenPnP's, both nozzles are up only at the safe
height (31.5): every move across goes there first, from above or below.
Measure *place_z* before the first run (the file's 20 keeps the tip well
above a board): jog the tip down onto the board's top, read its Z in the
readout, and set it to that Z plus the parts' height under *Tune the
machine file* in the Head panel, where the heights, feeds, dwells and the
vacuum's ranges are set a value at a time. *Vacuum on*, *Vacuum off* and
*Read vacuum* find the sensor's readings with the nozzle open and blocked
before `part_on`/`part_off` are set.

Feeders can be tape strips, trays (`columns`, `row_pitch`) or feeders
told to advance (`feed`, one line or several); one names its parts by
`refs` or by the words of `match`. The up camera's place on the machine
comes from its file, or *Camera is here* with the nozzle over it by
eye, or typed; *Center nozzle* measures it with the picture's scale, roll
and mirror, then *Measure runout*: the tip is found at six turns of the
nozzle, its runout made up for at every look and place, and a nozzle that
turns the other way for the file's `rotation_cw` says so. Parts of a
feeder marked `vision = true` are looked at over the camera turned to the
angle they go down at: their offset, size and angle are checked, the
angle corrected, and they are placed where their center lands.

The top camera (on the machine's head, looking down, `[top_camera]` in its
file) is set up in its panel: pick it and Start, jog the nozzle's tip
onto a mark it can see (a dot on paper, a hole) and press *Nozzle on
mark*, then *Measure offset*: the head moves so the camera should see the
mark (by the file's `offset`, or from where it stands when there is
none), measures the picture and centers the mark. *Find fiducials* (or
*find fiducials first* on a run) fits the board on its fiducials,
footprints FID* or named Fiducial, from where the references put them. A
feeder with `pocket` has each pocket looked at before its pick (an empty
one is passed over), one with `marks` has its marks found once a run and
its places moved to follow them.

With `part_on` in the file's `[vacuum]`, a pick that holds nothing, a
part not on the nozzle over the up camera, one off by too much or of the
wrong size is let go at `[motion] discard` (or back in its pocket) and
the next pocket tried, up to `pick_tries`; the part is then left out and
listed, and *Run the rest* places what the last run did not. A part still
on the nozzle after its place (with `part_off`) stops the run, and so do
two parts left out one after another.

Nothing here has run against a real machine yet: check the file's
commands against the firmware before the first run, with the nozzle well
above the board. The part's angle needs pcb-vision at b4d1299 or later
(the spot's smallest rectangle); an older pcbv places without correcting
it and says so.

Feeders on a bus, Opulo's Photon feeders on the LumenPnP: the file's
`[bus]` says how packets reach them (the LumenPnP file has Photon's),
and a feeder names its id there (`bus_id`) instead of a place. *Scan bus*
in the Feeders panel lists the feeders that answer, by address and id. A
feeder's pick point comes from its slot's place: put N1 over the point a
feeder presents its part at and press *Slot here* by its address, or let
*Import from OpenPnP* bring the slots and the feeders OpenPnP kept. A
feeder's slot is found by its id when a run starts (*Keep slot* writes it
into the machine file instead); *Feed* moves a feeder's tape on once, to see it
work. A run advances each feeder on the bus before its pick and waits for
it; a feeder that does not answer leaves its part out. None of it has
run on a LumenPnP yet: try *Scan bus* and *Feed* before a run.

### A virtual LumenPnP

`mise run virtual-pnp` (`bin/spinny-virtual-pnp` in a release) plays a
LumenPnP with nothing attached, so the PNP tab can be tried end to end.
It takes G-code on `socket://127.0.0.1:2327` as Opulo's Marlin does:
moves take the time their feed gives them (`--fast 4` four times
quicker), M400 waits for them, M410 stops the head where it is, M114
reports, the ring light and the fans switch, and the vacuum sensor behind
the I2C mux reads as a LumenPnP's: about 254 with the pump off, 251 with
the nozzle open, 231 with a part on it. Three Photon feeders answer on
the bus (addresses 1 to 3; the program prints their ids for `bus_id`).

Connect *Virtual LumenPnP* (`machines/virtual-pnp.toml`) on the Connection tab.
Give the bottom (up) camera the device `http://127.0.0.1:2328/snapshot`
and the top camera `http://127.0.0.1:2329/snapshot`, size 640x480 (or
start the backend with `SPINNY_CAMERA_PORTS="2325 2326 2328 2329"` and
pick them from the list). pcbv reads them as it reads a Pi's camera.

- The nozzle picks a part wherever its tip comes down to Z 16.5 or lower
  with the suction on (the pump and N1's valve), except over the bottom
  camera, and lets it go where the suction stops. Every part is 1.6 by
  0.8 mm, lying along X, picked a little off the tip and a little
  turned. `--miss-every 3` makes every third pick come up empty.
- The bottom camera shows the tip as a dark disk and a part on it as a
  dark body; it sits a few tenths of a millimeter off the file's
  `[up_camera] position`, at 20 um a pixel, turned 1.5 degrees and
  mirrored, and the tip runs 36 um off its axis: *Center nozzle* and
  *Measure runout* find these.
- The top camera sees the bed, a dark mark at 150, 150 (`--mark X,Y`) for
  *Nozzle on mark* and *Measure offset*, the parts let go, and a board
  given with `--board board.kicad_pcb@X,Y[,ANGLE]` (its origin at X, Y,
  turned ANGLE): its outline dark and its fiducials bright, for *Find
  fiducials*. Its offset is a few tenths off the file's.
- With the light off both pictures are dim.

A spot is read from a picture taken after it was asked for: a snapshot
camera asked a few times a second would otherwise show the head where it
was before the move.

### The Auto tab

The *Auto* tab is a conversation with a language model that works through
the backend's own tools. Ask for a job ("a 20 mm square with a 5 mm hole
in the middle, three passes at 300"), a Plot operation (drill these
points, face this rectangle), markers, a placement plan, or about what is
there ("which jobs are for the mill?"). The answer comes in as it is
written; each tool call is a folded line with its name, its arguments and
a short result (*running* until the call is done), and unfolds to the
whole. A job it makes or changes shows in the Jobs and Plot tabs at once.
Enter sends, Shift+Enter starts a new line, and *Send* is locked while a
turn runs; *Stop* ends the turn under way (what it made so far stays; a
tool call already running finishes in the backend all the same, and its
line shows what it did), *New chat* forgets the conversation. A turn makes
at most 25 tool calls, so a model that goes round in circles stops. What
it can make, and what it cannot do, is the tools' own boundary, below.

The row above the conversation picks who answers, kept for the next
visit:

- *Anthropic API*: the Messages API, with `ANTHROPIC_API_KEY` set where
  the backend runs; `claude-opus-5-5` unless another model is typed.
- *OpenAI-compatible*: any chat completions endpoint that takes tools, at
  the base URL typed: OpenAI (`https://api.openai.com/v1`, with
  `OPENAI_API_KEY`), OpenRouter, or a local ollama
  (`http://localhost:11434/v1`, no key). Type the model's name as the
  server knows it; a small local model may call the tools poorly.
- *Claude Code*: the `claude` command, installed and logged in where the
  backend runs, started for each turn with only these tools (served to it
  by `spinny-mcp`) and its own file, shell and web tools taken away. It
  keeps its own session from turn to turn.

Keys stay in the backend's environment: set one and restart the backend.
The page is told only whether each is set, never what it is. A key for
the OpenAI-compatible provider goes to the base URL typed, so type one you
trust.

### What the tools can and cannot do

The Auto tab's model, and any MCP client given `spinny-mcp`, works
through one set of tools. They make, change and read data, and nothing
else: jobs (combined jobs among them), Plot jobs (one operation, or a
list of them, a Plot job's list replaced in place), markers, the pick and
place machine's references and plans, and CAM jobs are made and changed;
`delete_job` takes a job out, which its description keeps to a job the
operator asks to delete or one the model made by mistake; the state, the machine
files (G-code machines' among them) and the CAM profiles are read. No tool
connects or disconnects the machine, jogs it or sends it anywhere, homes
it, runs, holds, resumes or stops a job, lights the laser, starts the
spindle, probes, starts a camera routine, moves the pick and place
machine or sends it a line, or writes the firmware's settings or a
machine or CAM file. That is the tool list itself, not an instruction to the
model: every tool is a call on the backend's HTTP API that names the
routes it may use, a request to any other route is refused before it
leaves, and the tests hold every route a tool calls against a list of
routes that move nothing. A job a model made is cut only when you run
it, so look at it in the preview first: a model can get a power, a size
or a place wrong.

### The tools in Claude Code or another MCP client

`spinny-mcp` serves the tools to any MCP client over stdio, calling a
running backend at `--url` (`http://127.0.0.1:8000` by default). To give
them to Claude Code, from the repository:

    claude mcp add spinny -- uv run --directory <repository> spinny-mcp

and for a backend elsewhere, `-- uv run --directory <repository>
spinny-mcp --url http://spinny.local:8000` (a backend started with
`--allowed-host` must allow that name). Claude Code then has
`mcp__spinny__make_job` and the rest, within the boundary above: it can
make you a job, and you run it. `mise run mcp` starts the server by hand.

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
   run or no run. A board that comes back counting from zero does not
   overwrite it: the position is held (the toast says so) until it is
   declared. The head sits where the run left
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
   A laser job whose groups have a focus of their own, picked up without
   the map, counts it from the height the stopped run began at while the
   focus axis frame holds; after a connect, a restart, a position set or
   a home that height means nothing, so focus the beam by eye and answer
   *Focused here* when the pickup asks.
   When nothing moved the axes since the offset was set (the link dropped
   and came back to a board that did not restart: `diag` at the connect
   shows its `up` time still counting), the banner under the status bar
   offers *Keep* for the dropped offset instead of a tie. Nothing checks
   that, so keep it only when you know the head was not moved.
3. *Plan* says which line the run starts at, how the head gets there and
   what goes out first; *Resume from line* does it after a confirmation.
   The count is of the stopped run's lines: a job re-cut, regrouped,
   turned or moved since, with paths deleted or added, or picked up with
   the map followed otherwise, has other lines at that count, and the
   pickup says so. Run it from the top, or give the line counted in the
   job as it is now and answer *Pick up the changed job*. Another power,
   speed or focus height, or the map tied again, changes no count.
   Leave *from the start of its path* on: the run then redoes the path the
   line belongs to from its rapid, so a count one line off cannot leave a
   gap in a trace. A spindle rises to the travel height, goes over the
   point, starts at the job's speed there, spins up and plunges before the
   first cut.

*Run* again from the top after such a stop asks the same of a laser job
with groups' own focus: the stop leaves the head at the height of the
group it was cutting, not where the run began. Send it back with `go H`
to the height the refusal names, or focus again and answer *Focused here*.

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

Before the first job, check every `invert` in the machine file, each
axis's and the probe's first, by what the machine does:
[MACHINES.md](MACHINES.md#pins) says how.

### Endstops and homing

An axis with a switch at one end or both (`endstop` under its section in
the machine file, with `endstop_pin`; [MACHINES.md](MACHINES.md#pins))
can be homed: *Home* in the jog panel, or `home`, `home R` or `home R+`
in the console, finds the switch and declares the axis to read
`home_pos` there. The cycle, and the halt `endstop_halt` asks for, are
in [PROTOCOL.md](PROTOCOL.md#endstops-and-homing). The readout's *Homed*
field names the joints homed since the position was last lost; a
position set, a reset while moving, a lost motor supply or an endstop
halt unhome them.

Before the first home, check each switch as the probe is checked: close
it by hand and watch the console's `?` line, which has no field for the
switches but refuses a `home` that starts on a closed one. A switch
wired the wrong way round reads closed at rest, so a home backs off it
and is refused (`error:12`), or never sees it (`ALARM:5`) and drives the
axis into its end. Set `home_travel` to the axis's real travel, since it
bounds how far a home seeks.

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
   board started every time it was connected (the reasons are in
   [PROTOCOL.md](PROTOCOL.md#diagnostics)). The board says
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
than a power cycle when you can: the next connect then logs the record
of its last life, which a power cycle loses. The record, and `diag`,
which prints it with the counters at any time, are in
[PROTOCOL.md](PROTOCOL.md#diagnostics).
