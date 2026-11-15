# The web page

## Buttons and requests

Every button made through `dom.button` disables itself while the promise
its handler returns is pending, so a second click cannot send the same
request again. Views that also disable buttons from state (run, hold,
resume, stop) go through `setLocked`, which keeps that flag apart from the
in-flight one; otherwise the request's `finally` would re-enable a button
the state had just locked. Keyboard jogs keep one request in flight the
same way, and are ignored while an input has focus or a dialog is open.

## Laser test

The beam test asks every time. A once-per-session answer would let a stray
click fire the laser, which is the one thing a confirm exists to stop.

## Event frames

The backend flattens the payload next to `type`. `parseEvent` also accepts
`data` or `payload` wrappers, so either framing works.

## Mock SVG units

The in-page SVG reader follows the backend: user units are CSS pixels
(25.4/96 mm) unless a `width` and a `viewBox` together fix the scale. A
bare `width="200"` is 200 px, as in a browser.

## Progress before a run

`GET /api/run` and the snapshot's `run` are `null` until a job has run; the
page keeps the last progress it saw and hides the bar when it belongs to
another job.

## The console and the status poll

The link asks the machine for status 5 to 10 times a second forever. Those
lines and the reports they bring back carry `poll` on the event, and the
store drops them unless the console's "polls" box is ticked: keeping them
would push every real line out of the 400 line buffer in under a minute,
which is what the console looked like at first. Ticking the box shows
polls from that moment on, dimmed; it does not go back and add the ones
already dropped.

If an operator presses "Status ?" while one of the link's own polls is
still outstanding, the two reports can swap labels, so one poll shows and
one asked-for report hides. Nothing downstream cares, and the alternative
is a request id the firmware has no room for.

## Cross slide panel

The slide sits in its own framed block beside the pad and the axis buttons
rather than as two more axis buttons: it is a setup axis that never takes
part in a cut, and the frame plus the note say so before a button is
pressed. Its step sizes (0.05, 0.1, 0.5 mm) are the corrections a centering
burn is measured into, not the board steps.

The panel sends `feed: null` for a slide move, so it runs at the firmware's
`jog_z`. The feed field next to the board steps is the operator's feed for
moves that carry the beam over the board, and a rate picked for those has
nothing to say about a setup axis.

`Joint` stays the interpolated pair (`r`, `a`) that the kinematics work in;
`JointPosition` adds `z` and is what the machine reports.

## The groups table under the operator's hands

A patch of one group field reloads the job, and a fresh copy of the same
job used to rebuild the whole table, tearing out the field being typed
into: the browser fires no `change` for a removed element, so that value
was lost. A same-job update now sets the existing inputs in place and
skips the focused one; only a different job, a different group count, or
a group's label or path count changing rebuilds (`groupsShown`). A re-cut
for another width or a stencil's margin keeps the count but changes the
labels, which until 2026-11-02 stayed stale in the table. The stencil's
margin row re-cuts on Enter or its button without a confirm, since trying
margins against the preview is what it is for; picking stencil in the
upload form turns a Layer of F.Cu or B.Cu into its paste layer. The run panel shows `progress.error` beside the badge, so the
reason a run ended stays after the toast. Delete asks first and leaves
the selection alone when the backend refuses. A board goto with one axis
blank sends only the other: the backend fills it from where the queued
jog ends, which the readout mid-move does not show. `numberField` asks
for the phone's decimal keypad only when the field has a non-negative
minimum, because that keypad has no minus key.

## The mock follows the firmware, not the other way round

Every rule the mock enforces is the firmware's or the backend's: a
negative radius is the far side and `r_max` compares its magnitude; a
hold closes a `laser` beam from any state and ends a slide move in
`Idle`; a reset alarms only when the joint stepper was moving; a
disconnect ends the run as stopped, keeps that progress for later
snapshots and resets the machine; a move under a micron of surface length
runs dark; the minimum radius is the closest approach of any segment;
joint groups are kept, previewed by sampling and streamed as a `go` then a
`cut` per pair, with no offset allowed; gcode closes paths on `M5`, `S0`,
a rapid and an S/F change and groups by `(S, F)`; SVG groups by effective
stroke color and skips hidden shapes; the defaults are the protocol
table's; `cut` without any F is `error:3`, F under 0.001 is `error:4`, and
a reset forgets F, S and the mode. The error texts, the reset transcript
(`[MSG:reset]`, the alarm, the banner) and `help` are the firmware's own,
so a console rehearsed against the mock reads like the machine.

