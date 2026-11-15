# The Plot page

The page that was the Mill tab until 2026-11-08 (page id `plot`; the code,
the API and the backend module keep `mill` for the operations): simple
operations typed by hand, a board's holes, jobs of several operations.

## Jobs of several operations, rounded corners, sketch sizes (2026-11-08)

- "Not have to make job for each mill", "Apply status" and "Add to job"
  were read as one design: a Plot job holds a list of operations
  (`recipe.ops`; a job made before keeps its one in `recipe.mill`, and
  `recipe_ops` reads either). `POST /api/mill` and `/api/mill/plan` take
  `{ops, name, job}`; a single operation alone still works (a pydantic
  union, `MillJobBody | MillOperation`). With `job`, the operations replace
  that job's in place and the result is turned and moved as the job has
  been since it was made (`placed`), so a job moved on the Jobs page stays
  put; the operations are typed in the job's frame from before the move.
- Every operation of a job cuts with one cutter and one bit or spot,
  refused otherwise: nothing changes the tool mid-run, and the job's
  `spot` (the width row) must mean one thing.
- A holes operation keeps its holes in the recipe (`op.holes`), so the job
  is made again (width, another operation beside it) without the board job
  they came from, and moves like the other operations. A job made before
  that, holes and all, takes the job's own (already moved) holes as before.
