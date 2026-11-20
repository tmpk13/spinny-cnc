# Camera looks, looking for a board, controls, the picture viewer (2026-11-12)

Built in the todo-cameras worktree by an agent, cherry-picked onto main.

- A look right after a move's wait (M400 ok, or Idle) read pcbv's newest
  frame, which a USB camera delivers a frame or two after exposure: the
  nozzle routine's scale steps could see the head where it was, so the
  spot "did not move" or the scale came out wrong. Every routine look now
  waits for a frame captured SETTLE_SECONDS (0.25 s, camera.py) after the
  look began, told from pcbv's `pose` `age_ms` (no pcbv change needed).
  Tests set SETTLE_SECONDS to 0 through an autouse fixture in conftest.py,
  since the fakes show the head at once; LaggingUpCamera in
  device_fakes.py is a fake that lags, and the test with it fails without
  the wait.
- Board look (boardlook.py): a locked pose becomes an estimate (job frame
  to machine frame, rigid) by fitting the picture's center and four corners
  (pcbv's `corners`, board points) against machine points made with the
  camera's offset/roll/mirror and pcbv's OWN mm_per_px, not the calibrated
  one: pcbv measures scale from the board at its real height, so the fit
  has no scale error. Poses without corners fall back to center +
  angle_deg (rotation = roll - angle_deg, the align capture's convention).
  When it is found: Guesses, below (it was 5 in a row of the newest 9).
- A pose counts only when the head is known to be at rest when its frame
  was taken: head camera = machine Idle at that place for SETTLE; G-code
  machine = link.position unchanged for move length / (feed_xy/120 mm/s)
  + SETTLE. GcodeMover now writes link.position after each move, else the
  watcher used the place from before a routine and put the board wrong
  (found the hard way: the top search test flaked until then).
- The head camera's offset and roll are taken as fixed in the board frame,
  as the find routine and align capture already do; on the polar machine
  that holds only at the table angle they were measured at.
- The search box is drawn on the camera picture (Shift+drag, plus "Add
  view" to grow it to the current view), not on the PNP Board drawing:
  the picture is the only drawing in machine coordinates on the PNP page
  (the Board drawing is in the job's frame, whose place on the machine is
  the unknown being searched for). A box drawn in one picture is small,
  hence Add view to grow it by jogging.
- pcbv `reset` is sent at each search stop so a stale coasting pose from
  the last stop cannot be read at the new one.
- Board look state is `board_look` (not `look`): PickCamera already used
  `look` for Look once, and placing_state merged both into `top`.
- V4L2 controls: set one v4l2-ctl call per control, names containing
  "auto" first (manual exposure is refused while auto exposure is on);
  kept per camera in its settings dict `controls`, set again after
  each start; a non /dev/ device (HTTP snapshot, socket://, files) has
  none.
- Picture viewer (views/picture.ts): marks are an SVG with a viewBox of
  the zoomed region and vector-effect non-scaling-stroke; zooming the SVG
  with a CSS transform would thicken the strokes (non-scaling-stroke does
  not undo ancestor CSS transforms). The frame width asked is the whole
  factor pcbv will shrink by that still covers the screen pixels.
- happy-dom's WheelEvent drops ctrlKey; the test dispatches a MouseEvent
  of type "wheel" with deltaY assigned.
- Rename to "bottom camera": string literals only (a small TS lexer and
  Python tokenize, f-string parts by line), not comments, docstrings,
  identifiers, routes, config keys or [up_camera]; infotip.ts by hand
  (captions and the two labels) to stay clear of main's drawing changes.

## Guesses, the threshold, corners, the Find board panel (2026-11-12)

Asked: a threshold slider, the estimate on the board drawing, an
equalizer-like graph of the location's probability with the threshold
slid over it, find board in a panel of its own with the camera picked,
and a rough place by corners.

- "5 in a row of the newest 9" became guesses: the newest 40 estimates
  sorted greedily (the estimate with the most match-weighted evidence
  within 0.5 mm / 1 deg of it seeds a guess of those, then the rest), a
  guess's probability its share of the summed matches. Found = the
  leader has 5+ looks, at least the camera's threshold, and strictly more
  than the next (a 50/50 tie is never found). In a row was dropped: one
  pitch-off look reset the count, and a repeated region filling the
  9-window could move the median, and so "found", to the wrong place.
  The share over 40 is slower to follow a board that really moved; Look
  for board or a search starts it afresh.
- A look's match = inliers / (expected + 0.5 unsure), capped at 1. pcbv's
  own coverage counts an unsure pair half, but its `inliers` counts it
  whole, so the share reads a little high with parts placed; 1 when pcbv
  sends neither (the fakes send 30/32).
- Corners act as a prior: a guess putting any corner taken further than
  corner_mm from where it was taken gets probability 0 and the others
  share the evidence; `share` (of all guesses) stays for the graph's
  hatched column. One corner: the rough place is square (fit_rigid with
  one pair), and a search's default box gets a tenth of the diagonal more.
- look_threshold and corner_mm live in each camera's settings
  (CameraSettings, TopCameraSettings: config, set from the page), not in
  machine files: the files' [camera] table has a fixed key list.
- BoardLook reads them through a `tuning` callable, never at its
  construction: the top camera's settings need the G-code part, which
  the Backend makes later (AttributeError `gcode`). retune() runs from
  state() too, so a change made elsewhere is followed.
- Every pose asks the place now (the guesses' picture outlines follow
  the camera while nothing locks); a record keeps `place` only for
  locked poses, as before. Threshold or corner changes go into a record
  as `settings` events and the report's replay applies them in order,
  else the "as recorded" row would not call found where the look did.
- Corner names are the outline box's corners in the job frame as the
  board drawing shows it (y up); the page's list is src/corners.ts.
- The Find board panel replaced the look buttons of the Camera and Top
  camera panels; it is mounted on the Jobs and the PNP page, each keeping
  its pick in localStorage (`spinny.find.jobs`, `spinny.find.pnp`). The
  PNP Board drawing follows the PNP panel's camera and threshold (also
  while the line is dragged). Use as board place: top camera = references
  (`by: look` or `corners`), head camera = Align's capture (found, else a
  mark per corner, else the raw pose).
- The mock's watchers give every 7th locked look a pitch off (2.54 mm in
  X), so ?mock=1 shows a second guess; its searches settle on exact looks.

## Search records (searchlog.py, searchreport.py)

- Recorded always, not under the camera log's switch: the search that
  went wrong is seldom one somebody chose to log. Kept within 60 records
  and 200 MB (the newest always stays, a record being written never
  goes); one record keeps at most 150 pictures, else one wide box (400
  stops) would push every other record out.
- One picture a stop, full size, taken once the stop's looks are done:
  taken during them it would eat into LOCK_SECONDS and STOP_SECONDS, as
  a frame request waits for pcbv between localized frames (up to half a
  second). Full size because pcbv shrinks to its own --work-width (1024)
  before detecting; a picture shrunk below that would not replay the
  same. pcbv's own drawing is not kept: `pcbv locate -o` draws it again
  from the picture and the record's copy of the board.
- A look's record ends when enough agree, at unload, as a search begins
  (`searched`) or at 3000 lines: the watcher reads five poses a second
  for as long as a board stays loaded. Its first picture is tried once,
  not at every pose, for a camera that gives none.
- search() ends the look's record before restart(): ended after, it
  would keep an empty consensus. end_record(only=...) stops the watcher,
  ending its look's record as found, from ending the search's record
  that took its place meanwhile.
- The board-to-job map is kept as an affine read off three points
  (Design.to_job is a flip, a turn and a shift), so the report maps
  pcbv's KiCad points without the job store.
- Consensus takes its thresholds per instance (the module's by default,
  read when made) so the report runs a record's poses again with others;
  the recorded settings must call found at the same pose the search did,
  which a test checks, so the replay is trusted.
- A stop is `missed` when the board covers at least a quarter of its
  picture (by the place found, or --truth) and no pose there was used.
  The test fake (SeenBoard) locks only with the picture's center over the
  board, so stops whose center is just off it count as missed too; real
  pcbv can lock on part of a board.
- The truth is the place found, so a search that found nothing has no
  deviations or cover until --truth gives one.
- The mock keeps a line per search it ran to its end; its links open a
  page saying it keeps no files.

## Independent locks, checks, features, edges, lens, colors (2026-11-13)

Asked: the camera's scale in the board request, agreement from
independent searches, a check that must agree, fiducials centered after
the pose, the top camera's side and finish and the parts placed, lens
calibration, a blank board's edges, ambiguity, round fiducials with a
sub-pixel center, and a color picker. pcbv got the matching requests
(its notes/ say how).

- Scale: pcbv's `scale` was per work pixel (a 1280 wide picture is halved
  before matching), so the camera's mm_per_px sent as it is would have
  kept the search at half the truth and never locked. pcbv now takes it
  per full size pixel, the unit a pose reports; the backend sends it a
  fifth either way (vision.SCALE_SPREAD).
