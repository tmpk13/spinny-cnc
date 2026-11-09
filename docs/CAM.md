# CAM profiles

A CAM profile is a TOML file in `cam/`: the machine's axes (which letters
carry the board plane or the polar pair, which one is the depth, which are
parked before the cuts), the tools on it (a laser, or a spindle with its
bits) with their cutting settings, the operations a design goes through
(isolation, copper clearing, the outline, the drills, a deposit, a
design's own paths, or a 3D model's rough, waterline and parallel passes)
with every setting of the cut, the materials a block may be, and how the
gcode is written. The files are meant to be edited by hand or by a language model:
every key is commented in the shipped files, a file is read whole and
refused whole with the table and the key named, and the page edits one
value at a time without touching the rest of the text.

| Where | How |
| --- | --- |
| Web page | the *CAM* tab: pick a profile, read its axes, tools and operations, change a cutting setting in the table or the whole file in the editor, pick the block's material, drop a design or an STL model to make a job, *Export gcode* to download the program for the profile's controller |
| Backend | `GET /api/cam`, `GET/PUT/PATCH/DELETE /api/cam/{id}`, `POST /api/cam/{id}/jobs`, `POST /api/cam/{id}/gcode` ([WEB_API.md](WEB_API.md)); `spinny-web --cam DIR` reads another directory |
| Command line | `uv run spinny-cam cam/mill-3axis.toml board.kicad_pcb` writes `var/out/board.nc` and a report beside it; `uv run spinny-cam cam/mill-3d.toml part.stl` for a model; `mise run cam -- PROFILE DESIGN` |
| Code | `spinny_laser.cam` (the schema and the text patch), `spinny_laser.camjob` (a design through the operations), `spinny_laser.post` (the gcode), `spinny_laser.carve` (runs the 3D kernel in `carve/`); the page's mock reads the same files with `web/frontend/src/mock/toml.ts` |

The shipped files: `mill-3axis` (a standard X/Y/Z mill with a spindle,
gcode for a grbl-style controller), `mill-3d` (parts out of a block after
an STL model on the `cartesian-mill` machine file, with aluminum, POM,
acrylic, HDPE, wood and brass), `cartesian-laser` (a laser on an X/Y
machine, grbl laser mode) and `polar-laser` (this machine: its jobs run
through the backend on the `polar-laser` machine file, and its gcode is
joint-space X and A for a controller that takes the two as linear axes).
Copy the nearest, name it, and change what differs; or type a new id on
the page and press *New*, which saves the text shown under that id.

## A board on a three axis mill

1. Zero the work coordinates with the first operation's bit touching the
   copper at the board's lower left corner. The profile's `[placement]`
   is `corner`, so board X 0, Y 0 is there and the surface is Z 0; the
   depth axis' `offset` can hold another Z for the surface. The outline
   is milled outside the board's edge, so the end mill goes about its
   radius past X 0 and Y 0 (the shipped axes' `min = 0` warns of it):
   leave stock there.
2. Drop the KiCad board on the CAM tab, or the copper gerber together with
   its `Edge.Cuts` gerber and its drill files, the plated and unplated
   holes' (`-PTH.drl` and `-NPTH.drl`), or the one `.drl` (one drop,
   several files). Every `.drl` whose name starts as the board's does is
   read. The notes under the drop say what was left out: no drill file,
   another board's drill file, no outline, holes narrower than the drill.
3. Read the job in the preview, and in the *Jobs* panel switch off what
   should not run this time (the clearing is off in the shipped file).
4. *Export gcode*. The report gives the lines, the cut length, the time
   and what each axis reaches; a reach past an axis' `min` or `max` is a
   warning, and so is a feed over an axis' `rate`, which is written at the
   rate, and every stop to change the bit. For an air cut first, raise
   the depth axis' `offset` by the height of the air and run the same
   program.
5. Run the file on the mill's own sender. The program starts by rising to
   the safe height, parks any setup axis, then for every operation starts
   the spindle (`M3 S`, a `G4` spin-up), and mills each path as a rapid at
   the safe height to its start, a plunge at the plunge rate, the cuts at
   depth and a rise, pass by pass down to the depth. Before an operation
   cut with another bit than the one before it (the shipped file's drills
   and outline), it stops the spindle, rises to the safe height, names the
   bit in a comment and pauses (`M0`): fit that bit, zero Z with it as in
   step 1, and resume. It ends with the spindle off, the tool up, the X/Y
   home, the Z home, and the footer.