- The page's model: `ops` (the selected Plot job's), `editing` (the index
  of the operation in the fields, or null). New job sets editing to 0, Add
  to its new index, so right after either the fields match. Switching the
  kind keeps `editing`, so the mark says `changed from operation N`: Apply
  would replace that one, Add would put the fields at the end. A
  heuristic dropping `editing` on a kind switch would have made turning a
  pocket into a profile impossible to apply; naming the operation in the
  mark was the explicit way. The mark's class is `plot-state`: the
  stylesheet already had an `.apply-state` (the config panels').
- `send` sets `plotJob`, `ops` and `editing` before selecting the job, so
  the job's arrival through the store keeps the operation marked. The plan
  is not cleared after Apply: a plan to stored job to plan switch would fit
  the view twice under the operator.
- `sameOperation` (src/sketch.ts) compares everything but the name and the
  holes filled in when the operation was made; an undefined `corner` is 0.
- Rounded corners: arcs about centers `corner` inside each corner, radius
  `corner + r` outside, `corner - r` inside (square inside path when that
  is 0 or less), `corner` on the line. Pocket loops whose radius `corner -
  r - t` is still positive share the wall's corner centers: rounding only
  brings two loops closer at a corner (the gap is sqrt(2)(s - rho(1 -
  1/sqrt(2))) against sqrt(2)s for square loops), so MAX_POCKET_STEPOVER
  still holds. Square corners keep the old code paths exactly, so the
  fixture's old samples came out byte for byte the same; the fixture only
  gained the new samples (`JOB_SAMPLES` carry `ops`).
- A rounded loop starts at the middle of the corner arc nearest the last
  loop's end, so the link between loops is one short diagonal step inside
  the pocket. Its closing point can differ from its start by one ulp
  (radians(a) + radians(45) against radians(a + 45)).
- Center and size is a page-only mode: the operation sent still has
  `x0..y1`; the center fields are remembered apart (`rcx`, `rcy`, `rw`,
  `rh`) beside the bit and the spot.
- "More CAD like, constraints preview" became the sketch sizes: the
  operation in the fields drawn with its width and height, its corners or
  center, the corner radius, a circle's diameter, a line's numbered points
  and legs (`operationDims`). They are drawn in screen space every frame
  after the marker labels, not in the still layers: a handful of lines,
  and no scene key to keep. A Plot job moved on the Jobs page takes them
  along (`movedDims`).

## Mill tab, markers, another width, preview grid (2026-10-30)

- A rectangular pocket of square loops leaves material at the corners
  between two loops once they are more than 0.853 bits apart: the point on
  the diagonal is sqrt(2)/(1+sqrt(2)) = 0.586 of the spacing from both.
  The pocket refuses a stepover over 0.85 instead of clamping it; rings of
  a circular pocket are s/2 from both, fine up to a whole bit. Found by the
  coverage test, not by looking.
- Loops go inside out and each starts at the corner nearest the last
  one's end, so the link between them is one diagonal step and the bit
  never lifts inside a pocket (each path lifts at its end in the
  streamer).
- Another width for a board job: import the kept file again with the new
  spot, then turn by the old design rotation and shift by the difference of
  the design shifts. A centered import moves with the spot (the isolation's
  box grows), so placing by the import options alone would miss the copper
  already cut. Offset and rotation of a Mill tab job track the same rigid
  move (they start at 0), so its remake is turn(rotation) then
  shift(offset).
- A kept gerber is copied alone into a temporary folder under its original
  name before it is imported again: the importer reads the layer from the
  name and looks for Edge.Cuts beside it, which in the jobs folder would be
  another job's file.
- A board saved and loaded as JSON comes back as source "json": the width
  refusal looks at the copper too, or such a job would take a new width
  with its old isolation paths.
- The grid choice is shared by every preview panel through a module-level
  set in previewpanel.ts; each Preview reads the stored flag only when it
  is built.

## Mill tab with a laser (2026-11-02)

An operation carries `cutter`; the page takes it from the connected
machine's tool, else the last one stored, so a disconnected page does not
flip to the polar laser default. The laser streamer skips one-point paths,
so a laser drill point is a closed ring of radius spot/2 (chord tolerance
at most spot/8 so a 0.1 mm spot still gets a real ring). A hole wider than
the spot is cut along its inside edge (profile inside) unless `bore`, which
clears it in rings. The Python model's `passes()` method became
`pass_count()` to free the name for the laser's field. Bit and spot are
stored apart in localStorage (`bit`, `spot`) since one browser may drive
both machines.

## Bug sweep fixes (2026-11-09)

- Hole sizes are rounded by `size_of` in the backend with the page's
  arithmetic (one multiply, then half up), not Python's `round(d, 2)`:
  the page sends the sizes it lists, and 3.175 mm (1/8 in) rounded to
  3.17 matched no size, so mounting holes were silently dropped. The
  mill fixture holds 3.175, 0.305 and 1.575 mm holes to pin it.
- A holes operation keeps its own holes; a board job's holes taken for a
  moved Plot job go through `unplaced` (the inverse of `placed`) into the
  job's frame from before its move, since `placed` moves the result once.
- Apply, Add, Up and Remove carry the Jobs page's group settings over
  (`carry_job_settings`, backend and mock): each new operation is matched
  to the one it replaces, then groups by label without numbers. A setting
  keeps the Jobs page value unless the operation's own number changed;
  typing the same number on the Plot page does not reset it. Regrouped
  groups carry only enabled, focus, min_power and thickness, by label.
- Here, Add here and the marker picks give board positions; with a Plot
  job selected they are taken into that job's frame. New job sends `like`
  naming the selected Plot job, and the new job is placed the way that
  one is, so a Here point lands where the preview showed it.
- Fields put back from an operation show three decimals only when that
  reads back exactly (an inch bit shows 1.5875), and the center and size
  fields remember the corners they came from, so a picked operation does
  not read as changed and Apply is not refused over a rounded bit.
- The Name field clears when another job is selected (a stale name
  renamed the next job changed); without a machine the page keeps the
  cutter it was using.
- A laser pocket or inside profile of a circle the spot fills is refused
  ("mark its middle with a drill point, or give a wider circle"): the
  one-point path it made burned nothing, and a ring would burn twice the
  circle's width.

## One Run panel (2026-11-11)

- src/views/run.ts (mountRun) is the Run panel for the Jobs and Plot
  pages; mountJobs mounts it in its runRoot, mountMill in roots.run. The
  Plot page kept its stats line and hint (options), and gained the map
  chip, the focus and power choices, the dispenser refusal and Resume
  from line; its own "no usable height map" note gave way to the chip.
  The title class is .run-job (was .mill-run-job).
- Both copies are on the page at once, so the height map pick is store
  state: mapPick is null until picked, then the choice follows the map
  (auto with a usable one, else off; power counts as auto on a mill);
  each copy derives it with mapChoiceOf and sets the same mapChoice. A
  flag per copy let mapChoice flip to whichever copy drew last.
- The page imports nothing from src/mock but main.ts's MockBackend:
  thumbKey is in api.ts, groupMoves/pathMoves/jointPreview in
  src/moves.ts, defaultOperation/recipeOps in src/sketch.ts.