- Five looks of one lock are one look: pcbv tracks a lock frame to
  frame. Found needs looks from 2 locks (`sessions`), pcbv's
  `acquisition` number when it reports one, else the backend's count of
  resets (the test fakes). A guess with all but the second has pcbv clear
  its pose, at most every RECHECK_SECONDS; `reset` in pcbv now also drops
  the observed pose, else the next `pose` read the old lock. Sessions
  never exceed `need` (a what-if of one look needs one lock), and records
  from before carry no `sessions` setting, so their replays need one.
- The check: the middle visit used to end at its first sample, the
  consensus being found already. It now resets and needs 3 looks within
  the agreement of the place found; 3 elsewhere is `disagreed`. A board
  whose middle is bare (a pour, a cutout) would never pass, hence the
  place with the most pads and holes in view when the middle holds under
  half of the best's. A failed check leaves its evidence in the
  consensus; while it still calls found the next place is checked, else
  the search goes on; MAX_CHECKS (3) bounds it.
- Rivals: pcbv's search only verified hypotheses that beat the best
  score, so a rival (a pitch off, a symmetric cluster turned) was never
  seen. With rivals on (serve) a strong candidate is held for the hold
  budget and weaker distinct hypotheses (half the best score) are
  verified, up to 20. Ambiguous at 80% (AMBIGUOUS); it is said, not
  refused: the check stop is what catches a wrong place.
