# The nozzle's tip over the bottom camera (2026-11-19)

What the bottom camera's finder takes for the nozzle's tip, why the
nozzle routine takes up backlash before every look, and what was measured
on the user's LumenPnP that evening.

## Glare taken for the tip

- Symptom: *Center nozzle* with the page's 1 mm step stopped with "the
  nozzle left the picture on the move along X: use a shorter step". The
  user suspected the scale or a bounding box. Neither: the scale kept on
  2026-11-15 (47.4 um a pixel) was right, no crop was set for the
  `nozzle` task, and pcbv's `spot` reaches a third of the picture's height
  from its center (240 px, 11 mm there), against 21 px for the 1 mm move.
- Cause: `spot` answers the blob of that shade nearest the picture's
  center. Under the ring light, N1's tip throws glare off its chamfers and
  steps: slivers 15 to 30 px long and 3 to 5 px wide (24 to 120 px in
  all), often nearer the center than the tip's lit end, that jump 20 to
  50 px between head places 0.25 mm apart and change with the light's
  angle. The routine followed whichever was nearest, so it measured
  nonsense (2026-11-15: "the spot moved 21 px for the step along X and 11
  px for the one along Y"), centered a speck, or lost it after a move. Over
  a 5 by 5 grid of head places 0.5 mm apart plus six turns (32 pictures)
  the nearest bright spot was glare in 19.
- Fix: a look for the tip (*Center nozzle*, *Measure runout*, and *Look
  once* at the nozzle, so it shows what a routine will take) asks pcbv for
  `min_roundness` 0.5 and `min_area` 60 px of a 1280x720 picture, in
  proportion to the picture's area at other sizes (`nozzle_limits`,
  pnp.py). The 32 pictures replayed through `pcbv serve --camera FILE`:
  the tip in all 32. Area alone (100 px) still took long slivers (108 and
  120 px, roundness 0.13) twice; roundness alone (0.65) a round speck (24
  px, 0.67) once. The tip's lit end: 292 to 384 px, roundness 0.72 to 0.97.
- What it refuses: a tip whose lit end is under about 60 px (0.4 mm
  across at 47 um a pixel), or one lit to a crescent. The routine's error
  then says what the finder takes. The dark look found nothing near the
  tip: its bore, about 5 px across, is under the detector's floor in the
  shrunk picture.
- Not built: the circular symmetry finder at the bore that
  docs/CV_WHOLE_PICTURE.md sketches. Tried on these pictures: the tip's
  rings are not concentric in the picture once the tip is off the lens's
  axis (their centers drift 11 px from the outer ring to the end with the
  tip 1 mm off: heights seen in perspective), so a score over the tip's
  whole width lands off the bore. It has to be confined to the end.

## calibrate() refuses unequal or skewed moves

- calibrate() refuses X/Y steps that did not show as equal moves at right
  angles (lengths over 1.25x apart or 15 degrees off square): before, a
  half-lagged picture or a wrong spot gave a garbage scale that the
  centering then chased out of the picture.

## Backlash in the scale step

- The scale step's second move (to +Y) turned X round, and the LumenPnP
  has about 0.06 mm of play (its Y, measured from a 0.25 mm step), so the
  moves the scale was measured over came out short: 49.9 um a pixel,
  against 47.6 and 47.9 measured over 3 mm with the play taken up and 47.4
  from a fit of the 25 grid places. Centering stopped 0.048 mm off after
  its four tries, each move landing short.
- Fix: every place the nozzle routine looks from is reached moving toward
  +X and +Y from TAKE_UP (0.3 mm) short of it (`_approach`): the first
  look, the scale step's three, each centering move, and the runout's
  place. On the machine the scale then came out 47.7 um and centering
  ended 0.013 mm off.
- The place kept is the head's place that puts the tip over the center
  when reached that way. Other moves to the camera (a placing run's look
  at a part) arrive from where they come, up to the play off. Marlin's
  backlash compensation (M425) or one-sided positioning is the general
  fix; neither is done.
- The roll from a 1 mm step is good to about 1.4 degrees (half a pixel over
  21 px): 178.68 measured against about 179.9 from the grid's fit. A longer
  step narrows it (3 mm on the LumenPnP keeps the tip within 65 px of the
  center).

## The LumenPnP's bottom camera on 2026-11-19

- The place kept on 2026-11-15, (240.077, 218.330), came from a centering
  that followed glare: 3.3 mm from the tip's center, about the radius of
  the tip's outer ring. Centered again with both fixes: (241.417,
  215.261), 47.7 um a pixel, roll +178.68, mirrored; then *Measure runout*:
  185 um, the tips 8 um rms off the circle, turning counterclockwise as the
  profile says (it keeps the place again, (241.426, 215.306)). The two
  places are 0.046 mm apart, about a pixel: how far the lit end's center
  wanders between looks, which a finder aimed at the bore would narrow.
- The scale from the grid: 21.17 px a mm along X and 21.05 along Y, X and Y
  within 0.5 degrees of the picture's axes.
- Q61 (answered yes): N1 may be lowered over the bottom camera to take
  pictures for the nozzle finder, since a finder cannot be graded without
  pictures of a tip. The user had left N1 at Z 4 over the camera; these
  were taken there with X and Y jogs only (the program lowered it only in
  the routines, at the camera's place). One height so far: the second the
  question named (to see the tip out of focus) is not taken.
- The 32 pictures and their head places are kept in the checkout's
  var/surveys/20261119-lumen-nozzle (not in git): stops.jsonl has each
  stop's head place, turn and the backend's look, around head (242.505,
  215.21) at Z 4. The scripts that took and graded them are beside the
  other surveys' in var/surveys/tools (nozzlewalk.py, filtergrade.py).

## A file's camera place is a guess (2026-11-20)

After Forget, the bottom camera's place falls back to the machine file's
`[up_camera] position` while a scale measured before stays kept, and the
place read as measured: a run took parts to the file's place and lowered
them there (the stock LumenPnP file's is 180 mm off, over a tape). A place
that is the file's is now `guessed`, a start for centering and Over
camera, never measured. Over camera, Center nozzle and Offset by bottom
camera still go to it and lower N1 without a look first, as designed; the
flag would make a guard one line.
