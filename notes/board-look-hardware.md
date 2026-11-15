# The board look on real pictures (2026-11-14)

First session on a LumenPnP's top camera over an OreSat battery card;
the numbers are in docs/CV_HARDWARE.md. Decisions and traps:

- Without a scale pcbv rarely locked a 20 mm view of a populated board
  (1 frame in 260 live): its hundredfold scale range spends the search's
  budget on wrong scales. pcbv now tries the whole range and then
  threefold windows (pcb-vision notes/localizer.md, Scale windows). The
  windows also lock pictures at half the true scale with a high share of
  their pads paired, so the backend still sends a scale when it has one:
  measured (a fifth either way), else the file's `[top_camera]
  mm_per_px` as designed (1.5 times either way, DESIGN_SCALE_SPREAD).
- The look's estimate turned the board by the roll in use less pcbv's
  angle, so a roll 0.4 degrees off turned every found board 0.4 degrees.
  A guess whose looks span 20 mm (PLACES_MM) now fits the job points
  under the pictures' centers to the machine places of those centers:
  roll-free, 0.01 to 0.07 mm on ten real searches. Closer places keep the
  median; a fake test board's stops lie closer, so its test lowers
  PLACES_MM. `roll_off` is the fit's turn less the looks' median turn.
- The roll and scale a search measures are kept at once as a finding
  (`picture`, Undo takes it back). Since 2026-11-15 (21792e2) a measured
  scale stays (the scale offered is pcbv's newest lock's, possibly a wrong
  check's: 16.13 um became 16.47) and the roll is rewritten only past 0.3
  deg: one search's roll scatters 0.07 deg and carries the axes' skew
  where its places lie along one axis (180.43 to 180.61 against Measure
  camera's 180.33).
- MIN_MATCH 0.5 is the vote's alone: the posterior weighs every lock by
  its own likelihood. A weak lock is refused in BoardLook.sample, before
  the consensus, so `seen` is `locked` and a stop with only weak locks
  ends at LOCK_SECONDS (counted as used, they held every quick scan stop
  over a feeder's tape for STOP_SECONDS). The record keeps the weak
  estimate with its problem, and Consensus.see refuses it again in a
  replay, at the record's own `min_match` (0 for older records).
- After a search gave up on its checks, the watcher kept calling the
  refuted guess found and remembered it as found: the next search started
  there. The consensus now restarts when a search gives up on its checks
  (not on a stop or an empty box: Stop search keeps the guesses).
- Quick scan: with nothing known and a `bed` in the file the search's
  stops are a lattice QUICK_SHARE (0.6) of the board's shorter side
  apart, then the lattice halfway between, each walked as a nearest-next
  path (sorted by distance from the start they jumped side to side). A
  bed box in a G-code request is the picture's center, head + offset:
  a box given in head places searches 23.5 by 65 mm beside the board on
  a LumenPnP.
- The battery card's middle is bare (the cells): checks over the middle
  see nothing and the check's move to the pad-richest place matters.
- The stock LumenPnP places (bottom camera, homing fiducial) did not
  match this machine: look with the top camera before lowering a nozzle
  anywhere. Home now lifts first once the backend homed the machine.

## Second session, the same night (CV_DIRECTION.md's items)

- Measure camera (topcam.measure_picture, pictures.py): pcbv hands over
  luma (`frame` format gray, pcb-vision bf6c52b) so the backend needs no
  JPEG decoder. A parabola through three pixels of the phase correlation
  pulled 12.3 px shifts to 12.1 (the peak is too narrow): the peak is
  refined by an upsampled inverse DFT. Full whitening let a soft
  picture's empty frequencies pull 0.4 px to 0.1: whitened by the square
  root of the magnitude. The head rings after a move: a fixed 0.25 s left
  1.1 to 2.1 px rms over the grid, so pictures are taken until two in a
  row agree within 0.3 px, and places are reached from one side. Runs
  repeat to 0.2% at one place but differ 0.8% between places (16.07 to
  16.10 um a pixel over the board's surface, 15.94 to 15.98 where parts'
  tops fill the picture): measure over the board's own surface; pcbv's
  scale (16.09 to 16.16) agrees with that.
- Empty pictures: the share of strong edges (contrast 30 on a 320 px
  luma picture) separated 126 board pictures (1 under 0.03) from 100 bed
  pictures (88 under 0.03). pcbv's spot count (up to 427 on a feeder's
  tape) and its candidates' matches (0.4 to 0.58 off the board) did not.
  Thresholds are module constants in pictures.py, tuned on one machine.
- pcbv's service panicked on a bare bed (a lock's scale outside the range
  emptied the next search's range, pcb-vision 2665515) and the search read
  125 stops as "no lock" for 448 s: a search now ends on a dead pcbv.
- The board's bare middle locks only wrong: checks and a known place's
  first stops go where the job puts the most pads in a picture, 20 mm
  inside the outline, the checks spread by farthest point among places
  holding half the best's pads; two places 25 mm apart put the middle
  0.12 mm off.
- The top camera's Look once answered 500: the backend's board look
  attribute `top_look` hid the method of that name (now top_look_once).
- Second backend: killing the user's backend was refused, so the session
  ran its own on port 8010 with SPINNY_HOME=var/lumen-home (machines and
  cam linked, a copy of the config and the battery card's job); its
  records were in var/lumen-home/var/searchlog until the next afternoon's
  searches pushed them out (below).
- Bottom camera: not at the file's (61.92, 219.82) but at about (241.98,
  217.10) (the top camera centered on its lens from above); N1 sent there
  and lowered to Z 4 showed its tip centered within a few px, so the top
  camera's offset is the file's within about 0.1 to 0.2 mm. Center nozzle
  then failed at its scale step (its spot moved 4 px for 1 mm moves: not
  the tip); pcbv's spot finder also refuses the lens (17% of the picture,
  its cap is 5%). Not yet kept in the file.
- The session's survey scripts are spinny-survey (survey.py, mise tasks
  survey, survey-grade, survey-baseline, survey-searches). The grade's
  robust fit is evalsurvey's to the step (pairs 5 mm apart propose, 0.5
  mm votes, three refits at 1 mm), so the cached answers give 106 / 52 /
  54 / 0.069 mm and 116 / 48 / 68 / 0.070 mm again; pcbv bf6c52b gives
  the same afresh (23 s with 4 at once: locate is one thread, 0.3 s of
  its 0.4 s the 6 MB board's load).
- The baseline grades against a truth kept in survey_baseline.json, not
  a fit of the build's own answers: a build that locks wrong the same way
  often enough could otherwise move the truth. Worse means fewer right,
  more wrong, or the right rms up by more than 0.005 mm; --write keeps
  what was measured, worse too, so lowering the bar is a choice.
- Answers are kept per pcbv build (its file's sha256), board and options
  (grades/KEY in the survey), so a rebuilt pcbv grades afresh and a
  second grade of the same build costs nothing. grade keeps a fit as the
  survey's truth.json only when more locks agree with it than with the
  one kept.
- A search estimate's center is in machine places (head + the camera's
  offset, the stop's `target`), the survey's truth in head places: the
  searches grade adds the record's picture.offset and goes through its
  board_to_job and middle. The session's eight searches from the board's
  corners and edges grade to 0.13 to 0.23 mm and 0.42 to 0.49 degrees
  off, as CV_HARDWARE.md says.
- Everything after -- goes to pcbv: argparse gives a positional list
  declared after a positional nothing that comes after an option, so
  main splits argv at -- itself.
- Checked on the virtual LumenPnP (ports 2347 to 2349, backend 8461):
  sweep keeps 640x480 pictures (pcbv's frame shrinks, never enlarges, so
  --width 1280 gives the camera's own size) and searches run to their end
  and are kept with their records; the virtual camera needs a scale set
  (PUT /api/pnp/top mm_per_px) before a search, and its board shows only
  an outline, so nothing locks there.

## Third session, 2026-11-15 afternoon (CV_REVIEW.md on the machine)

- The search log prunes by size (searchlog.MAX_BYTES 200 MB, 60
  records) and every record keeps a copy of the board's KiCad file (6 MB
  for the battery card): about 30 searches pushed the second session's 28
  records out, silently. Copy a home's searchlog away before a session
  and after each batch (this one's: var/surveys/20261115-lumen-cv-review).
- A search "from nothing" needs the head off the board when the camera
  starts: the look at rest finds the board otherwise, remembers it as
  found, and the next search starts from that known place (a 6 s whole
  bed). found_places lives in memory only; a backend restart clears it.
- `POST /api/pnp/top/search` with a box searches it picture by picture
  (refused past 400 stops); with no box and nothing known the backend
  scans the file's bed on the board-sized lattice, as the night did.
- pcbv's served frames (`frame`, the survey's JPEGs) are the camera's
  own: the lens it is given corrects what it detects, not the picture, so
  stitching models carry the lens themselves.
- The vote waited LOCK_SECONDS at every stop pcbv could not lock; since
  52275a1 it ends them on pcbv's search count as the posterior did (board
  scan 197 to 103 s). The `searched` end stays the posterior's: the vote
  counts tracked poses as looks.
- Travel 200 mm/s in the LumenPnP file since c8cf980 (no step lost,
  frames still on arrival). Marlin here: M203 X/Y 1500, M201 10000, M204
  T3500, 320 steps/mm.
