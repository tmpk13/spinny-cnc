# Probabilistic board search

Built on 2026-11-14 as planned on 2026-11-13, all eight phases; none of it
has run on hardware yet. It adds a second way for the board look and
search to decide where the board lies: a probability over the board's
pose, updated by every picture (`spinny_web.posterior`), beside the vote
among guesses (`spinny_web.boardlook.Consensus`). It is an option; the
vote stays the default.

The routes and fields are in [WEB_API.md](WEB_API.md) (Board look, the
scan and skew routes, the Align fit); how to use it is in
[OPERATING.md](OPERATING.md) (Looking for the board, Lining a job up).

## The option

- A camera setting `look_method`: `vote` (the default) or `posterior`, for
  the head camera (`PUT /api/camera/settings`) and the top camera
  (`PUT /api/pnp/top`), beside `look_threshold` and `corner_mm`. The Find
  board panel's *Method* list shows and switches it; switching starts the
  look over with the method.
- Both methods share the stops, pcbv, corners taken by hand, the known
  place, the check stop, Align and the search records. A record's
  settings name the method (`method`, `stretch`).
- `board_stretch` (posterior only, off by default) adds the board's scale
  and shear. The full scan is its own button, for after a rough place is
  known; `scan_motion` (`stop` or `fly`) picks how the head camera takes
  its pictures.
- `vote` stays the default until search records from hardware show
  `posterior` finds boards at least as often and as right:
  `mise run search-report -- sweep --method both` replays every record
  through both.

## Why

The vote counts a picture only when pcbv locks on it alone. Pictures over
a quiet stretch of board, half off its edge, or of a repeated pattern add
nothing or add a wrong guess; a picture with no lock says nothing about
where the board is not; a guess's share counts only the guesses seen, so
one weak guess holds all of it; and the fit is rigid, so a stretched
board or out-of-square axes show only as residuals.

## The model, as built

- **State:** the board's turn and where its middle lies on the machine.
  With board stretch, also X and Y scale and shear, priors 1 +- 0.2% and
  0 +- 0.1 degree (a fab's tolerance), so a few pictures cannot claim a
  large stretch. On a flying scan, also the camera's delay (0.08 +- 0.06 s
  first guessed).
- **Prior:** the place known before a search (found before, the Align fit,
  the references, the job's own place: today's order without corners) as
  a spread about it holding 70%; the search box the rest but a tenth; that
  tenth over a square four boxes wide, so a board outside the box can still
  be found from enough pictures. A look with no search takes a box the
  board's diagonal wide about its first picture.
- **Evidence from each picture** (a view: one place, its pcbv searches
  pooled, so a lock tracked or found again from the same picture never
  counts twice):
  - pcbv's candidates (pcb-vision 5885ddc: up to five distinct poses per
    search, passed or not, with `found` and `expected`; an older pcbv's
    lock and its rival stand in). A candidate is the board with a chance
    that grows as (match / 0.5)^4, halved for one that failed pcbv's
    checks, against two false candidates a picture gives on average,
    spread over the board's points and every turn.
  - What a pose predicts the picture shows: the job's pads and holes it
    puts in view (a fixed 400 of them stand for the rest; a grid over the
    outline for a board without). A picture with no candidate near a pose
    lowers it by the chance it would have given one there (0.9 at most, 1 -
    1/e of that with six features in view): an empty picture lowers every
    pose that would have shown pads in it, a picture half off the edge only
    the poses that put many of them in.
  - Corners taken and the Align marks made with the tool or by centering
    features: each a Gaussian about where it was taken (half `corner_mm`;
    0.05 mm for a mark), or wrong (2% of the time); a place putting a
    corner further than `corner_mm` off is said to be ruled out.
- **Representation:** each place the candidates of one or more pictures
  agree on is a hypothesis: a Gaussian about its best fit (Gauss-Newton on
  its candidates, corners and marks), weighed by Laplace's approximation of
  the probability's mass there. The rest, where nothing has looked yet, is
  1500 poses drawn from the prior, each weighed by how much every picture
  says the board is not there. A candidate no hypothesis gates (chi-square
  0.999) starts one of its own, so a wrong candidate is a small hypothesis
  beside the right one rather than a pull on its fit. The page says
  `gaussian` once one place holds 90%, else `samples`.
- **Found:** the most likely place holds the camera's `look_threshold` as
  a probability, more than the next place and more than where nothing has
  looked, its spread (one standard deviation) within `AGREE_MM` and
  `AGREE_DEG`, from the vote's two independent pcbv searches. The check
  stop then runs as with the vote.
