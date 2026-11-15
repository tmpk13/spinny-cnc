# Mosaic inspection: the top camera's survey stitched, parts checked

Can the top camera's pictures, stitched into one mosaic, check a board
after placing: parts missing, shifted or turned? Measured offline on the
battery card survey of 2026-11-14 (`var/surveys/20261114-lumen-battery-grid`
on the machine that took it: 169 pictures, 1280x720, on a 13 by 13 grid
of head places 8 by 7.5 mm apart). [CV_HARDWARE.md](CV_HARDWARE.md) has
that session and the camera's measured map, [CV_REVIEW.md](CV_REVIEW.md)
the lens and the axes' skew. Code:
[stitch.py](../web/backend/src/spinny_web/stitch.py) (camera model, seams,
adjustment, mosaics) and [inspect.py](../web/backend/src/spinny_web/inspect.py)
(the layout as a bare board shows it, part crops, checks, synthetic
defects), tested by `web/backend/tests/test_inspect.py`.

## In short

- Seams: head places and the camera map as measured leave 81 um rms (55
  median). The lens takes that to 68, the axes' skew changes nothing
  visible, the camera refitted with a 28 um backlash to 58, and the
  board's relief (parallax: its surface about 1.5 mm higher at one end
  of the head's travel) to 29 um rms, 21 median: one window's noise.
- Board map: KiCad's pads land 41 um median from the survey's truth; an
  affine refit leaves 22 um and finds the machine's axes 0.121 deg out of
  square from the board alone.
- Parts, with no learned model: presence works when it looks at the gap
  between the pads (its color found 96% of bare passive footprints, its
  brightness 91%, no placed part called missing), not by correlation
  with a golden; a 0.2 mm offset is found 70 to 80% of the time, 0.1 mm
  20 to 40%; a passive's quarter turn half the time, 5 deg 70 to 80%;
  180 deg on a passive cannot be told. Single pictures do as well as
  the mosaic.
- Verdict: a mosaic is worth building as the board's measured map, not
  as the picture parts are judged in. One survey (176 s here) gives the
  board's place to 22 um with the skew, the camera's scale, roll, lens
  and backlash, the board's relief, and a picture for people. Parts are
  judged as well in the one picture that sees each nearest its center,
  which a golden board can match place for place; a mosaic blends two
  views of a part's top that its parallax sets 60 um apart.

## What the survey holds

- Not the populated card CV_HARDWARE.md says. Read by eye from crops of
  the 229 front parts' footprints pictures cover whole: 175 bare, 32 0603
  passives on their pads, 4 lying visibly off them (C10, C57, R80, R91),
  9 unclear; no IC, transistor or diode placed. A few more chip parts lie
  loose. A clear film covers the top two thirds.
- The KiCad file is a newer revision (4.1, 2026-11-01) than the board
  (silkscreen v4.0, 2026-10-06): nine of its footprints are not on the
  board (C19, C69, D11, D12, D16, Q45, R122, R43, U18).
- The cell holders' contacts (B1 to B4) are copper bared by mask
  rectangles drawn apart from the pads, slots drilled 0.2 mm off center:
  windows over them register 0.2 to 0.26 mm off the layout, and the
  board map leaves them out.

## Stitching

Every picture placed at its head place through the camera model; in each
overlap of two pictures, 2.6 mm windows (160 px) every 2 mm, rendered from
both pictures onto the same machine places and phase correlated (each
window read again at what was found until under 0.01 px is left: a
windowed correlation reads short). A seam is where picture j puts a
feature less where picture i puts it. Counted: windows 1.5 mm or more
inside the board's outline with a correlation peak of 0.3 or more; one
over 0.1 mm from its pair's median is a failed registration, left out
(1.4 to 5.9%). Micrometers:

| Model | Terms | Windows | rms | 90% | 99% | max | median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| (a) head places, 0.0161 mm a pixel, roll 180.4 | 0 | 2568 | 81 | 130 | 218 | 336 | 55 |
| (b) + lens, k1 0.0166 | 0 | 3456 | 68 | 107 | 166 | 286 | 52 |
| (c) + axes 0.13 deg out of square | 0 | 3452 | 68 | 106 | 170 | 288 | 52 |
| (d1) camera refitted: its map, k1, k2, backlash | 7 | 3514 | 58 | 92 | 163 | 257 | 39 |
| (d2) d1 + tilt + the board's relief | 265 | 3515 | 29 | 43 | 74 | 257 | 21 |
| (d3) a shift per picture + k1, k2 | 340 | 3345 | 28 | 44 | 72 | 160 | 21 |
| (d4) a shift per picture + lens, tilt, relief | 598 | 2895 | 25 | 36 | 75 | 268 | 15 |

The (d) models were fitted to case (c)'s seams (Gauss-Newton, Huber
weights), then every seam was measured again under them. The max is one
misregistered window in every row; the 99th percentile is the tail.

- The lens is the largest error at first, since overlaps lie at the
  pictures' edges. Refitted with k2: k1 0.016 to 0.023, k2 0.009 to
  0.018, 0.23 mm at the middle of the long sides, 0.3 to 0.4 mm in the
  corners (few overlaps reach them).
