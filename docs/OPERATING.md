# Operating the machine

From the first connection to a probed, compensated run. The wiring and the bring-up order are in spinny-firmware's [rp2040/README.md](https://github.com/tmpk13/spinny-firmware/blob/main/rp2040/README.md); the line protocol is its [PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md), the web API [WEB_API.md](WEB_API.md).

## Connecting and first moves

Open `http://localhost:8000` and press *Connect* in the top bar: it names
the port found (this project's board, or a port a machine file claims) and
opens it. Home and the Run area's first step offer the same button; a port
typed by hand is the *Connection* panel's, on the Setup side's *Machines*
page (`socket://127.0.0.1:2323` for the virtual firmware, or
`socket://127.0.0.1:2324` for a controller on a Pi forwarded by `mise run
relay-pi -- user@host`). The top bar holds the machine as one button, its
name and its state (a press opens its menu: connect a port found,
disconnect, switch to a machine connected lately, home, and the Machines
page; the firmware's version is its tooltip), a chip for a run under way,
and the big *Stop*, always in view:
it stops a run or probing the way their own Stop does, else ends a camera
routine, cancels a jog or goto and turns the beam or spindle off; on a
G-code machine it sends the file's stop. One machine is connected at a
time; the Connection panel keeps a button for each machine connected lately
(up to four), which switches to it in one press, letting the one
connected go first. Then jog the beam over the
axis with the radius buttons, press "Set R=0 here", then turn the table
with the turn buttons: a positive turn must swing the point under the beam
counterclockwise seen from above, otherwise set `$dir_invert`. Check steps
per unit at low speed before the first job. The Machine panel lies along
the foot of every step of the Run area as a dock: the position always in
view, and the jog, the tool's buttons and the markers on a press of *Jog*.
*Home* is in the panel's head, beside *Jog*, on a machine that can home,
so it is one press away in every step; *Unlock* shows there while the
machine is in alarm.
One step size serves every axis: *Fine*, *Normal* or *Coarse*, each axis
taking its own step for it from the machine file (its smallest choice,
the one it starts on, its largest). Every step is a field showing the
distance a press moves by: the board's X and Y at the end of the size's
row, a joint's between its two moves. A number typed there is that
axis's step at the size picked (X 2.5 mm at *Normal* while *Fine* and
*Coarse* stay the file's), kept by the browser; the field cleared, the
file's step is back, and a field holding a typed step is drawn in bold.
On a machine with a board pad the pad comes
first: eight arrows around the head's X and Y on the board, the corners
moving X and Y together (the arrow keys
move along one axis at a time). Every joint is a line under it: where it
is now, and its two moves with its step between them, and *Motors*
under the lines. Under *More* are the
zero buttons, going to a place, declaring the position and the feed.
PageUp and PageDown never scroll the
page (a mill's file binds them to Z); a text area keeps them. *Cancel*
in the panel's head, or Escape, stops a move (Escape also leaves a text
field, so the next arrow key jogs). Shift held with a jog key jogs by the
fine step. Under *Hold to
move* a jog button or key held moves the axis until it is let go, the
step read as the distance per second: the page sends a piece of the move
every tenth of a second, and at the release this project's firmware
cancels the jog at once, while a G-code machine runs out the last piece. The Setup side's
*Machines* page holds the machine files (the *Machine file* panel), where the pins are set too (the laser output, the probe
and an optional tool output), and beside them the *Settings* panel, the list of every key a
file can set with the board's value next to the file's. The list opens on
the keys where the two differ; unticking *only differences* shows them
all, and a search looks through every key either way.

### Jobs, the preview and the Run panel

The *Jobs* panel in the Job area imports a file dropped on it or picked.
*Import settings* under its drop area opens the import dialog with what
the next import is made with (the power, speed and spot, the anchor and
offset, the layer, mirror, Board and the fields its mode takes), and the
line under the drop area says them. A row of the list is a job, one
button with its drawing, and its Delete; *More* under the list holds the
picked job's *Icon* and *Save job*, *Combine* and *Delete all*.

The picked job is the *Job* panel: its length and time in a line, then
its groups, a row each. A row is the box that takes the group in or out
of the run and a button that says its numbers ("S500, 400 mm/min, 3
passes"); pressed, it opens the group's fields under it, each under its
name, with *Pick its paths*. A number is kept when its field is left.
*More* under the groups holds the width (and a stencil's margin) and the
path's numbers, and *Run this job* goes on to the Run area with it.

A board upload isolates its copper by default; with Board set to deposit,
for a process that lays copper down, it burns the copper itself and
nothing past its edge. With Board set to stencil it cuts a solder paste
stencil out of a film laid where the board would be: once round the
inside of every paste opening, shrunk first by Margin mm on every side,
so each piece drops out and leaves its hole; picking stencil turns a
Layer of F.Cu into F.Paste. The preview draws every pad with its cut
inside it, the margin being the band between them, and the Job panel's margin
row cuts the stencil again for another margin where it lies. With Board
set to on the lines it cuts the layer where it is drawn: every line along
its middle and every filled shape round its edge, so Edge.Cuts cuts a part
out on its outline, a silk screen or a user layer is burnt as drawn. The
dialog's Layer field picks the layer a KiCad board is read from: a copper layer,
F.Paste, or any layer to cut on its lines. A `.kicad_pcb` picked or
dropped is not sent at once: the import dialog offers its own layers first, each with
what is drawn on it, with the settings under them, and picking a drawing (Edge.Cuts, a silk screen, a
fab or user layer) sets Board to on the lines; Import sends it, Cancel or
Escape leaves it. A gerber is its own layer. Any other file is imported
at once, with the settings as the line under the drop area says them.

A drawing is cut on its lines: an SVG a group per stroke color, a DXF a
group per layer (its lines joined where their ends meet, blocks inserted,
curves flattened, in the unit its header gives, millimeters when it gives
none). Save a DXF as ASCII: a binary one is refused. The Setup side's
CAM page takes a DXF too, its layers being what a paths operation's `match` picks.

The preview's head has *Fit* (the whole job in view again) and *Top view*;
*View* opens a row with the rest: the rotation lock, the height map, the
grid, *Box select*, the speed view, quarter turns and *Clear trail*. While
the row is shut, View says how many of the lock, box selection and the
speed view are on.

A click on a path in the preview picks it (shift or ctrl adds one or takes
it back, *Box select* picks every path inside a dragged box, *Pick its
paths* in a group's opened row all of its paths); the Job panel then moves
the picked paths into a group of their own, which takes the first one's
settings (switched off if any group they come from is) and can be given
its own power, speed, passes or focus, or into a
group the job has, or deletes them. *Array* copies the picked paths: in a
*Linear* row stepped by x and y, or *Circular* round a center (*Middle* of
the picked paths, the *Origin*, or typed) through a sweep, a whole turn
spreading them evenly; the count takes the picked paths in, the copies are
drawn on the preview as the fields change, and *Make array* keeps them,
each at the end of its path's group, picked, so *Delete paths* takes them
back. A job made from a file or in the Draw panel whose paths are moved,
deleted or copied (the page asks first), or changed in the *Job JSON*
panel, is no longer made again from it for another width, which would put
its paths back as the file or the operations make them. Each job in the list carries a
small drawing of itself; *Icon*, under the list's *More*, opens a picker
under the picked job for an icon in its
place: one of twelve glyphs or one or two letters, on one of eight colors,
kept with the job at once (also while it runs); *Drawing* gives the drawing
back. With *More* open each job has a box: checking two or more and pressing *Combine* makes
one new job of them, cut in the order they were checked, each group's name
led by its job's (the jobs themselves stay; jobs made for different tools
do not combine). The *Job JSON* view
shows the job with a path a line: the path and point under the caret are
drawn on the preview, a picked path brings the caret to its line, an edit
is drawn as it is typed and kept with *Apply*. A path picked on an edit
not yet applied is only found in the text: the Job panel moves, deletes
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
and *On*, a path at a time, show while it is off its end): the paths cut
so far are drawn, the last of them marked, the rest faint; at its end the
job is drawn whole.

The preview is drawn by the graphics card (WebGL2) in the background, so
a board of hundreds of thousands of points still turns smoothly and the
page answers while it does; a browser without a graphics card to draw with
gets the plain 2D canvas, also in the background. Should a graphics driver
draw the preview wrong, `?preview=2d` at the end of the page's address
draws it with the 2D canvas in the page, as before.

The run controls (Run, Hold, Resume, Stop, the progress and the pickup
of a stopped run) are the Run panel at the foot of the Run area's right
column, kept in view while the panels above it scroll under it; how a
run follows the height map is picked in the Height panel (*Runs follow*).
Every number field takes arithmetic (`25.4/2`, `1/8 in`; see the Draw
panel below).

### Probing and the height map

An optional focus axis (`H`, the E driver socket unless `$sockets` moves
it, `$h_axis=1`) carries a
touch probe on the Z-STOP input. The Height panel (Run area) probes a grid over
the board, and a run can then follow it: the focus axis tracks the board
under the beam, or, without a focus axis, the power is raised where the
board sits out of focus.

1. Jog the head up until the probe clears the board, or type a *Travel H*
   in the Height panel: probing travels at the higher of the two, and the
   probe's depth counts down from there. Set the probe's offset from the
   beam under *Probe*.
2. *Fit to job* (the preview shows the grid), then *Probe*. The panel
   shows the heights as a map of the board seen from above, blue below the
   mean and red above it, the points left out hatched.
3. Jog the beam over the board, focus it by eye with the focus axis, and
   press *Focus here*; or type the offset into *Focus offset mm*, where it
   holds until *Set*.
4. Run with *height map: auto* in the Height panel's *Runs follow*, which
   the choice turns to by itself while
   a map is usable and back to off when none is, until it is changed by
   hand. The chip beside Run in the Run panel says what Run will do with the map
   before it is pressed (*map on: focus axis*, *map off*, or why the run
   would be refused, such as *focus not set* or *map short of job*); the
   Height panel's head says the same for the selected job, and while a
   run lasts the status bar shows what it follows.

The focus offset is dropped whenever the focus axis may count from other
numbers (Set H=0, a connect, the firmware restarting, a map loaded;
[WEB_API.md](WEB_API.md#height-map) has every case): the panel then asks
for *Focus here* (*Touch off here* on a mill) again before a run follows
the map, and a tie ([below](#probing-less-around-the-cuts-and-one-point))
sets it again from one probe.

Wiring and bring-up are in spinny-firmware's [rp2040/README.md](https://github.com/tmpk13/spinny-firmware/blob/main/rp2040/README.md).

### Cartesian and spindle

Two optional modes use the same machine; both are firmware settings, off
by default, and the page follows them. The quickest way between them is
the Setup side's *Machines* page, which edits and loads a whole file from
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
spindle note in spinny-firmware's [rp2040/README.md](https://github.com/tmpk13/spinny-firmware/blob/main/rp2040/README.md) before connecting one.

### The Draw panel

The *Draw* panel in the Job area is the machine used like a manual mill:
simple operations, one or several in a job, drawn on the Job area's
preview, with the Machine panel beside it for the position, the jog (its
keys jog while the Job area shows), the spindle and the markers. On a
laser machine the same operations are burnt instead: the fields are the
spot, the power and the passes (each the whole path again), a point is
marked with a ring the spot across, and a board hole is cut along its
inside edge so the plug drops out, or with *clear* on burnt away in rings.
Focus the beam instead of zeroing a depth.

1. Zero the depth on the surface (touch off, *Set H=0 here* or the
   zero on the Machine panel's depth bar), as for any milled job.
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
   at the end of the selected drawn job, so one job can hold a pocket, the
   holes beside it and the outline round both. The job's operations are
   listed over the fields: a click puts one in the fields, *Apply* puts the
   fields back in its place, *Up* cuts one before the one above it and
   *Remove* takes it out. The groups keep what the Job panel set on them
   (turned off, a focus, a slower feed) unless the fields change that
   number. The mark beside the job's name says whether the fields are one
   of its operations as kept (*applied*), changed since (*changed*, also
   counted on the Job area's tab), or not in it. All of a job's operations cut with
   one bit or spot.
6. *Run* in the Run area's Run panel cuts the selected job, as it cuts
   any job, and a stopped run is picked up the same way.

A job moved or turned (Board place, *By hand*) keeps its place when its
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

The *Markers* fold at the foot of the Machine panel (in the Run area,
and in its copy in the Job area) keeps named positions:
*Mark here* saves where the head is, under the name typed or the next M
number, *Add* a typed x and y; a name used again moves that marker. *Go*
rises to the travel height and goes there, *Here* moves the marker to the
head. Every preview draws them, and the backend keeps them in its config
for every page and browser.

### Another bit for a job

The Job panel has the width the job is cut for (*Tool mm* on a mill,
*Spot mm* on a laser). *Re-cut* makes a board job again from its kept
file for the new width and puts it where the job is now, alignment and
moves included, so a second bit's isolation lands on the copper the
first cut; a job drawn in the Draw panel is built again with the new bit. The groups
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
Machine panel's *Extrude* and *Retract* push and pull the plunger by its step,
for priming the needle and checking the flow.

1. Upload the board with Board set to *dispense* in the import dialog: a dot on every pad of its paste
   layer (`F.Paste`; a copper layer's pads are its flashes), the paste
   thickness over a pad (0.12 mm by default) in the dialog's *Paste mm* and in the
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

The Run area shows one step of a run at a time. Its steps run across its
top as numbered circles: *Connect*, *Job*, *Board* (where the board sits),
*Height* (on a machine with an axis for it) and *Run*; with a G-code pick
and place machine, *Connect*, *Home*, *Parts*, *Board*, *Feeders* and
*Place*. A step shows the work on the left (the job's preview with the
head on it, a camera's picture on a tab behind it) and the one panel that
does the step on the right, with the Machine panel docked along the foot.
A step is ticked when the page sees it done (connected, a job picked, a
usable map, a run finished), a step a run can do without is ringed with a
dashed line, and the line under the steps says what is so in the one
shown. The area opens at the first step a run needs that is not done and
moves on when a step's own action completes it; a step pressed stays, and
*Next* goes on to the one after (a narrow window, whose steps are small
marks, has *Back* too, and puts the step's panel before the picture). *All panels*, at the right end, shows every
panel of the area at once, arranged with the layout tools below; pressed
again it gives the steps back.

With all panels shown the area also has the Steps panel, which follows a
common setup as a row of numbered circles: *Probe and follow a height
map*, *Mill a board*, *Measure the camera offset* or *Place parts* (only
the ones the machine has what for, once it is connected). A step fills in
when the page sees it done, the next one is ringed and said in words
under the row, and a press on any step goes to the panel that does it.

The Job area has views the same way, as tabs: *Jobs* (the list, the
preview and the picked job), *Draw*, *Assistant* and *JSON*. So have the
Machines page (*Machine*, *Keys*, *Import*) and the Cameras page (a view a
camera, its picture beside its settings, and *Head and bed*). A link, a setup step or the search going to
a panel the view shown does not hold brings up the view that holds it.

### Edits not applied

The machine file is the one place a machine's settings are written: an
edit in its editor counts until *Save* (or *Write to board*, which saves
first), and the board line says when the board runs settings no file has
or has values not saved to its flash, with *Save to flash* for those. The
camera settings and the CAM profile editors count their edits the same
way, and every tab shows the count of edits not applied on its page;
leaving the page with any asks first.

### The Use and Setup sides

The page's areas run down a rail at the window's left (a bar across the
top on a narrow window), on two sides. *Use* (the areas Home, Job and
Run) is what is done on every run; *Setup* (Checklist, Machines,
Cameras, CAM and Page) is what the machine is and knows. The rail lists
both sides' areas under their names, each one press away; a side's name,
or the `\` key, goes to the page that side showed last (on a narrow
window the bar shows one side's areas, and the other side's name swaps to
it). *Side by side* in the rail, or `|`, shows both with a handle
between them (on a window at least about 1000 px wide). Each side also
opens in a tab of its own: `/?side=setup` (keep `?mock=1` or `?api=` as
the page has them), or the middle button on any link to it.

The Checklist lists every value the machine runs on, where it came from
(measured and when, detected, in the file, typed, the default, missing),
and a link to where it is set or measured. A panel on the Use side that
runs on one of those values has a Setup link in its head, which turns
yellow and counts when something it needs is missing. A link opens its
target in the other pane when the sides are side by side, in a tab that
already shows that side when there is one (a toast here offers *Show
here*), and otherwise here, with Back to return. How it works and why:
[UI_SPLIT.md](UI_SPLIT.md).

### Panels, tabs and the page settings

*Home* says where things stand: the machine connected or not, the next
thing to do with one button that does it (connect the port found, or the
Run area at the step the work stands at), what the Checklist says needs
someone, each line a link to where it is done, and the jobs to pick from.

Color is kept for states: the next action is the one dark button of a
screen, a choice that is on is drawn pressed, blue is work under way,
yellow something that needs someone, red what stops the machine and
danger (a hazard at rest, as Test beam, is outlined in red, not filled).
*Colors for tabs and panels* in the page settings gives every page a
color of its own (Job orange, Run green, Machines yellow, Cameras violet,
CAM cyan, Page red; Home and the Checklist grey) on its tab and along its
panels' top edge; it is off unless turned on. Inside a panel, what every
run uses is in view and the rest under a *More* in the same panel, which
says what it holds; how something is done is a button's tooltip, or a
question mark's (pressed, it says its words as a message).

The layout tools arrange an area's *All panels* view; a step or another
view has its panels in set places. There, every panel's head has a fold button (the chevron before its name) and a
menu (the dots after it, or a right click on the head): fold, hide, move
up, down or to the next column, stack with the panel above or below,
stick to the panel above, lay stuck panels *Side by side* (and back *One
above another*), *New folder*, *Into* another folder or *Out of* its own,
*Fit to screen*, reset, and *Edit panels*. A stack shows one of its
panels at a time under a row of tabs, drawn as a folder with an edge
under it for each panel behind, and folds as one: folding any of its
panels folds them all, and a tab shows its panel folded too. Drag a tab
off the row to take its panel
out of the stack to where it is let go (another place, or onto another
panel to stack it there), or press the button at the row's end (or
*Take the stack apart* in the menu) to lay all of them out one above
another. Some panels start stacked: each camera's picture controls,
lens and colors and changes with its panel on the Cameras page, and
*What it can do* with the Assistant. Panels stuck together are drawn as
one block and move together, one above another or side by side (a phone
shows them in one column either way); side by side, a folded panel
stands on its side as a narrow strip and gives its width to the others.
A folder is a group of panels under a name, in a box with a head: its
fold (shut, the head names the panels it holds), its name (double click
to rename), how many panels it holds, and a menu that folds, renames and
moves the folder as one, or takes it apart. *New folder* in a panel's
menu makes one named after the panel, its name up for typing; a panel in
a folder moves *Up* and *Down in the folder*. A phone shows a folder's panels in the
one column, without the box. Content out of sight says so: a panel held
at a height, or a column with panels below its foot, fades there under a
*more below* press that scrolls on; a held panel's head casts a shadow
over what scrolled under it; a folded panel or stack says *folded*
beside its name.
The Run panel stays at the foot of
its column unless it is stuck or stacked. On the wide layout a handle
under each panel holds it at a height (it then scrolls inside, with
buttons in its head to its top and its end), and a handle between two
columns sets their widths; a double click on either gives the size back.
*Fit to screen* holds a panel at the height its column shows. The Parts
panel's list sizes by its lower right corner.

The gear among the tools at the rail's foot (at the bar's right end on a
narrow window) opens the page settings: the
tab the page opens on, the rail folded to a thin strip that opens on
hover or a press, tabs kept out of the rail (they open from *More* at its
end), the panel layouts kept by name, *Edit panels*, a reset of the page
shown, the hidden panels to show again, and the look: the page's own
fonts (Inter and JetBrains Mono, served with the page, so it reads the
same with no network) or the system's, *Animate the page* (panels
unfolding, a stack's panel coming forward, menus and pages opening; off,
or with the system's reduced motion, everything simply appears), and
*Colors for tabs and panels*. *Edit panels* (here or in any panel's
menu) puts a grip in every head: drag a panel to another place, onto
another panel to stack them, or onto a folder's head to put it in (a
panel in a folder goes alone; the folder's own grip drags the folder),
then press *Done editing* in the rail. While a panel is
hidden an eye shows beside the gear, counting them: pressed, the hidden
panels show for a while with a dashed edge (their menu has *Show for
good*), and pressed again they hide. On a narrow window two arrows beside it scroll the page
to its top or its end. A layout kept by name
covers every page; *Default* is the page as shipped and cannot be saved
over. Once one is kept, a pick beside the gear swaps layouts in one
step. The Steps, Head camera and Job JSON panels, and the Board place
panel's folds, keep their own fold, which a layout does not carry. All of this is kept in the browser, not
on the machine; a phone keeps the one-column order until its panels are
moved, and has no size handles.

While a menu, a drawing, the page settings or another pop-up is open,
the pointer outside it is a circle with an x: a press there only closes
the pop-up and presses nothing under it. The buttons that stop something
are the exception (the bar's Stop, a run's Stop and Hold, probing's Stop,
every Abort, the jog's Cancel, the console's Hold and Reset, Laser off,
Stop spindle): they always take the press. The red buttons that start
something (Test beam, Start spindle, Make mark) do not.

Every button shows on hover what it does, a disabled one also why it is
off ("connect first"), and a key in the Machines page's machine file shows
what it sets. The small "i" beside some settings opens a drawing of what
they mean when pressed (not on hover), until pressed again, anything else
is pressed, or Escape. The magnifier among the rail's tools (or "/" or Ctrl+K
with no field in use) finds a feature by a few letters of its name, in
order ("hprb" finds the Height panel's Probe), among every page, panel and
button: Enter or a press shows its page and panel, unfolded and pulsing,
and gives a button the focus without pressing it.

*To-do* among the rail's tools opens a list from the right edge:
type a line and press Enter to add it, check it off when done, *Delete*
takes one out and *Clear done* the ones checked off. The button, Escape
or a press anywhere else closes it, and the button counts what is left.
The backend keeps the list (`var/todo.json`), so every browser shows the
same one.

The bug among the rail's tools reports a bug. It takes a screenshot of the page
as it is when pressed (made in the browser from the page itself; the
preview is asked for its picture), shown small in the dialog, and lists
what was done lately: the last 200 buttons pressed, pages shown,
requests to the backend (method, path, status and time, never what they
carried), toasts and errors. Say what happened (the first line is the
title), untick either to leave it out, and *Save*: the backend keeps the
report under `var/reports/<time>/`. The *Bug reports* panel on the Setup
side's *Page* page sets where else it goes: nowhere (the default); a GitHub repository's
address, whose new-issue page then opens filled in (attach the
screenshot from the folder the dialog names, since a picture cannot ride
in an address); or any other address, which gets the report posted as
JSON, the dialog saying whether it was taken. Closed without saving, the
words typed wait for the next report.

The *Plugins* panel, on the Setup side's *Page* page, lists the page's plugins: JavaScript modules in
`var/plugins` that add a panel, a readout or a button to the page,
written by the Assistant or put there by hand ([PLUGINS.md](PLUGINS.md)
says how one is made). Each has a switch, what it does, who made it,
its source in a fold, and *Delete*. A plugin runs with the page's whole
power, moving the machine and firing the laser included, so each is off
until turned on here, which asks first, and goes off again when its file
changes. On or off applies at once in every browser open, and in each
one that loads later; turned off, a plugin's panels go at once, and
anything else it left goes with a reload.

### The travel height

*Travel H* in the Height panel (on a machine with a focus axis) is an H the
head rises to before the page moves it across the board: a goto of the
board or of a joint across it, probing, *Probe nearest* and the camera
routines. A head already higher stays where it is, a goto that names its
own H is left alone, and jogs and runs keep their own heights (a milling
run travels at its clearance over the surface). Blank turns it off. It is
a host value: `[host] travel` in a machine file, `host.travel` in
`PUT /api/settings`.

### Probing less: around the cuts, and one point

Probing every point of a grid over a sparse board measures mostly bare
board. Beside *Fit to job* (the grid's own fields are under the Height
panel's *More*), *around the job's cuts* probes only the
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
pads. *Probe pads*, under the Height panel's *More*, probes the selected job's pads
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
*Head camera* panel on the Setup side's *Cameras* page holds its settings; its
picture is the *Head camera view* panel in the Run area, whose *Start* and
*Stop* start and stop it (the camera's own panel has them too). A
camera's panel keeps in view which camera it is, what it last saw and
where it was measured to sit; its device and size, its place and scale as
numbers, the routine that measures them and its log are under its *More*,
each under a heading whose tooltip says what it is for. With *Look for board* (the Board place
panel's *By camera*) on a job imported from a KiCad file the panels say where
on the board the picture is and how well it is locked (below).

Every camera picture (the head camera's, and the bottom and top
cameras' in the Run area) works the same way. It is asked for at the size it is shown, so
it stays sharp when zoomed: *+* and *-* under it zoom on its middle by
steps, and Ctrl and the wheel over the picture (or a pinch on a
touchpad) zoom about the point under the pointer, which stays under it
(the plain wheel scrolls the page, over the picture too); *-* and *+* are the ends of the
zoom's own box, and the number between them is a field, so any zoom from
0.25 to 8 can be typed in and taken with Enter. Under 1 the picture shows
smaller than its box, and the marks beyond its edges (known points, a
search box, the board) show in the room around it, where a search box can
be drawn too. A drag with the middle button, or with Alt, pans the view;
*Reset view* goes back to the whole picture filling its box, not panned.
With the pointer over the picture the arrow keys move the head (1 mm a
press, a tenth with Shift) as the picture's *View* menu says, kept per
camera: *Arrow keys as the picture shows* (the default) moves it the way
they point on the picture as it is shown, turned or not, so a camera on
the head looks further that way and the fixed bottom camera sees the
nozzle go that way; *Arrow keys the other way* moves it against that (a
camera on the head then sees the picture's content go the way the arrow
points, as a drag moves it); *Arrow keys on the machine's axes* leaves
them to the jog keys, which keep the machine's axes and the Machine panel's
step, as the Machine panel's keys and pad always do. A drag moves the head
so what the camera sees follows the pointer, a line showing the move; a
double-click brings a point to the crosshair (both once the camera's
scale is measured). The grip under the picture makes its box taller or
shorter, kept per camera; a double-click on the grip gives the picture
its own shape back. In a step or a view the box stops at its panel's
edge however far the grip is dragged, the buttons under it staying in
the panel. Each camera's picture shows a second time on its view of the
Cameras page, beside the settings that change it; that one keeps its own
height and switches and draws no search box. *Overlay* switches the page's marks over it (the
crosshair, the circle a spot is looked for within, a spot found with its
ellipse and box, a search box, the board where the looks put it, the
known points below) and pcbv's pose of a loaded board; the marks keep
thin lines at any zoom. A spot a routine or *Look once* finds stays over
the picture until *Clear marks*, each newer one joining the older (only
the newest keeps the circle it was looked for within and the line from
the center); by default they follow the machine, staying over what they
marked as the head moves (the head's place for the bottom camera, which
sees the nozzle), and *Marks follow the machine* in *View* switched off
keeps them where they were drawn. *Edges* (kept per camera) draws in
yellow the straight edges pcbv finds in the picture, strongest first,
asked once a second while it is on and the picture shows: what *Corner by
edges* reads, so a blank board's sides can be checked (and a color picked
for them) before a corner is taken; its tooltip says why when they could
not be had. The cameras' routines (*Find mark*, *Measure offset*, a
search's roll and scale, *Find fiducials*, *Corner by edges*, *Center
features*, *Center nozzle*, *Measure runout*) keep what they find at once
and nothing asks first: for about ten seconds a row under the camera's
picture says what was applied, with *Undo*, and its marks are drawn dashed
magenta (the spot centered, the edges and their corner, the points found
ringed and named); the row's tooltip lists each setting it changed, before
and after. Every result is also an entry of the camera's *Changes* panel
(stacked with its picture controls), newest first with its time, its words,
each setting as before -> after and *Undo* (*Redo* for an undo). *Undo*
puts the settings back as they were (and the references, corners or Align
marks the result changed) and is listed too; it is refused, its button
saying why, once a setting changed since, while a routine of the camera
runs, for a result kept on another G-code machine, and, for a corner or
Align marks, after the backend started again. *Upright* (on unless switched off, kept per
camera) shows the picture turned by the camera's roll to the nearest
quarter turn, and flipped when the camera sees the machine mirrored (the
bottom camera looking up), so the machine's +X points right and +Y up as
on the jog pad: a camera mounted upside down shows the right way up once
its roll says 180, measured by its offset routine or typed (the head
camera's *Roll deg*, the file's `[camera] roll`, `[top_camera] roll` or
`[up_camera] roll` and `mirror`).
Its tooltip says the turn; the marks turn with the picture, their words
kept level, but pcbv's own marks drawn into the JPEG turn too. *Turn*
turns the picture a further quarter clockwise each press, over Upright's
turn or without it, kept per camera (four presses take it back); drags,
double-clicks and picks follow the turn. *View* sets the crosshair, kept
per camera: a cross, a circle, both or none, and how far it reaches (a
fortieth, a tenth or a quarter of the view's width, or across the whole
view), the same size on the screen at any zoom.

Blue rings mark the points whose place on the machine is known, where
they fall in the picture, so a glance says whether what the page holds
sits on what the camera sees. The head camera's picture rings the
selected job's alignment marks where they were found (*A1*, *A2*, in
the *By marks* table's order), its fiducials where a look that found the
board puts them (else where the job lies, which is where it is cut),
the corners taken by hand, the mark *Find mark* centers on, and the
markers. The top camera's rings the fiducials *Find fiducials* found
(the others where its look puts them once it found the board), the
parts taken with the nozzle or the camera, the corners, its mark and the
fiducial *Home by fiducial* finds; the bottom camera's rings the nozzle
where the head's place puts it. A ring keeps one size at any zoom; its
label shows only where it has room.

The cameras' own words (spot, shade, lens, roll, mm per px, offset, pose,
inliers, rms, look, lock, guess, threshold, rival and the like) are
underlined with dots where the panels use them: the pointer over one
says what it means (one list in `src/terms.ts`).

*Picture controls*, a panel stacked with each camera's panel on the
Cameras page (a tab beside it: *Head picture controls*, *Bottom picture
controls* and *Top picture controls*), lists what the
camera lets be set (exposure, gain, focus, white balance, brightness and
the like, as v4l2-ctl lists them): a slider, a box or a list each. A value
set goes to the camera at once and is kept, so it is set again whenever
the camera starts (kept ones are bold; *Forget* leaves the camera's own).
Automatic exposure is set before a manual exposure time; a control an
automatic one has taken over is left out and named in a line under the
list until the automatic one is off (one with a kept value stays, to be
forgotten). A camera on a bridge Pi
(an HTTP snapshot URL) has none here: they are set on the Pi.

While the panel shows (in front of its stack and unfolded), *Live picture* at its head measures the camera's
picture as its view shows it (the zoomed part when zoomed), a few times a
second, to turn the controls by: *Sharpness*, how crisp the edges are in
levels a pixel, with the best since the fold opened so the focus can be
turned to the peak (*Reset best* starts it again, as another zoom or
picture size does), and the share of pixels on an edge; *Noise*, the
grain left in the flat parts, and the signal to noise ratio, the mean
brightness over it in dB; *Brightness*, the mean level from 0 to 255,
and its spread; and the share *Clipped* to pure black and white, with a
histogram of the levels under them. Sharpness grows with contrast too,
so compare one focus with another at one exposure. The numbers come
only while the camera runs and its picture is on screen (the one beside
the controls on the Cameras page serves), and they are of
the JPEG the page is sent, which smooths some of the sensor's noise
away; with a board loaded and *Overlay* on, pcbv's own marks are drawn
into that JPEG and count as edges, so *Overlay* off measures the camera
alone.

The Head camera panel's *Camera* list holds the cameras attached: the ones on the
backend's computer, under their stable `/dev/v4l/by-id` names, and the
streams of a Pi forwarded here (below). They are listed when the panel
comes into view; *Detect* lists them again after one is plugged in.
Picking one fills *Device*, *Size* and *fps* (the size kept when the
camera has it, else 1280x720 or the nearest below; the fps lowered only
past what the camera gives), and *Start* (on the camera's view) sends what the fields show
before starting. A device can still be typed into *Device* by hand.
*Apply* on a running camera with another device, size or fps starts it
again on them. The Bottom camera panel beside it has the same list,
and each list says which camera the other one is set to. A pcbv that
leaves a request unanswered for 6 s (a stalled link to a Pi, a hung
program) or whose connection fails is closed, and the panel shows the
camera stopped: start it again once the link is back.

The camera is useful once the machine knows where it looks from the tool
(the Head camera panel's routines, or *Measure the camera offset* in the
Steps panel):

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

#### Looking for the board

The Board place panel's *By camera* fold (Run area) looks with one
camera: the head camera, or a G-code machine's top camera, picked from
the running ones in its Camera list.

*Look for board* loads the selected job's board into pcbv, which looks for
it in every picture until *Unload*. The backend reads its pose about five
times a second and, while the head stands still, turns each lock into
where the board lies on the machine. Looks that agree (within half a
millimeter and a degree) make one guess, and each guess is a column in
the panel's graph, as tall as its share of the evidence: its looks, each
counted by how well pcbv matched it. The board is *found* once the most
likely guess has five looks or more, from two independent locks (frames
pcbv tracks from one lock are one look at the picture: a lock its search
found again, after the pose was cleared or at another stop, is a second),
and reaches the threshold line (half the evidence unless moved; drag the
line, press the graph at a height or use the slider under it; each camera
keeps its own). A guess that has all but the second lock has pcbv clear
its pose and search the same picture afresh; the line under the buttons
says *looking afresh for another*, and the table's *Locks* column counts
them. When pcbv's search saw another place fit nearly as well (a repeated
row of pads, a symmetric cluster), the line says *AMBIGUOUS*: check the
place from elsewhere on the board. The camera's measured scale is sent
with the board, so pcbv never locks at another scale. The badge turns from
*looking* to *found*, the line under the buttons says how many looks agree
and why a look was not used (the head moving, say), and the table under
the graph gives each guess's numbers. A column under the line is grey,
one ruled out by the corners hatched. The Board panel's drawing (Run area) shows
where each guess at or over the line (and the most likely one) says the
camera's picture lies on the board, labeled with its share. The Job
area's preview draws the board's outline dashed where the most likely guess puts
it, and the camera pictures draw it over what they show.

*Method* picks how the board is called found, for the camera picked:
*Vote among guesses* (the default, above) or *Probability over the pose*.
The probability weighs every picture, also those that locked on nothing:
a picture that should have shown the board's pads and did not lowers the
places that would have put them there, and a place repeated along a row
of pads stays split until a picture at the board's edge tells the two
apart. Its columns are the places' probabilities, with one more, dashed
and marked *?*, for where nothing has looked yet; the threshold reads as
a probability (half means more likely than not, so raise it for caution),
and the most likely place must also hold more than that last column and
lie within half a millimeter and a degree. With it, *Search* goes next to
the stop that should tell the most for the time it takes to get there,
not the nearest. *Board stretch* (with the probability only) also fits
the board's X and Y scale and its shear, within a fab's tolerance, and
says them under the slider; pictures far apart on the board measure them.
The vote stays the default until search records from the machine show the
probability finding boards at least as often and as right
(`mise run search-report -- sweep --method both` replays both on every
record kept).

*Full scan* covers the whole board once a rough place is known (a board
found, its corners taken, the Align marks or the top camera's
references): the head runs rows over the board's outline, a little past
it, back and forth, and stops for a picture at each place. Every picture
is weighed by the look, whichever the method, and the scan does not end
when the board is found, so the place comes from the whole board rather
than from one corner of it (the long baseline board stretch needs). The
pictures are laid side by side under the panel's *Full scan* heading as a
mosaic, each where the head took it, with the board's outline dashed where
the scan found it.

Each board found with its stretch measured (a probability look with
*Board stretch* on, or *By marks* applied with three marks or more) is kept
for the machine it lies on: a board's stretch turns with the board, the
machine's skew does not, so averaged over boards found at different turns
it is the machine's own: its X and Y scale and how far its axes are out of
square. The panel says it, with how sure it is and how far apart the
boards' turns were (find one turned a quarter to tell the two apart).
*Write skew to machine file*, for a cartesian machine on this project's
firmware, multiplies the file's X and Y steps per mm by the scales
learned; load the file into the controller after. Out of square is said,
never written: square the axes by hand, or on a G-code machine give its
file's `[motion] skew` (MACHINES.md). *Forget boards* starts over.

With the head camera, *Scan* beside the buttons picks *At rest* (the
default) or *On the move*: the head then runs along each row without
stopping, and each picture is placed where the machine's position reports
put the head the moment it was taken. Set the camera's exposure by hand
first (its picture controls): the head goes no faster than keeps a small
pad's blur under a quarter of it over that exposure. A camera hands its
pictures over a little late; that delay moves the board one way on rows
run left to right and the other way on rows run back, so with *Probability
over the pose* the scan measures it, and the scan's line says it. A
G-code machine reports its place only at rest, so its scans always stop.

While a search or a full scan runs, *Stop search* stops it where it is:
the guesses, the place they predict and the corners taken stay, so *Use as
board place* can still take it. *Clear guesses* forgets the guesses and
the place they predict with the board still loaded; *Unload* stops looking
altogether. A search keeps a picture from every stop it looked from, laid
out under the panel as a map of where it looked, like a full scan's.

*Use as board place* keeps where the found board lies: with the top camera
as the job's references (two parts far apart; *Find fiducials* then makes
them exact), with the head camera as marks under *By marks*.

*Search* moves the camera over a box in steps of its picture until the
board is found, then checks it: the picture's center goes over the
board's middle (or the part of the board with the most pads and holes in
view) and the looks there, searched afresh, must agree with the place
found; a check that disagrees or sees nothing sends the search on (three
checks at most). It ends by itself (found and checked, or every step
looked at) or with *Abort*. Draw
the box with Shift and a drag on the picture; *Add view* grows it to take
in what the picture shows now (jog to one corner, draw, jog to the other,
*Add view*), and *Clear box* forgets it. With no box it searches where the
corners taken put the board, else a square the board's diagonal on a side
about where the picture is.

*Rough place by corners*: put the picture's center on a corner of the
board (jog, or double-click the corner in the camera's picture), pick
which corner it is (as the Board drawing shows the board) and press
*Corner here*; then the same at another corner. Two corners give the
board's place and turn, one its place only (taken square). The camera
pictures draw the board's outline where they put it, dash-dotted. The
corners narrow a search to the board, *Use as board place* takes their
place when nothing is found, and a guess that puts a corner further than
*Within* (2 mm unless set) from where it was taken is ruled out: a look a
pitch off cannot then be called found.

A blank board (copper clad, nothing on it yet, for a first operation)
has nothing pcbv can match, but its edges show against the bed: put the
picture about one of its corners, the bed around it in view, pick the
corner and press *Corner by edges*. The two edges found give the corner
exactly and the board's turn, so one corner is a whole place (*Use as
board place*, then *Apply* under *By marks* puts the job on the blank). When the
board and the bed are close in shade, pick the edges' color (below).

*Center features* (head camera, once the board is found or its corners
taken) centers the camera on three features far apart where the place
puts them: fiducials, else drilled holes, else pads (or the kind picked),
only ones standing clear of every other. They become the job's camera
marks under *By marks*, so the board's turn comes from a long baseline rather
than from the camera's roll over one picture's few millimeters. A round
feature must look round and of its size: a ring, a square pad or a spot
of the wrong size stops it with why.

*Lens and colors*, the other panel stacked with each camera's: *Measure lens*,
with the calibration test's camera pattern (dark dots printed, or bright
ones a laser marked) filling the picture, measures how the lens bends it
and corrects every point pcbv reports from then on (kept, sent at every
start; *Clear lens* forgets it). The top camera's *Measure camera* also
says how far the machine's axes are from square, and the `[motion] skew`
that squares them (MACHINES.md, G-code machines): the head's moves went
through the skew the file takes out now, so what is left adds to it.
Write it into the file by hand; it moves every place kept in machine
numbers. It finds
the lens too, with no pattern: tiles of its first picture followed into
the pictures after each head move bend with their distance from the
picture's center. It keeps the lens (and the scale at the picture's
center, where the correction leaves it) when the lens takes a tenth or
more off the tiles' residual, logged with Undo; over a populated board
the parts' heights blur it, so measure over a flat, textured surface
where one lies on the bed. *Pick* beside *Spots*, *Board pads* or
*Edges*, then a click on the camera's picture, keeps that color for what
the camera looks for: marks and fiducials, the board's pads, or a blank
board against the bed are then found by color instead of light or dark
(copper on bare FR4, which is as bright as the board, shows by its hue).

The top camera's *Side*, *Finish* and *Paste* say how the board looks to
it; a placing run tells it each part as it is placed, so the board is
still found with parts on it.

Both camera panels have the camera log: *log every look* keeps every
picture the cameras' routines look at (finding the mark, centering the
nozzle, looking at a part, a G-code machine's run, *Corner by edges* with
the edges it found and their corner), each as it was and with what the
finder found drawn on it, so a routine that went wrong can be followed
look by look; *Photo* keeps one now with what the finder sees.

Every look for a board and every search is recorded, switch or not: the
poses pcbv gave and why each was used or not, each stop's move and look,
a picture at each stop, and how it ended. The head and top cameras' logs
list the newest; *report* opens a page with the stops drawn over the box,
the poses along the time, each stop's numbers (the stops where the board
filled a good part of the picture and nothing locked are marked missed),
how far each estimate lay from where the board was found, what other
settings would have called on the same poses, and the pictures.
`mise run search-report -- list` and `-- show ID` give the same on the
command line; `--truth X,Y,DEG` measures the estimates against a place
from fiducials or a ruler (needed for a search that found nothing), and
`--pcbv PROGRAM` gives each picture to that pcbv build again, to see
whether a change to pcbv locks where the recorded one did not.
`-- sweep` does both over every record kept: for each setting, in how
many searches it would have found the board, how often wrongly and after
how many poses, and with `--pcbv` the stops a pcbv build loses or gains
against what was recorded. The records are folders in `var/searchlog/`: [WEB_API.md](WEB_API.md#search-records)
says what each holds.

A camera plugged into a Pi that is a bridge is streamed from there
([ARCHITECTURE.md](ARCHITECTURE.md#controller-on-a-raspberry-pi) says
how, and why a picture at a time): deploy with
`mise run deploy-pi -- --camera /dev/v4l/by-id/<name> user@host`
(the deploy lists the names it finds, the `video-index0` one is the
picture; `<name>@640x480@15` picks another mode than 1280x720 at 30 fps;
a second `--camera`, the bottom camera, gets the next port), keep
`mise run relay-pi -- user@host` running, and pick `stream on port 2325`
in the Head camera panel's Camera list (the backend looks at the ports relay-pi forwards, the
ones in `SPINNY_CAMERA_PORTS` when that is set where the backend runs).
The size is the one deployed. An fps of 10 in the camera settings leaves
a Pi Zero's WiFi room for the controller's lines, and `<name>@640x480`
sends a quarter of the bytes per picture. While the camera is unplugged
the picture is ustreamer's NO SIGNAL card.
`mise run pi-logs -- user@host` shows the camera units' journals.

### Pick and place

The pick and place panels (Parts, Board and the Bottom camera view in
the Run area; Bottom camera and Nozzle on the Setup side's Cameras page)
work with the machine connected. On an X/Y machine on this
project's firmware they serve a nozzle on the head and a camera fixed to
the machine, looking up at the nozzle (the bottom camera, as OpenPnP and
Opulo call it; a machine file's `[up_camera]`); a G-code pick and place machine
(next section) gets its own panels for placing. *Place parts* in the
Steps panel leads through it:

1. Start the bottom camera: pick it in the Bottom camera panel's list (or type its device;
   the spots say whether the finder looks for something dark or bright),
   then *Start* on the Bottom camera view.
   *Look once* there finds the nozzle's (or a part's) spot with no move and
   draws it over the picture: a red circle at the center says nothing was
   found, so check the polarity, the light and the focus before a routine
   relies on it.
2. Jog the nozzle over the camera until it shows in the picture and press
   *Center nozzle* (Nozzle panel): the head rises to the travel height, comes down to
   *Sharp at H* when that is set, moves the step along X and along Y to
   measure how the picture scales, turns and mirrors, and centers the
   nozzle. The head's R and Z there are the camera's place, kept for the
   next time, when the routine goes there by itself.
3. Pick a board job uploaded as a `.kicad_pcb`: its footprints are listed
   in the Parts panel and drawn on the board in the Board panel with the head and the bottom camera; a press on a
   row or a dot picks one. The search above the drawing finds a part by a
   few letters of its reference or, with *Value*, its value: the matches
   are lit and the rest dimmed, and Enter (Shift+Enter back) or the arrow
   keys step through them, picking each and bringing it into view.
   Footprints KiCad keeps out of the position files (its test point pads,
   mounting holes, net ties) are listed grey as *kept out*; the *kept out*
   box hides them, and a placing run leaves them out unless their *place*
   box is ticked (or a feeder names them in its `refs`). *Leave out* takes
   a regular expression (any case) tested against the reference, the
   value, the footprint or any of them: *Apply* keeps it on the backend,
   the parts it matches leave the list, the drawing and every placing run,
   and the line under it counts them, or says why an expression is refused.
4. With a part on the nozzle, *Look at part* (Nozzle panel) reads where its center sits
   against the nozzle's. *Go to part* (Parts panel) takes the nozzle over the picked
   part's place at the travel height, or, ticked, the part's center.

The routines need `$cartesian=1`; the vacuum and the nozzle's turn are not
driven yet.

### Placing with a G-code machine (OpenPnP compatible)

A pick and place machine whose own controller takes the G-code OpenPnP's
GcodeDriver sends (Marlin, Smoothieware, RepRapFirmware, Grbl) is a
machine file with `controller = "gcode"` ([MACHINES.md](MACHINES.md#g-code-machines)),
used like the other machines: connected from the Connection panel, jogged and
homed in the Machine panel, read in its readout, sent lines in the Console,
stopped with *Reset* or the jog cancel. `machines/opulo-lumen-rev5.toml`
is an Opulo LumenPnP (Rev05 board, Opulo's Marlin) as Opulo's stock
OpenPnP setup drives it; `machines/openpnp-marlin.toml` is a plain Marlin
start to copy. A file is edited on the Machines page like any machine file
(*Write to board* is locked for it: its controller keeps its own
settings), where *Import from OpenPnP* reads OpenPnP's `machine.xml` (and
a `.job.xml` with its `.board.xml` files, and its `parts.xml` and
`packages.xml`) into a new one: every value read has a box to keep or
leave it, and the file shows as it will be saved. A job's placements
become references for the board job picked in the Parts panel. A feeder's
part, by its part id in `parts.xml`, gives it its package's body as its
`size` (the bottom camera's check) and, with a job's board height, its
`place_z`: the board's top plus the part's height. The parts themselves
come from the board's KiCad file, not from OpenPnP. Its steps (the
Steps panel's *Place parts with a G-code machine*):

1. Connect: the Connection panel names the machine's port after its file (the
   LumenPnP's `MARLIN_OPULO_LUMEN_REV5 ... CDC in FS Mode` port by its
   `[port] match = ["lumen"]`, another machine by its file's `url` or
   words); pick it and press *Connect*. The status bar shows the
   firmware's name (M115) and the machine's.
2. Home, in the Machine panel (*Home* in its head, drawn as the next
   thing to press until the machine is homed).
3. Pick or upload the board (a `.kicad_pcb`) in the Parts panel, pick a
   part, put the nozzle over it with the Machine panel's jog (or the top camera,
   *with the top camera* on *Go to part*), and press *Nozzle here* or
   *Camera here* in the Board place panel's *By references*. The references are kept per job
   and map the whole board: one gives the shift (with *Turned deg*), two
   or more the turn too, and the panel says how far each one sits off the
   fit. A corner of the board taken with the top camera (*Corner here* or
   *Corner by edges* under *By camera*) is a reference too, listed
   as "corner bottom left", so *Go to part* works from it at once; one
   found by its edges also gives the board's turn. *Clear corners*
   forgets them. *Parts to align to*: *Choose* picks that many parts
   spread over the board (its fiducials first, then each next the part
   farthest from those picked; *Add picked* and *Drop picked* change the
   set), each a button that picks its part, green once it has a
   reference; *Next* picks the next one with none and, once the board's
   place is known, takes the top camera over it. With *part's shape on
   the top camera* ticked, the picked part's pads and body (as its
   footprint draws them, turned as it lies) are drawn about the top
   camera's crosshair: jog until the part fills them, then *Camera here*.
4. *Plan*, in the Placing part of the Run panel, makes the placement program from the references and the
   feeders and shows it; nothing moves (it works with the machine
   disconnected too, for the one last connected). *Run* places the
   parts; a run window shows its progress and its steps (each pick,
   look, place and retry) over the page, and *Stop* sends the quickstop
   at once. With *repeat* ticked, a run that finished asks for the next
   board and places it again; the boards are counted until *Reset*.

Moving it by hand: the Machine panel draws the file's bars (X, Y, the
nozzle's height Z and its turn A; the LumenPnP's say which way N1 goes on
its seesaw); a jog reads where the head is (M114) and moves by the step
from there, so jogs pressed quickly add up. A goto (under the jog's
*More*) moves
only the axes given: it goes up to the file's safe height only to go
across and only from below it (a nozzle above it stays there; a seesaw
comes down to it from above too), turns the nozzle on the way, and puts
the height last, so the nozzle goes down only over where it is going; the
line under the goto rows says what Go will move, from where to where, as
soon as a field is typed in. With `leave` in the file's `[up_camera]`, a
jog that takes the nozzle away from over the bottom camera with its tip off
the safe height goes up to it first, while small jogs over the lens stay
at the height they are at. A row in the Machine panel has the head's
*Light*, *Park*, *Vacuum on* and *Vacuum off*, with *Home by fiducial*
and *Find home fiducial*. The Head panel on the Setup side's Cameras
page has *Nozzle over camera* (the
nozzle over the bottom camera at the height it is sharp at), *Nozzle to
camera spot* and *Camera to nozzle spot* (the head moved by the top
camera's offset), *Read vacuum*, and *Tune the machine file*. *Go to part*
moves X and Y only: it rises to the safe height first when the nozzle is
below it and never brings it down. The Bottom camera view and Top
camera view panels in the Run area show the two pictures (stack them, or put them side
by side, from the panels' menus); a drag on a picture moves the head so
the picture follows the pointer, a double-click brings a point to the
crosshair, and Ctrl and the wheel zoom. With part classes in the
machine file (`[[part_class]]`, MACHINES.md), *Crop* under the bottom
camera's picture picks the class whose crop the dashed circle shows and
the Bottom camera view's *Look once* at a part keeps to, so a class's
crop can be tried on a part held over the camera before a run uses it.
*Nozzle box* under the top
camera's picture, then a drag on it, draws a box where the nozzle
generally shows in that picture: the nozzle rides on the head with the
camera, so the box stays put there and is drawn dashed orange with the
word *nozzle*, kept with the top camera's settings (*Clear nozzle box*
forgets it). The dashed circle is how far from
the center a part is looked for (`[up_camera] crop`, or a feeder's `crop`).
Each picture's *View* menu has a *Crop for* entry per task of that camera
(bottom: nozzle, part; top: board, spot, edges, measure): picked, the
picture shows that task's box with the rest dimmed, a drag draws another,
*Save crop* writes it into the machine file's `[up_camera.crops]` or
`[top_camera.crops]` and *Clear crop* takes it out, so the task looks at
the whole picture again (MACHINES.md). While a routine runs, its picture
shows the crop of the task it keeps to; a nozzle crop a couple of mm about
the center keeps *Center nozzle* off a still speck beside the tip.
Every look a routine takes waits for a picture taken a quarter of a
second after the head stopped, and *Center nozzle* refuses a measure
whose two steps did not show as equal moves at right angles (a picture
that lagged, or a spot that is not the nozzle): *Look once* and the
camera log show what the finder took.

On a seesaw Z like the LumenPnP's, both nozzles are up only at the safe
height (31.5), and its file says `seesaw = true`: every move across goes
there first, from above or below, and a Z jog stops there (N1 fully up)
rather than go on and lower N2; a goto to a Z above 31.5 still lowers N2.
The readout's Z going down from above 31.5 is N2 coming up.
Measure *place_z* before the first run (the file's 20 keeps the tip well
above a board): jog the tip down onto the board's top, read its Z in the
readout, and set it to that Z plus the parts' height under *Tune the
machine file* in the Head panel, where the heights, feeds, dwells and the
vacuum's ranges are set a value at a time. *Vacuum on* and *Vacuum off*
in the Machine panel and *Read vacuum* in the Head panel find the sensor's readings with the nozzle open and blocked
before `part_on`/`part_off` are set.

Feeders can be tape strips, trays (`columns`, `row_pitch`) or feeders
told to advance (`feed`, one line or several); one names its parts by
`refs` or by the words of `match`. The bottom camera's place on the machine
comes from its file, or *Camera is here* with the nozzle over it by
eye, or typed; *Center nozzle* measures it with the picture's scale, roll
and mirror (the file's `[up_camera] roll` and `mirror` stand until then),
then *Measure runout*: the tip is found at six turns of the
nozzle, its runout made up for at every look and place, and a nozzle that
turns the other way for the file's `rotation_cw` says so. Parts of a
feeder marked `vision = true` are looked at over the camera turned to the
angle they go down at: their offset, size and angle are checked, the
angle corrected, and they are placed where their center lands.

The top camera (on the machine's head, looking down, `[top_camera]` in its
file) is set up in its Top camera panel on the Cameras page: pick it
and press *Start* on the Top camera view (Run), jog the nozzle's tip
onto a mark it can see (a dot on paper, a hole) and press *Nozzle on
mark*, then *Measure offset*: the head moves so the camera should see the
mark (by the file's `offset`, or from where it stands when there is
none), measures the picture and centers the mark. *Home by fiducial*
in the Machine panel
(with `home_fiducial` in the file's `[top_camera]`, which the OpenPnP
import reads from the head's homing fiducial) homes the machine, then
finds that fiducial on the bed with the top camera, centers it, and
declares where the head is (G92) so the numbers put the fiducial where
the file says: the switches find home to a few hundredths, the fiducial
ties the numbers to the bed itself. *Find home fiducial* does the same
with no home first, from where the numbers put the fiducial now: a check
after a long run or a knock, quicker than a home. The Steps panel's Home step
offers it on a machine whose file names the fiducial. *Find fiducials*
under *By references* (or
*find fiducials first* on a run) fits the board on its fiducials,
footprints FID* or named Fiducial, from where the references put them.
A board with no references at all is found under the Board place panel's
*By camera* with the top camera picked (Looking for the board, above): *Look for
board* with the board's job picked, *Search* (over a box drawn on the top
camera's picture, or where corners taken put the board), then *Use as
board place* keeps where the looks put the board (else where the corners
put it) as two references (the two parts furthest apart), which *Find
fiducials* then makes exact. The Board panel's drawing shows where each guess
says the camera's picture lies on the board, green once found. A
feeder with `pocket` has each pocket looked at before its pick (an empty
one is passed over), one with `marks` has its marks found once a run and
its places moved to follow them.

The *Machine view* panel (Setup side, Cameras page) draws the machine from
above in its file's X and Y: the head's reach (`[motion] travel`), the
bed boards lie on (`[top_camera] bed`), the board area, the head with
what the top camera sees, the board where its look put it and the stops
of the newest search or scan. A drag on it sets the board area (cut to
the bed), *Board near it* or *only within it* says which, and *Save*
writes `board_area` and `board_area_only` into the file: near, a search
with nothing known looks there first and then over the rest of the bed;
only within, it never looks outside. *Clear area* and *Save* take them
out again, and with none the whole bed is searched. *Add picture* (a
photo of the machine from above) and *Add model* (an STL, drawn from
above) put a picture of the machine under the drawing, kept with the
machine file; *Drag sets* picks the box either is drawn over, by default
the travel for a picture and its own coordinates for a model.

With `part_on` in the file's `[vacuum]`, a pick that holds nothing, a
part not on the nozzle over the bottom camera, one off by too much or of the
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
in the Feeders panel lists the feeders that answer, by address and id.
Feeders picked in the panel's list (a press picks one, Shift a run of
them, Ctrl or Cmd adds or drops one) turn it into *Scan N picked*, which
looks for just those, each by its id, and names the ones that did not
answer. A
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
LumenPnP with nothing attached, so placing parts can be tried end to end.
It takes G-code on `socket://127.0.0.1:2327` as Opulo's Marlin does:
moves take the time their feed gives them (`--fast 4` four times
quicker), M400 waits for them, M410 stops the head where it is, M114
reports, the ring light and the fans switch, and the vacuum sensor behind
the I2C mux reads as a LumenPnP's: about 254 with the pump off, 251 with
the nozzle open, 231 with a part on it. Three Photon feeders answer on
the bus (addresses 1 to 3; the program prints their ids for `bus_id`).

Connect *Virtual LumenPnP* (`machines/virtual-pnp.toml`) in the Connection panel.
Its file gives the bottom (up) camera the device
`http://127.0.0.1:2328/snapshot` and the top camera
`http://127.0.0.1:2329/snapshot`, size 640x480, which the cameras take as
it connects (start the backend with `SPINNY_CAMERA_PORTS="2325 2326 2328
2329"` to see them in the cameras list too). pcbv reads them as it reads
a Pi's camera.

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
  fiducials*, and the file's homing fiducial, a bright dot on a dark
  5 mm square (a bright dot on the bright bed alone was too faint for
  pcbv to find). Its offset is a few tenths off the file's.
- A home (G28) leaves the virtual head 0.2, -0.15 mm off the place its
  numbers say (`--home-error DX,DY`), and G92 changes the numbers, not
  the head, so *Home by fiducial* has something to find.
- `--skew 0.0023` puts its axes out of square as a real LumenPnP's are
  (the head stands at X + 0.0023 Y), for the file's `[motion] skew` to
  take out; its Marlin knows no M852, as the stock Lumen build, unless
  `--skew-gcode` builds it in for `skew_by = "firmware"`.
- With the light off both pictures are dim.

A spot is read from a picture taken after it was asked for: a snapshot
camera asked a few times a second would otherwise show the head where it
was before the move.

### The Assistant

The *Assistant* panel in the Job area is a conversation with a language model that works through
the backend's own tools. Ask for a job ("a 20 mm square with a 5 mm hole
in the middle, three passes at 300"), a Draw operation (drill these
points, face this rectangle), markers, a placement plan, or about what is
there ("which jobs are for the mill?"). The answer comes in as it is
written; each tool call is a folded line with its name, its arguments and
a short result (*running* until the call is done), and unfolds to the
whole. A job it makes or changes shows in the Job area at once.
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

The Assistant's model, and any MCP client given `spinny-mcp`, works
through one set of tools. They make, change and read data, and nothing
else: jobs (combined jobs among them), jobs of Draw operations (one operation, or a
list of them, such a job's list replaced in place), markers, the pick and
place machine's references and plans, and CAM jobs are made and changed;
`delete_job` takes a job out, which its description keeps to a job the
operator asks to delete or one the model made by mistake; the state, the machine
files (G-code machines' among them), the CAM profiles and the cameras'
recorded board searches are read, so a model can say where a search went
wrong. Plugins for the page are listed, read, written and deleted, and a
plugin written is always off: no tool turns one on, which only the
Plugins panel does. No tool
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
table is wherever it was clamped. The Board place panel's *By marks*
fold (Run area) pairs points of the job
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
  two, far apart, do without the roll. Once enough of the camera's looks
  agree on the board (Looking for the board, above), *Capture* takes
  their agreed place and turn instead of the newest picture's.

With three marks or more the fit line also gives the board's stretch:
its X and Y scale and its shear (degrees off square), each with how sure
the marks make it, fitted as the probability over the board's pose fits
them (a fab's tolerance as the starting doubt, so a few marks cannot
claim a large stretch). A mark far off the rest is taken as a wrong one
and counts for nothing; the line says how many. The stretch is reported,
never applied. With the head camera's look on *Probability over the
pose*, the marks made with the tool and the features *Center features*
centered are evidence the look weighs too (the camera's own captures are
not, being the look's own place).

*Apply* moves the job and clears the marks. Check the result in the
preview, and probe the pads or tie the height map after a large move,
since the map is in board coordinates too.

### Picking a run up where it stopped

A run that stopped short, this session's or an earlier one's, shows a
*Resume from line* row under its job with the count of lines done filled
in. The backend writes `var/resume.json` as a run goes, so the count
survives the host as well as the controller.

1. If the controller lost its position (it was powered down, or reset
   while moving), tell it where the head is first: *Here is* in the
   Machine panel (under the jog's *More*) declares the joints without moving them, and *Last known* fills
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
   contact and a tie only remeasures the frame. The Height panel's
   *Runs follow* says how the pickup follows the board; untouched, it
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
can be homed: *Home* in the Machine panel's head, or `home`, `home R` or `home R+`
in the console, finds the switch and declares the axis to read
`home_pos` there. The cycle, and the halt `endstop_halt` asks for, are
in [PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md#endstops-and-homing). The readout's *Homed*
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

### Servos

A servo the machine file fits (`[servo.1]` to `[servo.4]`, on a pin of
the board or a channel of a PCA9685; [MACHINES.md](MACHINES.md#servos))
gets a bar in the Machine panel, below the axes: its number and name with
the angle it holds, or *off* while it has no pulse; a button for each of
its named positions; a field for any angle in its range with *Go*; and
*Off*, which takes its pulse away so it stops holding and can be turned
by hand. A move waits for whatever motion is queued before it, and is
refused while a job runs, the board is probed or a camera routine moves
the head. At the console, `servo N1 A90` moves servo 1, `servo N1 off`
lets it go, and the status line's `S` field says where each one is
([PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md#servos)).

A servo stays where it is through a hold, a stop, a reset and a
disconnect, and goes to its `start` angle at power on (none, and no
pulse, unless the file gives one). The pins, the channels and the
PCA9685's bus are read when the board starts, so after *Write to board*
changes one, restart the board. The first time, set a servo's `min_us`
and `max_us` with nothing attached to it, or with its arm free: a span
wider than the servo's own drives it against its stop at the ends. With
a PCA9685, the console says at boot whether the chip answers
(`[MSG:servo pca9685 0x40 on GP0 GP1 ready]`, or `not answering,
retrying`); the wiring and the supply are in
[rp2040/README.md](https://github.com/tmpk13/spinny-firmware/blob/main/rp2040/README.md#servos) of spinny-firmware.

### When the machine goes quiet

The backend gives a machine up after 3 s without an answer to its status
polls, fails the run with that reason, and with `--connect` tries again
every few seconds. What to read, in order:

1. The console's *Log* (or `var/spinny.log`): the `link ... closed` line
   says how long the link had been open, how many lines were sent and
   unanswered, when the machine was last heard and what it last said,
   and its last status report. `machine: boot ...` lines say why the
   board started every time it was connected (the reasons are in
   [PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md#diagnostics)). The board says
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
[PROTOCOL.md](https://github.com/tmpk13/spinny-firmware/blob/main/docs/PROTOCOL.md#diagnostics).
