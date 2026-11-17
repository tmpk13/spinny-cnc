# The preview

The 3D preview: projection and fitting, the grid and rings, picking paths and the job's JSON panel that draws on it, and how it is drawn (WebGL2 in a worker, the 2D canvas where that is software).

## 3D preview (2026-10-03)

Three.js was not added: the page has no runtime dependency, the test
environment is happy-dom without WebGL, and the scene is lines on a plane
plus a few raised points. camera.ts projects world mm through a
perspective camera with a fixed vertical field of view (40 deg), and the
painters (below) draw what it projects; the fit for the overview bisects
the distance until sample points of the reach circle land inside the
canvas, so it depends on the canvas's shape and not its pixel size. Zoom
about the cursor and pan are exact on the board plane by unprojecting the
cursor before and after. The right vector comes from the yaw alone, so
looking straight down keeps a direction (cross(forward, up) degenerates
there). Probed heights are drawn at (height - mean) * stretch with the
stretch making the map's spread a tenth of the reach (1 to 200x), and the
stretch is written in the corner. Tests drive draw() through a Proxy
standing in for the 2D context (every canvas made gets one, so the scene,
the overlay and the layers are told apart), and the WebGL painter through
a Proxy standing in for WebGL2, so the drawing code runs under test
instead of being skipped on happy-dom's null context.

## Fitting the preview

The canvas is measured in the `Preview` constructor, before it is in the
document, where `getBoundingClientRect` returns zeros. Fitting there fits
to nothing, and a guard keyed on "the width was zero" only ever fires that
once, so the view stayed at the smallest scale for the whole session.
`resetView` now records whether it fitted against a canvas that had a
size, and `resize` refits until one has. A resize after a real fit leaves
the view alone, so panning and zooming survive a window change.

Ring labels are drawn every ring, every second or every fourth, whichever
keeps them about 44 px apart; the readout row is a wrapping flex row
rather than a grid of guessed widths, which let `mm/min` run into the
next stat on a phone.

## Grid and rings follow the zoom (2026-11-05)

The step is the finest 1-2-5 step whose lines land 16 px apart at the
target's scale (`gridStep`), every fifth line of a 1 or 2 step and every
second of a 5 step heavier, so the heavier ones fall on round numbers.
Lines are drawn only over the box of the board in view (`visibleBox`:
canvas points taken down to the board; where the view reaches the
horizon the box runs six camera distances out, then the grid's extent
clips it), and the step coarsens until at most 400 lines or rings cross
it: a low tilted view would otherwise draw thousands. A ring is drawn over
the arc the box spans, its chords within 0.3 px, since 96 chords round a
100 mm ring sag 0.05 mm, 20 px at full zoom. Labels go on the heavier
lines where they meet the axis across them, else where they meet the
canvas's lower or left edge (a box edge is off screen in a tilted view),
34 px up so they clear the notes line; ring labels follow the rail, or the
middle of the arc when the rail is out of view.

## Picking paths, regrouping, the job's JSON (2026-11-05)

"Groups of paths" and "select by path" were read as one feature: pick
paths in the preview, put them in a group of their own (so they get their
own power, speed, passes or focus) or another group, or take them out. The
page builds the new job itself (`src/regroup.ts`, pure, tested) and sends
it whole with `PUT /api/jobs/{id}`, the route the JSON panel needs anyway,
so there is no regroup route to keep in step with a mock. A new group
takes the first source group's settings and sits after the last group a
path came from, so cutting order stays near what it was; a group a move
empties is dropped. Joint-space groups (paths drawn from joints) and model
groups (moves) give no path away; dots and paths never share a group.

A click is a press let go within 4 px; it picks the path nearest the
pointer within 8 px (projected segments, any group), shift or ctrl toggles.
Box selection is a toggle because a plain drag already orbits and shift
drag pans; it takes paths wholly inside the box. The halo is drawn under
the groups in the still layer (the selection is in the scene key), the
caret's place over everything.

