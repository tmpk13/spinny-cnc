# Camera pictures: crosshair, turn, zoom out, kept marks, edges, the log of changes (2026-11-14)

Built by an agent in a worktree (todo-camera), cherry-picked. The earlier
picture decisions are in notes/camera-looks.md.

- Crosshair sizes are fractions of the view's width (a fortieth, a tenth,
  a quarter; "across" reaches the view's edges, its circle the shorter
  half), so the crosshair keeps one size on screen.
- Turn by hand is kept as counterclockwise quarters per camera and added
  to Upright's quarter; the mirror flip is applied first, so a further
  screen turn only adds to the quarter, and the pointer is unturned by the
  total, so drags follow.
- Zoom below 1: the image's CSS scale shrinks the picture inside the
  stage and the marks' viewBox grows past it, so points beyond the picture
  show in the margin.
- Kept spots are keyed by their JSON; each records the place carrying the
  picture when first seen (the picture's center for a camera on the head,
  the head's place for the fixed bottom camera). Following the machine is
  a pure translation: `machineToPicture(then - now)` for a riding camera,
  `(now - then)` for a fixed one, with the current calibration. Spots
  present before a camera's state was first known are taken as old (but a
  running routine's), else every page load redrew the last routine's
  stale spot.
- The edge view asks `GET /api/cameras/edges` at most once a second, one
  request at a time. pcbv returns edge ends after lens correction, so with
  a wide lens they sit slightly off the uncorrected JPEG. The mock clips
  the board outline to the picture (Liang-Barsky).
- Findings: held for Keep until 2026-11-14, now a log with Undo (the
  section below). The page anchors an entry's pixel marks at the place
  carrying the picture when it first appears, as kept spots; its points
  are machine points, ringed with `knownMarks` in a "finding" tone.
- picture.ts and known.ts import each other; safe, since neither uses the
  other at module load.
- `armBox`: the next drag draws a box instead of moving the head; a plain
  click leaves the pick armed. `terms.ts` `explain()` marks only a labeled
  control's words, so the control keeps its own tooltip.
- Crops are circles about the picture's center because pcbv's spot finder
  takes only a radius: a part's crop is its feeder's, then its
  `[[part_class]]`'s (the first whose words its value and footprint hold),
  then `[up_camera] crop`, then pcbv's own reach. Look once gets its radius
  in pixels from the page, which knows which machine's calibration
  applies. `part_class` is in `GCODE_SECTIONS` in both
  `spinny_laser.machines` and the mock, and in src/filekeys.ts.
- `nozzle_box` is stored as fractions of the picture, so another capture
  size keeps it; nothing on the backend reads it.
- Corner by edges' log overlay numbers the lines strongest first; a
  refused corner is logged too; the search report skips the `edges` event.
  Find fiducials takes a `describe` so the fit's words exist before
  anything is kept; placing_part splits "said" from "done".
- Merged with the PNP agent's work: a top camera corner by its edges, once
  taken, is also one of the board's references (`_keep_corner`).
- happy-dom's `select.selectedOptions` can go stale after a garbage
  collection: look an option up by value (fc1daa5's jobs.ts change).

## Wheel and arrow keys by the user's answers (2026-11-14, Q37, Q38)

- Q37: only Ctrl and the wheel (a pinch) zoom a picture, about the point
  under the pointer; the plain wheel is the page's again, over the
  picture too. 026ec94 had taken the plain wheel.
- Q38, "have similar config for the movement as the camera": the View
  menu offers per camera (`spinny.picture.<key>.arrows`, beside Upright,
  Turn and the crosshair) Arrow keys as the picture shows (026ec94's way,
  the default), the other way, or on the machine's axes. "The other way"
  is exactly the opposite of "as shown" for every camera: for a camera on
  the head that is the picture's content going the way the arrow points,
  as a drag moves it; for the fixed bottom camera it moves the nozzle
  against the arrow (taking the question's "as a drag would" literally
  would have made it the same as "as shown" there, leaving that camera
  only two choices). "Machine's axes" does not move the head itself: the
  picture lets the key through to the jog keys, which follow the
  machine's axes with the jog panel's step and Hold to move, and do
  nothing on a page without a jog panel, as before 026ec94.
- The drag is not part of the choice: it always moves the head so what
  the camera sees follows the pointer, in the picture's own pixels, which
  a turned or flipped picture already undoes.
- Test trap: bun runs the test files in one document, so another file's
  jog panel can take an arrow key and prevent its default; a key left to
  the jog keys is checked by reaching the page, not by defaultPrevented.

## The log of changes in place of Keep (2026-11-14)

Built by an agent in a worktree (cv-log).

- Decision, the user's (Q40, Q36 "log style as with Q40"; Q35
  superseded): a log/history where each new parameter applied shows, all
  parameters kept automatically, and an Undo banner in place of the Keep
  banner that goes away shortly. So no routine asks first: Find mark,
  Measure offset, a search's roll and scale, Find fiducials, Corner by
  edges, Center features, and also Center nozzle and Measure runout (Q36's
  option B) apply at once and log. The row under the picture shows for
  `undoShown.ms` (10 s); every entry stays in the camera's Changes panel.
- A change is data, `(target, name, before, after)`, the values read from
  the target before and after the write (as stored, JSON-normalized), so
  an undo outlasts a restart. Targets the backend names at start: `head`,
  `up`, `top` (the cameras' settings), `up place` (the bottom camera's place
  on the G-code machine; `up` on this project's machine, so center_nozzle
  and measure_runout take a `target`), `references` (per job id; its write
  drops `top.fiducials` when the job's list has no fiducial left).
- Corners (BoardLook) and Align marks (Alignment) live in memory: their
  undo is a callable held for this backend run (`undo: held`), and such an
  entry is not undoable after a restart. `placing_part.take_corner` puts
  the look's corners back by clear and re-add, since boardlook.py has no
  remove; corners of another job's board that the take dropped are not
  brought back (that board's middle is not known there).
- Undo is refused (409, `UndoRefused`) when any value differs from the
  entry's `after` (relative 1e-9), while that camera's routine runs (as
  Keep was), and when the entry's G-code machine is not the one placed
  with (top settings and references are kept per machine). An undo of a
  data entry is itself undoable (Redo); of a held one, not.
- The cameras' method is `findings_target`: UpCamera already has a
  `target` property (the machine its routine moves).
- `confirm` was dropped from the bodies, not kept: pydantic ignores an
  unknown field, so an older page's `confirm: true` is a plain request.
  `/api/cameras/finding` is gone.
- The `findings` event carries each camera's newest 50 entries, each with
  `undoable` worked out from one read of each target; GET /api/findings
  gives up to 500. Camera states carry the newest entry as `applied`.
- Page: `applied` answers undefined while the camera's state is not known;
  the row primes on the first known state, so an entry there at page load
  is old news and only a newer one shows. The Changes panels
  (`camera-changes`, `pnp-camera-changes`, `pnp-top-changes`) are stacked
  in each camera's folder through `CameraFolds.changes`; without one the
  fold goes into the camera's own panel.
- The mock's log (src/mock/findings.ts) keeps every result's undo as a
  callable snapshot (corners, references, Align marks, the up place) and
  only the cameras' settings as data.

## Crops per task (2026-11-15)

- Q42 answered A by the user: the LumenPnP's top and bottom cameras get crops first, the head camera later.

Suggested home: a new section at the end of `notes/camera-pictures.md`
(its index line in NOTES.md gains "crops per task (2026-11-15)"). Built by
an agent in worktrees (spinny branch cv-crop, pcb-vision branch crop).

## Crops per task (2026-11-15)

- A crop is a box [x0, y0, x1, y1] in shares of the picture from its top
  left, as `nozzle_box` is stored. Tasks: top camera `board`, `spot`,
  `edges`, `measure`; bottom camera `nozzle`, `part`. Machine file keys
  `[top_camera.crops]` and `[up_camera.crops]`, read in openpnp.py
  (`TopCameraProfile.crops`, `GcodeMachine.camera_crops`), in the
  placing document as `top.crops` and `camera_crops`. One module
  (spinny_web/crops.py, twin src/crops.ts) holds the tasks and checks.
- Which looks use which task: `spot` covers every TopCamera.look_at, so
  also a feeder's marks and a part in its pocket during a run, not only
  Find mark / Measure offset / Find fiducials / Home by fiducial / Look
  once. The bottom camera's crops apply only while a G-code machine is
  connected (`_up_crops`): on this project's machine there is no file
  section for them. Up camera Look once takes `nozzle` or `part` by the
  spot it is asked for. Center features (head camera) and the head
  camera's edges take none (Q42 A: the head camera later).
- pcbv: a box crop is a filter, not a cut picture. `spot` keeps blobs
  whose raw (before lens) center lies inside, nearest the picture's
  center still; without a radius and with a crop the radius has no
  default (the old h/3 would cut a crop's corners). `edges` asks
  find_edges for every line (max_lines only truncates at its end) and
  keeps those whose raw middle is inside, then `max`. The localizer's
  crop drops spots outside and, the part that matters, makes
  `expected_in_frame` count only features a pose puts inside the box
  (taken back through the lens): otherwise coverage was judged against
  features never looked for and cropped locks failed.
- An older pcbv ignores unknown fields, so a `spot` with a crop it does
  not take answers as if uncropped. The client tells them apart by
  `hello` naming `crop` (`VisionClient.can_crop`); spot/edges replies then
  carry `uncropped`, the `crop` request raises, and the camera says
  NO_CROPS once per start (level warning) and looks at the whole picture.
  Fakes without `can_crop` count as taking none (`getattr`), so the old
  test fakes keep working; crop fields are only sent when a task has one.
- "The up camera's spot looks clip their radius to the crop": done for
  every PickCamera spot look with a crop: radius = min(radius, distance
  from the picture's center to the crop's farthest corner), from the
  settings' size. With a new pcbv it changes nothing found; it keeps the
  radius drawn and logged honest.
- The board crop goes to pcbv at every camera start (after the lens), on
  every top_board load, and after a PUT or PATCH of the placing
  machine's file (`machine_written`), so a crop drawn on the page holds
  at once. The busy test (BoardLook `crop`) and Measure camera cut their
  luma to `measure` (pictures there now live in pictures.py, not
  boardlook/pictures.py as the brief said).
- `set_value` (spinny_laser.cam) and its mock twin now reach a table in
  a table by its parts (`["top_camera", "crops", "spot"]`), and the
  header regex reads dotted names. Before, `[top_camera.crops]` was not
  seen as a header at all, so a key added to `[top_camera]` after it
  would have landed inside the crops table. The file patch adds a
  missing `[a.b]` header at the file's end like a plain table.
- Routines carry `crop: {task, box}` in their progress (RoutineProgress,
  the mock's too); the page draws that task's box while one runs. Search
  records keep `crops` in their picture fields (`_top_picture`), Measure
  camera's numbers keep `crop`.
- Page: the View menu's "Crop for <task>" entries; a drag draws while a
  crop is picked (an armed pick still wins), Save crop / Clear crop write
  through PATCH and refresh placing and machines, Done drops a draft.
  Outside the box is dimmed with four rect marks (tone `dim`), the box
  tone `crop`. The bottom picture's older *Crop* select (part classes'
  circles) stays; the two words sit side by side, which the user may
  want renamed.
