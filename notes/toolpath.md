# Laser jobs

## Per-layer minimum power

- Meaning: the LightBurn sense, a floor under the `dyn` scaling
  (`S * achieved / requested`), so corners and ramp ends still burn. It is
  not a per-layer `s_min`: that is a cutoff (below it the beam is off) and
  stays a machine setting applied after the floor.
- A new `cut` word `M`, not modal. `F` and `S` are modal and the host sends
  them on every line anyway; a modal floor would carry from a group with
  one into a group without it unless the host always wrote `M0`. Non-modal
  keeps old lines byte for byte and a reset has nothing more to forget.
- `M` above `S` is clamped to `S` in the planner (and by the host when it
  writes the line) instead of refused: `S` is modal, so the parser cannot
  always compare them, and a UI edit that lowers `S` below the floor
  should not start failing.
- A group's numbers are fields under its row, three to a line and
  wrapping (notes/views.md); the table they were, whose columns were
  squeezed to fit a 20rem side column, is gone.

## Copper clearing

- Three fills in `spinny_laser/clear.py`, all plain board paths so a later
  offset still works (only then the fill is no longer along the axes).
  Timed with the backend's estimate on `tests/data/board-F_Cu.gbr`
  (18 x 11 mm, 0.1 mm spot): at the firmware's default `a_rate` 400 deg/min
  radial 11.7 min, lines 45 min, rings 99 min; at 1080 deg/min 10.8, 17
  and 37. Near the axis anything that turns the table is capped by its
  rate (the crossover radius is F / a_rate, 57 mm at the defaults), and a
  radial stroke does not turn it at all, so radial is the fast one. The
  estimate leaves out acceleration: radial has the most strokes (1459),
  about 0.13 s each at 50 mm/s^2, a few minutes more.
- Spokes are nested by halving: the spacing at any radius stays between
  half a pitch and a pitch, so the dose varies up to 2x and the radial
  cut is ~1.45x the length of the others. A finer ratio cannot nest (an
  angular grid can only drop every other spoke), so it would cost ~3x the
  strokes for bands that each start and stop.
- Why rows cannot be fast here: a straight row at distance d from the
  axis needs the table at F d / r^2 rad/min, so it is table bound
  wherever r^2 < F d / a_rate. For rows along one direction that region
  is two discs of diameter F / a_rate (57 mm at the defaults) touching at
  the axis on either side of it; a board centered on the axis sits almost
  wholly inside them in any orientation. Only a stroke through the axis
  (a spoke) leaves the table still, and only the cross slide could run an
  off-axis row on one joint.
- Spokes since 2026-09-28: spaced by the exact far profile (per wedge, the
  farthest the area reaches, from its edges cut at the wedge rays) rather
  than one circle through the farthest corner, and each spoke starts where
  the gap between its coarser neighbors reaches a pitch. That rule keeps
  every gap within a pitch for any uneven spacing as long as the index
  keeps the ruler structure (between two spokes of one level there is a
  coarser one), which holds round the wrap because spoke 0 is coarsest.
  On the 28.5 mm test board (761b, 0.06 mm): burn 15128 -> 13632 mm.
- Spoke order: angle order with strictly alternating direction made the
  rail run back in the dark from each short spoke's inner end to the next
  long one's, 19 of 58 min. Now two orders are built and the one with less
  travel kept: once round with each spoke's direction chosen by a two
  state DP, and nearest end first by max(dr, dA * pace), pace = r_rate /
  a_rate. Nearest-first wins on big boards (it takes each level of spokes
  round in turn) and loses on small ones (stragglers cost a turn back),
  so neither alone is enough. 761b in a planner model with accel and
  junctions: 62.7 -> 48.4 min at 400 deg/min, lines 154.5; at 1080 deg/min
  62.1 -> 47.8, lines 62.1. Reversals (~0.13 s per stroke end at 50 mm/s^2)
  are now the largest overhead after the burn itself.
- The spoke gap search must stop when the reach stops falling, not when
  reach * gap <= pitch: (pitch / r) * r can round a hair above pitch and
  the loop then never ends.
- Rings are board polylines whose chords stay within half the chord
  tolerance, so the streamer sends each chord as one constant-R line (the
  exact arc) instead of subdividing it into a radius wiggle. They are
  clipped to the area shrunk by that half tolerance, because the arc bulges
  past the chord and a clipped end is put back on the ring.
