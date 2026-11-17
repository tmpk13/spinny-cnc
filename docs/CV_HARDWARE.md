# The board look on a LumenPnP: first hardware data

The top camera's board look and search, measured on a real machine for
the first time (2026-11-14), what the numbers said, and what changed
because of them. Decisions and their reasons live in the commits named
here; the pictures and records are kept on the machine that took them
(`var/surveys/`, `var/searchlog/`), not in git. The programs that took
and graded them are in the repository: `mise run survey` (the sweep),
`survey-grade`, `survey-baseline` and `survey-searches` (spinny-survey),
and `search-report` for the search records.

## The setup

- An Opulo LumenPnP with the Rev05 board (Marlin bugfix-2.1.x, built
  2024-09-19) on `machines/opulo-lumen-rev5.toml`, its top camera
  ("LumenPnP Top") at 1280x720 MJPG and 30 fps, manual exposure 78, the
  ring lights on. Both cameras and the controller sit behind one USB 2.0
  hub; both cameras streamed 30 frames a second together with no USB
  errors.
- The board: an OreSat battery card (github.com/oresat/oresat-batteries,
  `oresat-battery-card`, commit 031b458), populated, blue mask, a clear
  film over it, on the bed in its holder. The middle of the board is bare
  (the four cells' footprints).
- pcbv as built from github.com/tmpk13/pcb-vision at 1a2d4fb (the scale
  windows below).

## The camera, measured by moving the head

A 3 x 3 grid of head places 3 mm apart, twice, against the first
picture (phase correlation of the whole picture):

| | X | Y |
| --- | --- | --- |
| mm a pixel (head moves) | 0.01595 | 0.01610 |
| machine axis in the picture | 179.65 degrees | 269.53 degrees |

The picture is turned about 180.4 degrees and not mirrored (the stock
top camera is mounted upside down; Opulo's OpenPnP flips it in X and Y).
The axes show 89.88 degrees apart, the fit's residual is 0.9 px rms, and
a return to the start shows 0.5 to 1.2 px (8 to 18 um) of backlash.
pcbv reads 0.01609 to 0.01616 mm a pixel off the board itself.

## pcbv on single pictures

The top camera swept over the board's extent and a margin: 169 pictures
8 by 7.5 mm apart, each with the head's place read back. Each picture
went through `pcbv locate`; one rigid fit of the board to the machine
through every picture's center, robust to wrong locks, is the truth the
pictures are graded against (the board lies turned 0.17 degrees).

| pcbv told | locked | right | wrong | right, rms |
| --- | --- | --- | --- | --- |
| the scale within a fifth | 106 | 52 | 54 | 0.07 mm |
| no scale (scale windows) | 116 | 48 | 68 | 0.07 mm |

This sweep is the baseline every pcbv change has to beat: `mise run
survey-baseline` grades it against the truth and the numbers kept in
`web/backend/src/spinny_web/survey_baseline.json` and fails when a build
has fewer right locks, more wrong ones or a worse rms. The table above is
the session's pcbv (pcb-vision bf6c52b gives the same); the file holds
what today's pcbv reaches, with two of the 169 stops left out since
2026-11-17: they kept the picture of the stop before
([CV_WHOLE_PICTURE.md](CV_WHOLE_PICTURE.md)).
17 of its pictures (nine right, five wrong, three off the board) are a
test fixture in pcb-vision (`fixtures/survey/battery`), run by its
`cargo test`.

In a 6 mm patch over a dense part of the board every picture locked
right, the centers agreeing to 0.031 mm rms. Right locks lie over the
board's dense interior; the wrong ones lie within about 15 to 25 mm of
its edges and off it (the holder's clamps, the bed, a feeder's tape):
turned 90 or 180 degrees, one of the card's four repeated circuits, or
at half the scale. They pair few of the pads pcbv expects: right locks
paired 0.64 to 0.98 of them, wrong ones a median of 0.32 (90% under
0.52). Without any scale pcbv locked one frame in about 260 live (135 s)
and 5 of the patch's 18 pictures: over its hundredfold scale range the
wrong scales used up the search's budget.

## The system's own looks and searches

- The look at rest found the board 180 degrees off before the file said
  the camera's roll, and only after 135 s; now in about 5 s, turned 0.15
  degrees.
- Ten searches from the board's corners, edges and off it, all with the
  place found before known: found in 8 to 11 s, 0.13 to 0.23 mm off,
  turned 0.42 to 0.49 degrees off: the roll in use was 180, the camera's
  180.4. Taking the turn from the head's places (below), the same records
  replay to 0.01 to 0.07 mm and within 0.1 degree.
- Two searches with nothing known, started at the board's edge: each
  called a wrong place found (locks pairing a third of the pads) and
  failed all three checks; the second started from the first one's
  refuted place, which had been kept as found.
- A search with nothing known after the quick scan went in: the head
  started off the board, and the scan of the whole travel (128 stops)
  found the board at its 105th stop, 400 s in, 0.10 mm and 0.08 degrees
  from the sweep's truth, and offered roll 180.38 and 15.97 um a pixel to
  keep. Its first lattice put two stops on the board, 17 and 20 mm inside
  its edges, and pcbv locked nothing there; the first stop of the lattice
  halfway between locked and found it in 3 s. 96 of the 107 stops saw no
  lock and took 3.7 s each: a bed narrowed to where boards lie is the
  quickest way to a quicker scan.

## What changed

- pcbv searches scale windows when no scale is known (pcb-vision
  1a2d4fb): 18 of 18 locked without a scale.
- The LumenPnP file says the top camera's roll (180), its scale as
  designed (0.0161 at 1280x720) and its bed (the whole travel); the
  OpenPnP import reads a camera flipped in X and Y as roll 180 (1fe9be8,
  f45f1a4, fbbc33b).
- A guess whose looks were taken 20 mm apart or more takes its turn from
  the head's places, which no roll error touches, and says how far the
  roll is off (2ed87b6); the search then offers the roll and pcbv's scale
  as a finding to keep, so the picture is measured without a mark
  (ef2daa2).
- The vote leaves out locks pairing under half of what they should show
  (0a12371), refused before the vote so a stop seeing only those ends at
  the lock time (d0b777a).
- A guess every check disagreed with is forgotten (e79f592).
- A search with nothing known scans the file's bed on a lattice spaced
  by the board's size (fbbc33b), walked as one path (d0b777a).
- Searches take the look's newest locked scale when none is measured
  (837c979), and the file's design scale after it.
- Home lifts the nozzles to the safe height first once the backend has
  homed the machine (fdf93a3): the LumenPnP's G28 moves X and Y where Z
  stands.

## Second session: CV_DIRECTION.md on the machine

The same night, the same machine and board (it had not moved: the look
at rest put it 0.09 mm and 0.05 degrees from the first session's survey
truth, which every number below is measured against: middle 151.83,
335.65, turned 0.17 degrees).

| | Before | After |
| --- | --- | --- |
| Camera scale and roll | a session script | Measure camera, 16 to 19 s, no mark; repeats to 0.2% and 0.02 degrees at a place |
| Whole bed, nothing known (vote) | 400 s | 43.6 s; 23 s with a board area in the file |
| Whole bed, nothing known (posterior) | not run | 39.8 s |
| Place known (vote) | 8 to 11 s | 3.1 to 4.2 s, 0.025 to 0.052 mm (five starts) |
| Place known (posterior) | not run | 2.2 to 3.4 s (one 17 s), 0.07 to 0.09 mm |
| Empty stop | 2.8 s | 0.28 s |
| Posterior replay of the 400 s scan | over 240 s | 51 s |

- Measure camera (3 x 3 grid, twice, places reached from one side,
  pictures taken once two in a row agree): 15.98 um a pixel and roll
  180.395 at one place, 16.07 to 16.10 and 180.31 to 180.33 at another,
  each repeating to 0.2%. The difference follows what fills the picture:
  parts' tops lie nearer the camera than the board's surface, and pcbv's
  16.09 to 16.16 off the pads matches the surface.
- Empty pictures: the share of strong edges told the battery card (126
  pictures, 1 under 0.03) from the bed, its holder and feeders' tapes
  (100 pictures, 88 under 0.03). On the whole bed 32 of 37 stops ended
  empty in 0.28 s each; the rest of the time is moves.
- The board's bare middle as a check gave only quarter turns 10 to 19 mm
  off and ran out its time; checks at the dense places agree in 0.5 to
  0.8 s.
- One search ran 448 s against a pcbv whose service had panicked (a scale
  range emptied by a wrong lock's scale; pcb-vision 2665515); searches now
  end on a dead pcbv.
- The 18 records, replayed through both methods against the truth: of 12
  searches each found the same 11 (the twelfth ran against the dead
  pcbv), none wrong, the posterior's place closer at the moment of
  calling in 9; of 6 looks at rest the vote called 2 found, the posterior
  none (0.44 and 0.45: one place cannot settle it).
- The bottom camera is not at the file's place: the top camera found its
  lens at about 241.98, 217.10 (the file says 61.92, 219.82). N1 sent
  there and lowered to Z 4 showed its tip centered within a few pixels in
  the bottom camera, so the top camera's offset is the file's within
  about 0.1 to 0.2 mm. Center nozzle then failed at its scale step (the
  spot it tracked was not the tip).

## Not measured yet

- The bottom camera's place to better than a millimeter, its scale and
  roll, nozzle centering and runout: Center nozzle failed on its spot.
- The homing fiducial's place on this machine.
- No part was picked or placed.
