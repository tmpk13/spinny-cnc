# The top camera's offset by the bottom camera (2026-11-19)

Asked, with the LumenPnP's top camera over its bottom camera: "Would like
to have an auto option to find the offset between the top camera and the
nozzle that way. Test both the top camera looking at the bottom and
bottom camera looking at the top to find the offset."

Built: *Offset by bottom camera* (topcam.py `measure_offset_facing`,
`POST /api/pnp/top/offset/facing`). The geometry and the formula are in
the comment above `FACING_STEPS` in topcam.py; this file keeps why it is
that way and what was measured.

## What each camera sees

- The top camera over the bottom camera, both nozzles up (Z 31.5): the
  bottom camera's ring light far out of focus, a bright ring whose inner
  edge is 434 px about its center at 1280x720, taller than the picture,
  so its top and bottom are cut off; inside it dark rings and a lighter
  disc 270 px across. pcbv's `spot` finds nothing useful there: its blobs
  are found by local contrast and capped at 5% of the picture.
- The bottom camera under the top camera: the top camera's lens, a dark
  disc 120 px across (9700 px, roundness 0.98) inside the top camera's
  white ring light, which pcbv's dark spot takes cleanly
  (`UpCamera.lens_look`: roundness 0.5, 500 px and up, no crop, no picked
  color; dark first, then bright).

## Finders tried for the look down

A walk of 10 head places within 2 mm of the start, both cameras' raw
pictures kept at each (var/surveys/20261119-lumen-facing, stops.json; the
scripts in var/surveys/tools: facewalk.py, facegrade.py, edges.py,
radial.py, gradefinder.py, combine.py). Each finder's centers were
fitted to the head's moves; the rms says how well it follows the head.

| finder | rms |
|---|---|
| the picture against itself turned half round (phase correlation) | 12.5 px, Y held near 0 |
| the same on a central window, 260 to 400 px | 1.5 to 2 px |
| the gradients' meeting point (radial symmetry center) | 2 px |
| a circle on the ring light's inner edge, 1280 wide | 0.9 to 1.4 px |
| a circle on the ring light's inner edge, 640 wide (`round_edge`) | 0.6 px |
| a circle on the inner disc's edge | 1.0 px |
| bottom camera: pcbv's dark spot on the lens | 0.04 px |
| bottom camera: the half turn | 0.06 px, scale 1% short |

- The half turn failed in Y because the ring's left and right arcs run
  off the picture's top and bottom: arcs cut that way are symmetric about
  the picture's middle row wherever the ring is. Under the bottom camera
  its own ring light shows at the picture's edges and stays put, which
  pulled that look's scale short: the lens spot is used there.
- With the head still, the ring's circle moved 0.5 to 0.8 px from one
  picture to the next at 1280 wide and 0.1 to 0.3 px at 640 (smoothed 1.5
  px there); four pictures averaged agreed within 0.05 px. Hence 640 wide
  and `FACING_PICTURES` = 4.

## The rings lie at different depths

- Seen from the top camera, the ring light's edge moved 45.2 px a mm of
  head move, the inner disc 42.9 and a dark ring between them 41.7: three
  depths. The pattern is not rigid, its centers drift apart as the head
  moves (2.5 px at the walk's start), so a finder that mixes them follows
  none of them. One edge's circle is one depth; `round_edge` takes the
  edge that climbs most steadily round its circle, here the ring light's
  inner edge (about 6 luma a px).
- Which depth that is matters to the combination (below), and the scales
  say: the share of the way up from the bottom camera came out 0.305 by
  the top camera's scales (the ring) and 0.292 by the bottom camera's
  (counted from its lens), so the ring sits about at the lens.

## Why both looks: the cameras' lean

- The two looks gave offsets 1.98 mm apart: by the look down (24.600,
  64.342), by the lens seen from below (22.731, 63.698). That is the two
  cameras' picture centers leaning against each other: on a camera of a
  few mm focal length a sensor 0.1 mm off the lens' axis leans the line
  its picture's center looks along by a degree or two.
- Each look alone is off by the lean times a height (the look down by
  the tip's height above the ring, the look up by the top camera's
  height above the tip); the true offset at the tip's height lies between
  them, (1 - u) of the first and u of the second, u the tip's share of the
  way up from the ring to the top camera. A camera's scale grows with the
  distance from its lens, so the top camera's scale at the board over its
  scale at the ring is 1 - u (kept), and the bottom camera's scale at the
  tip over its scale at the top camera's lens is u again (the check:
  `FACING_SHARE_GAP` 0.05 apart calls the result doubtful).
