# The page's look: fonts, movement, pop-ups, the Overview page (2026-11-13)

## Fonts

- Inter and JetBrains Mono, the latin variable woff2 files from Google
  Fonts (fonts.gstatic.com, Inter v20, JetBrains Mono v24) with their OFL
  texts in web/frontend/src/fonts/. Served with the page, never from a
  CDN: the page runs on a Pi or a laptop with no network, and a CDN would
  also leak a request per load. Bun's bundler inlines them into the CSS
  as data URLs (the CSS went from about 70 KB to 224 KB, one file).
- The preview's canvas text stays system-ui: the worker that draws it
  does not see the document's @font-face.
- `--font`/`--mono` now name the bundled faces before `--system-font`
  and `--system-mono`; :root[data-fonts="system"] puts the system stacks
  back (look.ts, the page settings' Look section).

## Movement

- Opacity and transform only, under 0.2 s. The pages fade (opacity only:
  a transform on .page would make it the containing block of every fixed
  pop-up inside it while it runs). A panel unfolding gets data-unfold and
  one brought to the front of its stack data-arrive (panels.ts moveIn,
  taken off after 400 ms by a timer, not animationend: that event bubbles
  up from any animation inside the panel). Not marked at all while the
  page is still (look.moving()), so nothing waits on an animation that
  never runs.
- :root[data-motion="off"] stops every animation and transition, as the
  existing prefers-reduced-motion rule does, turning marks included.

## Pop-ups (src/dismiss.ts)

- A pop-up registers with popUp({nodes, close}) and lets go in its own
  close; the nodes get data-popup and the root data-dismiss while any is
  up, which the stylesheet turns into the circle-with-x pointer on
  everything else (an SVG data URL, hotspot 12 12, !important to beat
  component cursors; :not() with a complex selector list keeps the
  pop-up's own pointers).
- One pointerdown listener on the window in the capture phase runs before
  every document listener: a press outside closes all pop-ups and is
  stopped, and only the click that comes in the same task as that press's
  pointerup is swallowed (a swallow left armed until the next click took a
  test's checkbox click in another file: a press dispatched by a test, or
  a lost pointer, never lets go). Before, a press outside closed a menu
  and also pressed what was under it.
- .btn-stop and .urgent (every button that stops: Stop, Hold, Abort,
  Cancel, Reset, Laser off, Stop spindle) always take the press, and close
  the pop-ups too. Not .btn-danger: Test beam, Start spindle and Make mark
  are red too, and start things.
- A pop-up whose nodes all left the page is dropped at the next press: a
  test that left the feature search open made a later test's picture
  drag vanish, all tests sharing one module state.
- Registered: menus, the page settings, the feature search, the info
  drawings, the tab bar opened from its strip (followed by a
  MutationObserver on data-open, which several places set).

## The Overview page

- Gone since 2026-11-17: its cards repeated the rail and said nothing of
  the machine. Home is now what is next, what needs someone and the jobs
  (src/views/overview.ts, notes/views.md), and is the page a browser that
  remembers none opens on.

## Info drawings check

- layout/tips.html draws every info drawing at once; the layout check
  fails on words over words, over solid shapes (tip-shape, tip-mark), over
  lines or the nozzle outlines (points along the line, as a slanted
  arrow's box covers words it never touches), or out of the drawing.
  Words inside the faint boxes and dashed circles are meant to be there.

## Job icons (2026-11-13, an agent's, 8b13239)

- Drawn in the page (src/icons.ts: twelve glyphs on a 16-unit grid,
  even-odd fill; the eight Solarized accents; one or two letters or
  digits), not in thumb.svg, which would have needed the paths again in
  Python; the backend checks names against ICON_GLYPHS/ICON_COLORS and
  test_job_icon.py reads icons.ts to keep the two lists equal. A stored
  icon is not checked on load, so a bad one shows the drawing.
- A PATCH setting only the icon (`model_fields_set == {"icon"}`) is taken
  while the job runs and skips the stats; the runner keeps no copy of the
  job file. remake_upload, mill.remake, mill.placed, with_width and
  replaced() carry it; a combined job starts with none. The picker sits in
  its own li under the row and closing it removes only that li: rebuilding
  the list on pointerdown swallowed the click on another row. It is a
  pop-up (dismiss.ts). cam-post-samples.json holds job dumps, so a new Job
  field means `mise run cam-fixture`.

## To-do drawer and bug reports (2026-11-13, an agent's, 6faa7fd, aece6e8)

- The drawer lives in #app, not the status bar: the bar's backdrop-filter
  makes it the containing block of anything fixed inside it. Its top is
  set in rem from the bar's bottom on open and resize; its content is a
  .stack of its own height (the layout check's tail rule). A change is a
  function of the list, sent one at a time naming the revision it was
  made on; on a 409 the page reads the list again and applies the same
  function. No live event: another browser sees a change when it next
  opens the drawer. It is a pop-up (dismiss.ts).
- The screenshot is own code (src/pageshot.ts), no npm package: the body
  is copied synchronously at the press, before any await, so the dialog
  is never in it; values, ticks, picks and textarea text are copied in;
  hidden boxes and pages not shown dropped; a scrolled box's children are
  moved by translate (sticky ones not, or the docked Run panel jumped);
  in the SVG image :root is the <svg>, so the root's custom properties are
  copied onto it resolved; the stylesheet text goes in after serializing,
  escaped by hand (happy-dom's XMLSerializer leaves a style's < raw).
  Previews register a PictureSource and hand over their worker's frame
  (3 s limit); other canvases toDataURL; images through a canvas. Drawn at
  the screen's scale, at most 2 and 4 million pixels. Password fields are
  blanked.
- The action log keeps 200 actions (a repeat counts on the one before):
  presses with label, panel and page, checkbox toggles, pages shown,
  requests through HttpApi only (the mock makes none), toasts. Field
  values are never recorded.
- FormData: append a File; happy-dom ignored the name given to
  append(name, blob, filename).
- Plugins page (views/plugins.ts, src/plugins.ts): rows kept by id; a
  source loads when its fold opens; state.plugins from replies and the
  `plugins` event, read again when the tab shows or the feed reopens.
  Turning off runs the plugin's own undo, then the host's cleanups in
  reverse; a plugin whose listener throws is stopped; one that failed to
  start is not tried again until its text changes. pluginModuleUrl is
  absolute (under Bun's dev server an import resolves against a file
  path). The mock imports from data: URLs ending in "\n// .js" (skill
  bun-data-url-import-loader-by-dot).

## Page colors, the Overview's width, number fields, the top bar (2026-11-14)

Built by an agent (todo-panels), cherry-picked.

- Each page's color lives in tabs.ts PAGES, one home for the tab and its
  page; the tab bar sets `--page-accent` on the tab and on
  `main#page-<id>`. Only edges take the color, never text (yellow and cyan
  are too faint on base3 for small words). `Look.colors` sets
  `data-colors="off"` on the root and the color rules are gated with
  `:root:not([data-colors="off"])`; panels inside a folder take the plain
  top border back on the wide layout so the folder wears one color. The
  colors are off unless turned on since 2026-11-17 (color is kept for
  states, notes/views.md).
- Number fields (`input.num.field`) are centered. `dom.ts stepperBox(field,
  minus, plus, unit)` draws a field between - and + as one box, which takes
  the field's focus ring (`:focus-within`) and invalid mark
  (`:has(.field.invalid)`); only the camera zoom uses it so far.
- Top bar: `statusbar.ts firmwareLabel` shows `v<version>` for this
  project's firmware, and for a G-code machine the first word of M115's
  FIRMWARE_NAME and its first version-like token, the whole text as the
  tooltip (the real LumenPnP's M115 text was not seen).
