# CAM profiles and the carve kernel

## CAM profiles (2026-10-05)

A profile is TOML in cam/ (axes with roles, tools with cutting settings,
operations in order, the post, the placement), read by spinny_laser.cam
with the same one-error style as the machine files. The first target is a
standard three axis mill with its own grbl-style sender, so the output
that matters there is gcode: spinny_laser.post writes it from the axis
roles (x, y, depth, setup; radius and angle hand a polar profile to the
old grblHAL writer with controller=joint), and mills exactly the way the
backend's Streamer._spindle_pieces streams a milled group (safe height,
spin-up dwell, rapid, plunge, cuts, lift, pass k of n at depth k/n), so
a job that runs on the firmware machine and the program for the mill are
the same cuts. The job model got a `tool` per group ("laser" or
"spindle"); Streamer.check_job refuses a group made for the other tool,
but only at the run (the runner calls it), not in the estimate, so a mixed
job still gets stats and the refusal says which groups to switch off.
Drills are paths of one point: the spindle streamer and the post read
those as a peck (go, plunge, lift), the laser streamer skips them, and
the preview draws them as a dot (round cap on a zero length stroke).

Editing from the page keeps the file hand-written: tomllib has no writer
and tomlkit would be a dependency for one job, so cam.set_value patches
the text line by line (find the table by its header, the key by a regex,
replace the value up to the comment, append a missing key at the table's
end, parse the result and read the value back). The mock has a TypeScript
twin (mock/cam.ts, mock/toml.ts, a subset reader) so the page can be
developed on ?mock=1; the shipped files are imported as text at build
time, which keeps the mock's profiles the shipped ones. Bun serves one
module per path: importing the same .toml twice, once plain and once
with { type: "text" }, gives both imports the first loader, so the test
compares the subset reader with Bun.TOML.parse on the text instead.

A board upload for the CAM takes several files in one request (the copper
gerber, Edge.Cuts and the .drl), written into one temporary folder so the
geometry engine finds the siblings as it does on disk; the plain
/api/jobs upload still takes one file. The isolation plan places the
board once around everything cut, and the drill centers follow the shift
read back from the placed copper, since isolate.build returns the moved
copper but not the shift.

## 3D models: the carve kernel (2026-10-29)

- Kernel in Rust, run as a subprocess like `pcbv` (not a PyO3 module): the
  Pi deploy runs `uv sync`, and a maturin member would need cargo there
  for every sync; a missing binary only loses the 3D path.
- Polygons with clipper2-rust (a pure Rust port of Clipper2, no C++ build).
  Integer grid at 0.1 um. Offsets drawn at half the chord tolerance: a run
  along a round join's chord comes the full arc tolerance into what it
  skirts, plus rounding, and the gouge check saw it.
- The shadow at a level (everything above it) is the section at the level
  plus the projections of the down-facing faces in the slab above it; for a
  closed mesh a vertical line through the solid leaves it through one of
  those, so an overhang between two levels is never missed. Sections are
  "strictly above z", so a floor at exactly the level is not in its own
  shadow.
- Gouge measure: drop cutter height minus the move's z with the tool
  narrowed by the tolerance (a shape inside the tool, same tip). With the
  full tool, a side touching a vertical wall at its radius reads as a cut
  the wall's height deep.
- Links: a stock height map is cut down as moves are written (a sloped move
  in short pieces, each at its higher end, so the map never shows less
  material than is there). A link rises to the highest material under the
  tool along it plus 1 mm, only inside the operation's area (clamps sit
  outside it); else the path ends and the machine's travel height takes it.
- Helix ramps go a whole number of turns so the cut ends where it began and
  the op's next start (nearest point on the next loop) stays right.
- Rough boundary: the band round the model, clipped to the block grown by
  radius minus stepover, so the outer loop still takes a stepover off the
  block's edge and never cuts only air past it.