- Features (`/api/camera/refine`): centering in the picture makes roll
  and scale errors vanish, so the turn comes from features 20 to 40 mm
  apart instead of one picture. Only features clear of every other by
  CLEAR_MM beyond their sizes, so the spot nearest the center is the one
  meant. They replace the job's camera marks in Align (tool marks stay);
  Apply is the operator's.
- Round checks: pcbv's roundness is minor/major of the moments, and a
  square has a disc's moments, so a spot also fails when it fills over
  90% of its smallest rectangle (a disc fills pi/4); fill under 75% of its
  ellipse is a ring or a cross.
- Edges: a blank board's corner is the crossing of the strongest two
  edges within 15 degrees of square that both end near it; which side is
  the board does not matter, each side leaves the corner toward its far
  end and the counterclockwise one first is the job's +X at bottom left
  (CORNER_FIRST). One such corner carries the turn (rough_place takes it).
- Colors are per camera and per item (spots, board, edges), read by pcbv
  at full size about the clicked point (no JPEG artifacts, no page canvas
  read). A picked spots color is not used for holes (dark). The page's
  pick is a registry in picture.ts keyed by the picture's key, so the
  settings fold arms the picture in another panel.
- The top camera's run assembly: a run begins with a bare board (the run
  dialog asks for the next board), so the placed list starts empty and
  grows; kept in memory per job, lost at a restart.

## Known points, typed zoom, live numbers (2026-11-13)

Built by an agent in a worktree, cherry-picked (e5a7dbd..0611350).

- Known points (views/known.ts) go through each picture's marks(state,
  shown); `shown` carries the region shown, CSS px per picture px and the
  rem, since rings and labels keep one size on screen. The rem is read at
  mount and on resize, not per draw (getComputedStyle at 10 Hz per
  picture is waste and makes happy-dom's MutationObserver GC trap
  likelier); the ResizeObserver redraws too.