- Clipper's open-path clipping leaves sub-micron pieces where a spoke
  grazes a corner; under the 0.001 mm R quantum they would go out as a
  lone `go`, so pieces under 1 um are dropped. Clipped spoke ends are also
  rebuilt on the exact ray: nanometre rounding tilted short spokes enough
  to change the A word.
- Beam centers stay `max(offsets)` from copper, the outermost isolation
  loop's own line, so a stroke end lands in the trench. A rounded offset
  is chords inside the true arc by up to the curve tolerance (2 um), the
  same as the loops themselves. A CAM clearing tool wider than that
  (an end mill after a V bit) keeps its middle its own radius off the
  copper instead, with a note: at `max(offsets)` its edge cut into every
  trace beside the cleared area (2026-11-09).
- An upload is saved to a temp dir, so a single gerber never finds its
  Edge.Cuts sibling; it clears the X/Y box. A KiCad board exports both.

## Per-layer pass count

- A group's `passes` repeats the whole group, every path once and then all
  of them again, rather than each path N times in a row: a burned line
  gets the rest of the layer's time to cool before the next pass, the way
  laser software usually treats a layer's pass count.
- The streamer repeats the path list (`paths * passes`) and lets the usual
  rapid logic join the passes: a closed loop needs no rapid between passes,
  an open path gets a `go` back to its start. Burn direction is kept on
  every pass rather than alternating, so each pass lands the same way.
- The table angle is not wound back between passes; joint_of and
  turned_toward pick the start nearest the current angle, so a full loop
  per pass leaves the table a turn further on each time, as it would for
  consecutive loops anyway.
- The field is `passes` on a group, while the upload's `passes` is the
  count of isolation offset loops: two different things under one name,
  so the API doc says which is which.

## Deposit mode (2026-09-30)

For laser deposition the beam must burn the copper and nothing else, the
inverse of isolation. `spinny_laser/deposit.py`, `mode=deposit` on a board
upload.

- Loops at `spot/2 + k*pitch` inside the copper; a pitch of a whole spot
  leaves gaps at convex corners (about 20 um at a square corner) and down
  the middle of a feature whose half width is not a whole number of
  pitches. The gaps are found per level, `X_k - grow(A_{k+1}, spot/2)`
  with `X_k = A_k` shrunk by half a spot, and burnt along the boundary of
  `X_k` clipped to within half a spot of them. Any point left lies within
  `pitch - spot/2` of that boundary, so this always reaches it.
- Do not find the gaps by unioning the stroked loops: at pitch = spot
  adjacent bands share an edge and Clipper crawls (457 s on a 10 mm pour,
  against 0.02 s per level). The per-level difference has the same
  problem, so the next level is grown 2 um short of half a spot: the
  band that leaves along every edge is a hairline the opening drops.
  Growing it 6 um long instead hid real 3 um gaps at rounded corners.
- Offset every level from the copper, never from the previous level:
  round joins compound (388 points at level 0, 6044 at level 4).
- Clipper rounds the chord count of a round join, so a corner 1.5 steps
  long gets one chord: sag up to 2.25 x ArcTolerance (4.5 um here), not
  1 x. Tests and the hairline width allow for it.
- Traces narrower than the spot use the gerber Draw centerlines, clipped
  to the copper the loops cannot reach grown by half a spot. Without the
  half spot, where a trace meets a rounded pad or a bend the clip stops at
  a curved edge and leaves slivers on the trace's sides; only a check
  along the trace edges finds them, not a grid.
- The outline group comes in disabled: burnt at deposition power it would
  lay copper round the board.
- Test board, 0.1 mm spot, machine estimate: isolation 7.8 min; deposit
  contour 14.8, radial 8.2, lines 19.8, rings 48.4.

## A board job names its layer

The upload, the CLI and a CAM profile take a KiCad layer name, F.Cu by
default; F.Paste is cut as a solder paste stencil with mode stencil (see
below), or burnt whole with a deposit. kicad-cli 10
plots each layer under its Protel extension (F.Paste as .gtp, F.SilkS as
.gto, inner copper as .g2), and the sibling's `find_layer` only knows the
copper, mask and outline extensions, so the finder lives in
`spinny_laser.board` and matches the layer in the stem whatever the
extension, skipping the .gbrjob. kicad-cli exits 0 for a layer name it
does not know or a layer the board does not have, plotting nothing, so a
missing gerber after the export is reported as "has no layer"; an enabled
empty layer plots an empty gerber, reported as "draws no paste". Group
labels take the word for the layer (copper, paste, mask, silk) so a
stencil's groups do not read as copper.