- Enabled model ops are planned in one request (later ops see what earlier
  ones cut); a disabled one alone on the whole block, so enabling it later
  is safe. Disabling an earlier op after the fact is not.
- The firmware's `cut` F is the board speed: a move that also rises or
  falls is sent `F * run / length` so the tool's speed along it is the feed.
- Feeds: when the plane's rate holds the feed, the rpm comes down with it
  to keep the chip load (rubbing melts POM, welds aluminum).
- Timing (debug build at opt-level 2, 8 cores): a 161,600 triangle wavy
  surface 40 x 30 mm plans rough 2.0 s, parallel 4.9 s, waterline 1.5 s; a
  drop cutter query is about 23 us there (a box reject before the contact
  tests took it from 58 us). The rest of the parallel time is the stock
  map's sweep of sloped moves in cell-long pieces; an exact sweep of a ball
  (a capsule round the segment of centers) would cut it if needed.
- Cuts that take nothing are skipped (rest machining for free): the check
  looks within the tool's radius less two tolerances, not a cell past it
  as the link heights do, or every loop along a finished wall sees the
  wall in the stock map and is kept.
- Gaps the rough cannot enter: the model's outline closed by the tool's
  reach (so notches count), minus the level's shadow, in pieces; a piece
  the tool's sweep never touches is named once, at its highest level.

## The kernel after the bug sweep (2026-11-09)

- A stay-down link that goes down into stock crosses at the tool's
  height and comes down the next cut's helix or zigzag (or plunges a
  sliver at the plunge rate): it fed straight down through a step of
  fresh stock at the cutting feed. Level, rising and through-air links
  still feed straight. The plate's rough and walls got about 18% longer.
- `clean()` and the gouge check sample a move per check step of its run
  and per tolerance of its height change, with the gouge check's tool:
  steep waterline links were checked at their ends only and cut up to
  0.05 mm into curved walls. Some V-bit passes over steep ridges are now
  refused where they really gouge; avoiding that needs a better `refine`.
- Quarter and half turns use exact sines and cosines (within 1e-12 of 0
  or 1), so flat faces stay flat; the 1e-9 grid snap is gone.
- The rough's loops are spaced at the stepover or the tool radius less
  two tolerances, whichever is smaller, with a note when capped: a
  stepover over the radius left full-height ridges between loops.
- Sections are oriented by the triangles' winding and filled nonzero, so
  overlapping bodies add up; a shell sunk into another still gets a false
  undercut note, and a doubled mesh the open-edges note.

## Bits, heights and comments in the post (2026-11-09)

- CAM groups carry `tool_id` and `tool_name`. The post stops between two
  bits with M5, a rise to the safe height, a comment naming the next bit
  and M0 (not M6 Tn: every grbl-style sender pauses on M0), with a report
  warning; the shipped mill-3axis profile ran isolation, drills and the
  outline in one program with the V bit fitted. A run cannot pause for a
  bit, so `Streamer.check_bits` refuses a milling job of more than one
  bit, naming the groups to switch off. A group with no bit (Plot jobs,
  drawings, imports) cuts with whatever is fitted; laser tools never stop
  the program; the first bit is not named (CAM.md step 1 says to fit it).
  Regrouping keeps a group's bit and refuses to mix two bits in a group.
- A stored laser group keeps its operation's `height`, which the export
  writes (it took the first laser tool's height for every group).
- Comments fold control characters and U+2028/U+2029 into spaces: a
  newline in a name or label became an executable gcode line.
- An export with nothing enabled is refused, as a run is; the polar
  writer refuses a model's group instead of skipping it; milled and model
  groups rise before the spindle starts; the polar footer comes after the
  writer's own end (its M2 came before the return home).
- The mock post follows post.py line for line against
  web/backend/tests/data/cam-post-samples.json (`mise run cam-fixture`),
  Python's round-half-even included; the fixture found a rapid from a
  coordinate of exactly 0 counted no time in post.py.
