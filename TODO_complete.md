# Completed

- Polar kinematics: board point to radius and unwrapped angle, chord
  tolerance subdivision, axis crossings as dark turns.
- Emitter in the Cartesian tool's dialect with per-segment feed words, `G93`
  by default and `G94` scaled as an option; axis limit accounting in the
  estimate, rotary-bound and near-axis reporting.
- `spinny-iso`: KiCad board or gerber to polar isolation gcode, reusing the
  sibling tool's geometry engine; center and keep anchors, offset, fit radius,
  outline and drill mark groups.
- `spinny-polar`: rewrite an existing absolute X/Y laser job for the table.
- Markdown map with a mermaid timeline, SVG preview drawn around the axis,
  `.sim.json` sidecar for the simulator.
- `spinny-sim`: macroquad playback with orbit camera, rotating board, rail and
  head, beam and burn trail colored by effective power, ghost toolpath, HUD,
  scrubbing, screenshot mode.
- Tests: kinematics, emitter, replay of the emitted gcode back onto the board
  geometry, both commands end to end, simulator parser and timing.
- grblHAL polar kinematics as the default target (2026-09-19): board X/Y
  in G94, pre-split to tolerance, axis exit through a rounded two-quanta hop
  with re-subdivision; the joint emitter kept behind `--controller joint`;
  simulator and test replay model the controller's 0.5 mm pieces, feed
  floor and unsplit rapids.
- `spinny-jog`: setup rapids from the DRO position, radial moves and table
  turns split into quarter-turn steps, with what each motor does.
- Web backend (2026-09-20): `web/backend` uv project with the serial link
  (credits, realtime bytes, status poll), the joint-space streamer, SVG,
  gcode, gerber, KiCad and JSON job importers, the job runner and the
  FastAPI routes plus WebSocket fan-out of `docs/WEB_API.md`; host tests
  on a byte-at-a-time fake port, e2e test gated on `SPINNY_VIRTUAL`.
- Own firmware for the machine (2026-09-20): `firmware/core`, a portable
  control core with the line protocol, settings in a CRC blob, a lookahead
  planner over joint moves and a two-half stepper whose interrupt ties the
  laser duty to the speed reached; `firmware/rp2040`, the SKR Pico port on
  embassy (USB CDC with realtime bytes and credits, TIMER alarm 1 step
  interrupt, laser PWM, TMC2209 UART, settings sector, watchdog);
  `firmware/virtual`, the same core on TCP with a virtual clock and a beam
  trace, which the web tests run against.
- Web interface (2026-09-20): `web/backend` owns the serial link and turns
  gerber, KiCad, SVG, gcode and JSON into joint moves; `web/frontend` is
  the page, with board and independent axis jogging, a laser test, jobs
  with a live preview, a console and the settings table.
- Firmware safety review (2026-09-20): every path that can leave the beam
  lit or lose the position walked and tested. Fixed a hold that let the
  queued segments and the whole deceleration ramp keep burning, a `dwell`
  that fired during a hold and left the stepper wedged, a `$load` that
  applied a changed laser or enable polarity a loop pass late, and moves
  long enough to wrap the step interrupt's Bresenham counters; the laser
  port is now driven from the stored polarity before the board's other
  tasks start.
- `spinny-center` (2026-09-21): a burn that separates the radius zero
  error from the rail's miss distance, four radial lines bounding a square
  of twice the latter around a ring centered on the axis.
- Cross slide in the web interface (2026-09-21): `Z` parsed from the status
  line (zero on a firmware without the field), `jog`/`jogto Z` lines that
  never carry `R` or `A`, `dz`/`z` on the jog, goto and position routes, and
  a setup control in the jog panel with its own small steps, a zeroing
  confirm and the position in the readout. The firmware side lands
  separately.
- Cross slide in the firmware (2026-09-21): `z_*`, `jog_z` and `tmc_z_*`
  settings with a blob version bump, `Z` on `jog`/`jogto`/`set` and refused
  beside `R` or `A`, a `slide` module with its own polled trapezoid, `Jog`
  state and `|Z:` in the status, the SKR Pico Z socket wired up and its
  driver in the `$tmc` report, and a counting port in the simulator.
- Far side cuts (2026-09-22): `go` and `cut` take a negative radius, as
  jogs already did; `r_max` alone bounds the head. Past the axis is the
  same board point half a turn on with the head's offset reversed, which
  is what a calibration burn compares.
- Joint-space job groups (2026-09-22): a group may carry `joints`,
  streamed as they are with whole turns added toward the machine's angle,
  priced, drawn from a sampled path, and refused an offset; the runner
  accepts a job made only of them. The drain asks for a fresh status
  instead of trusting the polled one, which could predate the run.
