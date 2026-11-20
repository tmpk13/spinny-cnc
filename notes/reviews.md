# Reviews and bug sweeps

## What a review of the firmware turned up

Six things the first reading of every path had missed, found by walking
the code against its contracts a second time.

- The driver configuration retry was inverted: `then_some` keeps a
  configuration that landed and drops one that was refused, so a board
  brought up on USB before motor power never retried, and said "tmc
  configured" right after "refused". The retry now keeps only what has
  not landed, and the request is a latest-value slot rather than a queue
  of four, which dropped the newest snapshot under the settings page's
  burst of `tmc_*` lines.
- The USB endpoint reads and writes of embassy-rp never fail, so the
  reader's "read failed, host gone" path could not run: no laser off, no
  machine reset, no line assembler reset on an unplug. The device's own
  state changes (reset, suspend, configuration dropped) now report the
  disconnect through a `Handler`, and the reader and writer restart on a
  signal.
- A cross slide move did not close a constant beam lit by `laser`, so
  the rail could be carried across the board at full power. It closes it
  as a joint move does.
- A jog sent while a jog cancel was still braking was queued, answered
  `ok`, and thrown away with the rest. It is refused while the brake
  lasts.
- The step pulse is busy-waited inside the tick, at about 1.5 times its
  setting, so a `step_us` above 4 overran the 10 us tick the planner's
  rate ceiling assumed: the interrupt slipped, the move ran slower than
  planned, and under `mode dyn` the beam kept the duty of the planned
  speed. The tick floor and the ceiling now follow `step_us`.
- The status line's second `Q` number was a constant, its `V` and `L`
  described the segment last written to the ring rather than the one
  running, up to 150 ms ahead, a position past 2^31 steps was moved to
  short of its target with an `ok`, a reset in `Alarm` stood in for
  `unlock`, and a `version` typed in the console during a run was read
  by the host as the firmware restarting and ended the run. All five are
  fixed, and the docs say what the fields and codes now mean.

## What the host-side review turned up

The second half of the review read the backend, the frontend and the
virtual firmware against their contracts.

- The link held its send lock across the credit wait, so a console line
  or a settings read sent while a run had every credit in use waited
  behind the run instead of timing out; the credit wait is now held by
  nothing, and the queue-and-write step re-checks the count.
- A `version` typed with a comment was not recognized as one, and a
  `version` sent right after a reset took the reset's banner and leaked
  the expected count; the reset's banner is consumed first, and the
  keyword is compared with the comment stripped.
- A callback that raised ended the reader thread with the link still
  open; the status request returned a stale report when the port died
  during its wait; a line could carry a realtime or control byte past the
  reset bookkeeping; a partial line grew without bound; two closes could
  run at once; a port that died during the banner wait reported success.
  Each is guarded now.
- The backend's own status requests (a run's drain, a snapshot after a
  command) were shown in the console as if an operator had asked, which
  rolled every real line out of the 400 line buffer during a run's tail.
  They are polls now.
- The jog bookkeeping forgot a known end for a relative jog queued while
  jogging, kept a stale end after a move typed in the console, and
  recorded a sampled coordinate for an axis a one-axis goto left out.
- A patch refused part way left the job half changed in memory and
  unchanged on disk; a settings write applied the values before the one
  it refused; a config file that could not be written was reported saved;
  an overlong upload name was a 500. NaN and infinity passed every check
  and reached the wire as `Rnan`; every number entering from a body or a
  file is now finite and bounded, and a validation answer no longer echoes
  the input it refused.
- A path whose first vertex was within half a quantum of the axis but not
  on it lost its beam-off turn: the joint tracked kept a radius under the
  snap while the word written was `R0.000`, so the move away was cut as a
  spiral at the axis. The tracked joint is snapped with the word.
- An SVG line right after a close lost the segment from the closed
  subpath's start; a gcode file's cut order was changed by merging
  same-setting paths from anywhere in the file; the estimate defaulted to
  rates the firmware does not have and ignored `step_us`.
- The page kept a run it remembered when the backend restarted under it,
  toasted "not connected" on every load, stepped its readout back when an
  HTTP reply landed after a newer feed frame, and opened the beam confirm
  with the destructive button focused. The documented `?api=` mode never
  worked, since the backend sent no CORS headers: `--cors-origin` allows
  a named page.