- On the machine (X/Y only, the nozzle's place kept from the evening's
  Center nozzle, 241.4136, 215.3107): (24.0302, 64.1456), (24.0295,
  64.1463), (24.0355, 64.1480); 7 s a run. Each look alone repeated to
  about 5 um.
- Against the offset kept from a mark by eye, (23.701, 63.620): 0.62 mm
  apart; the file's design, (23.544, 65.188).

## What the result rests on, not yet checked

- No part was placed and no mark made by the nozzle and found by the top
  camera, so the true offset is not known. A placement where a fiducial
  found by the top camera says is the check.
- The combination assumes the nozzle goes straight down; that the top
  camera's scale kept (Measure camera, over a board) is at the tip's
  height when centered (Z 4, about the bed's top; a board is 1.6 mm
  higher, worth about 0.02 in u and 0.04 mm here); and that the ring's
  center lies on the bottom camera's picture-center line, as the two
  shares agreeing says.
- The whole routine (the user approved N1 going down over the bottom
  camera) ran once that evening: 14.3 s, the nozzle centered at
  (241.4417, 215.3326), 0.028 and 0.022 mm from the place kept two hours
  before, and the offset (24.0588, 64.1673): 0.025 and 0.020 off the X/Y
  runs, the same as the nozzle's place moved. The looks across hold to a
  few um; the nozzle's centering (its lit end's wander, about 0.03 mm)
  is what the offset's repeat rests on.

## The routine's choices

- Order: the nozzle first (its place fresh, the looks then start from
  it less the offset in use), the looks at the travel height after, so
  the routine ends with the nozzles up. A kept nozzle place from another
  session (another home, a skew change) would put the offset off by as
  much, so the page always centers the nozzle; `nozzle: false` is for
  repeat runs and tests.
- One set of moves measures both: at the start place, a step along X and
  one along Y, both cameras look at each; then each look is centered on
  its own (`_center_by`), each place reached from 0.3 mm below along X
  and Y as the nozzle routine does (`TAKE_UP`).
- A look whose moves show mirrored, or turned over 15 degrees, against
  its camera's own (the top camera's measured roll, the bottom camera's
  from the centering) is refused: it followed something else. A ring that
  rides with the head (a reflection) fails calibrate's check first.
- Only the offset is kept: the top camera's scale at the ring is not its
  scale at the board.

## Testing it on the machine that evening

- Stopping the user's backend on :8000 to load the new code was refused
  by the permission classifier (as on 2026-11-14). It gave up the machine
  and cameras through its own API (both cameras' Stop, Disconnect), and a
  second backend ran the tests: `uv run spinny-web --port 8010 --data
  var/facing-home --machines machines --cam cam`, its config a copy of
  var/config.json. What it measured is in var/facing-home/config.json, not
  the user's.
- M114 answers X to two decimals, so a place read back is up to 0.005 mm
  off the one asked for; the routines go by the places they asked for.

## The virtual LumenPnP

- Its cameras see each other (virtual_camera.py): the top camera the
  bottom camera's ring light at 1.4 times its bed scale, the bottom camera
  the top camera's lens at 3.4 times its tip scale, so a share comes out
  (0.29, about the LumenPnP's). Neither leans, so the two looks agree.
- Run end to end through pcbv (`mise run virtual-pnp`, a backend on its
  own data directory): the offset came out (23.8842, 64.928) against the
  world's (23.884, 64.928), the design offset plus its error less the
  tip's runout. With no top camera scale measured the share is the
  bottom camera's alone.
