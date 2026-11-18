# The rail, the areas and the panels sorted (2026-11-16)

The plan is docs/UI_PANELS.md (what goes inside each panel) and
docs/UI_REDESIGN.md (the frame). This file holds the decisions taken
while building them and what was not obvious. Since 2026-11-17 an area
shows one view of its panels at a time and the Machine panel is a dock:
notes/views.md.

## Decisions

- The Use side's tabs became areas on a vertical rail, Home, Job and
  Run, built now together with the panels' contents rather than after
  them (the user, 2026-11-16, answering Q43 and Q51: "do the rail now").
- Every way of saying where the board sits is one panel, Board place
  (the user, Q52).

## The areas and the old pages

- Pages: Use `home`, `job`, `run`; Setup `facts` (Checklist), `machines`
  (Machine file, Connection, OpenPnP import, the firmware's Settings),
  `cameras`, `cam` (CAM profiles), `ui` (Version, Bug reports, Plugins).
  RENAMED in src/views/tabs.ts maps every old page name to the area its
  panels went to (jobs, plot and auto to job; pnp to run; config and
  connection to machines; plugins to ui), so a stored page, an old address,
  a bug report's link and a plugin asking for `page: "jobs"` still land.
- The views that run only while their page shows (the head camera's poll
  in vision.ts, the PNP state poll and its pictures, the jog keys) name
  `run`; `activePage()` falls back to `run` where no #app exists (the unit
  tests mount views alone).
- One Find board panel (page key `run`) serves every camera; mountPnp
  takes it as `shared` and draws the board again through `boardChanged`.
  mountPnp still mounts its own when handed `roots.find`, which the PNP
  tests do.
- The Job area has one preview. It shows the Draw panel's planned
  operation while no job, or a job drawn by hand, is selected, and the
  selected job otherwise: the Draw panel plans on every change, so
  `millPlan` is set even while a gerber job is selected, and showing it
  then would hide that job.
- The narrow one-column order by grid areas is the Run area's alone
  (`#page-run.grid`); on every other page the panels stack in the markup's
  order. The areas were once on every `.grid`, harmless while only the
  Jobs page held those panels.

## The rail

- The tab bar is the rail on a window of 64rem or more: #app's columns are
  `var(--rail)` and the panes (`--split-cols` side by side), rows the status
  bar and the rest. A narrow window keeps the bar across the top. The
  split's own bar grid (each side's tabs over its pane) is gone: the
  split only exists on a wide window, where the rail lists both sides.
- The line marking a tab is drawn from `--tab-line`, so the rail draws it
  on the tab's left edge and the bar under it, with the page colors or
  without.
- The gear's and the search's sheets are `position: fixed` beside the rail
  with their foot on the window's, since the tools sit at the rail's foot.
- The layout check skips a code editor's colored layer: its lines end
  wherever the file's do, and one ending within a few pixels of the edge
  at some width was reported as text against a wall.

## The Machine panel

- Position, Jog, Laser and Markers are one panel (src/views/machine.ts),
  mounted on Run (`#machine`) and on Job (`#job-machine`, for the Draw
  panel's Here). Each part is the old view in a box carrying the old
  panel's id (`dro`, `jog`, `laser`, `markers`; on Job the `mill-` ones),
  so a step, a fact or a link naming `jog` still finds it. goToPanel
  reveals the section a part is in, opens a fold holding it and pulses the
  section.
- The parts' heads are taken apart after mounting: their titles go, the
  position's age and the jog's Hold to move and Cancel join the
  panel's head. The panel layer only takes a section's direct
  `.panel-head`, and setup links go to the section named in FACT_RULES
  (`machine`, `job-machine`), so nested heads would be neither.
- The jog's go-to rows, Here is, the zero buttons and the feed fold under
  More, open as last left across redraws. Home, Unlock and Motors came
  out of it on 2026-11-17 (notes/views.md, "Home is in the head").

## Cameras on two sides

- Each camera's picture is on Run (`camera-view`, `pnp-view`,
  `pnp-top-view`) with Start, Stop and Look once in a row under its head
  (`pictureActions` in src/dom.ts); everything else of a camera (device,
  size, spots, lens and colors, picture controls, changes, calibration and
  its routines, the log) is on the Cameras page, as are the pick and place
  Head panel's moves and tuning and the Machine view. The buttons are the
  same nodes the settings views made, handed to the picture's panel, so
  Start still sends the device typed on the Setup side first. Since
  2026-11-17 each camera's picture is mounted a second time on the
  Cameras page (`camera-picture`, `pnp-camera-picture`,
  `pnp-top-picture`): notes/views.md, "A camera's picture beside its
  settings".
