# Board vision review: speed, accuracy, wrong locks

A review of the board look and search after the two LumenPnP sessions of
2026-11-14 and the camera crops of 2026-11-15, with changes ranked by what
they buy. [CV_DIRECTION.md](CV_DIRECTION.md) judges the work so far and
[CV_HARDWARE.md](CV_HARDWARE.md) holds the sessions' numbers; this file
adds what replaying their pictures and records shows, and what the
literature and other machines do. Every number here was measured for this
review on those pictures and records unless it says "modeled" or cites a
source. [Method](#method) says how. The surveys are kept in `var/surveys/`
on the machine that took them; the second session's search records were
in `var/lumen-home/var/searchlog/` until the log's size cap pruned them on
2026-11-15 (each record keeps a copy of the board's KiCad file, 6 MB here,
and the log keeps 200 MB), so their replays cannot be run again. The
afternoon's records are kept in
`var/surveys/20261115-lumen-cv-review/searchlog/`.

## In short

| Change | Buys | Evidence |
| --- | --- | --- |
| [Scale window to +-2%](#narrow-the-scale-window) once the camera is measured (now +-20%) | pcbv's search 75 to 9 ms median; wrong locks 54 to 46, right 52 to 55 | measured |
| [End a stop on evidence](#end-stops-on-evidence), not on a clock | 6 of 18 known-place searches spent 5 to 27 s waiting out stop clocks | measured |
| [Correct the lens](#correct-the-lens) | turn scatter 0.30 to 0.19 deg a picture; place error 0.064 to 0.040 mm rms | measured |
| [Square the machine's axes](#square-the-machines-axes), 0.13 deg off | up to 0.23 mm across a 100 mm board, in every placement | measured twice |
| [Fit each picture to what is unknown](#fit-each-picture-to-what-is-unknown): place and turn, with the camera's measured scale and roll | a live lock read the turn as -2.2 deg (truth 0.17) and held its search 10 s | code, records, literature |
| [Center the final looks on their pads](#center-the-final-looks-on-their-pads) | removes lens, height and scale error at the center | OpenPnP practice |
| [Travel at 200 mm/s, settle by frames](#travel-faster-settle-by-frames) (now 100 mm/s and a fixed 0.25 s) | whole bed 40 to about 24 s; with a board area 21 to about 13 s | modeled |
| [Weigh locks by a fitted likelihood](#weigh-locks-by-a-fitted-likelihood) | wrong locks passing: 9 to 3 (right 52 to 50); the 3 left need a second place | measured |
| [Grade before trusting placed parts](#placed-parts-make-the-checks-lenient) in pcbv's model | every part placed: right locks 55 to 14, wrong 40 to 83 | measured |
| [Give the posterior the board crop](#camera-crops) | a cropped picture now counts pads pcbv never looked at | code |
| [Grade against a truth from the same session](#a-truth-from-the-same-session) | 18 known-place finds sit 0.065 mm from the first session's truth, scattering 0.04 mm | records |

Not recommended: learned matchers (LightGlue, XFeat, RoMa and their
cross-modal kin). None is tested on a rendered layout against a photo, the
CPU-fast ones say they are weak on repeated patterns, and the dense ones
want a GPU ([3](#sources)).

## Status, 2026-11-15

Applied the same day and measured offline, on the survey's 169 pictures
and the second session's 23 search records; then run on the machine the
same afternoon ([on the machine](#on-the-machine-2026-11-15)).

| Change | Where | Measured |
| --- | --- | --- |
| Scale window +-3% when the camera is measured (not +-2%: room for the board's height) | spinny ab5d015 | survey: 54 right, 44 wrong (+-20%: 52, 54) |
| pcbv fits a similarity, its scale held to a window within +-5% | pcb-vision 69bde3b, 5605458 | survey at +-3% with the lens: 86 locked, 58 right, 28 wrong, right rms 0.048 mm, turn scatter 0.11 deg (the old shipped options: 106, 52, 54, 0.069 mm, 0.28 deg); kept as the survey baseline's `measured` case (1c10b03). The second session's 282 search pictures at +-3%: 55 right, 8 wrong (the old pcbv 54, 15); with the lens 55, 11, the right ones 0.028 mm (median) from where their search found the board |
| Stops end on evidence; a lock agrees by its center point | spinny 4a31a7b | `spinny-search stops` on the 23 searches: 53.8 of 448.3 s saved, the slowest known-place search 17.3 to 5.9 s, no outcome lost |
| The vote too ends a stop without a lock on pcbv's searches | spinny 52275a1 | on the machine, a board scan of 84 pictures with the vote: 197 s, 103 s after |
| A search keeps a measured scale; rewrites the roll only past 0.3 deg | spinny 21792e2 | on the machine every search rewrote both, the scale once by 2% |
| The posterior's match weight fitted to the graded locks | spinny d484d78 | 49 records of both sessions: 2 more boards found, one whole-bed search 50 s sooner, the wrong places of three searches held at a tenth of their old probability, none called found |
| Checks centered on their pads | spinny c530934 | survey: right locks whose pads' middle lies within 1.5 mm of the picture's center err 0.030 mm (median), 3 to 5 mm off 0.057 |
| The board crop in the posterior and the checks | spinny c530934 | tests only: the LumenPnP file sets no crop |
| Measure camera measures the lens, and the scale at the picture's center | spinny 370726d | grid calibration pictures: k1 0.025 to 0.027, the tiles' residual 0.93 to 0.58 px; the survey with that lens (old pcbv): right rms 0.069 to 0.050 mm |
| A stop's pictures trusted once two frames agree | spinny 882a65f | on the machine, 497 stops at 100 and 200 mm/s: the frames agreed as the head arrived at 495 (the other two within 0.11 s); the first trusted frame 0.078 s after arrival (median, 90% within 0.156) against the fixed 0.25 |
| A third place in the final fit | spinny 105727d | survey right locks 20 mm or more apart: the board's middle 0.18 mm off (rms) from two places, 0.11 from three, 0.08 from four |
| Placed parts | not changed | the survey board is mostly bare (32 of its 229 front parts on their pads, [MOSAIC_INSPECTION.md](MOSAIC_INSPECTION.md)), so `--placed all` told pcbv bodies that are not there (14 right, 69 wrong against 56, 16 for none, +-1%): no grade of a board with parts placed yet. A change made on that misreading was reverted (ba97c58); the section below rests on it too |
| Frames stamped with the V4L2 buffer's time | pcb-vision d88e201 | the LumenPnP's top camera: the stamp 32 ms (median) before the dequeue, a frame |
| Axes 0.13 deg out of square | QUESTIONS.md Q48 | with the new pcbv the survey's leave-one-out error is 0.049 mm rigid, 0.033 affine: a third of what is left |
| The survey stitched, and parts checked in it | spinny cbf1b4e, c6f2584: [MOSAIC_INSPECTION.md](MOSAIC_INSPECTION.md) | seams 81 um rms from the head's places, 25 with the lens, the backlash, a tilt and the board's relief fitted; the board's pads 22 um (median) off an affine refit, which finds the axes 0.121 deg out of square from the board alone; a bare footprint told by the color between its pads 96% of the time, a 0.2 mm offset 70 to 80%, 0.1 mm 20 to 40%, a passive's half turn not at all |
| Travel at 200 mm/s | spinny c8cf980 | on the machine: a whole-bed search from nothing 33.5 s at 100 mm/s, 23.9 to 28.9 at 200 (its moves 27.6 to 17.9 s, as modeled); no step lost |
| A truth from the same session | done on the machine | the afternoon's survey of the same grid graded the board 0.4 um and 0.003 deg from the night's truth: it had not moved |
| A gate on the lock's rms and scale | not applied | at +-3% the logistic fit on match, rms and scale separates no better than match alone (cross-validated AUC 0.961 against 0.965) |

## On the machine, 2026-11-15

The LumenPnP with the battery card the night's sessions left, through a
backend of its own home (`var/lumen-home`), the head moved in X and Y at
the safe height only. The board had not moved: the first whole-bed search
found it 0.01 mm and 0.04 deg from the night's truth, and the afternoon's
own survey of the same grid graded it 0.4 um and 0.003 deg from it
(middle 151.833, 335.646 where the picture's center sees it, turned 0.168
deg). Searches started from the night's head places, five a set.

| | The night | The afternoon |
| --- | --- | --- |
| Measure camera | 15.94 to 16.10 um a pixel, roll 180.31 to 180.40 | 24.6 s: 16.06 um at the picture's center, roll 180.33, the axes 0.16 deg out of square, lens k1 +0.0257 (0.30 mm at the corners) |
| Whole bed, nothing known, vote | 43.6 s | 33.5 s at 100 mm/s; 23.9 and 27.9 s at 200 |
| Whole bed, nothing known, posterior | 39.8 s | 34.3 and 69.0 s at 100 mm/s; 24.6 to 28.9 s at 200 (four) |
| Place known, vote | 3.1 to 4.2 s; 0.025 to 0.052 mm | 4.0 to 4.5 s (one set 2.9 to 6.3, one search 10.3); 0.015 to 0.046 mm, a set within 7 to 15 um |
| Place known, posterior | 2.2 to 3.4 s, one 17.3; 0.07 to 0.09 mm | 3.6 to 5.0 s, 3.0 to 3.5 at 200 mm/s; 0.053 to 0.080 mm |
| Board scan, 84 pictures | not run | vote 197 s, 103 s since 52275a1; posterior 86 s |

- Known-place searches take a second longer than the night's typical
  ones: the third final place costs about 1.1 s, and on this board the
  farthest dense place often locks a repeated cell 39 mm off (3% over the
  scale, its rival 0.86), so that check disagrees and stays out of the
  fit. None waited out a clock (the night's slowest, 17.3 s, did).
- The vote's places sit 0.015 to 0.046 mm from the truth, the
  posterior's 0.053 to 0.080, about 0.04 mm lower in Y in every set. Both
  fit their looks' points to the head's places (placed_estimate), but the
  posterior's first stop brings one look where the vote's brings five, so
  the check places weigh more in its fit. Not chased further.
- The posterior missed the board once in six whole-bed searches (69.0
  s): at the first stop over it pcbv locked the right place weakly (17 of
  27 pads, rms 0.16 mm), which the fitted match weight counts as no
  evidence (exp(15 (0.63 - 0.65)) = 0.74); the stop ended after its one
  search and the scan came back to the board 30 s later. The vote called
  the same lock found in 0.6 s.
- 200 mm/s lost no step: the vote found the board within 0.02 mm at 100
  mm/s after the fast runs as during them (a full step is 0.05 mm here).
  Marlin allows far more (M203 1500 mm/s, M204 T3500) and Opulo's own
  file travels at 283 mm/s; the LumenPnP file travels at 200 since
  c8cf980.
- Exposure to stamp (the ring light switched 40 times by `M150`, frames
  read as luma with pcbv's age, each placed by its V4L2 stamp): a frame
  stamped at s gathers light from about s - 6 ms (its top rows) to s + 27
  ms (its bottom rows), one frame of rolling readout. A frame stamped 10 ms
  or more after a move ended holds nothing of the move.
- Every search that found the board rewrote the camera: the roll it read
  from the head's moves (180.43 to 180.61 against Measure camera's 180.33:
  it scatters 0.07 deg and carries the axes' skew), and with it pcbv's
  newest lock's scale, which may be a wrong lock's (a measured 16.13 um
  became 16.47 in two searches). Since 21792e2 a measured scale stays and
  the roll is rewritten only past 0.3 deg.
- The afternoon's survey stitches as the night's did: 82 um rms on the
  head's places, 71 with Measure camera's numbers (the night's lens fitted
  to its seams gave 68), 57 with the camera refitted and a 29.5 um
  backlash, 27 with a tilt and the board's relief
  ([MOSAIC_INSPECTION.md](MOSAIC_INSPECTION.md#on-the-machine-2026-11-15)).

Left open: the posterior's weak first lock; check places on this board
that repeat (pick ones whose pads have no twin within the scale window);
the vote's and the posterior's final places apart; a board scan's stops
still wait the fixed settle (look_scan_stop); the axes' skew (Q48); and,
with pcbv's turn scattering 0.10 deg a picture on the afternoon's survey,
the posterior's ROLL_DEG (0.3) and the vote's AGREE_DEG (1) can come down.

## Speed

Where the second session's searches spent their time:

| Search | Total | Moves | Settle and busy test | pcbv looks | Stops |
| --- | --- | --- | --- | --- | --- |
| Whole bed, nothing known | 39.8 s | 27.0 s (2100 mm) | 10.7 s | 1.0 s | 38 |
| Bed with no area, nothing known | 90.4 s | 55.7 s (4365 mm) | 21.4 s | 11.3 s | 75 |
| Place known, typical (4 of the 5 newest) | 2.2 to 3.4 s | 1.1 to 2.1 s | 0.6 to 0.9 s | 0.2 to 0.6 s | 2 |
| Place known, the slowest of the 5 newest | 17.3 s | 2.7 s | 1.9 s | 12.6 s | 5 |

Moves are two thirds of a scan and the fixed settle a quarter. pcbv itself
costs little, except where a stop waits out its clock.

### Narrow the scale window

`SCALE_SPREAD = 0.2`
([vision.py:52](../web/backend/src/spinny_web/vision.py#L52)) gives pcbv
the scale within a fifth either way, even after Measure camera has measured
it to 0.2%. The survey's 169 pictures through pcbv with three windows:

| Window | Search, median | p90 | Hypotheses, median | Right | Wrong | Right rms |
| --- | --- | --- | --- | --- | --- | --- |
| +-20% (shipped) | 75 ms | 317 ms | 38,000 | 52 | 54 | 0.069 mm |
| +-2% | 9 ms | 173 ms | 3,800 | 55 | 46 | 0.083 mm |
| +-1% | 5 ms | 97 ms | 2,000 | 55 | 40 | 0.068 mm |

Right locks read the scale within 0.6% (median) and 1.5% (90%), which
holds the 0.8% between parts' tops and the board's surface: +-2% for a
measured camera, the wide window only for the design scale.

The window binds the search's hypotheses but not the refinement: `sane()`
([refine.rs:192](https://github.com/tmpk13/pcb-vision/blob/main/crates/vision/src/refine.rs#L192))
admits a local scale from half the window's low end to twice its high
end, so with +-1% the wrong locks still come out 4.6% off scale (median).
Holding the refined map to the window makes it a hard rule (see
[fit each picture](#fit-each-picture-to-what-is-unknown)).

### End stops on evidence

A stop ends `found`, `likely` or `agreed`, else after 2.5 s without a
lock or 5 s with one
([boardlook.py:1614](../web/backend/src/spinny_web/boardlook.py#L1614)).
The posterior pools every picture of one place into one view and keeps its
best candidate
([posterior.py:1272](../web/backend/src/spinny_web/posterior.py#L1272)),
so more pictures from one place cannot narrow its lead. Record
20261115-000051, on today's code: at its first stop the lead held 98% from
the first frame, but with a spread of 1.5 mm and 5.9 deg; at its second,
100% with 0.7 mm and 1.1 deg; each stop sat out its 5 s, and a third
stop's 2.4 s "no lock" followed: 13.3 of its 17.3 s. Six of the 18
known-place searches spent 5 to 27 s in stops that ended "time up" or "no
lock".

- "Likely" needs the stop's lock to agree with the lead within 0.5 mm
  *and 1 deg* (`agrees`, `_near`). The first stop's locks read the turn
  as -2.0 to -2.3 deg (see [fit each picture](#fit-each-picture-to-what-is-unknown))
  and never agreed. A picture's turn is its weakest output: let this
  check compare the board point under the picture's center only.
- With the posterior, end a stop once pcbv has searched it with each of
  its looks since the settled frame (its pose replies count searches;
  `search_cycle` in pcbv's localizer): staying adds nothing the view can
  use. The same count, not 2.5 s, should call "no lock"; at 5 to 10 ms a
  search that is a few tenths of a second.

### Travel faster, settle by frames

The LumenPnP file travels at `feed_xy = 6000` mm/min (100 mm/s), where
Opulo's machine allows 17000, with `M204 T3500`. The recorded moves fit a
trapezoid profile plus 0.13 s a move; Marlin 2.1 holds a lone move in an
empty planner up to 100 ms (`BLOCK_DELAY_FOR_1ST_MOVE`, [6](#sources)),
which is most of that overhead. Modeled:

| Feed | Whole bed, moves | Bed with no area, moves |
| --- | --- | --- |
| 100 mm/s (now) | 27.0 s (measured) | 55.6 s (measured) |
| 200 mm/s | 17.6 s | 35.9 s |
| 283 mm/s | 15.4 s | 31.2 s |

Every stop also waits `SETTLE_SECONDS = 0.25`
([camera.py:55](../web/backend/src/spinny_web/camera.py#L55)) for a frame
captured that long after the move ended: 9.5 s of the whole bed's 39.8.
pcbv stamps a frame when its capture thread dequeues it (`Instant::now()`
after `stream.next()`,
[camera lib.rs:254](https://github.com/tmpk13/pcb-vision/blob/main/crates/camera/src/lib.rs#L254)),
after the whole frame has crossed USB and queued, so the settle carries
that margin too.

- Stamp frames with the V4L2 buffer's timestamp (CLOCK_MONOTONIC, the
  clock Python's `time.monotonic()` reads). uvcvideo sets it when the
  frame's first USB packet arrives; measure the exposure-to-stamp delay
  once by switching the ring light (`M150`) and finding the first frame
  that changed.
- End the settle when two frames in a row agree (phase correlation of the
  busy test's 320 px luma under a tenth of a pixel), as Measure camera
  already does and OpenPnP's frame-difference settling does, with 0.25 s
  as the ceiling. Opulo's own OpenPnP file waits a fixed 800 ms a look.
- Raise `feed_xy` in steps and read the settle each speed needs from
  that test.

Together (modeled, 200 mm/s and a 0.1 s settle): whole bed 40 s to about
24 s, a bed with a board area 21 s to about 13 s, a known place 2.2 to
3.4 s to about 1.3 to 2.2 s.

Larger and later: a fixed wide camera over the bed would put the board to
about a millimeter from one picture, so every search would start as a
known-place one (2 to 3 s). A flying busy test saves only the stops'
overhead, not travel, so it is not worth building for this.

## Accuracy

The random part of a lock's error is small: tens of pads at a fraction of
a pixel each come to about a micrometer. The 0.045 mm median error of a
right lock is systematic, and the changes below remove the parts of it
that were measured.

### Correct the lens

Phase correlating 96 px tiles of the grid calibration's start picture
against the same scene after its 3 mm head moves (235 tiles, 16 pairs)
shows a local scale 2% smaller at the picture's left edge than in its
middle; a radial fit puts the distortion near 0.2 mm in the corners
(pcbv's lens term k1 about 0.017; a rough fit, over a board partly
under a clear film). The survey graded with that lens,
on the 52 pictures every case locked right (scale +-1%, error against an
affine fit, see [the axes](#square-the-machines-axes)):

| Lens (`--lens k1,0`) | Turn scatter, sd | Place error, leave-one-out rms | median |
| --- | --- | --- | --- |
| none | 0.30 deg | 0.064 mm | 0.031 mm |
| 0.008 | 0.25 deg | 0.046 mm | 0.028 mm |
| 0.0166 | 0.19 deg | 0.040 mm | 0.027 mm |
| -0.008 (wrong sign, a control) | 0.29 deg | 0.052 mm | 0.031 mm |

The control helps the rms too (any change moves a few borderline
pairings), but only the right sign moves the turn and the median.
CV_DIRECTION freezes lens correction; this says it is worth about a third
of the place error. Measure it properly: pcbv's `calibrate` on the burned
calibration card, or as OpenPnP's advanced calibration does, moving one
feature along radial lines across the picture, at two heights to get the
scale's change with height as well ([4](#sources)). Measure the scale on
the board's surface (pads or the bare middle), not over parts' tops.

### Square the machine's axes

Fitting the survey's right locks to the head's places with an affine map
instead of a rigid one puts the X and Y axes at 89.86 to 89.89 degrees in
every case graded (both windows, every lens); Measure camera saw 89.88 from
head moves alone. The rigid map leaves it as error: rms 0.069 to 0.060 mm,
leave-one-out 0.071 to 0.064 (with the lens on: 0.058 to 0.046). 0.13 deg
is 0.23 mm across 100 mm, and it moves every placement, not only the look.

- Compensate it in the machine's coordinates before any fit: OpenPnP's
  non-squareness factor (tan 0.13 deg = 0.0023 of Y added to X), or
  Marlin's `SKEW_CORRECTION` (`M852`) where the firmware has it built in.
  Take the factor from Measure camera's axes or a survey's affine fit.
- Then fit the board rigid in corrected coordinates; keep the affine fit
  for measuring the skew.

### Fit each picture to what is unknown

pcbv's refinement takes "the richest map the pairs determine that fits no
worse than a simpler one"
([refine.rs:259](https://github.com/tmpk13/pcb-vision/blob/main/crates/vision/src/refine.rs#L259)).
A homography always fits no worse, so every right lock in the survey is
projective. Its turn scatters 0.28 to 0.30 deg a picture and its scale
0.9%, where Measure camera repeats to 0.02 deg and 0.2%. Record
20261115-000051's first stop shows it on hardware: the right place, but
pcbv's rms 0.16 mm, its scale 0.7 to 2.6% low and the homography's corners
0.6 to 0.7 mm (rms) off a rigid map at the camera's scale, which read the
board's turn as -2.0 to -2.3 deg (truth 0.17). That spread held the
posterior's lead at 1.5 mm and 5.9 deg (see
[end stops on evidence](#end-stops-on-evidence)).

A homography fitted to pads bunched in part of a picture is unstable and
bends where the board goes on past them; a simpler model chosen by
geometric AIC is more accurate (Kanazawa and Kanatani; Torr's GRIC does
the same, [8](#sources)). With the camera's scale, roll and lens measured,
only the board's place and turn are unknown in a picture: fit those three
(scale held to the measured value or the window), and the place alone
once the places across looks give the turn. At the scatter measured, a
free turn and scale cost 24 and 45 um at 5 mm from the pads' centroid;
projective terms add more on one-sided pads.

### Center the final looks on their pads

A non-telecentric lens moves a point by its scale change times its
distance from the picture's center: part tops 0.8% finer, 8 mm out, sit
64 um off, and lens and scale errors grow the same way. At the center they
vanish, which is why OpenPnP's fiducial locator looks again centered on
what it found until it moves under a few micrometers ([4](#sources)).
`check_places`
([boardlook.py:1658](../web/backend/src/spinny_web/boardlook.py#L1658))
picks places with the most pads in view; put each check's picture center
on the centroid of the pads it expects there instead, so the board point
under the center is interpolated, not extrapolated.

### More places in the final fit

The final place is a rigid fit of looks 20 mm or more apart
(`placed_estimate`). Looks from one place share their errors, so the fit
improves with places, not frames: a third place cuts the error by about a
fifth. With faster stops a third check costs under a second; place the
checks to straddle the board's middle.

### A truth from the same session

The second session's 18 known-place searches put the board's middle on
average 0.065 mm from the first session's survey truth, (+0.054, -0.036),
and scatter 0.04 mm (sd, each axis) about that mean; the look at rest put
it 0.09 mm from that truth at the session's start. Much of the posterior's
"0.07 to 0.09 mm off" is the truth's, not the estimator's. No `G28` went
out between the survey (19:09) and the second session (22:48) by the wire
logs, but two `M410` quick stops did (19:52:59): a stop without
deceleration can cost steps, or the board moved in its holder.

- Survey the truth in the same session as the searches it grades.
- Look at one dense place before and after a quick stop.
- A REV05 LumenPnP homes X and Y on switches, which Opulo corrects with a
  homing fiducial after every home (OpenPnP's visual homing,
  [7](#sources)). Do the same at a mark the top camera has seen on this
  machine (the stock place holds a tape), and log each correction: their
  spread is the homing's repeatability, which nobody publishes.
- Approach every look from the same side, as Measure camera and Opulo's
  file do, to keep the 8 to 18 um backlash out.

### The camera to nozzle offset

As CV_DIRECTION item 8 says: the 0.1 to 0.2 mm it is known to moves every
place found, and nothing above matters for placing until it is measured to
a few hundredths.

## Wrong locks

### Weigh locks by a fitted likelihood

The survey labels its locks right or wrong (95 to 106 per case). How each
field separates them, scale window +-1% (AUC: 0.5 is chance, 1 or 0
perfect):

| Field | Right, median | Wrong, median | AUC |
| --- | --- | --- | --- |
| match (paired of expected) | 0.85 | 0.32 | 0.96 |
| pcbv's rms | 0.068 mm | 0.17 mm | 0.07 (lower is right) |
| scale off the camera's | 0.55% | 4.6% | 0.10 (lower is right) |
| spots in the picture | 156 | 93 | 0.89 |
| explained share | 0.27 | 0.24 | 0.69 |
| rival ratio | 0 | 0 | 0.51 |

With the shipped window, `match >= 0.5` passes 9 wrong locks; adding
pcbv's rms under 0.12 mm and the scale within 2% passes 3, at the cost of
2 right ones. The posterior weighs a candidate by `(match / 0.5) ** 4`
([posterior.py:178](../web/backend/src/spinny_web/posterior.py#L178)), with
P_MAX, FEATURES_HALF and CLUTTER set by hand. Fit P(right | match, rms,
scale off) to the graded locks (logistic, two or three fields,
cross-validated) and use its odds; refit as boards are added. The
principled form of pcbv's coverage threshold is a significance test
against chance: astrometry.net accepts a match only past a Bayes factor of
1e9, the a contrario test (Moisan and Stival) when the expected number of
equally good chance fits is under one. Both charge pads predicted but not
seen and spots left unexplained, and scale themselves to a dense or a
sparse picture ([1](#sources)).

### What one picture cannot settle

The 3 wrong locks every filter keeps (survey pictures 46, 67 and 73) are a
repeated circuit 8, 40 and 5 mm from the right place, two of them at the
right turn. No test of one picture can tell them apart; a second place or
a prior can. pcbv should report every significant mode with its odds, not
only the best, so the copies reach the posterior as separate hypotheses
for `look_value` to split; only a feature outside the repeated unit
confirms, as the star trackers' Pyramid method does with its fourth star.
The vote cannot represent this; the posterior can.

### Placed parts make the checks lenient

The backend tells pcbv the parts a job has placed
([placing_part.py:468](../web/backend/src/spinny_web/placing_part.py#L468)).
On the survey board, scale +-1% (the board turned out mostly bare, so
`all` told pcbv bodies that are not there: see the status above):

| `--placed` | Right | Wrong | Right rms |
| --- | --- | --- | --- |
| none | 55 | 40 | 0.068 mm |
| unknown | 46 | 69 | 0.087 mm |
| all | 14 | 83 | 0.121 mm |

With parts placed, their pads count as unsure and spots over their bodies
are not held against a pose, so a wrong pose pays little. A re-find in the
middle of a job would lock wrong this often. Grade a board part way
through a job before relying on it, and consider counting placed parts'
pads as not expected instead of unsure.

## The posterior

The direction in CV_DIRECTION stands: the posterior reads empty pictures
as evidence and refused both wrong places with no rule written for them.
Split its jobs as search and localization practice does ([5](#sources)):

- **Where to look:** next where P(board in picture) x P(lock there) /
  time is largest (Blackwell's rule, optimal for a target that stays
  put). `look_value` does more work for the same choice, and counts every
  look as `LOCK_SECONDS` long where an empty picture costs 0.28 s.
- **When it is found:** when the lead's odds against every other mode
  pass a threshold set by the cost of a wrong answer, so repeated-circuit
  modes keep the search going.
- **Where it is:** one continuous least-squares fit over all of the lead's
  looks (as `placed_estimate` already does), not the mixture's mean.

Longer term, a likelihood surface per look (Olson's maximum-likelihood
matching: each pad scores log(a N(d) + (1 - a) p) on a distance transform
of the picture's spots, searched coarse to fine with a max pyramid) would
give the posterior a likelihood with every mode in it and an uncertainty
from the peak's shape, in place of candidates weighed by hand
([2](#sources)).

## Camera crops

The crops that landed on 2026-11-15 (spinny 7bc130c and fdaa98c,
pcb-vision d75f4c0) filter pcbv's spots to the box and check a pose only
against the features it puts inside it, in raw pixels before the lens:
sound, and free (detection still runs over the whole picture, about 2 ms
of a search). Two things to change:

- The backend's own picture geometry does not know a `board` crop. The
  posterior's `features_in` and `look_value`
  ([posterior.py:516](../web/backend/src/spinny_web/posterior.py#L516))
  and the check places' `held_counts`
  ([boardlook.py:1622](../web/backend/src/spinny_web/boardlook.py#L1622))
  count pads over the whole picture. With a board crop set, a picture that
  locked nothing counts against every place whose pads lay outside the
  box, which pcbv never looked at, and checks are chosen for pads it will
  not see. A View should carry the crop's box (its size and its center's
  offset).
- A board crop is no substitute for the lens: it trades pads for less
  distortion. With the lens corrected, keep the board crop to the whole
  picture.

## Sources

1. Matching against chance. Lang et al., astrometry.net, AJ 139:1782
   (2010), https://arxiv.org/abs/0910.2233 ; Mortari et al., Pyramid
   star identification, Navigation 51(3) (2004),
   https://doi.org/10.1002/j.2161-4296.2004.tb00349.x ; Moisan and
   Stival, a contrario RANSAC, IJCV 57(3) (2004),
   https://doi.org/10.1023/B:VISI.0000013094.38752.54 ; Breuel, RAST
   branch and bound, CVIU 90(3) (2003).
2. Likelihood surfaces. Olson, maximum-likelihood template matching,
   TPAMI 24(6) (2002),
   https://faculty.washington.edu/cfolson/papers/pdf/pami02.pdf ; Olson,
   correlative scan matching, ICRA 2009,
   https://april.eecs.umich.edu/pdfs/olson2009icra.pdf ; Ulrich and
   Steger, matching accuracy on real images, ISPRS 2002 (under 1/20 px).
3. Learned matchers. XFeat, CVPR 2024, https://arxiv.org/abs/2404.19174
   (27 FPS on a laptop CPU, weak on ambiguous pairs); LightGlue, ICCV
   2023, https://github.com/cvg/LightGlue ; RoMa, CVPR 2024,
   https://arxiv.org/abs/2305.15404 ; MatchAnything (2025),
   https://arxiv.org/abs/2501.07556 . Repetition defeats feature matching
   on PCB pictures: EHIR, Pattern Recognition Letters (2024).
4. Calibration on placing machines. OpenPnP advanced camera calibration,
   https://github.com/openpnp/openpnp/wiki/Advanced-Camera-Calibration ;
   the fiducial locator (re-looks centered),
   https://github.com/openpnp/openpnp/blob/develop/src/main/java/org/openpnp/machine/reference/vision/ReferenceFiducialLocator.java ;
   non-squareness,
   https://github.com/openpnp/openpnp/wiki/Linear-Transformed-Axes ;
   settling, https://github.com/openpnp/openpnp/wiki/Camera-Settling ;
   backlash, https://github.com/openpnp/openpnp/wiki/Backlash-Compensation
5. Search and decisions. Stone et al., the AF447 search, Statistical
   Science 29(1) (2014), https://arxiv.org/abs/1405.4720 ; Blackwell's
   rule, https://arxiv.org/abs/2103.09310 ; Wald's SPRT (1945); Hess et
   al., Cartographer's branch and bound then continuous fit, ICRA 2016,
   https://research.google.com/pubs/archive/45466.pdf
6. The loop. Marlin 2.1.2.5 planner.cpp (`BLOCK_DELAY_FOR_1ST_MOVE`),
   https://github.com/MarlinFirmware/Marlin/blob/2.1.2.5/Marlin/src/module/planner.cpp ;
   V4L2 buffer timestamps,
   https://docs.kernel.org/userspace-api/media/v4l/buffer.html ;
   uvcvideo's stamping, drivers/media/usb/uvc/uvc_video.c in Linux.
7. LumenPnP homing. Releases (v4.0.0 back to limit switches),
   https://github.com/opulo-inc/lumenpnp/releases ; Opulo's homing
   fiducial, https://docs.opulo.io/openpnp/v4/calibration/4-homing-fiducial/ ;
   OpenPnP visual homing,
   https://github.com/openpnp/openpnp/wiki/Visual-Homing
8. Model choice. Torr, GRIC, Phil. Trans. R. Soc. A 356 (1998),
   https://doi.org/10.1098/rsta.1998.0224 ; Kanatani, geometric AIC,
   IJCV 26 (1998); Kanazawa and Kanatani, homographies from concentrated
   points, LNCS 2018 (2001), https://doi.org/10.1007/3-540-45296-6_3

## Method

- Survey grades: `uv run spinny-survey grade 20261114-lumen-battery-grid
  --pcbv PCBV --cache DIR -- --finish masked --scale LO:HI
  [--lens K1,0,1280x720] [--placed all|unknown]`, pcbv built from
  pcb-vision c26d8cf. The +-20% case reproduces the baseline (106 locked,
  52 right, 54 wrong, 0.069 mm).
- Lock fields, affine fits and leave-one-out errors: numpy over the
  graded rows (`survey.row_of`, `survey.grade`), the truth refitted per
  case.
- Time budgets: the `stop`, `arrived`, `busy` and `stop_end` events of
  the second session's 28 records; moves modeled as trapezoids at
  3500 mm/s^2 plus the 0.13 s overhead a move measured.
- Lens: tile phase correlation (Hann window, parabolic peak) of the grid
  calibration pictures (`var/surveys/20261114-lumen-gridcal`), then the
  survey graded with the fitted term and a wrong-sign control.

Not verified: anything on the machine. The faster travel and shorter
settle are models; the lens term is a rough fit; the
sources were read by a research pass, some only in summary.
