# The rail, the areas and the panels sorted (2026-11-16)

The plan is docs/UI_PANELS.md (what goes inside each panel) and
docs/UI_REDESIGN.md (the frame). This file holds the decisions taken
while building them and what was not obvious.

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
