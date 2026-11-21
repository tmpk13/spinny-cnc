# Modes (2026-11-21)

The operator asked (2026-11-21): "Swap from the current `all panels`
toggle to just all panels. Want to move to defined `modes` a dropdown,
that allows for preset and user panel arrangements and hidden/shown
panels. For example one might be PNP use, another PNP config, ... so on.
This will mean the setup steps will removed for now. They need a rework
anyway." The views, the steps' bar and the dock that came before are in
notes/views.md; how to use modes is docs/OPERATING.md, Modes and Auto.

## Decisions

- **A mode is every area's layouts**, the layout layer's own model
  (src/layout.ts), so nothing in a panel knows of modes and the layer
  only gained a way to read and set every page's layouts
  (`layouts`, `setLayouts`, `defaults`, `blankPages`). src/modes.ts holds
  what a mode is and the built-in ones; src/views/modes.ts puts one on
  the page. All panels is the markup's layout everywhere.
- **Built-in modes hide by lists of the markup's panels** (`PAGE_PANELS`,
  `only`, `none`), never by "every panel": a panel added later (a
  plugin's, or one new in index.html) shows in every mode until a mode
  says otherwise. A hide-all flag hid a plugin's panel adopted after the
  mode's layouts were worked out, so the mode read as changed or not by
  when the plugin started. A test holds `PAGE_PANELS` to index.html, so
  a panel added to the markup asks where it goes in each mode.
- **Each mode keeps its changes** (Q72), as an editor's workspaces do: a
  mode's layouts as left are kept apart from its own, and only while
  they differ, so going to another mode and back loses nothing. Reset
  puts its own back; Keep as makes a mode of the operator's from the
  panels as they are (opening on the area shown then), and keeping one
  under its own name again is how its own layouts change.
- **`spinny.layout` is the mode in use's layouts as drawn.** The layer
  reads it at mount (and for a plugin's panel's last place); every change
  the layer reports is written as the mode's too, and at mount the
  layouts drawn are taken as the mode in use's, so the two stores cannot
  disagree for long. A hand-edited store that names a mode with other
  layouts reads as that mode changed: Reset mends it.
- **The first time**, the layouts kept by name before modes
  (`spinny.layout.presets`) become modes of the operator's own (Default,
  the markup's then, is All panels), and the mode in use is the one the
  layouts drawn match, else All panels.
- **An area with nothing to show leaves the rail.** Blank is read from
  the layout alone: a panel only its own view hides (fit.ts by machine, a
  top camera's without a G-code machine) still counts, so an area does
  not come and go with what is connected. The area in view keeps its tab
  until another is shown, so hiding the last panel by hand does not lose
  the page; a side out of view that was on a blank area turns to its
  first area with something; a side with no area left has no name; a
  pick or a reload never leaves a blank area shown. Home's panels have no
  menu, so Home is never blank. Peeking shows every hidden panel, and the
  blank areas come back with them.
- **A mode picked goes to the area it opens on** (the use modes to Run,
  Laser/mill config to the Checklist, PNP config to Cameras, one of the
  operator's to the area shown when kept); All panels stays where the
  page is.
- **The pick is in the top bar, not the rail**: the rail folds to a strip
  in the page settings, and principle 7 wants the mode in use in plain
  sight.
- **A link, the search, Next or Auto going to a panel the mode hides
  shows it**, a change the mode then keeps, as it was for a panel the
  operator hid. A panel hidden is never out of reach.
- **The use modes leave the Setup side's areas out but Page** (Q74):
  connecting is the top bar's, what needs someone is Home's; a link to
  one of them shows it.
- **The steps became stages** (src/views/stages.ts): each is done or not
  from the state, says what is so in a line, and names the panel that
  does it. Home's Next goes to that panel; the run chip goes to the Run
  panel.
- **Auto moved to the top bar** (Q71). It goes to a stage's panel where
  it stops for a person, not on Stop Auto (the operator is where they
  mean to be); a press on its line goes there again and puts the line
  away. The line hides on a phone.
- **The Steps panel stays** (Q75), shown in All panels and hidden in the
  other built-in modes: the Checklist's Measure links (`steps/<setup>`)
  go to it.
- **What was a step's alone went**: the Connect and Job to run panels
  (the top bar's Connect and Home's Jobs do both), the dock and its Jog
  toggle (the Machine panel is whole everywhere).
- **The budget** (docs/UI_PRINCIPLES.md, principle 13) measures every
  area of every built-in mode but All panels; the eight screens over it
  hold at what they measured (Q73). Folding the console in every mode
  took 10 controls off the config modes' Run.
- Q55 (steps or all panels on Run) was answered by the request; Q47 (the
  layout layer once each step shows its own panels) is moot: the layer
  arranges every area, kept per mode.

## Traps

- **tabs.ts's blank areas are module state**, shared by every test file
  bun runs in the process: a test that names blank areas puts the set
  back (`setBlankPages([])` after each test), or a later file's rail
  loses tabs.
- **A mode picked goes to its own area**, so the shot tool shows the page
  a shot asks for again after the pick, and the layout check walks the
  areas the rail lists after each pick.
- **The measure counts a stack's tabs** ("other" in its tally): putting
  the Job area's ways (Draw, the Assistant) behind tabs in Laser/mill use
  made its Job screen heavier (66 controls against 63), as Draw stayed in
  front; the area is whole there.
- **The eye counts every panel the mode hides** (38 in PNP use), and the
  page settings' list of hidden panels holds them all.
- **The pick squeezed to "P." in a phone's bar**: a select shrinks with
  its flex item; its box is `flex: none` there and the machine's name
  gives way.