- The virtual firmware ran a dead client's queued lines on with the beam
  lit and, in a hold, spun forever waiting for a queue it could never
  drain; a reset left the dropped line's entry in the trace's command
  log, shifting every later answer; the trace took the pin level for the
  beam, so under `laser_invert` the rapids were the burn; a disconnect
  waited out the idle disable timer before the next client was served.

## Where the doubles and the docs drifted from the firmware

- The mock refused a negative radius, kept a `laser` beam lit through a
  hold, held and resumed a cross slide move, alarmed on a reset during
  one, left a stale running progress after a disconnect, lit the beam on
  an axis turn, took the nearest vertex for the minimum radius, dropped
  joint-space groups on upload, read gcode and SVG by different rules
  than the backend, took F0 and a first cut without F, kept modal F/S
  across a reset, ran the old grblHAL rates as defaults, and patched
  running jobs unchecked. All of it now follows the firmware and the
  backend, with the firmware's error texts, reset transcript and `help`.
- The protocol doc lacked the reset's forgotten modal state and its
  `[MSG:reset]` line, the USB disconnect being a full reset, the command
  by state table, the setting bounds, the `$tmc` output, the fate of
  non-ASCII bytes and of empty lines; the web API doc lacked the error
  body shape, the patch's `name`/`label`, the summaries' `joints`
  count, the laser `ms` rules, the command edge rules and the nulls in
  the snapshot. A speed or feed in (0, 0.001) passed the host and reached
  the firmware as `F0`; both are refused at the firmware's floor now.
- The command line tools: a repeated point (a rapid then a cut to the
  same place, which every gcode file starts with) was taken for a turn
  on the axis, hopped the head there and cut back out, or looped forever
  for the joint dialect; a crossing that missed the axis by less than a
  quantum was a lit chord through it, since only an exact hit was seen,
  so paths are now cut at the axis the way the backend cuts them; an `F`
  on the `M4` line was dropped; the estimate assumed an infinitely fast
  table where the simulator assumed 3600 deg/min; the grblHAL return
  home booked a turn the controller never makes; `--fine` took and
  ignored the coarse pattern's flags.

## Third full review (2026-09-26)

A multi-agent review of everything since `678a36d` (probe, height map,
modes, clearing, restyle), 124 distinct findings, each checked by an
agent told to refute it; about 95 held and were fixed. What was not
obvious:

- The hold latch read the waiting-line count from the previous loop pass:
  both loops counted lines after the realtime bytes, so the usual case (a
  line and its `!` in one pass) found 0 and ran the line. The test passed
  only because it set the count by hand. Loops now count first; the core
  test models one loop pass (`Rig::pass`).
- A kept hold now applies to every line that acts: `laser S` answers and
  stays dark, a slide jog answers without moving, `spindle S` enters Hold
  (held Idle) and starts at the resume.
- A segment's rate was the mean of its end speeds. A block short enough
  to fit one segment, from rest to rest, has both ends 0, so it crawled
  at the 2 events/s floor for seconds with the beam at full power (and,
  since the per-layer `M` floor, lit in `dyn` too). The last segment of
  a block now runs at the mean of the fastest profile over its length,
  capped at `v0` during a hold.
- `~` during a probe's contact brake lifted the brake and drove the head
  through the board; it is ignored while braking. A probe queued behind
  a jog ran after the jog was cancelled; it now ends unrun.
- Spindle safety: `cut` is refused with the spindle stopped (a console
  `spindle off` ends the job at its next cut), `probe` while it turns
  (the probe may be the tool), and a turning spindle keeps the drivers
  enabled past `idle_ms`. `$defaults` keeps the four wiring settings, or
  an active-low laser lit at full power.
- The height map's heights live in the focus axis frame of the session
  that probed them; the axis has no homing. Only the focus offset ties
  them to the frame in use, so the backend takes `focus_set` back on any
  possible frame change (declared position, connect, restart, motor power
  loss, map from a file, rescaling setting) and "focus here" re-anchors
  the same heights exactly.
- The probe's answer timeout counted from the `probe` line, but `probe`
  waits for the travel move ahead of it: a half turn of the table at the
  default rate took longer than the margin. The e2e test ran `--fast`.