- The given map is coarse for seams: the refit says 0.01599 mm a pixel
  (0.7% under 0.0161) and roll 180.34. The skew refits to 0.12 to 0.14
  deg (Measure camera: 0.13); over a 7.5 mm step it is 17 um, lost under
  the rest, so (c) gains nothing visible.
- Backlash: pictures reached moving +X lie 28.5 um from those reached
  moving -X (the scan alternates by row); Measure camera saw 8 to 18 um.
- The relief is the largest error after the lens: fitted on an 8 mm
  grid as the share by which a place shows larger, -1.0 to +0.8% over
  the board (2nd to 98th percentile), rising from the machine's lower
  left to its upper right. It is parallax: the surface lies nearer the
  camera on one side. The placed parts are the yardstick: their tops
  move 0.57% (0603 resistors, usually 0.45 mm tall) and 0.78% (0603
  capacitors, 0.8 mm) of the distance between two pictures, bare pads
  -0.07%. So the camera works about 90 mm above the board, and the
  board's surface lies about 1.5 mm higher at one end of the head's
  travel than the other: tilted against it, or bowed (Measure camera's
  scale changing 0.6% between two places says the same). Modeling it
  halves the seams.
- A shift per picture closes the seams as well (d3) but bends the
  mosaic: each picture's share of the relief becomes a shift, and the
  shifts add up. The board map through (d3) is 45 um median off and 0.4%
  too large, through (d1) 23 um. Head places and one camera hold the
  geometry; the relief belongs inside the pictures.
- What is left is the noise of one window: in one overlap, two windows
  2 mm apart differ by 17 um median, as much as the seams. The film makes
  no difference (22 um median without it, 20 um under it).

The mosaic, model (d2) flat-fielded by the median of all pictures and
blended by weights falling from each picture's center, shows seams only
where the film's reflections change. A part's top does not stitch: two
pictures 8 mm apart see an 0603 capacitor's top 60 um apart.

## The board as a measured map

The front layout as a bare board shows it (pads with their own mask
opening, the openings drawn apart over pads without one, drilled holes
dark) placed by the survey's truth and registered against the mosaic
(d2) in 4.1 mm windows every 4 mm, the search held within 0.3 mm (pads
repeat). 351 windows hold layout, 274 register with a peak of 0.3 or
more, 40 over the cell holders' contacts are set apart, 234 remain.
Micrometers:

| The board's place | Turn | Scale | Axes | rms | 90% | max | median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| the truth as kept | 0 | 0 | 90 deg | 52 | 80 | 143 | 41 |
| refitted rigid | -0.015 deg | 0 | 90 deg | 50 | 76 | 121 | 42 |
| refitted similar | -0.015 deg | -470 ppm | 90 deg | 48 | 70 | 120 | 40 |
| refitted affine | -0.018 deg | -330 ppm | 90.121 deg | 29 | 43 | 103 | 22 |

