# Panel layout, page settings, tooltips (2026-11-11)

Built by an agent in a worktree (branch todo-layout), merged by
cherry-pick on 2026-11-11.

- src/layout.ts holds the layout rules as pure functions (tested);
  src/views/panels.ts puts them on the page. A column is blocks, a block
  is stacks stuck together, a stack is panel ids. The markup is the
  default, read at mount by id, so a panel added to the markup joins with
  no code change; a stored layout is normalized against it (gone ids
  dropped, new ones put before the first block holding a panel the
  markup puts after them). Moves, the grip and Move left/right act on the
  whole block, since stuck panels move together; a drop onto a panel
  stacks only when the dragged block is one stack. Left/right keep the
  place counted in blocks.
- Layouts kept by name are global (one covers every page): a layout is a
  way of working, and per-page names would multiply. Default is reserved.
  Edit mode is not stored. localStorage: `spinny.layout` (the working
  layout by page; pages matching their markup are not stored),
  `spinny.layout.presets`, `spinny.tabs` ({start, fold, hidden}).
- Panels folding with their own disclosure (Setup, Align, Camera, Job
  JSON) keep that fold their own way (foldPanel's key); the layer only
  opens and closes it. Storing the fold in the layout too gave two
  sources that disagreed (Job JSON mounts closed, the others open).
- A page whose arrangement differs from the markup gets data-arranged,
  which drops the curated narrow grid areas, so a phone shows the panels
  in their columns' order.
- Sticky Run: Chromium stops a box stuck to the bottom of a padded scroll
  container at the padding, and content showed in that strip. Columns
  have no foot padding; the layer marks the first and last panel shown
  (data-first, data-last) and they take the room as margins. Run docks
  through data-dock in the markup, only while not stuck or stacked.
- Fixed height: the panel is the scroll container, its head sticky at
  top 0 with the panel's top padding moved into the head (browsers
  disagree on where a sticky box rests in a padded scroller). The height
  handles are absolute elements in the column placed by JS from
  offsetTop: inside a scrolling panel they would scroll away.
  ResizeObservers keep them and the column handles placed. Widths are
  stored as shares and applied through --cols only in the wide media
  query (.grid[data-widths], minmax(12rem, Xfr)).