- `_status_asked` counted `?` bytes but `_status_seq` every report, so a
  typed `status` or a late report put every later `status_now` one report
  behind for the rest of the connection.
- A stop or reset during a run's preparation (seconds on a compensated
  job) found nothing running and was lost; the run then started.
- A program that closes the serial port is not a USB disconnect for the
  board (the endpoint never errors, see the embassy-rp note); the backend
  stops a spindle or beam before closing. DTR edge handling on the board
  is left for a hardware session.
- Verification was cut short once by the account's session limit: a
  verifier that returns nothing must not count as a refutation.

## Bug sweep of the 2026-10-29 work

A code review of everything since 7a6b276 found, and these were fixed:
a lost G-code link could not be connected again (its port was kept); a
part picked and then not placed (a stop, a failed look) was not counted
against its feeder (counted at the pick now); Abort on a device routine
waited out the move and its M400 before the stop went out (sent at once
now); position replies with axis letters past XYZABCE were not read; the
PNP page kept a moved or aligned job's old part places; the config could
be serialized while a run thread changed it (saves now take turns and
read again on RuntimeError); vision parts made the run's sent count pass
its total; the probe confirms ignored the travel height, and the touch
dry run left out its rise; the device profile was parsed on every state
publish (cached by mtime now). Also found by hand: Download offered a
program before one planned (it would save the refusal). Clippy and ruff
found style only. The fake Marlin must answer in order behind a held
wait, as a real controller does, or a stop's `ok` answers the wait.

## Bug sweep of 2026-10-29 to 2026-11-08 (2026-11-09)

Nine finders read the work since 641d1d7 (3D carving, Plot tab, Auto and
MCP, preview picking, job edits, CAM posts, TMC keys, cameras, run and
resume) and proved their reports with scratch scripts; nine skeptics
told to refute them confirmed 72 of 73 (the refuted one: the cartesian
laser posts leave S on rapids by design, grbl laser mode). Fixed in ten
batches, each fix with a test seen failing first; details sit in each
topic's notes under the same date. What was not obvious:

- The worst ones were machine-facing: a CAM mill program that ran every
  bit with no stop (the V bit fitted plunged for the holes), a board
  outline milled on the drawn line, a clearing bit eating copper, the
  kernel feeding straight down into stock at the cutting feed, a resume
  driving the focus axis from another frame's height, Last known
  overwritten by power-on zeros, a newline in a label becoming a gcode
  line, and a silent pcbv using up the server's threads so Stop waited.
- Agent worktrees were made from origin/main, 14 to 27 commits behind
  local main, not from local main: each fixer had to fast-forward first.
  `uv run` in a worktree needs the sibling ../kicad-to-gcode: a symlink
  .claude/worktrees/kicad-to-gcode stood in while they ran.
- The account's 5-hour limit stopped the first fix stage outright (all
  nine fixers at once, nine minutes in, nothing committed); fixers that
  commit after every fix lose nothing to a cut.
- A reversed restore order (s_min/s_max) passed its own tests and broke
  test_app's lost-setting case: run the whole backend suite, not the
  file next to the change.