- Head camera: Align marks at `machine`, not `design` (Apply clears the
  marks, so `design` is only the unaligned job's place); fiducials where
  a found look puts them, else at the job's own coordinates; corners, the
  Find mark, every marker. Top camera: its frame is the nozzle's place
  (topCenter = head + offset), so home_fiducial, mark_at, found fiducials
  and references' `at` go in as they are; references by look, corners or
  fiducial are left out (derived, or already shown). Bottom camera: the
  nozzle, with the camera's position as the center given to knownMarks;
  the picture's own `center` stays null so boxes are unchanged.
- Labels are placed greedily (right of the ring, else left, inside the
  view, clear of rings and labels placed) with a 0.62 em per letter
  estimate. Ring tooltips never show: the marks layer has
  pointer-events: none.
- Zoom typed: any value 1 to 8 in hundredths; stepZoom goes to the ZOOMS
  entry next to a typed zoom. The zoom is not kept per camera (the `key`
  option's comment in picture.ts said it was; it never was).
- Live numbers: picture.ts hands each loaded frame to watchFrames(key)
  watchers (head, up, top) with its zoom and whether pcbv's overlay is in
  the JPEG, so the numbers cost no extra frames and come only while the
  picture shows. Sharpness is the RMS Sobel gradient in levels per pixel,
  which depends on zoom and frame size, so the best seen restarts when
  naturalWidth x naturalHeight @ zoom changes. Noise is Immerkaer's mask
  over all pixels, then twice over pixels within 3 noise deviations of
  flat (edges left out); JPEG smooths noise, so it is relative only.
  Clipped means level <= 5 or >= 250; an edge is 8 levels/px or more.
- With a board loaded and Overlay on, pcbv's marks are in the JPEG and
  count as edges: the block says so rather than asking for unmarked
  frames (the picture would change under the operator).
- Frames from another origin (dev server with ?api=) taint the canvas and
  the block says the pixels are unreadable; crossOrigin was not set, since
  it blanks the picture wherever the backend's CORS does not list the page.
- happy-dom gives no canvas pixels: the stats view takes `read` and `now`
  for tests; the measures are tested on synthetic arrays.
- layout/check.ts serves through Bun's reloading bundler: editing a source
  file while it runs reloads the page and kills the check with "Execution
  context was destroyed", which is no finding.

## Known places and specks (2026-11-13)

Built by an agent (spinny d88cf05, cfdb100; pcb-vision 9fe6966..1534d52,
fast-forwarded on its main, release pcbv rebuilt).

- Before: a look or search used the camera's scale (a fifth either way),
  the top camera's paste and parts placed, and corners taken (rule-out and
  default box); not a place found before (each search restarted its
  consensus), the Align marks, the references or the job's own place.
  Stops went nearest the camera first and pcbv searched with no hint.
- A search now takes the first known place of: corners, found before (per
  job, in memory; a look's find, or a search's only once its check
  agreed), the Align fit (head) or references (top), the job's own place
  (head only: the top camera's job frame is not the machine's). Its stops
  start nearest that place, and each stop's pcbv `reset` carries `near`
  (the KiCad point and turn under the picture's center, within_mm,
  within_deg). Tolerances: found 2 mm / 3 deg; marks and references
  max(2 mm, 3 x rms) / 3 deg; corners corner_mm (+ diagonal/10 with one);
  the job's own place max(5 mm, diagonal/4) / 15 deg.
- It orders, never decides: pcbv tries the hypotheses near the place
  first, then the rest, with rivals and hold budget as before. The check
  stop resets pcbv with no place, so a known place cannot make a wrong
  lock pass the check; a recheck resends the stop's place. A gate was not
  taken: it would hide rivals outside its window and let a pose one pitch
  off inside it win. No soft weight toward a place found before either:
  it would pull toward a moved board's old place, exactly when a search
  is run again. Look for board (no search) tells pcbv nothing.
- near_fields builds the turn numerically (the picture's +x through the
  known place and the design map's inverse from three points) in pcbv's
  convention; checked against SeenBoard's corners, front, mirrored, back.
- A pcbv older than `near` answers {"ok": true}: only `near: true` counts
  (state `board_look.known`, guided vs unguided stops, in the record too).
  The real-pcbv test runs the first pcbv on PATH or the sibling build and
  skips an old one.
- Specks: thousands of 2 to 6 px specks filled pcbv's stage-two sample
  and pulled the explained share under a fifth (pac1944 bare at 3000
  specks: 0 of 12 locked). pcbv now also samples the 32 largest spots and
  weighs spots by area for close fits (rms <= 1.5 work px): 12 of 12 there.
  Specks the size of real pads (3 to 8 px) still beat pac1944 bare at
  2000: size cannot tell them apart. No speck floor from the scale: vias
  are as small as the harmful specks. Numbers in pcb-vision's
  notes/localizer.md; `mise run clutter` there redoes the survey.