The JSON panel formats the job with every path on one line (`formatJson`):
82 kB for the test board, a plain textarea copes; text past 4 MB waits for
"Show anyway". The caret's place is found by scanning the text up to the
caret (`stepsAt`), not by a parse, so it works while the text is broken
past the caret; `offsetOf` is the way back for a picked path. An edit that
parses is the preview's job (`jobDraft`) until Apply or Revert; a job
changed under a dirty editor (a group's number set in the Job panel) is not pulled in, the
status line says so instead. The edit counts as pending on the Machine tab.

## The canvas that crept down the page (2026-11-08)

Screenshots of every preview came out blank. The drawing ran (a counted
1120 strokes) and its layers held ink, but the canvas grew a pixel a frame
(453, 454, 455 ... for seconds): it sat in the flow of `.preview-box`,
whose height came from its content, and `height: 100%` of a content-sized
flex item does not resolve, so the canvas was as tall as its own `height`
attribute, which `resize` sets from the measured size, border included.
Every resize made the box a border taller and fired the ResizeObserver
again, and setting the attribute clears the canvas, so the picture was
blank until the creep stopped near the 70vh cap. On a screen of two device
pixels per CSS pixel the attribute is twice the size, so the box jumps to
the cap in one step and nothing shows; on a one-to-one screen (and
headless) it crept. The canvas is now absolutely placed over its box and
the box takes `height: 70vh` within its limits. Software 2D canvases
(`--disable-accelerated-2d-canvas`) were tried first and changed nothing:
not the stale-readback trap.

## View buttons, the speed view, the cut order slider (2026-11-08)

- Top view keeps the target and the distance and snaps the yaw to the
  nearest quarter; CCW 90 and CW 90 turn from the nearest quarter. A
  positive yaw turns the eye counterclockwise seen from above, so the
  board turns clockwise on the canvas: CW 90 is yaw + 90.
- The speed view (`src/speed.ts`) uses the mock's `groupMoves` and the
  page's `moveMinutes`, the sums the stats' `limited_fraction` makes, with
  the group's passes taken as one (each pass runs the same moves). A
  cartesian machine's cap is each axis's rate along the move's direction,
  X on the rail (`r_rate`) and Y on the cross slide (`z_rate`), the table
  angle taken as 0. Without settings read the view uses the firmware's
  default rates and the key says so. Segments are drawn in five color
  buckets (one path per bucket) and the capped ones under a red halo, so
  a board of thousands of segments is a handful of strokes. The ramp has
  no red or orange, which the capped mark and the axis use.
- The slider's order is the groups that are on, a path at a time, a
  model's group as one entry; disabled groups are faint either way. It is
  part of the still layers' key, as are the speed view and its rates. A
  job of another id resets it to the end (the whole job); an edit of the
  same job keeps the place. The speed view hides the slider and ignores it.

## Speed view, picks on an edit, regrouping (2026-11-09)

- The speed view holds every axis rate to the step generator's ceiling
  (`stepCeilingHz`, `cappedRate` in kinematics.ts), as the firmware's
  planner and the backend's pricing do; the z fallback is 560. Joint-space
  moves are drawn along their sampled arcs, not as chords.
- Picks made on the JSON panel's edit carry `draft: true`: they find
  their line in the text, and the Jobs panel's Move, Delete and arrays
  ignore them (indices into the draft are not the stored job's). A Plot
  plan takes no picks.
- A group made by a move is on only when every group its paths came from
  is on (a switched-off group's paths were switched on by a move).
- A JSON edit that changes a joint-space group's joints draws it again
  from its joints; unchanged joints keep the drawing sent (the centering
  burn's drawing). The caret on a list's first entry is inside it.

## Drawing a large job in 2D (2026-11-11)

What the 2D painter (src/render/canvas2d.ts, the fallback since
2026-11-12) does to keep up. Measured first (headless Chromium, software
canvas, a 160 x 100 mm job of
28,200 paths and 348,000 points): overview zoom 942 -> 63 ms a frame,
pan 711 -> 38, orbit 674 -> 39, the cut-order slider 706 -> 47, the speed
view's pan 2,878 -> 147, upload and first draw 2.0 -> 0.8 s. A GPU canvas
was not measured.

- 81% of a frame went to drawImage of the still layers (the canvas
  rasterizing what was drawn into them) and 11% to closePath; projecting
  the points was a few percent, so caching projections would not have
  helped (every camera move changes them, and the still layers already
  cache per view).
- closePath is quadratic in Chromium (each call walks the path so far):
  3,700 pads took 100 ms with it, 6 ms without; fill() closes subpaths
  itself.
- One path per group rasterizes slowly (the scan converter's work per
  line grows with the edges crossing it): 20,000 strokes as one path took
  510 ms, in 128-point strokes (Pen, BATCH_POINTS) 38 ms (64 to 256
  within 10%, 4,096 already 100 ms). A translucent set spanning batches is
  stroked opaque on a scratch layer and laid on at its alpha, or crossings
  of batches would darken.
- While a drag, the wheel or the slider moves a job over 50,000 points
  (COARSE_POINTS), lines at the 1.2 px minimum draw one device pixel wide
  with 1 px detail; the full picture comes back once the view has stood
  for max(150 ms, two draw times) (a fixed 150 ms found a slow drag still
  between its own events). Smaller jobs draw as before.
- A point within 0.5 px of the last kept one is dropped (a run's last
  point always kept); a line wholly off the canvas is skipped by its
  projected box, which is exact for points in front of the eye.
- Projector (camera.ts) works the frame's sums out once and writes into
  a Float64Array, no object per point; picking and box select use it.
- The speed view joins consecutive moves of one color into a line (their
  ends come from the same joint, so exactly), and src/moves.ts (no longer
  the mock's groupMoves) makes them.
- A drag or zoom that leaves the camera as it was asks for no draw.

## WebGL2 in a worker (2026-11-12)

The scene is a list of items (src/render/scene.ts: the grid or rings, the
rail, limits, copper, halos, speed view, cut order states, groups, outline,
caret, probe mesh, markers, axis) that two painters draw: WebGL2
(webgl.ts) and the 2D one, so the look is decided once. The head, trail,
labels, notes and selection box go on a second canvas laid over the scene
(overlay.ts), so a moving head no longer redraws the job. The renderer
runs in a worker on both canvases handed over with
transferControlToOffscreen (host.ts); the page posts what changed, once
an animation frame, and keeps the camera, picking and the cut order.

- Bun 1.3.3 neither bundles `new Worker(new URL(...))` nor keeps a second
  script of a page apart (it merges them), so the worker loads the page's
  own bundle by import.meta.url and host.ts starts serving when it finds
  itself in a worker. Nothing in the bundle may touch the page while it
  loads: main.ts guards its boot, and `mise run test-render` loads the
  built page and fails unless its previews say `data-drawing="worker ..."`.
  Bun's dev server gives import.meta.url as the source's file:// path, so
  under `mise run dev` the preview draws in the page. A worker that fails
  before taking the canvases leaves the page drawing; one that fails after
  took them along, so fresh canvases are cloned in.
- Lines are one quad per segment shaded by the distance to it (round caps,
  joins, a device pixel of soft edge). Drawn as a 4-vertex instance per
  segment, the 400,000 point job took 3.3 s a frame in SwiftShader, which
  sets up every instance on its own; with the points in RGBA32F textures
  and one plain draw of six vertices per segment fetching its two points
  by gl_VertexID, 210 ms there and a steady 60 frames a second on an Iris
  Xe. Ids along the points break lines (a pair of points with different
  ids draws nothing) and carry a path's place in the cut order, so the
  slider is a uniform, not new geometry.
- A translucent set (one color and alpha: a group's lines and dots) is
  drawn opaque into a layer with MAX blending and laid on at its alpha,
  the WebGL form of the 2D painter's scratch layer: no darker where its
  lines cross or join. Copper is filled even-odd by a stencil: a fan from
  each shape's first point inverts a bit, a quad over the copper's box
  fills where it is set. The layer is cut to the set's screen box; a dot
  is drawn a screen size wherever it lies, so its room is taken on the
  screen, not the board (padding on the board clipped far dots to slivers).
- WebGL cuts lines and fills at the near plane and draws what is in front;
  the 2D painter drops a segment or a shape that reaches behind the eye.
  Seen from low over the board the two differ, so the render check does
  not compare that view; elsewhere they agree to anti-aliasing (a mean
  difference under 1 of 255, more in a moire of lines under a pixel apart).
- `auto`, the default, asks for WebGL2 with failIfMajorPerformanceCaveat
  and also reads the renderer's name on a throwaway canvas: headless
  Chromium's SwiftShader takes the caveat flag. On software GL the 2D
  painter, still in the worker, draws the large job about six times faster
  than SwiftShader's WebGL. `?preview=gl` and `?preview=2d` draw in the
  page with that painter.
- A job posted as it is cost the page 139 ms for 400,000 points (each
  [x, y] array copied); packed into typed arrays and handed over
  (pack.ts), 10 ms. Reach for the fit compares squares (hypot over every
  point was 10 ms).
- Pictures are read back inside the renderer in the frame that drew them
  (readPixels, getImageData), not screenshot: under SwiftShader a 2D
  canvas over a WebGL one can screenshot stale.

The large job, page ms per drag step and frames a second, headless
(SwiftShader) then headed on an Iris Xe: 2D in the page 32 / 30 and
14 / 27; WebGL in the page 0.9 / 4.7 and 0.9 / 54; WebGL in the worker
0.1 / 4.0 and 0.1 / 60; 2D in the worker 0.1 / 26 and 0.1 / 30. Showing
it cost the page 134 ms in 2D headless, 13 ms with the worker.