- `spinny-center --fine` (2026-09-22): the amplifying pattern, written as
  a web job: a rail line through the axis crossing two arms burnt from
  either side at three degrees, whose crossings move apart by 76 times the
  cross slide error, and two spirals burnt from either side whose crossing
  moves 38 times the radius zero error along a second rail line; the arms
  subdivided to a tolerance scaled by the angle; `--show-error` draws the
  coupon a machine that is out would burn and prints what it reads.
- Firmware and host review (2026-09-22): every module read against its
  contracts, with a multi-agent pass over the core and the port. Fixed on
  the host a reset that could let one more line into the emptied machine
  and a console reset that restarted a held run, the `version` answer read
  as a firmware restart, a board jog from a head parked past the axis, JSON
  jobs with a zero speed, and the estimate ignoring the step ceiling. Fixed
  in the firmware the inverted driver configuration retry and its queue
  that dropped the newest snapshot, the USB disconnect path that could
  never run, a cross slide move under a constant beam, a jog taken during
  a cancel brake, the tick floor ignoring the step pulse width, the laser
  resting level driven only at the first poll, a position past the 32-bit
  step range, a reset standing in for `unlock`, a feed with no speed, and
  the status line's constant credit count and ahead-of-time rate and duty.
  Every suite passes, the end-to-end tests included.
- Host-side review (2026-09-22, second half): the link no longer holds a
  lock across the credit wait, consumes a reset's banner before a
  `version` answer, survives a raising callback, refuses realtime bytes
  in a line and caps a partial one; the runner's own status requests are
  polls; the jog bookkeeping follows the firmware's planned end; patches,
  settings writes and uploads fail whole; NaN and infinity are refused
  everywhere; a first vertex within a quantum of the axis leaves it with
  a turn; SVG close-then-line and gcode file order are kept; the page
  drops a run the backend no longer has, stops toasting on load, keeps
  the feed authoritative and opens the beam confirm on Cancel; the
  documented `?api=` mode has a `--cors-origin` flag; the virtual firmware
  drops a dead client's queue, keeps its trace aligned and reports the
  beam rather than the pin.
- Host-side review (2026-09-23, third pass): the firmware reports `Hold`
  only once its brake has finished, so the runner's reset lands on a
  still machine; the runner keeps run identity, refuses a start while the
  old thread halts, treats the plan window as active, re-checks the
  start, never unlocks, retries an overtaken hold, and ends a drain that
  outlasts its hour as an error; the app bounds the tolerance and writes
  the config without NaN, checks serial urls, refuses board moves past
  `r_max` whole and moves while a run is active, applies settings all or
  nothing with a restore, routes a typed `!`/`~` through the run, serves
  moves one at a time, bounds `passes` and uploads, fills a blank goto
  axis from the planned end, and refuses cross-origin posts and
  websockets (`--allowed-host` for the Host header); the page keeps the
  selection on a refused delete, asks before deleting, updates the groups
  table in place, shows the run's reason, checks the tolerance and the
  beam duration as sent, and gives signed fields a keyboard with a minus.
- Doubles, docs and CLI (2026-09-23): the mock mirrors the firmware and
  the backend in fifteen places (far side, hold, slide, disconnect, axis
  turn, minimum radius, joint groups, gcode and SVG reading, bounds,
  defaults, modal words, patches) and prints the firmware's texts; the
  protocol and web API docs gained the reset transcript, the state table,
  the setting bounds, `$tmc`, non-ASCII and empty lines, error bodies,
  patch fields and nulls; speeds and feeds under the firmware's floor are
  refused on the host; the command line emitter no longer turns a
  repeated point into a hop to the axis, cuts crossings at the axis the
  way the backend does, keeps an `F` given on the spindle line, prices the
  table at the simulator's rate by default, keeps the angle on a grblHAL
  return home, and `--fine` refuses the coarse pattern's flags.
- Safety and concurrency pass (2026-09-23): the firmware takes motion lines
  during a hold of a run and latches a hold asked for on an idle machine
  onto the line that is waiting; the runner sends nothing while held,
  renumbers the table angle within a turn before a job, and reports a
  reset no banner answered; the link matches each status request to its
  own report; the axis snap is the chord tolerance on the host and in the
  emitter; the page's laser-off during a run is the run's hold and `mode`
  is refused; the laser pin is claimed at its off level after the stored
  polarity is read.
- Centering test in the web page (2026-09-23): `POST /api/center` builds the
  `spinny-center` pattern, coarse or fine with its options, as a stored job
  with its summary and reading notes; the Jobs panel has the form, and the
  mock builds the coarse one.
- Per-layer minimum power (2026-09-23): `cut` takes a non-modal `M` word,
  the floor a `dyn` cut's speed-scaled power does not drop below (capped
  at `S`, still under `s_min`'s cutoff); groups carry `min_power` through
  the store, patch, emitter and mock, and the groups table has a Min S
  column whose number fields shrink with a narrow panel.