- Left open: the mill-3axis profile's X/Y min 0 now warns on every board
  (the bit's middle reaches -0.4 off the drawn edge), a PATCH label still
  loses a group's settings at a re-cut, a surrogate in a model's text
  (not its arguments) still breaks the conversation over the
  OpenAI-compatible provider, a sunk shell gets a false undercut note.

## Cleanup pass (2026-11-10)

Seven read-only reviewers (app.py; the pick and place, camera and auto
modules; the backend core; the toolpath library and carve; the page's
views; the mock; the docs) reported cruft by area, then fixer agents
applied the vetted lists with each group's suite green before its commit
(70 commits after afec19b). Behavior was meant to stay; where it moved:

- Ids: a CAM profile or G-code device id ending in a line break is
  refused (the regex used `.match` with `$`; one `machines.is_id` with
  fullmatch now).
- `_soft_limits` reads `r_max` and `z_max` one at a time: an unreadable
  one zeroes only itself.
- The device refusal for a missing position command now names both
  cameras' routines.
- Writes: every whole-file write goes through `spinny_web/files.py`,
  `config.json` included (it was written in place); `heightmap.json` now
  gets the umask's mode, not mkstemp's 0600.
- Page: Shift+Tab leaves both text editors (Tab still indents); Enter in
  the width row and the device line field presses the button, so a
  locked button ignores it; Save job and Save map toast when the browser
  cannot save; the laser panel's aria-label follows its title.
- Mock, toward the backend: a dispenser's nearest touch goes over the
  point itself; angles convert as `a * (pi / 180)` like `math.radians`;
  `{:g}` texts through formatG; `matches` uses closeTo; `help` lists the
  dispenser line; the device file's TOML error says its line once.

Not done, for a later pass or the user: one UpCamera/TopCamera base; one
TOML profile store and one reader base (machines, cam, openpnp); Backend
split into a device service and a probing service; one run panel for Jobs and Plot;
one camera panel builder and one file-editor panel; the helpers the page
imports from src/mock moved out; patch pre-check order (twin). Bugs seen
and left: GcodeDevice.stop writes the quickstop without `_lock`; the top
camera's camera log overlay draws pcbv's default circle, not the one
searched; views/camlog.ts `removed !== null` is always true; pagehide
stops the camera pick and a page back from the bfcache never lists
cameras again; camjob.read_gcode merges runs whose S or F differ past
`:g`; fine.Design refusals name command line flags on the page; the
endstop bring-up check says to watch `?`, whose status line has no
switch field.

## Bug sweep of 2026-11-10 to 2026-11-20 (2026-11-20)

Eleven reviewers, one area each (the placement run; the G-code link; the
board look and posterior; the app's routes and stores; firmware, toolpath
and carve; the camera tools; the page's PNP side, machine side, camera
views, frame and preview), proved each bug with a test seen failing, fixed
it and committed it on its own in the shared tree, after 1a7bb23 (one in
spinny-firmware). The details sit in each topic's notes under the same
date; `notes/gcode-link.md` is new. What was not obvious:

- The worst were machine-facing: a home of one axis made Z trusted, so
  Home lifted from a Z never homed; a forgotten bottom camera place read
  as measured and a run lowered parts at the file's; a run could start
  between a slot find's moves; a timed-out G-code line's `ok` answered
  the next line; Auto took the last board's place for the new one; a
  stretched board's place missed by 0.4 mm; a gerber took a neighbor
  board's outline and drills; keys in a menu or the to-do drawer jogged,
  a held jog's piece in flight ran after the release, and Stop did not
  end a key-held jog; a Shift drag on a picture with no search box moved
  the head. On the page, a lost WebGL context came back blank, and a
  render test passed for the wrong reason (a count group 0 already met).
- Capture times: told from a reply's arrival, a slow pcbv answer passed a
  moving head's picture as settled (`notes/camera-looks.md`).
- Two tests compared the operator's calibrated LumenPnP file with numbers
  written in them and failed on the user's uncommitted calibration,
  cancelling the other suites in `mise run test`; they read the file's own
  values now. The page's mock moved its board with every reference taken
  through a wrong camera offset, and a test had been loosened to pass on
  the miss that caused.
- Five reviewers running suites at once made a 20 ms timing bound flaky,
  and jog panels other page test files left mounted marked Escape handled
  for a later file's test: both tests check what matters now.
- Choices made without the user, each its own commit: a timed-out G-code
  line drops the link; Z trusted only after a home of X, Y and Z or all;
  a servo's range narrowed under its angle holds it at the new end; a run
  marks the vacuum not known; Count again refused under a run; Auto
  searches once every run; an OpenPnP strip fed to its end is left out;
  any press on the page ends a held jog; Escape over a pop-up still only
  closes it (Q70).
- Left open: the big Stop while a run is being prepared cancels no jog or
  goto in flight; skew_apply writes X and Y as two patches (a failure
  between leaves X applied, and applying again doubles it); whole-file
  writes have no fsync before the rename (this laptop has no battery); a
  flying scan on a spindle machine fails at its first row (`cut ... S0`
  is refused there); a hypothesis the corners ruled out keeps its
  probability in the posterior; DXF layer names compare case-sensitively
  and INSERT arrays have no cap; `controls.ts` gives a G-code machine a
  Center button (an empty `center`) until the settings are read.