The truth (one rigid fit of pcbv's right locks) is right on average, 3
and 11 um off in X and Y, 0.015 deg in turn. The affine fit finds the
machine's axes 0.121 deg out of square, as the seams (0.12 to 0.14) and
Measure camera (0.13) do: from the board alone. A rigid truth in the
machine's coordinates cannot hold the skew and pays up to 0.1 mm at the
board's corners. 22 um median is how well the mosaic knows a pad's place,
and where the part checks below cut their crops (the truth refitted by
the affine map).

## Part checks

Each front part (not test points, connectors or cell holders) cropped in
its own frame (KiCad's footprint frame at angle 0, 16.1 um a pixel, 1 mm
of board around its courtyard) where the board map puts it, from two
sources, each a test and a golden from different pictures:

- single: the nearest picture of the even grid columns against the
  nearest of the odd columns;
- mosaic: the half-mosaic of the even columns (16 mm apart, still
  covering the board) against the half-mosaic of the odd ones.

`inspect.compare` aligns the test on the board around the part, then
over the part's body box (and its quarter turn) reads: correlation with
the golden, correlation with the layout's bare pads, the offset, the
quarter turn whose undoing matches best (90 or 270 flags a passive; 180
too for a part that is not symmetric) and the small angle about it.
Each threshold flags 2 in 100 correct parts. The real states give two
sets: the 32 placed passives cut out of the test crop and pasted back
moved, turned or left out (the hole filled with the layout's bare pads;
golden: the other picture, untouched), and the bare footprints; ICs and
polarized parts exist only as synthetic parts drawn from their layout
(dark body, metal ends or leads, a cathode band, a pin 1 dot).

Share flagged, by the check meant for the defect (by any check):

| Real 0603 passives (32) | Single picture | Mosaic |
| --- | --- | --- |
| correct (false alarms) | 6% | 9% |
| missing: the hole's layout pads (easy by construction) | 94% | 94% |
| missing: a real bare footprint of its package | 72% (78%) | 75% (84%) |
| shifted 0.1 / 0.2 / 0.5 mm | 19 / 69 / 72% (41 / 78 / 75%) | 41 / 81 / 69% (59 / 88 / 72%) |
| turned 90 | 50% (69%) | 50% (72%) |
| turned 180 | cannot tell | cannot tell |
| turned 2 / 5 deg | 6 / 72% | 9 / 81% |

| Synthetic, single picture | ICs (33) | Polarized (11) |
| --- | --- | --- |
| turned 90 / 180 | 100 / 70% | 91 / 91% |
| missing (bare pads) | 45% (58%) | 18% (55%) |

Presence without a golden, on the real states (single pictures; the
threshold flags none of the 32 placed parts):

| Bare footprints found | Passives (125) | Polarized (11) | ICs (33) |
| --- | --- | --- | --- |
| crop like the layout's bare pads, courtyard | 29% | 9% | 39% |
| the same over the body box | 74% | 45% | 64% |
| brightness of the gap between the pads | 91% | | |
| blue share of the gap's color | 96% | | |

What works and what does not:

- Presence is a question about the gap between the pads, not about the
  whole crop: bright pads look alike under a part's metal ends and bare.
  The gap's color (b / (r + g + b): 0.52 to 0.68 under a part, 0.70 to
  0.96 on the blue mask) or its brightness finds nearly every bare
  footprint with no placed part called missing. Correlation with a
  golden from another picture fails at it (two views of one real part
  correlate only 0.58 median: the terminals' glare moves with the view).
  Dividing the gap's brightness by the board around it made it worse
  (17%); the glare needs care. `inspect.body_gap` and `gap_luma` keep it.
- Offset: 0.2 mm is found 70 to 80% of the time, 0.1 mm 20 to 40%. The
  floor is 45 um median (95%: 90 um), mostly parallax: the golden came
  from a picture 8 mm away, and a part's top moves 60 um between them. A
  golden taken at the same place would not have it.
- Turn: a quarter turn of a passive is found half the time, of a synthetic
  IC or diode nearly always; 5 deg is found 70 to 80% of the time, 2 deg
  not. 180 deg on a capacitor or a resistor cannot be told from its
  shape (a resistor's print could tell it, not tested); a diode's band or
  an IC's pin 1 mark can, in synthetic parts.
- Mosaic or single picture: the same within the counts (the mosaic a
  little better on offsets, its golden being a blend of more pictures).
- The real misplaced parts, against a placed part of their package
  elsewhere: C57 (lying turned about 60 deg) and R91 flagged by offset,
  R80 (0.35 mm off its pads) not; C10 has no placed part of its package.

## What to build next

1. Judge parts in single pictures against a golden board: the first
   good board's pictures at places given in the board's frame (through
   its board map), every later board's at the same places, so the lens,
   the glare and the parallax match. Center each picture on a cluster of
   parts: lens, tilt and parallax vanish at the center.
2. Presence first, by the gap between the pads (`inspect.body_gap`): it
   needs no golden. Then offset and turn against the golden, over the
   body box; let 180 deg count only for parts with a mark.
3. Keep the mosaic for what it measures: the board's place and the axes'
   skew, the camera's map, lens and backlash, the board's relief (for
   focus and placing heights) and a picture for people.
4. Colors: pcbv sends luma; the gap's color separated better. And the
   board must match its KiCad revision.

On the machine:

- Scan: approach each place from one side (28 um backlash alternates by
  row in a serpentine); overlap about half a picture both ways (Y
  overlapped 35%: one row of windows per pair). 169 stops took 176 s,
  almost all moves.
- Height: level the board to the head's travel or map it (the relief
  says 1.5 mm across this one); a part's top shows its height over about
  90 mm as parallax.
- Light: the ring light's camera-fixed glare (the median picture runs 0.2
  to 2.5 times its median across the frame) washes out pads in its lobes
  and moves the terminals' glare between views; a diffuser or crossed
  polarizers, and no film over the board, would make views agree.

## Method

- Pictures decoded with Pillow (`uv run --with pillow`), head places
  from the survey's `stops.jsonl`.
- Seams: `overlap_windows`, `register`; case (c)'s windows as pixel pairs
  (`matches_of`) fitted by `fit_camera`; every seam measured again under
  each fit.
- Board map: `layout_raster` over `board_pads`, `board_openings` and
  `board_holes` through the truth, against `sample` of model (d2) with
  `flat_field`, by `phase_shift_near`.
- Parts: `part_grid` crops; `compare` over `body_mask` with the board
  aligned on the ring around; real parts moved with `cutout` over
  `under`; synthetic ones by `sprite`, `paste`, `bare`; the gap from the
  nearest picture's colors; footprint states read by eye from contact
  sheets of every crop with the layout's pads outlined. Part-top
  parallax: the placed parts' bodies registered between the two
  pictures, against the pictures' baseline.

One-off scripts drove these and are not kept. Not verified:
anything on the machine; a populated board (32 passives, no IC, diode or
transistor); the working distance and the relief in mm, which rest on
the 0603 parts' usual heights.
