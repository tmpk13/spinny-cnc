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
  choice, Coarse its largest, Normal the step its file starts it on. The
  board's X and Y lost their bars: the pad moves them.
- **A step is a field** (the user, 2026-11-17: the numbers at the end of
  the size's row "should instead be input boxes that show the distance
  number that can also be set"). The board's X and Y fields end the
  size's row, a joint's sits between its two moves where its step was
  said, and the row of own steps under More is gone. A number typed is
  that axis's step at the size picked, not at every size as the old own
  step was: a field that shows the step has to change when another size
  is pressed, or it reads as broken. Typed steps are kept by the browser
  under a name made of the bar, its unit and the file's choices
  (`stepsKey`), so a step typed for the laser's table in degrees is not
  the LumenPnP's A, and a file whose choices change starts from its own
  again. The file's own number typed, a blank or a zero keeps nothing.
  Shift with a jog key is the Fine step, typed or the file's.
- **Home is in the head** (the user, 2026-11-17: Home was "way too hidden
  away"; it sat under the jog's More, itself behind the dock's Jog, and
  the fold's name did not say it). Home is the jog's, drawn in its head,
  which the Machine panel takes over: in sight in every step with the
  dock shut. It is drawn as the next action (ink) while a G-code machine
  is not homed, since that machine's steps have a Home step that needs
  it; a machine of this project's with endstops gets a plain button, as
  it may be run from a position named by hand. Unlock is there too, shown
  only while the machine is in alarm: it has nothing to clear otherwise
  (the firmware answers `error:5 not now`), and in the fold it was out
  of sight exactly when it was needed. Motors is a row under the bars.
  Zero here, go to, set position and the feed stay under More (Q62).
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
- **A list of things with numbers is rows that open in place.** A job's
  groups and a CAM profile's operations were tables of fields: six
  controls a row, every row. A row is now two controls however many
  numbers a tool has (the box that takes it in or out, and a button that
  says the numbers in a line, `groupSays` and `operationSays`), and its
  fields open under it, each under its name. The rows are a `ul.groups`:
  a list lays out its own items, so the spacing check leaves it alone.
  Which rows are open is kept by index while the same job or profile
  shows, since CAM makes its rows again after every change.
- **A button that cannot act now is put away where its turn comes by
  itself**: a camera's Stop while it is stopped, Abort with no routine,
  the Assistant's Stop, Draw's Apply with no operation picked, Clear with
  nothing typed, the markers' buttons with no markers, a find's Previous
  and Next with no word. A button the operator has to do something for
  (Run with no job) stays, locked, with its reason: putting that one away
  would hide where the action is.
- **A list's row is the thing and one action.** A job in the list is one
  button and Delete; the box that ticks it for Combine shows while the
  list's More is open, and the icon picker opens from Icon there, under
  the picked job. Per-row marks grow with the list; what is done to one
  job now and then does not need a control on every row.
- **A camera starts where it is set up.** Start and Stop belong to the
  picture's panel in the Run area; a camera's own panel on the Cameras
  page has a pair too (the one that can be pressed), and the picture
  beside it there has none of its own.
- **A camera's picture beside its settings** (the user, 2026-11-17: "need
  to be able to see the camera on the camera settings page"). The
  Cameras page had no picture, yet three things on it wait for one: the
  live numbers measure the frames a picture shows, a color is picked by
  a click on the picture, a crop is drawn on it. Each camera's view now
  leads with its picture (3fr) and has the settings over the stack
  beside it. It is a second mount of the same picture (`mountVisionView`
  and camview's `bottomPanel` and `topPanel`, each called per panel),
  not the Run area's node moved: side by side both pages show, and a node
  is in one place; the Find board panel presses Start through the Run
  panel's own row. The two share the camera's key, so a pick armed or a
  nozzle box drawn is taken on either and the live numbers hear both;
  each keeps its own height, turn and switches (`store`: `head.setup`,
  `up.setup`, `top.setup`), since Overlay off to measure the camera alone
  is not how the Run area wants it; and only the Run area's draws the
  search box, which is the one the search reads.
- **A picture keeps inside its panel** (the user, 2026-11-17: the camera
  view "can be enlarged past the length of the border"). In a view the
  panel has the height its column gives it, while the picture's box had
  the height its grip was dragged to (up to 80 rem) or its own shape at
  the panel's full width, and ran on past the panel's foot with the
  buttons under it. The panels of pictures (`.picture-panel`) lay their
  rows in a flex column in a view, and the box alone gives height up;
  `fit()` already letterboxes the picture in whatever box it has. A grip
  let go keeps the height the box shows at, not the one the pointer
  reached. With every panel shown, or on a narrow window, the panel
  grows with the box as before.
- **The key list opens on the differences.** 160 keys with their help is
  a reference; the keys where the file and the board differ are what asks
  for a decision. A search looks through every key whatever the box says,
  so a key is never hidden from someone looking for it.
- **An offset typed is applied when its field is left**, as a group's
  numbers are: Move was one more button for the same thing.
- **In the rail a side's name is a heading.** Both lists show there, so
  the name had nowhere to go that an area does not; it is a button only
  on a narrow window, where the other side's areas fold away behind it.
- **On a narrow window a step's panel comes before the work**
  (`data-lead-column`, order on its panels since the columns are not
  boxes there): the preview first put Run a screen down on a phone.
- **Back shows only where the steps are small marks** (a narrow window):
  beside named steps it said one of them again.
- **A panel's Setup link shows in a view only while it has a need to
  say**; with the rail listing the Setup areas beside every view, the
  plain link was one more thing to read on every panel.

## Auto and the Board step (2026-11-18)

- **Auto is the page pressing its own buttons** (src/views/autosteps.ts).
  The steps are the page's (what is done is read from its state), and
  every act is a request a button of the step sends, so there is no
  second copy of homing, searching or placing to keep right on hardware.
  `autoMove(state, memory)` says the next move from the state and what
  this run tried; `autoRunner` does the moves. A backend routine was the
  other way: it would have needed the page's notion of a step.
- **Each act once in a run.** An act whose goal is still not met after it
  ran stops Auto with what it said; a machine is not moved twice for one
  press. A wait is only for a routine the state shows running.
- **It never starts a run, and never replaces a place by itself** (Q64).
  References are kept per job across sessions, so a new board of the
  same job would be placed where the old one lay: with references there
  Auto still looks, and passes when the camera sees the board within
  `AGREE_MM` (1 mm) of them, stops and says how far otherwise. On a laser
  the place found becomes marks and Apply stays a press, as the whole job
  moves.
- **It homes a G-code machine only** (Q63): that machine's steps have a
  Home step. A home of this project's firmware renumbers an axis and
  moves the frame a height map was probed in, and its endstops have not
  run on hardware. Heights are not Auto's either: a probe touches the
  board and a focus is set by eye.
- **A camera is started through its picture's Start**, as the Find board
  panel does, so it starts with the settings typed there.
- **Search is named for where it would look** (`searchWill` in
  findboard.ts): the user asked where the quick scan button was. It was
  Search, with nothing known, inside By camera, which was folded. Now it
  reads Scan the bed in that case, Search the box with a box drawn, and
  By camera is open at first with a G-code machine, where By hand and By
  marks (the job's offset, this project's marks) say nothing and are not
  shown. The page's guess of "nothing known" is from what it can see
  (corners, a place found, references); the backend also keeps places
  found before a Clear guesses, so the name can say bed where the search
  starts from one.
- **Search loads the board itself** and is the dark button; Look for
  board is the look from where the camera stands.
- **The lock the user met was the page's, not the backend's**: Search
  was locked until the top camera's scale was measured ("Measure offset
  first"), while the backend plans by the file's `mm_per_px` or a lock's
  scale. The page now locks only with no scale from any of them. What the
  offset is needed for, and how places follow it, is in
  notes/pnp-device.md.
- **A LumenPnP's whole bed is too many stops for a small board**: the
  quick scan's two lattices pass 400 stops under about 54 mm on the
  board's shorter side. The refusal now says what narrows it (a board
  area in the file, a box, a corner); it said "draw a smaller box" to
  someone who had drawn none.
- **A fold's `toggle` fires for the page's own opening too**, so the Board
  place folds keep a state only when it differs from how the fold stands
  at first, or once one is kept.
- The mock twins the scan of the bed (its first lattice only), a scale
  kept from a board found and references carrying their offset; it does
  not move its look's corners when the offset changes.
- Run's Board step is at the budget (40 controls; the pick and place one
  39 and 190 words): the next control there goes under a fold.

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
  Home step shows Home by fiducial without the jog. Home and Unlock are
  in the head (`.jog-machine`, not a `.button-row`: the rule that puts
  Hold to move and Cancel away with the jog shut matches those).
- A part inside a shut dock is reached by a `spinny:show` event bubbling
  from the node: `goToPanel` and the search dispatch it, the Machine
  panel and the preview's View row open on it.

## The budget as a check

- `mise run test-budget` (layout/budget.ts over layout/shots.ts) walks
  docs/ui/budget.json: 31 screens, every view of every area. The limit is
  the principle's (40 controls, 200 words, first view, frame included). A
  shot may carry a ceiling of its own with its reason (`budget: {controls,
  words, why}`); none does.
- The frame is 15 of the 40: the rail's 13 (8 areas, side by side, 4
  tools) and the bar's 2. A view has 25 for itself.
- All panels is not in the list: it is the operator's own layout.
- A new view goes into budget.json; a view over the budget wants a layer
  (a More, rows, a button put away), not a higher ceiling.
- docs/ui/budget.json was, until 2026-11-17, an older list that counted a
  whole page through a script of its own; the counts in UI_REDESIGN.md and
  UI_PANELS.md were made with it (it is in the history at 36eb42e).

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
- **The measure counted what a shut fold holds.** Chromium keeps the
  boxes of a closed `details` (content-visibility), so words inside one
  had a size and lay "in the window": `checkVisibility()` is asked too.
  A toast covers what is under it (a control under one is not "met"), so
  the measure lets go of the toasts first.
- **A table's row buttons with `white-space: nowrap` ran off a narrow
  panel** (the key list's Copy and Insert): the cell wraps them now.
- A stacked panel in a view whose head holds only a question mark has
  that head taken out of the flow to the panel's corner; the block after
  it then needs its top margin taken off, or the layout check reports a
  lead.