## One board reader (2026-11-10)

`spinny_laser.board.read` is the one reader of a board: the Jobs page's
import (`jobs.from_board`) and a CAM profile's (`camjob.read_board`) both
start from the `BoardLayer` it returns: the gerber image, the filled
area, the outline, the holes (a slot keeps its far end) and notes. Until
then each had its own copy and they had drifted: the Jobs import read a
KiCad board's drill files only, never those beside a gerber, and kept a
hole drilled in two files twice. The reader refuses nothing about what a
layer holds: a layer that fills nothing comes back empty, since mode
lines cuts a layer drawn with zero width lines, while a CAM profile
refuses it ("draws no ..."). Its errors are `board.ReadError`, which
each caller turns into its own. Holes on the Jobs page are now sorted
rows first over every drill file, not file by file. A page upload is
alone in its folder, so it still finds no drill file beside a gerber.
The `spinny-laser` command keeps its own resolver: it takes the outline
and drill file as paths of their own and can leave the gerbers in
`--gerber-dir`.

## Back layers and inner shapes first (2026-11-02)

A B.* upload is mirrored in X by default (`ImportOptions.mirror`, None =
auto). Pads and holes are flipped before the placement shift, and the
isolation's shift is read back as plan point minus the flipped gerber
point; the design map carries `mirror` applied before its turn, so a
camera fix, another width and PnP parts follow (a part's angle becomes
180 - a for x, -a for y). Radial clearing differs by a few strokes
between a board and its mirror: the spokes sit at fixed angles about the
axis. "Inner first, outer second" was read as the laser cutter rule (a
part's holes before its outline) since isolation loops already run
nearest the copper first; `spinny_laser.order` ranks paths by how many
closed shapes enclose them, applied per SVG group, to a board outline and
in the CAM's paths and outline operations, not to gcode or job files.
A board outline is joined into loops first (`spinny_laser.outline`):
KiCad plots each edge segment as its own stroke, so nothing was closed,
every depth was 0 and the drawing order stood. For a bit the joined
board region is grown by the radius (the edge moves out, cutouts in), in
the CAM and in the Jobs import on a spindle machine; the board corner
stays the zero, so the bit's middle reaches minus its radius and the
shipped mill-3axis profile warns at X and Y min 0 (left for the user to
settle: a lower min, or the corner on the cut). A cutout narrower than
the bit is noted (CAM) or kept switched off on its line (Jobs import).
A gerber upload reads every .drl of the board's stem, the NPTH file too.

## Stencil mode (2026-11-02)

The user asked for a stencil mode that cuts on the inside of the pads,
with a margin that shrinks the openings, and a preview. `mode=stencil`
(`spinny_laser.stencil`) runs the beam once round every opening, its
middle `margin + spot/2` inside the paste's edge, so the piece drops out
and the hole is the opening shrunk by the margin; a deposit of F.Paste
burns the whole opening instead and is slower. The loop is offset from
the opening in one step, not from the shrunk opening, so a rounded corner
is drawn in chords once. Choices made without asking:

- An opening with no room for the beam once shrunk is cut along the long
  center line of its smallest bounding rectangle, half a spot short of
  each end, never shorter than a quarter spot: the laser streamer skips a
  path of one point (`len(points) < 2`), so a dot would burn nothing.
  Paste pads are convex, so the rectangle's middle is the pad's; a narrow
  neck of an opening whose wide part holds a loop is left uncut.
- An opening the margin closes is not cut (KiCad also plots no paste for
  a pad whose paste margin closes it) but kept as a switched-off group of
  middle strokes: the preview draws it faint, so pads that lost their
  paste show, and it can be switched on. A margin that closes every
  opening is a 400, and a margin re-cut leaves the job as it was.
- `passes` other than 1 is refused with a stencil: the upload's passes
  are extra loops, which a stencil has no use for; group passes repeat a
  cut through a thick film.
- No inner-first ordering: a film island inside an opening falls out
  whatever is cut first. The outline group comes switched off.

The test board's F.Paste is 32 rounded pads 0.5 x 1.5 mm: with a 0.1 mm
spot, margins 0.05 and 0.15 give loops 0.3 x 1.3 and 0.1 x 1.1, 0.2
gives middle strokes, 0.25 closes them all. A 0.25 mm QFN pad with a
0.05 margin is too narrow for a CO2 spot of about 0.2 mm, so the middle
strokes matter on the K40. Nothing has been cut on hardware yet.

## Cutting a layer on its lines (2026-11-05)

"Need to be able to cut exactly on lines/paths" was read as: a board
layer that is a drawing (Edge.Cuts, a silk screen, a user layer) cut where
it is drawn, since SVG and gcode paths already are and only a board was
always isolated. `mode=lines` takes every dark stroke's centerline and
every contour of every fill (a hole's included), joins pieces whose ends
meet within the clearing's epsilon (`clear.chains`), orders them with
`clear.by_travel` and then `order.inner_first` (stable, so travel order
holds within a depth). Placement grows the lines by half a spot for the
anchor, so another width moves nothing. Lines with no width leave no ink
(`geom.copper` is empty), so the emptiness check is on the lines; the ink
is still kept as the job's copper for the preview. With layer Edge.Cuts
the outline group is left out, since it would cut the same loop twice;
otherwise it comes switched off, as for a deposit.

kicad-cli 10 names a plotted gerber after the name a layer is shown by:
F.SilkS as board-F_Silkscreen.gto, Dwgs.User as board-User_Drawings.gbr,
a layer the board renames by its new name. `find_layer` only looked for
F_SilkS, so a silk import failed with "has no layer" although the page
offered it. `board.layer_table` reads the file's table (KiCad's standard
shown names filled in where the table gives none), `find_plotted` tries
every name; `layer_of` maps the shown names back so a gerber named that
way keeps its layer. The page's chooser reads the same table itself
(`src/kicad.ts`, a streaming s-expression pass, 3 ms for the test board).

## DXF drawings (2026-11-11)

- spinny_laser.dxf is hand-written for ASCII DXF (no new dependency):
  LINE; LWPOLYLINE and POLYLINE with bulges as arcs (spline frames and
  meshes skipped); ARC, CIRCLE, ELLIPSE; SPLINE as a NURBS by de Boor's
  algorithm flattened by bisection (depth 12), a knot vector that does
  not fit replaced by the clamped uniform one, fit points alone as the
  line through them; INSERT with scale, rotation, rows and columns,
  nested up to 16 deep, a block inserting itself refused, names matched
  without case, layer 0 entities taking the insert's layer.
- An entity's own coordinate system follows the arbitrary axis algorithm
  (an extrusion of -Z mirrors X); $INSUNITS codes 0 to 20, 0 or unset mm;
  arcs stepped by the sagitta (8 to 10,000 chords a turn), an ellipse as
  the circle of its major radius; the tolerance is divided by the
  transform's largest stretch; lines joined end to end by clear.chains
  (1 um). A drawing past 1e6 mm is refused (a wrong $INSUNITS).
- Skipped: TEXT/MTEXT, HATCH, DIMENSION, POINT, faces and meshes,
  invisible entities, paper space, layers off or frozen. A binary DXF is
  refused ("save the drawing as an ASCII DXF").
- Jobs: one group a layer ("layer NAME", first-drawn order, inner shapes
  first, source dxf); CAM: one PathSet a layer, so a paths operation's
  match picks a layer. The Auto and MCP tools take .dxf too.
- The mock's twin (src/mock/dxf.ts) must stay step for step, with its own
  clear.chains; pinned differences: Python's float % (pyMod), radians as
  x * (pi / 180), ASCII-only strip and CR/LF-only splits in both, one
  number grammar before float()/Number(), sqrt not hypot in the spline
  flattening, step counts taking ceil 1e-9 short. dxf-samples.json (mise
  run dxf-fixture, kept current by a Python test) is what the Python
  reader makes of tests/data/dxf/*.dxf; the page test compares the twin
  within 1e-9 (lines.dxf has CRLF ends on purpose). Both agree exactly on
  the OpenSCAD and GDAL sample DXFs on this machine.

## A gerber among other boards' files (2026-11-20)

A gerber read from a folder holding other boards' plotted files took the
first Edge.Cuts there and every drill file named like the board up to its
first dash, so led-matrix-F_Cu.gtl was cut around led-driver's outline and
drilled with its holes. A board is its file's name less the layer
kicad-cli adds (`board.board_name`); its outline is named after it or
after no board, its drills are <board>.drl and <board>-*.drl, or with
none of those the drill files named after no other board in the folder.