- **Steering:** a posterior search goes next to the stop with the most
  expected narrowing for its time: what its picture would tell of which
  place (or none) is right, by whether it would give a candidate, plus how
  much a candidate there would shrink the most likely place's spread, over
  the travel at the head's speed and the look.
- **Machine skew:** each board found with its stretch measured (a posterior
  look with board stretch, or Align applied with three marks or more) is
  kept by machine (var/skew.json). Turned into the machine's frame, a
  board's stretch is the machine's skew plus its own, which turns with it;
  averaged over boards at turns 30 degrees apart or more it is the
  machine's X and Y scale and how far its axes are out of square, shown with
  its uncertainty. *Write skew to machine file* multiplies a cartesian
  machine file's X and Y steps per mm by the scales; out of square is said,
  never written.

## Full scan

For after a rough place is known (corners taken, a board found, the Align
marks or the references; not the job's own place): the camera covers the
whole board instead of stopping once the board is found.

- Rows over the board's outline where the rough place puts it, grown by a
  margin (2 mm or the place's tolerance), a picture apart less the
  overlap, back and forth from the bottom left. Every picture feeds the
  look (either method); the scan ends when every row is done.
- Each picture is kept (640 px wide) with where its center lay, its roll
  and mirror; the Find board panel lays them out as a mosaic with the
  board's outline dashed where the scan found it.
- `scan_motion`:
  - `stop` (the default): the head at rest for each picture. Every
    machine; a G-code machine's scans always stop.
  - `fly` (head camera, this project's firmware): each row is a beamless
    cut at a steady speed. Every frame taken on the row is placed where the
    firmware's status reports (ten a second while moving) put the head at
    that moment, less the delay first guessed, with the head's velocity;
    frames from the rapid to a row's start are not used. The posterior
    keeps the delay in its state: a wrong delay moves the board one way on
    rows run left to right and the other way on rows run back, so rows run
    both ways measure it. The speed keeps a small pad's blur (the job's
    tenth percentile, else 0.5 mm) under a quarter of it over the camera's
    exposure, which must be set by hand, and pcbv's looks a third of a
    picture apart, 20 mm/s at most.

## Phases, as built

| Phase | What | Commits |
| --- | --- | --- |
| 1 pcbv candidates | `pose` carries `search` (every reply), `candidates`, `candidates_search`, `candidates_frame`, `candidates_age_ms`; the backend places candidates by their own frame's time | pcb-vision 54b1f06..5885ddc |
| 2 Estimator | posterior.py; `search-report show` and `sweep --method vote\|posterior\|both --threshold ...` replay records through both | 0366cbc, 6813a16 |
| 3 The option, live | `look_method`, `board_stretch`; the Find board graph's *?* column for where nothing has looked; the mock's twin; WEB_API.md, OPERATING.md | 035c2f0, a6e0bd3, cce4c21 |
| 4 Steering | expected narrowing for its time (with phase 2's commit) | 0366cbc |
| 5 Full scan, stopping | rows, the mosaic, records of kind `scan` | 2f7c6f2 |
| 6 Board stretch | its switch; Align fits three marks or more with the same state and priors (`fit_marks`, each mark weighed by how likely it is good) and shows X and Y scale and shear; tool marks and centered features are a posterior look's evidence | 2994ebf |
| 7 Full scan, flying | frames placed by the head's reports, the delay in the state, the speed held to the exposure | 14bc79e |
| 8 Machine skew | learned across boards, shown, written on request | 3c840c2 |

## What was found building it

- On a picture pcbv fits with perspective, the vote's estimate (a rigid
  fit through the picture's center and its four corners) lies a few
  tenths of a millimeter off: the corners are the fit extrapolated past
  the features. The posterior measures the job's point under the picture's
  center and the turn, which pcbv gets right; a test on a drawn board
  shows both (`test_a_real_pcbv_lists_its_search_candidates...`).
- A board whose pads repeat at quarter turns gives candidates at those
  turns nearly as strong as the lock; the posterior keeps each as a place
  of its own until a picture of a part that does not repeat tells them
  apart, where the vote would count the lock alone.

## How it fits

- [RESTRUCTURE.md](RESTRUCTURE.md) phase 2 step 4 moves the board look and
  search into their own domain; posterior.py, mosaic.py and skew.py go
  with it.
- Not yet run on hardware or on the virtual firmware: the first real
  search records are the data that decide whether `posterior` becomes the
  default, and the first flying scan on the machine the check of the
  status reports' timing. `locate` (what the report's `--pcbv` replays
  run) searches without rivals, so its candidates on ambiguous pictures
  differ from `serve`'s.
