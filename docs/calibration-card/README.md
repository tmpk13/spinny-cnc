# Camera calibration card

A 120 by 120 mm metal plate coated in layout blue, with the coating
burnt off by a laser where the drawing marks it: bright metal on dark
blue. [card.svg](card.svg) and [card.dxf](card.dxf) hold the same drawing.
Both were generated once by a script that is not in the repository yet;
the plan is to fold the card into the calibration test's patterns.

## Burning it

- SVG: black shapes are burnt filled, red lines are burnt along the line
  (0.1 mm drawn), and the dashed blue square is the plate's edge, not
  burnt.
- DXF (R12, millimeters): one layer per feature, listed below. Fill the
  closed shapes on FIDUCIAL, LENS_1MM, LENS_2MM and PATCH, the middle
  dots on NOZZLE and the pin 1 dots on TARGETS. Burn every other line
  along itself. Leave OUTLINE off.
- Sand the plate matte before coating it. Polished metal reflects the
  ring light away from the lens and looks dark or patchy.
- Run a material test on a corner first, so every dot clears down to the
  metal. Blue left inside a dot moves its center.
- A plate about 1.6 mm thick sits where a board's top would. The camera's
  scale changes with distance.

## What is on it

Coordinates are in mm from the plate's bottom left, with Y up.

| Layer | What | Where |
| --- | --- | --- |
| FIDUCIAL | 1 mm dots at the corners of a 100 by 100 mm square, nothing else within 3 mm of them; a fifth dot 8 mm right of the top left one says which way the card lies | (10, 10), (110, 10), (110, 110), (10, 110); (18, 110) |
| SCALE | Rulers with a tick every mm, longer every 5 and 10; tick 0 and tick 100 lie under the fiducials' centers | along the bottom (y 1.5 to 5.5) and the left (x 1.5 to 5.5) |
| LENS_1MM | 31 by 21 dots 1 mm apart, 0.5 mm across, the top right one left out | lower left dot at (15, 84) |
| LENS_2MM | 21 by 15 dots 2 mm apart, 0.6 mm across, the top right one left out: the calibration test's default camera pattern | lower left dot at (63, 76) |
| PATCH | 171 pads of random size (0.4 to 1.3 mm), squares and circles, at least 0.6 mm apart, with no pattern that repeats at any turn | x 15 to 65, y 42 to 70 |
| NOZZLE | Rings 1, 2 and 3 mm in radius, a cross and a 0.4 mm middle dot, one target per nozzle | middles at (82, 56) and (98, 56) |
| TARGETS | Corner brackets 0.15 mm outside each part, with a middle cross the part hides. Parts: 0402, 0603, 0805, 1206, SOT-23, SOIC-8 and QFN-16 (4 by 4), each at 0 and 90 degrees; ICs carry a pin 1 dot | 0 degrees along y 30, 90 degrees along y 19; columns at x 20, 31, 42, 54, 67, 82 and 98 |

## Using it

- **Fasten it.** Tape or clamp the card to the bed. On a LumenPnP a
  loose plate turned 0.026 degrees and crept 17 um in 25 s under the
  head's moves, which spoils anything that uses the machine as the ruler.
- **The burner's scale.** With calipers, check that the rulers' 0 and
  100 ticks lie 100.00 mm apart, along X and along Y. That says how true
  the machine that burnt the card was, and so how far the card can be
  trusted as millimeters. The fiducials lie 141.42 mm apart corner to
  corner.
- **The machine's scale and squareness.** Have the top camera find the
  four fiducials. Then turn the card a quarter turn and find them again:
  the card's own error turns with it and the machine's does not, which
  tells the two apart.
- **Lens.** Run *Measure lens* with `bright` dots over LENS_1MM (pitch 1)
  or LENS_2MM (pitch 2). On a simulated 1280 by 720 top camera picture
  at 0.0161 mm a pixel, pcbv found 231 dots on the 1 mm grid and 45 on
  the 2 mm grid, and read the scale as 0.01610 mm a pixel from both. On
  the same pictures bent like a lens, the fit took the error from 5.4 px
  to 0.33 px rms (1 mm) and from 4.4 px to 0.22 px (2 mm). On a real
  burnt card the 2 mm grid fit better: its dots came out rounder and
  more even than the 1 mm grid's, which spread from 0.5 to about 0.65 mm.
- **Camera to nozzle offset.** Use a NOZZLE target as the mark for
  *Nozzle on mark* and *Measure offset*.
- **Placing.** Place real parts inside the TARGETS brackets, then
  measure with the top camera where each one landed against its
  brackets.
- **Board search.** The PATCH needs a board model of its pads before
  pcbv can search it. That model comes when the card is integrated.