- Copper clearing in the web page (2026-09-23): a board upload takes
  `clear` (`radial`, `rings` or `lines`) and adds a `copper clearing` group
  that burns everything the isolation leaves inside the board outline, or
  the X/Y box the isolation spans without one, with beam centers kept
  outside the outermost loop and a pass along the inside of the edge; the
  Jobs panel has a Clear copper choice, and the mock checks the value.
- Per-layer pass count (2026-09-23): groups carry `passes` (1 to 100)
  through the store, patch, streamer, stats and mock; each pass streams
  the whole group again from where the last one stopped, and the groups
  table has a Passes column.
- Probing and height map (2026-09-23): an optional focus axis `H` on the
  E socket as a third joint, a touch probe on Z-STOP GP25 (`probe H [F]`,
  `[PRB:h:1]`, `Alarm:2` on a miss), a simulated board in the virtual
  firmware, a prober and height map in the backend, runs compensated by
  the focus axis or by power, and a Height map panel with focus jogs, the
  probe grid on the preview and a compensation choice on Run.
- Adjustable probe brake queue (2026-09-23): `$probe_ms` (0 to 160 ms,
  default 20) sets how long a probe goes on past the contact before it
  brakes; 0 stops the focus axis dead at the contact when the probe is
  within `h_jerk`. Also a field under Probe in the Height map panel.
- Cartesian mode (2026-09-24): `$cartesian=1` makes the cross slide the
  fourth joint, stepped by the interrupt with the others, so the rail is X
  and the slide Y; `go`/`cut` refuse `A` so the table holds, switching
  hands the slide's position over, `$z_jerk` and a `$z_max` soft limit
  come with it, and the settings blob (version 5) still reads version 4.
  The backend streams straight `R Z` lines in the table's frame, jogs,
  probes and checks reach in it, and the page shows the slide as Y.
- Spindle mode (2026-09-24): `$spindle=1` puts a spindle on the laser
  output (`spindle S` / `spindle off`, turning through moves and holds,
  stopped by a reset or an alarm) with the focus axis as its depth axis.
  A job is milled: lift, spin-up, then per path a plunge, cuts at depth
  and a rise, each pass a step deeper; groups carry depth and plunge,
  the host keeps clearance and spin-up, and the height map is the
  autoleveling with a touch-off. The page has spindle controls and
  milling columns.
- Third full review (2026-09-26): about 95 verified faults fixed across the
  firmware (hold latch loop order, probe brake and cancel, short-block
  crawl, spindle refusals, `$defaults` polarity), the board port (motor
  power loss, `$tmc`), the virtual firmware, the backend (status counting,
  run start cancellation, probe timeout, height map frame, console guards),
  the page and mock, and the command line tools.
- Faster radial clearing (2026-09-28): spokes spaced by how far the area
  reaches in each direction, and cut in whichever order travels least in
  the machine's own time (rail rate over table rate from its settings).
  The 28.5 mm test board: 62.7 to 48.4 min, against 154.5 for lines.
- Deposit mode for board imports (2026-09-30), for laser deposition, where
  the beam lays copper down: only the copper is burnt. An edge loop half a
  spot inside every outline, then a fill (contour loops in to the middle,
  or the radial, rings or lines clearing fills clipped to the copper),
  with the corners and middles the loops miss found and burnt; traces
  narrower than the spot run along their gerber centerline. The outline
  group comes in off. Page: Board isolate/deposit and Fill copper.
- Repository reorganized (2026-10-03): one uv workspace at the root for
  the toolpath library (`toolpath/`, moved out of the root) and the web
  backend, one environment and lock file; runtime files (jobs, config,
  height map, tool output) under an ignored `var/`, with `spinny-web
  --data`; the in-page mock in `web/frontend/src/mock/`; pixi removed;
  the README cut to a map and a quick start with the calibration,
  operating, gcode toolchain and architecture material in `docs/`; mise
  tasks per suite.
- Machine configuration files (2026-10-03): a TOML file per machine in
  `machines/` (axes with scales, rates, limits and direction; polar or
  cartesian; laser or spindle; probe, output, drivers; the host's own
  values), mapped onto all 46 firmware settings. Listed, matched against
  the live settings and loaded whole by the backend (`/api/machines`),
  picked and loaded from the page's Settings panel, read by the virtual
  firmware (`--machine`) and by the gcode tools (`--machine`); an end to
  end test checks the Rust and Python readings agree on every shipped
  file. Four files ship: polar laser, polar laser with focus axis,
  cartesian laser, cartesian mill.
- 3D preview (2026-10-03): the page's preview is a 3D view on the plain
  canvas, projected by `camera.ts`: rings and the rail at the head's
  height, soft limits, copper, outline, the job, the probe grid with its
  heights raised and stretched to be seen, the head over its board point
  with the beam and a trail. Drag orbits or, with the rotation locked,
  pans (the lock is kept between visits); shift or right drag pans, the
  wheel zooms about the cursor, Reset view and a double click return to
  the overview.