## Stylesheet (Solarized restyle)

- Colors are Solarized tokens; UI tokens may use `color-mix()`, but the
  `--pv-*` preview colors stay literal hex because the canvas reads them
  with `getPropertyValue`, which returns the unresolved expression.
- A disabled `fieldset.panel-body` no longer fades itself: its controls
  already match `:disabled`, and the two opacities multiplied to about 0.27.
- DRO values scale with `cqi` (each `.dro-cell` is an inline-size
  container) so a nine-character angle fits without wrapping.
- Desktop layout is three `.column` scroll boxes in a one-screen-tall grid;
  on narrow screens the columns are `display: contents` so the panels fall
  back into the one-column grid areas. Jog, preview and jobs take the leftover
  column height (`flex: 1 0 auto`) so the short panels never stretch. The gap
  is split between grid and column padding so panel shadows are not clipped
  by the scroll boxes.
- `input[type="number"].field` outranks `.field-grid .field`, so full-width
  rules for number fields have to name the type too.
- Flow (2026-11-11): blocks stacked in a panel are spaced by the box, not
  by their own margins. Before, ~60 rules gave blocks one-sided margins in
  nine sizes (`.hint` 0.4rem above only, rows 0.5rem below, a bare `<p>`
  the browser's 1em), and fields, buttons, tables had none, so a pair's
  gap was whichever margin was bigger: a hint sat on the button under it,
  trailing margins ran into panel padding, and rows needed rules taking
  their margin back off inside other rows. Now the flow rules at the end
  of style.css zero every stacked block's vertical margin and put
  `--flow-tight`/`--flow`/`--flow-wide` between shown siblings; a new box
  that stacks blocks joins their list (`stack` for an anonymous div), and a
  component gets no vertical margin. Empty p/ul/ol/div take no margin (a
  margin passes through an empty box and out of its parent); the console
  and the JSON caret line are named exceptions since they keep their size
  empty. A view hides a row whose content is all hidden instead of leaving
  it standing empty. `mise run test-layout` (layout/check.ts, Playwright's
  Chromium over `?mock=1`, several states, 1440 and 400 px) fails on any
  gap off the tokens, any leaked lead/tail, and text within 3 px of a
  drawn box's inner edge. A frame drawn for a picture (`.pnp-drawing`)
  pads a note put in place of the picture. Segmented buttons take width
  by label (`flex: 1 1 auto`): an equal split put "On the line" into its
  padding.

## CAM page and the TOML imports

The CAM view keeps the profile's text and its parsed document together
(`CamProfileResponse`): every field edit goes to the backend as a one
value patch and the answer carries both, so the table and the editor are
rebuilt from the same reply. A textarea the operator has typed in is not
overwritten by that reply (`dirty`), only told it is behind; Revert takes
the saved text. The mock imports the shipped `cam/*.toml` files with
`with { type: "text" }` and reads them with its own subset reader, so the
mock's profiles are the shipped ones without a copy. Bun gives one module
per path: a second import of the same file with another attribute gets
the first loader, hence the test compares against `Bun.TOML.parse` on the
text rather than a plain import of the file. The tabs set `data-page` on
#app and the stylesheet hides the other page; the jog keys check the page
so arrows on the CAM page move nothing.

## The TOML editor

The editor is a text field with transparent text over a `pre` holding
the colored copy; the two share font, size, line height, padding and
`white-space: pre`, and the layer is scrolled to the field on every
scroll event. A `pre` drops a trailing newline, so the HTML always ends
with a space past the last line: without it the field's empty last line
had no counterpart and the layer came up a line short. The live check
uses the page's own TOML reader, which reads less than the language
(plain keys, table names one level deep): a file it refuses may still be
good TOML, so the status wording is the reader's and the backend's check
is the one that counts. Tab inserts four spaces by slicing the value
rather than `setRangeText`, which the test DOM does not have.

## Jog bars

Every axis is a bar with its own step pick, the board's X and Y bars
included, so the keyboard reads the X bar's step for left and right and
the Y bar's for up and down. A step typed in the bar's field wins over the
choice buttons while it is there and unpresses them; pressing a choice
clears the field. The cancel button sits in the panel's head, outside the
fieldset the connection disables, so it is locked on its own with
`setLocked` when no machine is connected.

## Machine file order

The backend lists the files by file name, byte by byte, so
`polar-laser-focus.toml` comes before `polar-laser.toml` (`-` sorts
before `.`). `localeCompare` on the ids puts them the other way round; the
mock sorts the ids with `.toml` appended and a plain `<` to match.

## Travel height, map chips, unapplied edits, setup steps, PNP (2026-10-29)

- Travel height is an absolute H (`[host] travel`, `host.travel`, null is
  off), rise-only: gotos across, probing (a floor under the height probing
  travels at, so the probe depth counts from it), Probe nearest, the
  camera and PNP routines. Milling runs keep their own clearance over the
  surface; jogs are the operator's. A goto planned while the head is still
  moving goes to the travel height regardless, since the end is unknown.
  On the polar machine `_move_frame` returns no status, so the rise reads
  one itself.
- The map chip mirrors `Backend.compensation` on the page (auto, focus
  axis, power, complete, focus set, covers the job within 1 mm); masked
  cells along cuts stay the backend's to refuse. Progress carries the
  settled mode (`compensate`), so a run under way says what it follows.
- Unsaved-to-flash is tracked by the backend from what it sent or saw
  taken at the console since the last `$save`/`$load`, a connect or a
  restart; it cannot know what the board held before it connected. The
  mock compares against its copy of flash instead.
- Pending edits: a store map per panel, the tab count drawn from a data
  attribute so a tab's textContent stays its name (tests match on it).
- The steps test called `goToPanel`, which remembers the page in
  localStorage that every test file shares; a later tab test saw Config.
  Clean that key up in any test that switches pages.
- `bun test | grep` hides the exit code: write the output to a file and
  check `$?` before committing.
- PNP: the up camera's mapping is picture px to machine mm through scale,
  roll and a mirror; two head moves (+X, +Y) give all three, the mirror
  from the sign of their cross product. Positions are joints (R, Z), not
  board points, since the camera is fixed to the machine and the board
  frame turns with the table. Only X/Y machines: on the polar one the head
  moves along the rail alone.
- The PNP table and drawing are rebuilt only when what they show changes:
  rebuilt at the state rate (10 Hz), a press on a row or a dot could land
  on an element replaced between mousedown and click.
- Parts come from the kept `.kicad_pcb` with a small s-expression reader
  (KiCad 10 puts tokens on lines of their own, so no grep), footprints
  marked `exclude_from_pos_files` or `board_only` or with a `*` reference
  left out; placed with `Design.board_to_job`, angle plus the design's
  rotation.
- Screenshots: Playwright 1.64.1 in another project's node_modules
  matches the cached chromium-headless-shell 1248; import it by absolute
  path from a script in the scratchpad. The confirm dialog ignores presses
  in its first moments, so a script must wait before confirming.

## Tabs, the Run panel, arithmetic, arrays, combining, thumbnails (2026-11-08)

- The page ids are `jobs` and `plot` (were `machine` and `mill`); `?page=`
  and the stored page still accept the old names (`RENAMED` in tabs.ts).
- The run controls left the job details for a Run panel at the foot of
  the right column: a sticky element cannot leave its containing block, so
  sticky inside the details would have scrolled away with them whenever
  the details were below the fold. The panel is sticky on the wide layout
  only; on a phone it falls in the flow after the jobs (grid area `run`).
  `mountJobs(root, ctx, runRoot?)` appends the run parts to the panel when
  given one, else to its own end (the tests mount it that way).
- Number fields are text fields: a `type=number` field throws anything but
  a plain number away, so `25.4/2` could never reach `parseNumber`. The
  arrow keys step them as a number field did (step `any` steps by 1), a
  calculation is replaced by its value on change in a listener added at
  creation, so it runs before every view's own, and a plain number is
  left as typed (3.50 stays). `src/calc.ts` reads the arithmetic itself
  (no eval): units scale the product they end, so `1/8 in` and `1 in / 8`
  agree; trigonometry is in degrees. A field with a non-negative minimum
  still asks a phone for the decimal keypad, which has no operators; the
  others get the full keyboard. Selectors that named `input[type=number]`
  now name `input.num`. "Nickle" (the desk calculator language) was not
  used: it would need a process on the backend for a page-side need.
- Arrays (regroup.ts `arrayPaths`) copy picked paths into their own
  groups' ends and answer the copies' refs, which stay picked, so Delete
  paths undoes an array. The draft lives in `arrayDraft`, apart from the
  JSON panel's `jobDraft`, which that panel owns. The job goes back with
  `recipe: null`: a re-cut for another width or a Plot page Apply would
  rebuild it without the copies.
- Combine labels each group `job name: label` so two jobs' `cut` groups
  stay apart in the table; the jobs are combined where they are (offsets
  and turns are in the paths), so the new job starts unmoved. Jobs whose
  groups name different tools are refused.
- Thumbnails come from the backend (`/api/jobs/{id}/thumb.svg`), not the
  page: the list holds summaries, and fetching every job whole for a
  64 px drawing would cost megabytes. The address carries a key of what
  the drawing shows (`thumbKey`: stats, offset, rotation, groups' on/off
  and counts), so the browser keeps an unchanged one. The mock answers a
  data address, cached by the same key.


## Buttons kept through status frames, and other sweep fixes (2026-11-09)

- The Setup row and the alignment marks table are drawn again only when
  what they show changes (a JSON key of their contents): the store
  changes with every status report, and a button replaced between press
  and release takes no click. markers.ts had the same guard already.
- The Map on and Run steps lead to the Run panel since Run moved there.
- A tool call that changed jobs reloads the selected job only after the
  list is back and still holds it (a deleted one toasted 'no such job').
- Thumbnails skip empty paths (a PUT may store one); combining refuses a
  dispenser's dots with untooled paths; the mock's width change gives a
  recipe with neither file nor operations the number alone, as the
  backend does.
- Each camera log panel asks for its own camera (`camLog(camera)`): the
  shared newest hundred could hold only the other camera's looks.
- Move and Delete paths send the job with `recipe: null`, asking first
  on a job with a recipe, as arrays do; the backend's replaced() drops a
  recipe itself when the groups no longer cut what the old job's did
  (count, label stems, paths, joints, moves, areas), since a width or
  margin re-cut made from the kept file brought deleted paths back and
  switched-off ones on. A label changed by PATCH still loses its group's
  settings at a re-cut (carry_settings matches by label stem).

## Text on the page (2026-11-11)

Since 2026-11-15 the rules for anything shown on the page live in
docs/UI_PRINCIPLES.md (layers by frequency, one next action, color only
for a state, a budget of 40 controls and 200 words per screen); the text
rules below are its principle 8. docs/UI_REDESIGN.md is the proposal
built on them, not yet applied.

The user found the page's text much too verbose; a pass cut ~350 strings
(a53897b, 395f8be, 1a25870, 7600f4e). Keep new text to the same rules:
a tooltip is one phrase; a hint is one or two sentences and is left out
when the label says it; a confirm is the question plus the one
consequence that matters (safety warnings stay); an error names the
field and its range ("margin: 0 to 2 mm"). Backend and mock messages
were not touched (they mirror each other line for line), so the page
says "does not parse" where they still say "does not read". The jog
panel's zero hints and notes live in four copies kept identical:
controls.ts, controls.py, toolpath/tests/data/default-controls.json
(`mise run controls-fixture`) and the shipped machines/*.toml.

- views.test.ts "a KiCad board's own layers are offered before it is
  sent..." fails about one full run in four (also at deb93f2), passing
  alone: a timing flake under load, not a fault (2026-11-14).
