# Board vision: where it stands, where it goes

Written 2026-11-14, after the first session on real hardware (a
LumenPnP's top camera over a populated OreSat battery card). The numbers
behind every claim are in [CV_HARDWARE.md](CV_HARDWARE.md); the design of
the probability search is in
[PROBABILISTIC_SEARCH.md](PROBABILISTIC_SEARCH.md). This file only judges
them: what works, what to build next, what to stop building.

## Where it stands

| Piece | On hardware | Verdict |
| --- | --- | --- |
| Camera scale and roll measured by moving the head (phase correlation over a 3 x 3 grid of head moves) | 0.0160 mm a pixel, roll 180.4 degrees, 0.9 px residual, 8 to 18 um backlash; agrees with pcbv's own scale to 0.5% | Works. Only a session script, not a routine in the system |
| pcbv on one picture, scale known | Over the board's dense interior: right, 0.03 mm rms. Within 15 to 25 mm of an edge and off the board: about half of all locks wrong (quarter turns, a repeated circuit, half scale) | Good where it looks at enough pads; wrong locks pair few pads (median 0.32 against 0.64 to 0.98 for right ones), so a least match of 0.5 removes most of them |
| pcbv with no scale | 1 frame in 260 locked before the scale windows; 18 of 18 after, but some at half scale | A rescue, not a way to work |
| Search with the place known | Found in 8 to 11 s; 0.01 to 0.07 mm and within 0.1 degree once the turn comes from the head's places | Works |
| Search with nothing known | Twice called a wrong place found (now refused); the quick bed scan found the board at stop 105 of 128, 400 s, 0.10 mm off | Right but slow: 96 of 107 stops saw nothing and each waited out the 2.5 s lock time |
| The vote, replayed over the 21 records | 16 of 21 called found at the shipped settings, 2 of them the wrong places from scratch; needing 3, 4 or 5 looks within 0.5 or 1 mm gives the same 16 | Its tuning knobs do not move the outcome |
| The posterior, replayed over the same records | 13 of 21 found, no wrong place called found, agrees with the vote's places; slow on long scans | The direction, once it is fast enough: see [Vote or posterior](#vote-or-posterior) |
| Bottom camera, nozzle routines, camera to nozzle offset, home fiducial, picking and placing | Not run: the stock file's bottom camera and fiducial places hold parts tapes on this machine | The largest error not yet measured: the offset moves every place found |
| Lens, blank board edges, color picks, round checks, centering features, full scan and mosaic, flying scan, board stretch, machine skew | Not run | Built ahead of data |

## What the data says

1. **The machine's geometry is better than the picture's.** Head places
   repeat to 8 to 18 um. pcbv's angle carried the 0.4 degree roll error
   straight into every board found, and taking the board's turn from where
   the head stood removed it. A picture is good at saying which board point
   is under its center, and less good at anything else.
2. **A known scale matters more than any other input.** Without one, pcbv
   spends its time on wrong scales and almost never locks.
3. **Where the camera looks matters more than how locks are counted.**
   Locks over dense board are right; locks near edges and off the board
   are where the wrong ones come from. A board with a bare middle (this
   one) defeats a check that simply goes to the middle.
4. **Search time goes to empty pictures.** A scan stop with no board in
   view costs the move, the settle and the full 2.5 s lock wait.
5. **A shipped machine file's places are guesses** until the top camera
   has seen them on this machine.

## Move towards

In order of payoff:

1. **Measure the camera by moving the head, as a setup step.** Make the
   grid-of-moves measurement a routine that runs over any textured surface
   before any board look: scale, roll, mirror and backlash in under a
   minute, no mark needed. Every later search then starts with a measured
   scale and roll.
2. **Take points from pcbv, not poses.** Each lock gives one board point
   under the picture's center and its match; the board's place and turn
   are fitted to those points against the head's places. This already
   happens when the looks span 20 mm; make it the only estimate, and drop
   the vote's fit through the picture's corners (extrapolated past the
   features, a few tenths off on a perspective fit).
3. **Look where the board is dense.** Choose check and search stops by the
   number of pads the job puts in view, and keep stops that must lock away
   from the outer 20 mm unless nothing else is left. Edges are for
   *Corner by edges*, not for locking.
4. **Throw out empty pictures cheaply.** Before pcbv runs, test whether
   the picture shows board at all (the share of the mask's picked color,
   or the count of pad-like spots). An empty stop then moves on in well
   under a second. Use the same test across a scan to find where the board
   lies, and run pcbv only at two or three dense places inside that area.
   Target: a full-bed search in under a minute.
5. **Say where boards lie** (Q39): the full bed by default, narrowed by a
   machine file entry, chosen on a machine view panel that shows the bed
   (a box from the file, or a model or picture of the machine).
6. **Keep each measurement with a history and undo** (Q40), not a Keep
   banner: roll, scale and offset change on their own, are listed in a
   log, and can be undone.
7. **Grade on real pictures.** Move the session's survey, grading and
   search scripts into the repository as mise tasks. The 169-picture sweep
   is the baseline (with a scale: 106 locked, 52 right, 0.07 mm rms) that
   every pcbv change has to beat. Add a few boards that look different: no
   bare middle, a bare board, another mask color. Keep a small subset in
   pcb-vision as a test fixture.
8. **Next hardware session: the nozzle side.** Find the bottom camera with
   the top camera, measure the camera to nozzle offset with *Nozzle on
   mark* and *Measure offset*, grade nozzle centering and runout, then
   place a first part. Grade the board look's places only after the offset
   is measured.

Targets: with the place known, under 10 s and 0.05 mm; with nothing
known, under 60 s over the whole bed; never a wrong place called found.

## Abandon or freeze

Abandon:

- **Searching the scale in normal use.** The scale comes from the camera
  measurement, or from the file's design scale until one exists. pcbv's
  scale windows stay only as the very first look's fallback.
- **The board's turn from pcbv's angle** when the looks are spread out
  (done for 20 mm and more); keep pcbv's angle only for a single place.
- **Two estimators.** The vote and the posterior both exist, so every
  change to the search is made and tested twice. The replays point to
  the posterior ([below](#vote-or-posterior)); delete the vote when its
  conditions hold, and before the board look moves into its own domain
  ([RESTRUCTURE.md](RESTRUCTURE.md), phase 2).
- **Tuning the vote's `need` and `agree`.** The replays show they do not
  change what is found.
- **More consensus rules.** The wrong places on hardware came from bad
  inputs (no scale, a wrong roll, locks at the edges, weak matches), not
  from too few rules. Fix the inputs instead of adding checks after the
  vote.
- **Trusting places in a stock machine file** (bottom camera, homing
  fiducial, camera offset): treat each as a guess until the top camera has
  seen it.

Freeze (keep the code, add nothing, until hardware data asks for it):

- **Flying scan.** Only the head camera on this project's firmware can
  fly; a G-code machine's scans stop.
- **Board stretch and machine skew.** A fab's 0.1% over a 50 mm board is
  0.05 mm, about one picture's own error; measuring it needs many boards
  at different turns.
- **Lens correction, round checks, color picks, rival reporting.** Each
  was built before any real picture. Grade each against the picture sets
  (item 7) before giving it more work.

## Vote or posterior

The session's 21 records replayed through both (`mise run search-report
-- sweep --method both`). The truth is each record's own found place, or
the quick scan's for records that found nothing, so the place row
measures agreement with the vote, not accuracy.

| | Vote (5 looks within 0.5 mm) | Posterior (threshold 0.5) |
| --- | --- | --- |
| Called found | 16 | 13 |
| Wrong among them | 2: both searches from scratch | 0: both of those wrong places held 0.17 |
| Found where the other did not | 1 look at rest | none |
| Place, where both found | | within 0.11 mm of the vote's in 11 of 12, 0.33 mm in one |
| Median to found | 9 looks, 3.2 s | 9 looks, 3.2 s |
| Replay time | 2 s for all 21 | 0.1 to 1 s a search; 73 s for a stopped scan of 1566 looks, over 240 s for the scan that found the board |

The two wrong places came from locks pairing 0.31 to 0.38 of their pads,
recorded before the least match of 0.5 went in, so on today's code the
vote refuses them too. The difference is that the posterior refused them
with no rule written for that case.

**Direction: move to the posterior and delete the vote**, once:

1. a scan replays faster than it ran (the record that found the board
   took 400 s live and more than 240 s to replay);
2. the look at rest it missed by 0.49 against 0.5 is understood;
3. the next session's records, graded against a surveyed truth, show it
   finds at least as many boards as the vote with no wrong place called
   found.

Why the posterior: it reads an empty picture as evidence against the
board being there, which is exactly what the cheap board test (item 4)
and the bed area (item 5) produce; it already steers stops by what they
would tell; and it refused wrong places without extra rules. Until all
three points hold, the vote stays the default and gets no new features.
These are 21 records of one board from one session: enough to choose a
direction, not to flip the default.