## A part from a 3D model

1. Export the part as an STL from the CAD program, in mm (a model drawn in
   inches takes `[model] scale = 25.4`). The face to be cut looks up:
   *Model* on the CAM tab (or `[model] turn`) stands it otherwise. A part
   needing both faces is two jobs, the second with the part turned over.
2. Pick `mill-3d`, and in the *Stock* row the block's material, how much
   bigger than the model it is round the sides (*Margin*) and over the top
   (*Over the top*), or give `[stock] size`. The material works out every
   tool's rpm and feed (below); a tool or an operation that gives its own
   keeps them.
3. Drop the STL. The notes give the model's size and the block's, the
   feeds each operation took, the material's note, and what to look at: an
   undercut (faces looking down above the bottom, which a tool from above
   cannot reach), an open mesh, a cut deeper than a tool's `length`. The
   preview draws the paths at their depth under the block's top.
4. Clamp the block outside the band the rough clears round the part (half a
   tool past the finish, or `band`), zero X and Y at the block's lower left
   (`anchor = "corner"`) and touch the tool off on the block's top: Z 0 is
   the block's top. For an air cut first, touch off a few mm above it.
5. Run it on the mill from the *Jobs* tab, or *Export gcode* for another
   controller. The operations were planned in order, each over what the one
   before left, so run them in that order and skip none; one switched off
   in the profile is planned alone on the whole block, which is safe to
   turn on later. A run from the *Jobs* tab cannot stop to change the bit,
   so operations of several bits (the surfaces' ball end mill between the
   end mill's rough and walls) are run a bit at a time, the others
   switched off; the exported gcode stops for each change.

What the operations cut:

| Source | Cuts |
| --- | --- |
| `rough` | level by level from the block's top, every `step_down` and at every flat face (lifted by `leave_floor`), down to the model's bottom less `below`: the area the tool may be in at that height, `leave` and its radius away from everything of the model above the level, cleared with loops `stepover` apart from the inside out (the tool's radius apart at most: farther, the middle of a wide area would stand, and the notes say the loops were brought closer); inside the block and a `band` round the model, never the whole block. Each piece of a level is followed down through the pieces under it before the next. |
| `waterline` | a loop along every wall at each level, the tool's radius plus `leave` from it, climb milling unless `direction` says otherwise; with `step_down = 0` only at the flat faces and the bottom, a full depth pass on light stock |
| `parallel` | lines `stepover` of the diameter apart at `angle` degrees from X, the tool dropped onto the mesh along them (flat, ball, bull nose or V bit), back and forth, over the model's outline and `band` past it: the finish for slopes and curves |

A cut that would take nothing, because an operation before it already
took that material, is left out (the notes count them). So a second rough
with a smaller tool after the first only goes into the corners, holes and
slots the first could not reach: rest machining, by adding an operation.
The rough names every gap in the model narrower than its tool (a hole, a
slot, a notch in the outline) with its place and size; drill it, or add
that smaller tool.

The tool comes down into a cut on a ramp no steeper than `ramp` degrees:
round a loop, a whole number of turns, or back and forth along the start of
a line; a sliver of material, or `ramp = 90`, is plunged. Between cuts it
rises only to just over the material left (1 mm over a stock height map
the kernel cuts down as it writes the moves), and only within the area the
operation cuts; anything farther, or a path's end, goes by the travel
height. Before a job is made, every move is checked against the model with
the tool's true shape, and a toolpath that would cut into it is refused.

Rough and waterline treat the tool as a cylinder its full width from the
tip up: exact on vertical walls, stepped on slopes, which a parallel pass
with a ball finishes. Floors come out at their height when `leave_floor` is
0 (the shipped rough); the walls take the waterline.

A level at the model's bottom cuts the part free, so that level belongs to
the last operation. The shipped profile's rough stops at `below = -0.3`,
a 0.3 mm skin that holds the part through the rough and the surfaces, and
its waterline goes last with `below = 0`, cutting down through the skin
round every wall. A through hole wider than two tools keeps a disc of skin
in its middle, which comes loose then. Put the block on a spoilboard or
tape, or give the waterline a negative `below` too and cut the skin by
hand after.

### Feeds and speeds

A material gives the cutting edge's `speed` (m/min) and the chip a tooth
takes by tool diameter (`chip_load`). For each mill:

- rpm = speed * 1000 / (pi * diameter), held to `[spindle]` min and max;
- feed = rpm * flutes * chip load at the diameter;
- a feed over the slower of the X and Y `rate` is held there and the rpm
  brought down with it, so the chip stays the same: a tool that spins fast
  and moves slowly rubs, which melts plastics and welds aluminum to the
  edge;
- plunge = feed * the material's `plunge`, held to the depth axis' rate.

A rough also takes the material's step down and stepover (of the
diameter), its ramp and its `leave`. The shipped numbers are a careful
start for a light machine: run an air cut, then cut scrap, and raise the
chip load before the speed.

## Schema

Every key is optional unless marked; what a file leaves out takes the
default written beside it. Numbers are checked against the bounds given,
an unknown key is refused with the table named, and a file is taken all
or nothing.

```toml
name = "3 axis mill"            # shown on the page; default: the file name
description = "..."
machine = "cartesian-mill"      # the machines/ file whose firmware runs these jobs
                                # through the backend; left out, the gcode is all

[[axes]]                        # one table per axis, in the order the words are written
letter = "X"                    # needed: one letter
kind = "linear"                 # linear | rotary; the angle must be rotary, the others linear
role = "x"                      # needed: x | y | depth | radius | angle | setup
                                #   x and y: the board plane (a cartesian machine)
                                #   radius and angle: the polar pair (a polar machine)
                                #   depth: the axis the tool goes down; optional, a spindle needs it
                                #   setup: parked at `park` before anything moves
min = 0                         # travel; a program past it is written with a warning
max = 300
rate = 1500                     # units/min: the fastest feed; a cut over it is capped
rapid = 3000                    # units/min for G0, for the time estimate
offset = 0                      # machine coordinate of board 0 (of the surface, for the depth)
home = 0                        # where the program ends; left out, the axis stays
safe = 5                        # depth axis only, needed there: travel height over the surface
park = 0                        # setup axis only

[[tools]]
id = "vbit"                     # needed: letters, digits, - and _
kind = "mill"                   # needed: mill (a spindle) | laser
name = "30 degree V bit"
diameter = 0.2                  # a mill, needed: the width of the cut, mm (`spot` for a laser)
shape = "flat"                  # a mill: flat | ball | bull | vee; vee when angle is given
# corner = 0.5                  # a bull nose: the radius of its rounded corners, mm
flutes = 2                      # a mill: for the feed a material works out; default 2
# length = 12                   # a mill: how deep under the block's top it reaches, mm
# angle = 30                    # a mill V bit instead: the included angle of its point, degrees; the
# tip = 0.1                     # width of its tip, mm. The cut is then tip + 2 * depth * tan(angle / 2),
                                # as wide as each operation's depth makes it, and `diameter`, if given,
                                # is the shank that bounds it
rpm = 12000                     # a mill, needed unless the stock has a material: S
feed = 300                      # a mill, needed unless the stock has a material: mm/min along the cut
plunge = 60                     # a mill: mm/min into the cut; default 60
step_down = 0                   # a mill: mm per pass, 0 is the whole depth at once; default 0
stepover = 0.4                  # a mill: of the diameter, between clearing strokes; default 0.5
depth = 0.1                     # a mill: default depth for its operations; default 0.1
# a laser instead: spot (needed), power (needed, S), min_power (the floor the
# firmware's dynamic mode slows down to), speed (needed, mm/min), passes,
# height (where the depth axis holds the beam in focus; left out, not moved)

[[operations]]                  # in cutting order
name = "isolation"              # needed, one of a kind
source = "isolation"            # needed: isolation | clearing | outline | drills | deposit | paths
                                #   | rough | waterline | parallel (a 3D model's, with a mill)
tool = "vbit"                   # needed: a [[tools]] id
enabled = true                  # false keeps the group in the job, switched off
depth = 0.1                     # any cutting setting of the tool's kind, given here, wins here
passes = 2                      # a mill: overrides the count from depth / step_down
loops = 1                       # isolation and deposit: loops around (or inside) the copper, 1 to 50
pattern = "lines"               # clearing: radial | rings | lines
fill = "contour"                # deposit: contour | radial | rings | lines
marks = "circle"                # drills with a laser: circle | cross | dot
match = "red"                   # paths: a part of the imported paths' label (an SVG stroke, a gcode S and F); "" takes all
leave = 0.2                     # a model's: mm left on the walls; leave_floor on the floors (default leave)
ramp = 3                        # a model's: degrees, the steepest entry; 90 plunges
band = 1.5                      # a model's: mm past touching the model the tool goes round it
below = 0                       # a model's: mm under the model's bottom the last level reaches, < 0 a skin
direction = "climb"             # rough and waterline: climb | conventional
flats = true                    # rough and waterline: a level at every flat face
angle = 0                       # parallel: degrees from X of the lines

[post]
header = ["G21", "G90", "G94", "G17"]
footer = ["M5", "M2"]
spindle_on = "M3"               # M3 | M4, with S on the same line
laser_on = "M4"                 # M4 scales the beam with the speed, M3 holds it
spinup = 2                      # s after the spindle starts or changes speed, 0 to 600
decimals = 3                    # 1 to 6
return_home = true              # G0 to each axis' home at the end

[[materials]]                   # what a block may be, for a model's operations
id = "aluminum"                 # needed
name = "6061 aluminum"
speed = 150                     # needed: the cutting edge's speed, m/min
chip_load = [[1, 0.004], [3, 0.012], [6, 0.025]]  # needed: [diameter mm, mm a tooth], read straight between
depth = 0.2                     # a rough's step down, of the diameter; default 0.5
stepover = 0.3                  # a rough's stepover, of the diameter; default 0.4
ramp = 2                        # degrees; default 3
plunge = 0.3                    # the plunge rate, of the feed; default 0.3
leave = 0.2                     # mm a rough leaves; default 0.2
note = "..."                    # shown with every job made from it

[stock]
material = "aluminum"           # a [[materials]] id: the rpm and feed of every mill that gives none
margin = 3                      # mm of block round the model in X and Y; default 2
top = 0.5                       # mm of block over the model's top; default 0
# size = [50, 40, 6.35]         # the block instead: the model in its middle, on its bottom

[model]
turn = [0, 0, 0]                # degrees about X, then Y, then Z, before anything else
scale = 1                       # 25.4 for a model drawn in inches

[spindle]
min = 0                         # rpm; a material's rpm is held inside min and max
max = 24000

[placement]
anchor = "center"               # center | corner | keep: the middle on the origin, the lower
                                # left on it, or the design as drawn (a model's block)
offset = [0, 0]                 # mm, added after the anchor
layer = "F.Cu"                  # the layer a KiCad board is read from: a copper layer, or
                                # F.Paste with a deposit operation for a solder paste stencil
mirror = "none"                 # none | x | y: flips the layer, for a bottom layer cut through;
                                # a back layer (B.Cu) cut with none is noted, since with the board
                                # turned over its copper as drawn lies mirrored (x flips it)
```

A spindle operation's passes are `ceil(depth / step_down)`, each pass a
step deeper and the last at the depth, which is how the web backend
streams a milled group (pass k of n at `depth * k / n`); a laser's passes
go over the paths again. A profile is refused when it has two axes of one
role (setup aside), no plane (x and y, or radius and angle), a depth axis
without `safe`, or a spindle depth that takes more than 100 passes.

## What an operation makes

| Source | From a board (KiCad, or a copper gerber with its siblings) | From an SVG, gcode or job file |
| --- | --- | --- |
| `isolation` | one group per loop around every copper feature, the first half a tool width out | nothing, noted |
| `clearing` | the copper left between the loops inside the outline, as strokes of the pattern a stepover apart (a laser: a spot apart), the tool's middle on or past the outermost loop; a tool wider than the isolation keeps its radius from the copper, and a gap narrower than it is left (noted) | nothing, noted |
| `outline` | the Edge.Cuts profile, its pieces joined where their ends meet, a cutout inside the board before the edge round it; a laser cuts on the line, a mill's bit runs its radius outside the board's edge and inside each cutout, so the board comes out the size drawn (a cutout narrower than the bit is not cut, and a piece that joins no loop is cut on its line, both noted) | nothing, noted |
| `drills` | a mill: a hole the bit's size is a path of one point, the bit put down at its center and lifted; a wider hole is milled round at `(hole - bit) / 2`; a slot along its middle, or as an inset loop; a laser marks each hole (`marks`) | nothing, noted |
| `deposit` | the copper itself: edge loops in from its edge, the fill, the traces narrower than the tool along their middle | nothing, noted |
| `paths` | nothing, noted | the design's paths whose label holds `match`: an SVG's strokes, a gcode file's runs at one S and F, a job's groups; within a group, whatever lies inside a closed shape is cut before the shape |

Every group carries the tool's kind (`tool` in the job): the web backend
refuses to run a group made for the other tool than the machine has, so
a job with laser and spindle operations is run twice, once on each
machine file with the other operations switched off. It carries the
tool's id and name too (`tool_id`, `tool_name`): the exported gcode
stops to change the bit between two, and a run, which cannot, refuses a
job whose enabled groups were made with more than one, naming the groups
to switch off to cut with the first bit alone. The job's `spot` is the
isolation tool's width, or the narrowest tool's. The placement is one
for the whole board, around the copper's loops, the holes and the drawn
outline at that width; a mill's outline cut runs its bit's radius outside
the drawn outline, past what the anchor places.

## How the gcode is written

A cartesian profile is written by `spinny_laser.post`: the two comment
lines, the header, `G0` to the safe height, the setup axes to their
park, then each enabled operation with paths. A spindle operation cut
with another bit than the spindle operation before it is preceded by a
stop: the spindle off (`M5`), the tool up, a comment naming the bit,
`M0`, and a warning in the report. A spindle operation starts the
spindle when its speed differs from the one running and dwells the
spin-up; a laser operation turns the spindle off, writes `M4 S0` (or
`M3`), moves the depth axis to its `height` when it has one (the
operation's, else the tool's), and cuts with `S` on every line that
changes it. Feeds and `S` are modal, written when they change. The end
is the output off, the tool up, the X/Y homes, the depth home, and the
footer. A laser's `min_power` has no gcode word and is left out with a
warning. A polar profile goes through the grblHAL polar writer in
`spinny_laser.gcode` (`controller = joint`: the radius on X, which the
radius axis must be named, the angle on the rotary letter, inverse-time
feed), laser operations only.

## Editing

`PATCH /api/cam/{id}` with `{"path": ["operations", 2, "depth"],
"value": 1.6}` changes that one line and keeps everything else, comments
included; a key that is not there is added at the end of its table, and
`null` takes a key out, so a cutting setting cleared on the page is the
tool's again. The table is refused when it is not there. The page's
operations table does its edits this way; the editor beside it saves the
whole text, which is checked before it is written and left as it was when
it does not read. A profile's id is its file name, lower case letters,
digits, `-` and `_`.

## The 3D kernel

A model's toolpaths come from `spinny-carve`, the Rust program in `carve/`
(`mise run build-carve`; `mise run test-carve` runs its tests on made up
parts). The CAM runs it once per job with one JSON request on its input:
the STL's path, `turn`, `scale`, the `stock` (margin, top, size, anchor,
offset), the `tolerance`, the `travel` height and the `clearance`, and the
operations (strategy, tool shape and size, step down, stepover in mm,
leave, ramp, direction, band, below, flats, angle). It answers the model's
size, flat faces, undercut area and open edges, the block, the model's
outline, and for each operation its levels, its paths of `[x, y, z,
kind]` moves, their length and how deep any comes into the model, or
`{"error": "..."}`. It is looked for as `SPINNY_CARVE` names it, then in
`carve/target` (the build changed last), then on PATH; a backend on a
Raspberry Pi needs it built there too.