- A view polls while its own page shows, alone or side by side
  (`onShownPage`: the node's `main.page` has `data-up`; a node on no page,
  as in the unit tests, counts as shown). Asking `activePage()` would stop
  the Setup side's camera panel polling while Run is the page in front.
- Light, Park and Vacuum on and off (mountHead's `quick`) and Home by
  fiducial with Find home fiducial (mountTopCamera's `places.home`) go in
  the Run Machine panel's box for a pick and place head, shown only with a
  G-code machine.

## Board place

- One panel (src/views/boardplace.ts) with a fold per way, rough to
  exact: By hand (the selected job's offset and turn, which jobs.ts draws
  into the box it is handed), By camera (Find board), By marks (Align), By
  references (the pick and place references, shown with a G-code machine
  only). The boxes keep the old panels' ids, so `find`, `align` and
  `pnp-refs` in steps, facts and links still land; the Checklist's links
  name the panel, `place`.
- The views draw their own heads; `finish()`, called in main.ts once the
  last of them is mounted, moves what else a head held into the fold's
  summary and removes the title. Align's own fold is unwrapped: a fold in
  a fold folded twice. A way whose view hides its box hides its fold by
  `:has` in the stylesheet, so no store subscription has to run after the
  view's own (subscribers run in the order they subscribed).

## Height

- The Height panel (the height map's, renamed) holds the travel height and
  how a run follows the map, above the map. The jog draws its travel row
  into the box `mountJog`'s `travel` option names (the Run Machine
  panel's), and none on the Job area's Machine panel (`travel: null`):
  one home. The Run panel lends its map choice through `mapHost` and keeps
  the chip saying the map's use in words. The two boxes are separate
  because the jog redraws its row with `replace`, which would empty a box
  shared with the map choice.
- The Travel height step and its Checklist fact point at `heightmap`.

## Jobs, Job and the import dialog (Q53 A, applied, open)

- The Jobs panel is the drop area, a line saying the next import's
  settings in words, and the list. The settings themselves (power, speed,
  spot, anchor, offset, layer, mirror, board mode, clear or fill copper,
  margin, paste) are in the import dialog: the layer chooser a KiCad board
  opens, or Import settings with Done. Every other file still imports on
  one press with the settings the line states; asking for every file was
  one press more on each import for settings that rarely change.
- The selected job's groups, picked paths, stats, width and margin rows
  are the Job panel (`places.details`); its offset and turn are Board
  place's By hand.
- The drop area is a `stack`: its old `.drop p` bottom margin left the
  new line's foot against the box (the layout check's tail finding).

## Steps, Run and what fits the machine

- One Steps panel: a G-code pick and place machine's placing setup, else
  the setups this project's machines fit (setupsFor) with placing parts
  among them. The PNP page's own steps panel is gone (mountPnp mounts one
  only when handed `roots.steps`, as its tests do).
- Placing with a G-code machine is a part of the Run panel (`#pnp-run`, a
  box appended to `#run` after the job's run, its head made a section's by
  `asPart`), shown with such a machine only. The Checklist's links for
  placing name `run`.
- src/views/fit.ts hides the Run area's panels the machine connected
  cannot use: the head camera's picture and Height with a G-code pick and
  place machine; Parts, Board and the bottom camera's picture with a laser
  or a mill (a nozzle or a dispenser on this project's firmware places or
  dispenses, so they show). With nothing connected every panel shows,
  unless the pick and place machine last used says otherwise.
- The layout check sticks Board place to the panel above it: with a laser
  connected, Height is the first panel of its column and has no "Stick to
  above".
