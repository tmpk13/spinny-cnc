# The panels' layers and the quiet look (2026-11-17)

The reasons are in docs/UI_VISUAL.md (what the screens looked like, what
they held after). This file holds the decisions taken while building and
what was not obvious.

From 2026-11-17 to 2026-11-21 an area showed one view of its panels at a
time, the Run area's views being the steps of a run, with the Machine
panel docked along their foot. The operator then had every area show its
panels by mode (notes/modes.md): the views, the steps' bar, the dock and
their rules are gone. A view was a layout the layout layer put on the
page in place of the operator's, so nothing inside a panel knew of views,
and they came out without touching one. What follows still holds.

## Decisions

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
  which the Machine panel takes over: in sight with the panel folded. It
  is drawn as the next action (ink) while a G-code machine is not homed,
  since a run on that machine needs it first; a machine of this project's with endstops gets a plain button, as
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
  a click on the picture, a crop is drawn on it. The config modes put
  each camera's picture in a column of its own beside its settings. It is a second mount of the same picture (`mountVisionView`
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
  panel had the height its column gave it, while the picture's box had
  the height its grip was dragged to, and ran on past the panel's foot.
  The rules that laid a view's picture panels in a flex column went with
  the views: an area's panels now grow with their content, the picture's
  box with them. A grip let go keeps the height the box shows at, not the
  one the pointer reached.
- **The key list opens on the differences.** 160 keys with their help is
  a reference; the keys where the file and the board differ are what asks
  for a decision. A search looks through every key whatever the box says,
  so a key is never hidden from someone looking for it.
- **An offset typed is applied when its field is left**, as a group's
  numbers are: Move was one more button for the same thing.
- **In the rail a side's name is a heading.** Both lists show there, so
  the name had nowhere to go that an area does not; it is a button only
  on a narrow window, where the other side's areas fold away behind it. A
  side the mode in use leaves no area to show has no name at all.
## Auto and the Board step (2026-11-18)

Auto sat beside the steps' Next until 2026-11-21; it is in the top bar
since, and works through the stages of a run (src/views/stages.ts) that
the steps became (notes/modes.md).

- **Auto is the page pressing its own buttons** (src/views/autosteps.ts).
  The stages are the page's (what is done is read from its state), and
  every act is a request a button of the stage's panel sends, so there is
  no second copy of homing, searching or placing to keep right on
  hardware. `autoMove(state, memory)` says the next move from the state
  and what this run tried; `autoRunner` does the moves. A backend
  routine was the other way: it would have needed the page's notion of a
  stage.
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
- **It homes a G-code machine only** (Q63): a run on that machine has a
  Home stage. A home of this project's firmware renumbers an axis and
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

## The budget as a check

- `mise run test-budget` (layout/budget.ts over layout/shots.ts) walks
  docs/ui/budget.json: since 2026-11-21 every area of every built-in mode
  but All panels, 24 screens (31 views before). The limit is the
  principle's (40 controls, 200 words, first view, frame included). A
  shot may carry a ceiling of its own with its reason (`budget: {controls,
  words, why}`): the eight mode screens over the limit on 2026-11-21 hold
  at what they measured (Q73), the Machine panel whole being 24 to 25 of
  a Run screen's.
- The frame is 15 of the 40: the rail's 13 (8 areas, side by side, 4
  tools) and the bar's 2, more now with the mode's pick and Auto.
- All panels is not in the list: it is every panel at once.
- A screen over the budget wants a layer (a More, rows, a button put
  away), not a higher ceiling; a mode's ceiling holds it from growing.
- docs/ui/budget.json was, until 2026-11-17, an older list that counted a
  whole page through a script of its own; the counts in UI_REDESIGN.md and
  UI_PANELS.md were made with it (it is in the history at 36eb42e).

## Traps

- **Two stylesheets load in an order the dev server picks.** A second
  `<link>` after style.css came first under `Bun.serve` (the shots and the
  layout check), while `bun build` kept the page's order: rules meant to
  override lost on one and won on the other. The frame's rules are in
  style.css, before the flow rules.
- **happy-dom's `matchMedia` matches `(min-width: 64rem)`**, so the rail
  shows in the tests; a test of the narrow bar stubs `matchMedia`.
- **The step size is kept per browser** (`spinny.jog.level`): every test
  file shares the storage, so the jog's tests remove it after each test.
- **The layout check presses buttons by Playwright**, which needs them in
  view: it goes through the old states in All panels, then mode by mode,
  every area the rail lists. A button a folded rail hides (To-do moved
  there) is pressed by script.
- **The shots' measure counted a preview twice** (its scene canvas and
  its overlay); the work's share is counted over a grid of points.
- **The measure counted what a shut fold holds.** Chromium keeps the
  boxes of a closed `details` (content-visibility), so words inside one
  had a size and lay "in the window": `checkVisibility()` is asked too.
  A toast covers what is under it (a control under one is not "met"), so
  the measure lets go of the toasts first.
- **A table's row buttons with `white-space: nowrap` ran off a narrow
  panel** (the key list's Copy and Insert): the cell wraps them now.
- A stacked panel in a view whose head held only a question mark had
  that head taken out of the flow to the panel's corner (gone with the
  views); the block after such a head needed its top margin taken off,
  or the layout check reported a lead.
