# Probabilistic board search (plan)

A plan, as of 2026-11-13; nothing is built. It adds a second way for the
board look and search to decide where the board lies: a probability over
the board's pose, updated by every picture, beside today's vote among
guesses. It is an option; the vote stays.

## The option

- A camera setting `look_method`: `vote` (today's, the default) or
  `posterior`, for the head camera (`PUT /api/camera/settings`) and the
  top camera (`PUT /api/pnp/top`), beside `look_threshold` and
  `corner_mm`. The Find board panel shows and switches it.
- Both methods share the stops, pcbv, corners taken by hand, the known
  place, the check stop, Align and the search records. A record names the
  method that ran.
- Board stretch and machine skew (below) are their own switches, off by
  default, and work only with `posterior`. The full scan (below) is its
  own button, for after a rough place is known.
- `vote` stays the default until search records from hardware show
  `posterior` finds boards at least as often and as right.

## Why

The vote counts a picture only when pcbv locks on it alone. Pictures over
a quiet stretch of board, half off its edge, or of a repeated pattern add
nothing or add a wrong guess; a picture with no lock says nothing about
where the board is not; a guess's share counts only the guesses seen, so
one weak guess holds all of it; and the fit is rigid, so a stretched
board or out-of-square axes show only as residuals.

## The model

- **State:** the board's pose on the machine (x, y, turn). With board
  stretch on, also X and Y scale and shear, with tight priors (scale 1
  within the fab's tolerance, shear 0), so few marks cannot overfit them.
- **Prior:** the known place, in today's order (corners, an earlier find,
  Align marks, references, the job's place), as a spread about it, else
  even over the search box. Some probability is always kept for "where
  nothing has looked yet".
- **Evidence from each picture:**
  - pcbv's candidate poses with their match scores, not only its lock.
  - What a pose predicts the picture should show: the pads and holes it
    puts in view against what pcbv found there. An empty picture lowers
    every pose that would have put features in it.
  - Room for error: any candidate or mark may be wrong, so one bad one
    is discounted instead of bending the fit.
- **Representation:** many weighted sample poses while the board could
  be in several places; a Gaussian about the peak once one dominates.
- **Found:** the peak holds at least the camera's `look_threshold`, read
  as a probability, and its spread is within the agreement used today
  (`AGREE_MM`, `AGREE_DEG`). The check stop then runs as now.
- **Steering:** the next stop is the one expected to narrow the
  probability most, travel counted against it.
- **Machine skew:** out-of-square axes and per-axis scale, shared by every
  job on one machine, while board stretch belongs to each board. A board
  carries its own stretch with it when turned and the machine's skew
  stays put, so boards placed at different turns separate the two. The
  learned skew is shown with its uncertainty and written to the machine
  file only when the user applies it.

## Full scan

An option for after a rough place is known (corners taken, Align marks,
or a board found): the camera covers the whole board instead of stopping
once the board is found.

- The head runs rows over the board's outline plus a margin, back and
  forth, a picture's size apart less the overlap. Every picture feeds the
  estimator, and the scan ends when the outline is covered.
- It gives the place from the whole board rather than from one corner of
  it, the long baseline that board stretch and machine skew need, and the
  pictures for a mosaic on the page, placed by where the head was.
- It works with either method; `posterior` uses the pictures that would
  not lock alone, which the vote drops.
- A scan setting `scan_motion` picks how pictures are taken:
  - `stop` (the default): the head comes to rest at each picture, as the
    search does now. Every machine.
  - `fly`: the head moves at a steady speed along each row and the
    pictures are taken on the move. Each needs the head's place at the
    moment it was taken, so `fly` is offered first on this project's
    firmware, whose status reports place the head while it moves; a
    G-code machine reports its place only at rest.
- What `fly` adds to the model:
  - The camera's delay (how long before pcbv gets a frame it was taken)
    is part of the state. A wrong delay moves the board one way on
    forward rows and the other way on return rows, so rows run both ways
    measure it.
  - Each picture's place is less certain along its row than across it.
  - Blur stays under a fraction of a pad: the row speed is capped by the
    camera's exposure time, which must then be set by hand.

## Phases

Each phase ends with the suites passing. The work runs offline against
recorded searches first, live second, hardware last.

1. **pcbv candidates** (pcb-vision): `pose` gains `candidates`, the best
   few poses each with `found` and `expected`. Additive: the vote ignores
   them. Tests on drawn boards with repeated patterns.
2. **Estimator** (backend, a pure module with no camera): the probability
   from a recorded search. `search-report sweep` gains a method choice and
   replays records through both methods side by side. Tests on drawn
   boards.
3. **The option, live:** the `look_method` setting, the search driven by
   the estimator, the Find board graph drawing peaks against the threshold
   line, records naming the method, the page mock's twin, `WEB_API.md`.
4. **Steering:** stop order by expected narrowing (`posterior` only).
5. **Full scan, stopping:** the scan from a rough place with
   `scan_motion = "stop"`, and the mosaic on the page.
6. **Board stretch:** its switch; Align marks feed the same estimator, and
   Align shows X and Y scale and shear.
7. **Full scan, flying:** `scan_motion = "fly"` on this project's
   firmware: frames matched to the head's reported places, the camera's
   delay in the state, the speed capped by the exposure.
8. **Machine skew:** learned across jobs, shown, applied to the machine
   file on the user's word.

## How it fits

- [RESTRUCTURE.md](RESTRUCTURE.md) phase 2 step 4 moves the board look
  and search into their own domain. Phases 1 and 2 here do not depend on
  it; phase 3 is simplest after that move.
- No search has run on hardware yet. The first real records are the data
  that decides whether `posterior` becomes the default.
