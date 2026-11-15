# A board's parts on the PNP page: kept out, filtered, searched (2026-11-13)

Built by an agent in a worktree, cherry-picked (ccdd1e1, f86e02c, 3ef18d8).

## Parts kept out of the position files

- KiCad's pad test points (TestPoint_Pad_*, THTPad_*, Plated_Hole_*,
  2Pads_*: 30 of the 57 footprints in KiCad 10's TestPoint.pretty),
  mounting holes (all 167), net ties, solder jumpers (29 of 30) and logos
  carry `(attr exclude_from_pos_files ...)`. pnp.footprints_of dropped
  every one of them but fiducials, so test points never showed. Now only
  `board_only` footprints and those without a reference are dropped; the
  rest carry the flag in the components route (`kept_out`). Test points
  that are real parts (Keystone 5015/5019 `smd`, the loops `through_hole`)
  always showed.
- KiCad 10's own fiducials are `(attr smd exclude_from_bom)`, not
  `exclude_from_pos_files`, whatever an older note said.
- Shown by default, grey, with a "kept out" switch in the Parts panel
  (kept per browser). A plan places a kept-out part only when the run's
  refs or its feeder's `refs` name it: a feeder matching value or
  footprint words does not count, since broad words could take a test
  point. A row's "place" box (per job, in the browser) makes Plan and Run
  send explicit refs: every placeable part plus the picks; with no picks
  none are sent and the skipped list names the kept-out parts.

## The parts filter

- A regular expression, its own config record (`parts_filter`, GET/PUT
  /api/pnp/parts-filter), not inside the bottom camera's settings:
  PickCamera.settings() falls back to every default when one value fails
  its check, so a bad expression would have reset the camera. A stored
  filter that does not compile leaves nothing out, and GET says why.
- Matched against one field, the reference by default (value, footprint
  or any of the three on request), any case: `^TP` over values would also
  take a TPS62130.
- Filtered parts stay in the components route (marked `filtered`), so
  references, gotos and the board-place routine still see them; the page
  hides them and the plan skips them even when named. Python `re` has no
  timeout: a pattern such as `(a+)+$` over a long footprint name could
  stall the parts request.
- The mock filters with JavaScript RegExp, so Python-only syntax (named
  groups as `(?P<name>...)`, inline flags) differs there. The mock's board
  has a mounting hole H1 kept out; its TP parts stand for real parts.

## The board search

- fuzzyScore over the parts the drawing shows, by reference or by value
  (a toggle); an exact match gets +100 so "10k" lists the 10k values
  first, ties in reference order. Typing only lights the matches; Enter,
  Shift+Enter and the arrows step through them and pick each (stepping
  never unpicks); Escape clears. Matched labels come right after the
  picked part when labels crowd; the view moves only when the part is
  outside the middle 80% of it.

- PNP Board panel with nothing to draw (2026-11-14): `noBoard()` offers
  Open a board (the Parts panel's file input) and the four newest jobs of
  source `kicad` (the job list is oldest first).
- Picked part in the list (2026-11-14): `listedParts`, `scrollToShow`;
  the drawing's nearest-part pick (`PICK_REM` 1.2 rem, `boardPointAt`
  undoing the viewBox fit); the look's outline is inserted before the
  first part (its translucent fill used to take the clicks). Parts to
  align to: `spreadParts`, localStorage `spinny.pnp.align.<job>`,
  `spinny.pnp.align.count`, `spinny.pnp.shape`. A view test ticking a box
  kept per browser (`spinny.pnp.group`) leaked into the next test file:
  remove the key at the end.
