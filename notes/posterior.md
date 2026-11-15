# The probability over the board's pose (2026-11-14)

docs/PROBABILISTIC_SEARCH.md describes what was built and its numbers;
this file keeps why it is built so and the traps met.

## Shape of the estimator

- Hypotheses as Gaussians plus poses drawn from the prior, not a particle
  filter: a candidate pins the pose to a few tenths of a millimeter and a
  degree, so particles spread over a box and every turn would need about a
  million to land one in a candidate's kernel. Each hypothesis is an
  association of candidates (one per view) refitted by Gauss-Newton; its
  weight is Laplace's approximation; the diffuse part is the "no candidate
  is true" association, Monte Carlo over 1500 prior draws (importance
  weighed when corners or marks pull the draws about their rough place).
  Checked: one candidate's Laplace term integrates to one (log N at the fit
  plus 3/2 log 2 pi plus half log det P is 0).
- Weights in log space; numpy for the feature counts (draws x 400
  features per view). numpy became a backend dependency for this (release
  wheels per platform carry it).
- A view is one place: all pcbv searches there pool their candidates (the
  better match kept), so a lock tracked or re-found never counts twice.
  The vote's two independent locks are still asked (`sessions`), as a
  check on one chance lock; they add no evidence by themselves.
- Evidence comes once per pcbv search: `search` (every pose since
  pcb-vision 5885ddc) keys it; an older pcbv's `searched` frames, else its
  `acquisition`. On the move every frame is a view of its own (`moving`,
  keyed by the frame number), tracked or not.
- Candidates belong to the frame their search ran on: the backend places
  them by `candidates_age_ms` (the place at that frame's capture time),
  else a jogging operator's head would put old candidates at a new place.
- The known place is the prior; corners and marks are evidence. Using
  corners as both would count them twice, so the prior's known place is
  taken without corners (`_head_known(..., corners=False)`), and an Align
  known place is dropped when its marks are passed as evidence.
- The threshold reads as a probability. 0.5 (the shared default) calls a
  53/47 split found; the found rule also asks more than the next place
  and than where nothing has looked, and the check stop runs after.

## Numbers that matter

- PLACE_MM 0.05: the per-picture place error. The camera's offset error
  is the same for every picture and only moves the whole board, so it is
  not per-picture noise; at 0.15 mm stretch was unobservable.
- Stretch from pictures: about 0.003 of scale per picture over a 30 mm
  board against a 0.002 prior, so nine pictures move the scale about half
  way to the truth; marks centered to 0.05 mm pin it.
- Marks: Huber weights still pulled a fit 0.12 degree with one mark 2 mm
  off; the mixture weight (good vs. wrong anywhere within 10 mm, 2% wrong)
  drops it, leaving the regularized fit.

## Traps

- Two fake pcbv instances in one test restart the search numbers and the
  second's evidence is taken as already read: one pcbv numbers its
  searches for the whole load.
- A flying scan's frames from the rapid to a row's start had velocities in
  the thousands of mm/s (the history jumps), which pinned the delay wrong
  and split the hypotheses: frames before the row began or faster than 1.5
  times the row speed are refused.
- Reading `look.consensus` after `look.stop()` reads a fresh vote: stop
  replaces the consensus.
- pcbv's first search after a stop's reset usually runs on a frame from
  inside the settle time, which the stop refuses; if it locks, the frames
  after are tracked and bring no new search, so the stop gave the
  posterior nothing. The tracked lock in a frame at rest now stands for
  that search (8f27d7e); the fakes (age 0, settle 0) never showed it.
- The vote's estimate on a perspective pcbv fit is a few tenths off at the
  picture's center (corners extrapolated past the features); the
  posterior measures the center point and the turn instead.
- BoardTopCamera now gives pictures (frame); the not-found test passes
  `pictures=False` to keep the "camera without pictures" case.

## The page and the mock

- The Find board graph keeps its eighth slot for where nothing has looked
  (dashed violet, "?"); the table adds a row for it.
- The mock's twin is a stand-in, not the math: its elsewhere is
  1 / (1 + the looks' weight), its scan is made at once over its found
  place, and it learns no skew. QUESTIONS.md Q9 (retire the mock) is open,
  so it was kept in step only as far as the page's switches need.

## Speed and the search's checks (2026-11-14, second session)

- A 3151-pose scan took over 240 s to replay (400 s live): every pose
  re-weighed every hypothesis against every view, a numpy call each. A
  hypothesis' features are now counted in all views at once and kept
  while its mean and the views' scales stay (`_seen_counts`); the
  measurement noise is diagonal, so its solve is a sum; predict's 2 by 2
  solve and scalar detections skip numpy; far pairs skip the merge's
  solve. 51 s, the same result.
- One place's pictures pool into one view, so a single place cannot call
  a board found against weak wrong locks elsewhere and where nothing has
  looked (a look at rest at 0.49; a fully matched lock at 0.37 against
  0.62 over a whole bed). `worth_checking` (a quarter of the probability
  and more than any other hypothesis, elsewhere left out) makes a search
  check the lead from another place, as a place found is. Weak locks
  (under MIN_MATCH) no longer hold a stop or count at a check.
- Live: from nothing 39.8 s (the vote 43.6); with the place known 2.2 to
  3.4 s but 0.07 to 0.09 mm off where the vote gave 0.025 to 0.052, also
  with the final place fitted to the looks' points (placed_estimate). Not
  understood yet; the vote stays the default.
