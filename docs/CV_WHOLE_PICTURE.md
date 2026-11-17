# Board vision, fourth pass: the whole picture (2026-11-17)

What was tested, read up on and built to make the board look better, with
no machine attached: every number is from the pictures and records the
three LumenPnP sessions kept ([CV_HARDWARE.md](CV_HARDWARE.md),
[CV_REVIEW.md](CV_REVIEW.md)). One board (an OreSat battery card, blue
mask, a clear film over part of it) under one camera and light. Nothing
here has run on the machine.

## In short

| | Before | After |
| --- | --- | --- |
| Pictures locked right, of 586 with the head's place known | 205 | 351 |
| Pictures locked wrong | 74 | 0 once pcbv trusts its new search, 42 in a first picture |
| A view of 4 to 9 pads locked right | 1 of 61 | 53 of 61 |
| A view of 10 to 19 pads | 7 of 71 | 58 of 71 |
| A view of 20 to 39 pads | 30 of 68 | 66 of 68 |
| A view of 40 pads or more | 167 of 176 | 174 of 176 |
| The battery card sweep, 167 pictures | 58 right, 26 wrong | 114 right, 0 wrong |

"Before" is pcb-vision 5d67045 as the backend asks it (the scale 3
percent either way, the lens); "after" pcb-vision f008be5. The 586
pictures are the two sweeps of the battery card and a third of the stop
pictures of the 68 searches recorded on 2026-11-15; a lock is right
within 0.5 mm of the sweep's truth.

What that buys a search, read from the stop pictures of the eleven long
runs recorded on 2026-11-15 (each picture given to the old and the new
pcbv on its own; no search was run again):

- **A scan over the board** (three runs of 84 stops): 30 or 31 stops
  locked right before, 68 now, of the 74 that show four pads; the first
  stop locks where the third did.
