# Views, the dock and the quiet look (2026-11-17)

The reasons are in docs/UI_VISUAL.md (what the screens looked like, what
they hold now). This file holds the decisions taken while building and
what was not obvious.

## Decisions

- **A screen shows one view of its area.** Moving panels between pages
  twice (the two sides, then the areas) left every screen showing every
  panel its area owns. The unit that had to change was the screen, not the
  panel: a view is a few panels in set places.
- **A view is a layout, not new panels.** The layout layer already puts a
  layout on a page; a view is one more, made from a spec
  (`viewLayout` in src/views/panels.ts) and put on the page in place of
  the operator's, which is set aside (`PageView.own`) and stays the one
  written to storage, named and reset. So every panel keeps its one view
  and its code path, All panels is simply "no view", and nothing in a
  panel's own view knows about views. Rewriting the panels as smaller
  step screens was the other way; it would have left two copies of the
  probing and placing logic to keep right on hardware.
- **Steps follow the work until one is pressed.** A stepped area opens at
  the first step a run needs that is not done (`stepToOpen`) and moves on
  when the state completes it, so Connect leads to Job leads to Run by the
  presses the steps themselves ask for. A step pressed by hand stays
  until another is: a page that moved a pressed step away would break
  "places stay put". Steps are not remembered across a reload (where the
  work stands is read from the state); All panels and a plain area's view
  are (`spinny.views`).
- **Board and Height can be done without.** The page cannot tell whether
  the board was placed, so Board is never ticked, and a height map is one
  way to run, not a need. They are in the row, ringed with a dashed line,
  and the Run panel says what each is set to with a link to its step.
- **One step size for every axis** (Q46 A): Fine is each axis's smallest
  choice, Coarse its largest, Normal the step its file starts it on. A
  step typed for one axis holds at every size until cleared, which keeps
  what the per-axis choosers could do (X by 10 while Y by 1). The board's
  X and Y lost their bars: the pad moves them and says their steps.
- **Color for states** (Q44 A): the pages' colors are off unless turned
  on; `.btn-primary` is ink (`--strong` on `--panel`, so it is the one
  light button of the dark theme); a choice or a switch that is on is
  drawn pressed, not blue; `.btn-danger` is outlined, and filled only
  with `.btn-stop`, `.urgent` (not `.at-rest`) or in a dialog.
- **Controls sized by the pointer.** `--touch` is 2.25rem, and 2.75rem
  under `(pointer: coarse)`: a mouse does not need a finger's target, and
  six fields no longer take a quarter of a column. The jog's moves keep
  2.5rem.
- **More is one thing.** `details.more` with a summary that says what it
  holds ("More: area, pads, tying the map, probe, files"). A paragraph in
  a panel became its button's tooltip, its heading's tooltip, or a
  question mark (`helpMark` in src/views/context.ts: a tooltip, and a
  message on a press for a screen with no hover).
- **Home opens a fresh browser** (`readPage` falls back to `home`): it
  says what is next. A browser that remembers a page still opens on it.

## The layer and a view

- `setView(page, spec | null)`: the spec's columns map to the page's
  `.column` elements in order; every panel the spec does not name goes
  after them with `hidden: true`. A view with fewer columns than the page
  leaves the rest empty: the layer marks a column with nothing drawn
  `data-empty` and the stylesheet takes it out of the grid.
- Edits in a view (a fold, a tab pressed) change the view's layout, kept
  per view id while the page is open (`PageView.left`, with the columns it
  was made for: a view whose columns change with the state, as Jobs does
  when a job is picked, starts anew). Nothing in a view is written to
  `spinny.layout`. The menu, the drags and the handles are off in a view
  (the entry points return, the stylesheet hides them).
- `hiddenPanels`, `showPanel`, `resetPage`, presets, `adopt` and `drop`
  act on the operator's layout (`ownOf`, `setOwn`), also while a view
  shows; a plugin's panel adopted while a view shows lays the view out
  again.
- `reveal(id)` on a panel the view keeps out of sight asks whoever knows
  the views (`onPanelOutOfView`, set by the view bar) for a view that
  holds it, and falls back to no view. So `goToPanel`, links, the old
  Steps panel and the search need no change.
- The view bar mounts after the layout layer (main.ts) and after every
  view, so its store listener runs after theirs: a plain area's views are
  filtered by whether any of their panels is not `hidden` by its own view
  (a top camera's on a laser), read from the DOM at that moment.
- Panels made for a step alone (`VIEW_ONLY`: `run-connect`, `run-job`) get
  the `hidden` class while their area shows all panels.

## The dock

- The Machine panel is a dock where a view names it in its last column
  with `dock: true`: the view bar marks that column `data-dock-column`,
  and the stylesheet lays the panel as a grid (the position and the head
  on its last row, `machine-more` over them). No node moves: the panel is
  the same section in a step, in the Draw view (a panel with Jog) and in
  All panels (whole).
- `machine-more` holds the jog, the tool and the markers; the pick and
  place head's quick buttons stay out of it, under the position, so the
  Home step shows Home by fiducial without the jog.
- A part inside a shut dock is reached by a `spinny:show` event bubbling
  from the node: `goToPanel` and the search dispatch it, the Machine
  panel and the preview's View row open on it.

## Traps

- **Two stylesheets load in an order the dev server picks.** A second
  `<link>` after style.css came first under `Bun.serve` (the shots and the
  layout check), while `bun build` kept the page's order: rules meant to
  override lost on one and won on the other. The frame's rules are in
  style.css, before the flow rules.
- **An `auto` grid row beside `minmax(0, 1fr)` came out 0 px tall** in
  Chromium for the view bar's row of the pane, and the page lay over the
  bar; `max-content` gives it its height.
- **happy-dom's `matchMedia` matches `(min-width: 64rem)`**, so the rail
  shows in the tests; a test of the narrow bar stubs `matchMedia`.
- **The step size is kept per browser** (`spinny.jog.level`): every test
  file shares the storage, so the jog's tests remove it after each test.
- **The layout check presses buttons by Playwright**, which needs them in
  view: it goes through the old states with `spinny.views` set to All
  for Run and Job, then view by view. A button a folded rail hides (To-do
  moved there) is pressed by script.
- **The shots' measure counted a preview twice** (its scene canvas and
  its overlay); the work's share is counted over a grid of points.
- A stacked panel in a view whose head holds only a question mark has
  that head taken out of the flow to the panel's corner; the block after
  it then needs its top margin taken off, or the layout check reports a
  lead.