- Menus (src/menu.ts) close on a scroll only when their anchor moved: a
  scroll event can arrive a frame late from a scroll made before the menu
  opened (Playwright's scroll into view), and the console scrolls itself
  all the time. The menus' arrow keys are prevented, so the jog keys
  (which skip defaultPrevented) never fire from them; the settings sheet
  stops arrow keys from propagating.
- Tooltips: disabled buttons get pointer-events: none, so hit testing
  lands on what holds them; src/tooltip.ts finds the button by its box
  and swallows a press on that box in the capture phase. This does not
  depend on how a browser handles events on disabled controls; Firefox
  itself was not tested (only a snap Firefox, which Playwright cannot
  drive). `setLocked(node, locked, reason)`, `lockFor(node, [cond,
  reason]...)` and `lockFieldset` carry the reasons; every page's views
  pass them, the PNP ones included.
- happy-dom 17.6.3: :scope in querySelector(All) returns nothing (the
  layer filters children instead), and a MutationObserver's callback is
  held through a WeakRef to an arrow function nothing else refers to, so
  a garbage collection silently ends it mid-test (allocation-heavy calls
  such as getComputedStyle make that likely). The panel tests call the
  controller's refresh() rather than wait for the observer; the layer
  reads a view's hidden class live when it draws. Its DOMParser also
  refuses OpenPnP's machine.xml (see notes/pnp-device.md).
- Tab bar: .tabs-list is display: contents so the gear shares the last
  row of tabs on a phone. The folded strip's label is drawn from
  data-label, so no button's text repeats a tab's name (tests find
  buttons by text).
- layout/check.ts switches tabs by script, with the window scrolled to
  its top (a folded bar hides the tabs, and a JS click does not scroll as
  page.click did); a box held at a height or scrolling has no tail check.
- The machine file tooltip maps the pointer to line and column from the
  field's line height, padding and a canvas-measured character width;
  tabs would throw the column off, but the files are indented with spaces.
- Left: the size handles take mouse and touch only (no keyboard); the
  grip and menu buttons' aria-labels are set at mount, so they go stale
  if a view renames its panel; dragging in edit mode is wide-layout only.

## Side by side, peeking, scroll ends, fit (2026-11-12)

- A block's stacks sit side by side when the block's first panel has
  `row: true` in its prefs (setRow clears it from every other panel of
  the block; unstick clears it from the stacks parted). The layer wraps
  such a block in `div.panel-row` with a `div.panel-row-cell` per stack
  (its tabs over its panels), cached by the block's and stack's ids like
  the strips, removed when unused. Row members lose the join and
  first/last marks (the wrapper takes first/last); a cell whose panels are
  all hidden is `hidden`. A narrow screen makes both wrappers
  `display: contents`. Panels in a row get no height handle: one the
  column's width would not say whose height it sets.
- Peeking (the bar's eye) is not stored: `shown()` takes operator-hidden
  panels as shown while it lasts and marks them `data-peek`; their menu
  offers Show for good. The eye goes when nothing is hidden, and a peek
  with nothing hidden ends itself.
- Scroll arrows sit in a head after the menu button and show only while
  the panel has a fixed height (the panel is then its scroll container).
  The bar's arrows act on the column last pointed at or typed in
  (pointerover/focusin), every column of the page when none was, and the
  window on a narrow screen. Fit to screen sets the fixed height to the
  column's clientHeight less two gaps (`--gap` read as rem).
- The new bar buttons are `.tabs-tool`, not `.tabs-gear`: layout/check.ts
  opens the settings with `page.click(".tabs-gear")`, which takes the
  first match.
- Thick scroll bars: Chromium (121+) ignores the ::-webkit-scrollbar parts
  whenever scrollbar-width or scrollbar-color is not auto, so every
  `scrollbar-width: thin` rule went and the webkit block sets
  `scrollbar-color: auto`; Firefox keeps its auto width with the colors.
- Info drawings open on a press and are `position: fixed`, placed by JS
  under the mark: inside a panel held at a height an absolute pop was
  clipped. A fixed pop would stay put while its mark scrolls away, so any
  scroll (capture phase) closes it.

## Folder stacks, tabs pulled out, rows folding sideways, markup stacks (2026-11-13)

- The markup stacks a panel with the one before it by `data-stack`
  (markupDefaults in panels.ts). layout.ts's `Defaults` is the old
  `string[][]` with an optional `stacked` property on the array (id to
  the stack's first panel), so every function and test that passed plain
  columns still works; withStacks builds one. insertDefault puts a marked
  panel into its partner's stack wherever that is now, so a stored layout
  from before the marking picks the new panel up in the right stack, and
  Reset panel puts it back there.
- sameArrangement compares the shape only (it drives data-arranged, the
  narrow grid); isDefault also wants every stack's front to be its first
  panel, else a tab pressed in a markup stack would read as the markup's
  layout and not be stored.
- A tab dragged more than 1.25rem off its place (wide only, no edit mode
  needed) unstacks its panel, then places it; dropAt(alone) keeps the
  block it left as a place to go before, and a drop "before" the dragged
  panel itself (it headed its block) means before the block's next panel.
  The click that ends the drag is swallowed by a data-dragged-out flag
  cleared on a timeout (the click comes in the same task as pointerup).
- Folder look: tabs overlap by -0.3rem, the ones behind sit 0.125rem
  lower; the panel behind a stack is drawn by box-shadow offsets 0.25rem
  and 0.45rem (inside the column's 0.5rem side padding, so not clipped by
  the scrolling column), data-depth set by render. The stacked panel's own
  h2 is visually hidden (still read out); a folded row cell shows it again.
- Side by side, the cell gets data-folded both in render (after the cell
  is filled; applyPanel runs before the panel is moved into its cell on
  the first draw) and in applyPanel (a disclosure's toggle event draws
  only the panel). Its head turns vertical-rl, only inside the wide media
  query: on a phone the row wrappers are display: contents and the same
  selectors would turn the head on its side there too.
- Panels added after the layer mounted (a plugin's): PanelsController
  adopt(root) and drop(id), with adoptPanel/dropPanel. The id goes into
  the column's defaults before the next panel already known there and
  the layout is normalized from the stored one, so it comes back where
  it was left; drop removes the id and its handle and stops watching its
  size. A plugin's panel goes at the end of the page's last column, above
  a docked one such as Run. layout/check.ts presses the bug button by
  script (the tab bar is folded in that state) and waits 400 ms before
  confirming a plugin.

## Folders, one fold per stack, marks of content out of sight (2026-11-14)

Built by an agent in a worktree (todo-panels), cherry-picked.

- A folder is a block with a name. The folder's name and whether it is
  folded (`PanelPrefs.folder`, `shut`) are kept, like `row`, on the panel
  heading the block (the first panel of its first stack). `passBlockPrefs`
  hands them to the next head whenever the head leaves (`takeStack`,
  `unstack`, `resetPanel`, `moveStack`), drops them when the block joins
  another (`stick`) or is split (`unstick`, `ungroup`), and
  `normalizeLayout` drops them from any panel that heads no block. Before,
  `row` stayed on a panel unstacked from a block's head and the block
  quietly stopped being side by side.
- Drawing: a folder's nodes go into `div.panel-folder` after its head;
  nothing inside joins; the view is cached by the head panel's id (a new
  head makes a new box); the box is not positioned, so the height handles
  still measure from the column. Narrow screens: the box is
  `display: contents` and its head hidden; the rule that hides a folded
  folder's panels sits only in the wide media query (a
  `display: revert !important` on narrow screens beat `data-behind` and
  showed panels hidden behind a stack).
- Markup folders: `data-folder="Name"` on every member, a run of one name
  is one folder (`Defaults.stuck`, `Defaults.folders`); the default
  layout's panels carry the names, so `isDefault` compares against
  `defaultPrefs`; a layout kept from before has none until Reset.
  `drop()` rebuilt `page.defaults` with `Array.map`, losing `stacked`; it
  now goes through `withStacks`.
- In a folder a panel's menu moves it within the folder (`moveStack`), the
  folder moves from its own head; in edit mode a member's grip drags its
  stack alone, the folder's grip the whole block; a drop on a folder's
  head is a drop of its own kind.
- One fold per stack: `setCollapsed` folds every member, disclosures
  opened or closed under a `folding` flag (their toggle events are
  synchronous in happy-dom); `syncFolds` in `render` gives a stack its
  front panel's fold; a disclosure toggled by hand folds the rest.
- Out-of-sight marks: a zero-height sticky `.more-mark` at the end of
  every panel and column (`markCut`, `data-cut-top`/`data-cut-bottom`).
  In a panel a sticky box rests at the padding's inner edge in Chromium,
  so the fade reaches through the padding (`--more-pad`); in a column a
  negative margin takes back the flex gap, so showing the mark changes no
  scroll height and cannot loop a ResizeObserver. No mark under a docked
  Run panel. A held panel's children are observed for size, since its own
  box no longer grows with them.
- Trap: layout/check.ts runs on Bun's dev server, which hot-reloads a
  source edited during a run; the page reloads mid-state and a later click
  times out. Never edit page sources while the check runs.

## The Machine view panel (2026-11-14)

- `#pnp-machine-view` is the last member of the PNP page's Machine folder
  (Head, Board on the machine, Feeders), hidden with the other G-code
  panels by pnp.ts showTarget; PnpRoots.machineView is optional, so the
  tests' pnpRoots() need not give it. It is drawn by its own height
  (aspect-ratio of what it shows, max-height 70vh), with no height
  handle of its own beyond the layer's.