- **A whole-bed search from nothing** (eight runs of 39 to 76 stops): no
  sooner. The first right lock comes at the same stop, the lattice's
  first on the board; the stops before it show the bed. Travel is what
  such a search costs, as [CV_REVIEW.md](CV_REVIEW.md#speed) found.
- So the gain is where a look already has board under it: a search
  started on or near the board, checks free to go where they spread
  best and not only where pads are densest, and a board scan whose
  pictures are each placed by their own lock.

## Tested: where the look fails

- **By how many pads a picture shows.** pcbv was right in 45 of the first
  sweep's 48 pictures showing 40 pads or more and in 2 of the 95 showing
  under 20. Over half of this board is that sparse (the cells'
  footprints, the edges), which is why a search's first stops on the
  board often saw nothing and why checks had to go to the pad-richest
  places.
- **Two of the first sweep's 169 pictures are not of their place.** Stops
  24 and 46 hold the picture of the stop before (they correlate 0.99 and
  0.999 with it, no other pair over 0.76): the camera gave no new frame
  for a moment (pcbv took one look in that second where it takes two to
  four) and the sweep kept its last one. Stop 46's lock, right for the
  picture it shows, had been counted wrong, and CV_REVIEW read it as a
  repeated circuit 8 mm away; 8 mm is the sweep's step. The baseline
  leaves both out now and the sweep asks again for a picture taken after
  the head came to rest (below).
- **The wrong lock a picture "cannot settle" was a QFP turned half
  round.** Picture 73 shows the microcontroller's four rows of pads, which
  pass the spots' checks at every quarter turn. The whole picture tells
  them apart (0.91 against 0.80).
- **What fools a whole-picture score.** Two holes of a feeder's tape
  match two round pads at 0.86, and a picture of three pads lies at 0.6
  to 0.7 on a place that shows seven. A score says how alike two pictures
  are, not how much there was to compare: hence the rules below.

## Read up on

A research pass (an agent with web access; its report is not kept in the
repository) looked for what others do about these failures. What was
used, with how each source was read:

- **A picture against a drawing of the design.** No readable paper
  compares methods for a design render against a board photo. The
  nearest documented practice correlates gradient directions of a
  CAD-simulated image (an Applied Materials patent for CAD to SEM, seen
  as an extract). Normalized cross-correlation by Fourier transform is
  the standard search (Lewis 1995; Padfield's masked form, CVPR 2010,
  both read), and
  against a two-level drawing the correlation ratio equals its square, so
  it is the right measure across the two kinds of picture (the agent's
  derivation). Phase correlation and mutual information fit this case
  poorly.
- **How sure a peak is.** Published thresholds (a peak to sidelobe ratio
  of 7, a peak ratio of 1.2 to 2) do not carry over, and Bolme (MOSSE,
  2010, read) says the ratio "is not useful" for plain template
  correlation: calibrate on labeled pictures, which the sweeps are. Wrong
  peaks near 0.4 in dense views are far above noise, so they are the
  board's own repeats, not chance.
- **The turn.** The best document-deskew methods get within 0.1 degree in
  68 to 77 percent of cases (the DISEC 2013 contest's table as
  Bezmaternykh and Nikolaev reprint it, read); 0.05 degree across a 20
  mm picture is one
  pixel. So a picture's own turn stays coarse and the fine turn comes
  from locks far apart, as the search already does. Measured here too:
  the turn from gradient directions looked exact only through the pixel
  grid's help.
- **Stale frames.** uvcvideo stamps a buffer when its first packet
  reaches the host, after the exposure; OpenPnP ignores stamps and sleeps
  250 ms or waits for frames to stop changing (source read).
- **A nozzle's tip from below** ([below](#the-nozzles-tip-not-built)).
- **Glare.** A lighting guide prefers changing the light's geometry to
  polarizers; in software, a color channel the glare is dark in (done:
  the least of the three colors) or the least of two pictures taken with
  the head shifted (not done).

Sources, as the agent read them (the paper or source file itself unless
said otherwise):

- Lewis, Fast normalized cross-correlation (1995),
  http://scribblethink.org/Work/nvisionInterface/nip.pdf
- Padfield, Masked FFT registration, CVPR 2010,
  https://iacl.ece.jhu.edu//proceedings/cvpr2010/papers/1815.pdf
- Registration of CAD data with SEM images, US20160035076A1 (an extract),
  https://patents.google.com/patent/US20160035076
- Bolme, Beveridge, Draper and Lui, Visual object tracking using adaptive
  correlation filters, CVPR 2010,
  https://www.cs.colostate.edu/~draper/papers/bolme_cvpr10.pdf
- Bezmaternykh and Nikolaev, A document skew detection method using fast
  Hough transform, https://arxiv.org/pdf/1912.02504
- OpenPnP at its main branch of 2026-02-27:
  https://github.com/openpnp/openpnp/blob/main/src/main/java/org/openpnp/machine/reference/ReferenceNozzleTipCalibration.java ,
  https://github.com/openpnp/openpnp/blob/main/src/main/java/org/openpnp/vision/pipeline/stages/DetectCircularSymmetry.java ,
  and its camera settling under
  https://github.com/openpnp/openpnp/tree/main/src/main/java/org/openpnp/machine/reference/camera
- Opulo's nozzle pipelines,
  https://docs.opulo.io/openpnp/v4/vision-pipeline-adjustment/4-nozzle-calibration-pipeline/ ,
  and its bottom camera page (an extract),
  https://docs.opulo.io/openpnp/v4-1/issues-solutions/fundamental/bottom-cam-pos/
- Loy and Zelinsky, A fast radial symmetry transform, ECCV 2002 (in
  parts), https://link.springer.com/content/pdf/10.1007/3-540-47969-4_24.pdf
- Linux's uvcvideo driver,
  https://github.com/torvalds/linux/tree/master/drivers/media/usb/uvc
- Martin, A practical guide to machine vision lighting (in parts),
  https://www.rauscher.de/fileadmin/user_upload/AdvancedIllumination/A-Practical-Guide-to-Machine-Vision-Lighting-Second-Edition.pdf

Not found: a measured sub-pixel accuracy for correlation against a
design render, a measured latency of UVC MJPG capture, and any prior use
of differencing two head places to find a nozzle's tip. One paper on
design-referenced board registration (Electronics 15(22):5320) refused
the fetch and is unread.

## Built

In pcb-vision ([notes/dense.md](https://github.com/tmpk13/pcb-vision/blob/main/notes/dense.md)
has the method, the measurements behind each rule and what it does not
cover):

- **A look through the least of red, green and blue**, first on a masked
  board: white pads are high in all three, this board's mask and the
  film's glare are not. pcbv's own search alone went from 369 right and
  92 wrong (of 1085 pictures) to 441 and 92.
- **A whole-picture search** beside the spots' search, for a camera
  whose scale is measured: the picture is correlated with the drawn pads
  at every place on the board for the turns worth trying, and the best
  places are refined in place, turn and scale. It locks views of 4 pads
  and more, moves a loose lock onto the picture, replaces a lock turned
  by a part's own symmetry, and refuses a lock the picture does not fit
  once one lock on the board has fitted (wrong locks score 0.05 at the
  median where right ones score 0.90).
- **Rules that held on every kept picture:** a lock by the whole picture
  scores 0.6, shows four pads, and has four spots on them or scores 0.75.
- A search frame takes 0.1 s more where the spots lock and 0.4 s where
  they do not (a release build on this laptop).

In this repository:

- A pose's match is the larger of its pairs' share and the whole
  picture's score (`boardlook.match_of`), for the vote and the posterior
  alike: a view of four pads the spot finder saw two of is as good as
  the picture says. A low score lowers nothing here; refusing is pcbv's,
  which knows whether its search can be trusted on the board.
- `GET /api/pnp/top/frame.jpg` says how old its picture is
  (`X-Frame-Age-Ms`, `X-Frame-Number`), and `spinny-survey sweep` asks
  again until the picture was taken after the head came to rest, marking
  a stop `stale` when none comes; grades leave stale stops out.
- The survey baseline (`survey_baseline.json`) leaves the two stale stops
  out and holds a fourth case, the whole-picture search trusted: 114
  right, 0 wrong of 167. The cases that changed are explained there.

## Not verified, not built

- **Nothing ran on the machine.** How searches change (time to a first
  lock from nothing, the stops a known place needs, the stop rule's
  count of pcbv's searches, with about 0.7 s more at a stop on the board
  that locks nothing) is not measured; the pictures say only what one
  look gives.
- **One board, one light.** The thresholds are from the battery card's
  pictures. Synthetic pictures of another board (white silk, gold pads)
  lock 20 of 23 sparse views with none wrong, which is all that stands
  behind other boards. A bare board's locks are checked but its sparse
  views are not locked.
- **A first picture can still lock wrong** (42 of 586 with each picture
  its own pcbv): the refusal waits for one lock that fits. A backend's
  pcbv keeps that trust while the board stays loaded.
- **Views of one to three pads** never lock, and a view of no pad has
  nothing to match: tracks under the mask, silk text and the board's edge
  are not in the drawing.
- **Placed parts** are left out of the comparison as silk is, and no
  picture of a populated board has graded that.

### The nozzle's tip (not built)

TODO.md says finding the nozzle's center is really bad; on 2026-11-14 the
routine tracked a static spot. No picture of a tip over the bottom camera
is kept (the three in `var/surveys` were taken at the stock file's place,
which holds a tape), so nothing could be graded and nothing was changed.
What the reading says to build once there are pictures:

- OpenPnP finds the tip by circular symmetry (the variance between
  concentric rings against the variance within them) inside a window
  around the expected place and a band of diameters, takes six pictures a
  turn, and throws the measurement away when more than one result
  remains. It does no differencing. Opulo ships fixed pixel diameters
  aimed at the bore and warns that reflections make it take the wrong
  circle, with "repeat and adjust exposure" as the remedy.
- The test that tells a tip from a static spot is the head's own move:
  between two head places the tip moves by a known amount and everything
  fixed to the camera cancels. Take the tip from the difference of
  pictures at two or three head places (or from each picture less the
  per-pixel median over them), then its center by a symmetry or circle
  fit at the bore, aimed at the dark hole since highlights on the rim
  turn with the nozzle. Two turns of the nozzle cannot do this: a
  centered round tip does not change.
- Keep OpenPnP's frame around it: the expected place, a diameter band,
  exactly one result, and a limit on the circle fit's residual for the
  runout (OpenPnP only shows it).

Q61 in QUESTIONS.md asks for the pictures this needs.
