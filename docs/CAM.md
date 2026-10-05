# CAM profiles

A CAM profile is a TOML file in `cam/`: the machine's axes (which letters
carry the board plane or the polar pair, which one is the depth, which are
parked before the cuts), the tools on it (a laser, or a spindle with its
bits) with their cutting settings, the operations a design goes through
(isolation, copper clearing, the outline, the drills, a deposit, or a
design's own paths) with every setting of the cut, and how the gcode is
written. The files are meant to be edited by hand or by a language model:
every key is commented in the shipped files, a file is read whole and
refused whole with the table and the key named, and the page edits one
value at a time without touching the rest of the text.

| Where | How |
| --- | --- |
| Web page | the *CAM* tab: pick a profile, read its axes, tools and operations, change a cutting setting in the table or the whole file in the editor, drop a design to make a job, *Export gcode* to download the program for the profile's controller |
| Backend | `GET /api/cam`, `GET/PUT/PATCH/DELETE /api/cam/{id}`, `POST /api/cam/{id}/jobs`, `POST /api/cam/{id}/gcode` ([WEB_API.md](WEB_API.md)); `spinny-web --cam DIR` reads another directory |
| Command line | `uv run spinny-cam cam/mill-3axis.toml board.kicad_pcb` writes `var/out/board.nc` and a report beside it; `mise run cam -- PROFILE DESIGN` |
| Code | `spinny_laser.cam` (the schema and the text patch), `spinny_laser.camjob` (a design through the operations), `spinny_laser.post` (the gcode); the page's mock reads the same files with `web/frontend/src/mock/toml.ts` |

The shipped files: `mill-3axis` (a standard X/Y/Z mill with a spindle,
gcode for a grbl-style controller), `cartesian-laser` (a laser on an X/Y
machine, grbl laser mode) and `polar-laser` (this machine: its jobs run
through the backend on the `polar-laser` machine file, and its gcode is
joint-space X and A for a controller that takes the two as linear axes).
Copy the nearest, name it, and change what differs; or type a new id on
the page and press *New*, which saves the text shown under that id.

## A board on a three axis mill

1. Zero the work coordinates with the bit touching the copper at the
   board's lower left corner. The profile's `[placement]` is `corner`, so
   board X 0, Y 0 is there and the surface is Z 0; the depth axis'
   `offset` can hold another Z for the surface.
2. Drop the KiCad board on the CAM tab, or the copper gerber together with
   its `Edge.Cuts` gerber and the drill file (one drop, several files).
   The notes under the drop say what was left out: no drill file, no
   outline, holes narrower than the drill.
3. Read the job in the preview, and in the *Jobs* panel switch off what
   should not run this time (the clearing is off in the shipped file).
4. *Export gcode*. The report gives the lines, the cut length, the time
   and what each axis reaches; a reach past an axis' `min` or `max` is a
   warning, and so is a feed over an axis' `rate`, which is written at the
   rate. For an air cut first, raise the depth axis' `offset` by the
   height of the air and run the same program.
5. Run the file on the mill's own sender. The program starts by rising to
   the safe height, parks any setup axis, then for every operation starts
   the spindle (`M3 S`, a `G4` spin-up), and mills each path as a rapid at
   the safe height to its start, a plunge at the plunge rate, the cuts at
   depth and a rise, pass by pass down to the depth. It ends with the
   spindle off, the tool up, the X/Y home, the Z home, and the footer.

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
rpm = 12000                     # a mill, needed: S
feed = 300                      # a mill, needed: mm/min along the cut
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
tool = "vbit"                   # needed: a [[tools]] id
enabled = true                  # false keeps the group in the job, switched off
depth = 0.1                     # any cutting setting of the tool's kind, given here, wins here
passes = 2                      # a mill: overrides the count from depth / step_down
loops = 1                       # isolation and deposit: loops around (or inside) the copper, 1 to 50
pattern = "lines"               # clearing: radial | rings | lines
fill = "contour"                # deposit: contour | radial | rings | lines
marks = "circle"                # drills with a laser: circle | cross | dot
match = "red"                   # paths: a part of the imported paths' label (an SVG stroke, a gcode S and F); "" takes all

[post]
header = ["G21", "G90", "G94", "G17"]
footer = ["M5", "M2"]
spindle_on = "M3"               # M3 | M4, with S on the same line
laser_on = "M4"                 # M4 scales the beam with the speed, M3 holds it
spinup = 2                      # s after the spindle starts or changes speed, 0 to 600
decimals = 3                    # 1 to 6
return_home = true              # G0 to each axis' home at the end

[placement]
anchor = "center"               # center | corner | keep: the middle on the origin, the lower
                                # left on it, or the design as drawn
offset = [0, 0]                 # mm, added after the anchor
layer = "F.Cu"                  # the copper layer of a board
mirror = "none"                 # none | x | y: flips the layer, for a bottom layer cut through
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
| `clearing` | the copper left between the loops inside the outline, as strokes of the pattern a stepover apart (a laser: a spot apart) | nothing, noted |
| `outline` | the Edge.Cuts profile | nothing, noted |
| `drills` | a mill: a hole the bit's size is a path of one point, the bit put down at its center and lifted; a wider hole is milled round at `(hole - bit) / 2`; a slot along its middle, or as an inset loop; a laser marks each hole (`marks`) | nothing, noted |
| `deposit` | the copper itself: edge loops in from its edge, the fill, the traces narrower than the tool along their middle | nothing, noted |
| `paths` | nothing, noted | the design's paths whose label holds `match`: an SVG's strokes, a gcode file's runs at one S and F, a job's groups |

Every group carries the tool's kind (`tool` in the job): the web backend
refuses to run a group made for the other tool than the machine has, so a
job with laser and spindle operations is run twice, once on each machine
file with the other operations switched off. The job's `spot` is the
isolation tool's width, or the narrowest tool's. The placement is one
for the whole board, around everything that will be cut.

## How the gcode is written

A cartesian profile is written by `spinny_laser.post`: the two comment
lines, the header, `G0` to the safe height, the setup axes to their park,
then each enabled operation with paths. A spindle operation starts the
spindle when its speed differs from the one running and dwells the
spin-up; a laser operation turns the spindle off, writes `M4 S0` (or
`M3`), moves the depth axis to the tool's `height` when it has one, and
cuts with `S` on every line that changes it. Feeds and `S` are modal,
written when they change. The end is the output off, the tool up, the
X/Y homes, the depth home, and the footer. A laser's `min_power` has no
gcode word and is left out with a warning. A polar profile goes through
the grblHAL polar writer in `spinny_laser.gcode` (`controller = joint`:
the radius on X, which the radius axis must be named, the angle on the
rotary letter, inverse-time feed), laser operations only.

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
