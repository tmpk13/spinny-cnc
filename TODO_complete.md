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
- Config defined controls (2026-10-06): the jog panel and the position
  readout draw a `[controls]` section of the machine file (a board pad on
  the arrow keys, a feed field, Center, and one control per joint with its
  letter, label, steps, button labels, place beside the pad or in a frame,
  feed, goto field, zero button and hint, keys, note) instead of a fixed
  R/A/Z/H layout switched by profile. The backend sends the loaded file's
  controls with the settings, or the defaults for what the settings say
  the machine is; `spinny_laser.controls` holds the defaults and the
  parser, `src/controls.ts` the page's twin, checked against the shipped
  files, which spell the defaults out. The virtual firmware reads past the
  section; the mock's TOML reader learned dotted table names and inline
  tables for the check.

## Driver sockets as a setting (2026-10-07)

- `$sockets` (four digits, rail/table/slide/focus, 1 X 2 Y 3 Z 4 E, each
  once; 1234 as labeled) picks the driver socket of each joint. The board
  steps each joint on its socket's pins and sends each joint's current and
  microsteps to its socket's UART address; settings blob version 6.
- Machine files take `socket = "X"` per axis section; `cartesian-mill` is
  wired as a three axis mill (1423, table driver left alone).
- Loading a machine file names every setting the controller lacks and
  blames old firmware.

## Config tab, settable pins and jog bars (2026-10-08)

- Firmware: `laser_pin`, `probe_pin`, `tool_out`, `tool_pin` and
  `tool_invert` settings (blob version 7); the board claims the laser PWM,
  the probe input and the tool output on the stored pins at boot, the
  laser's PWM slice following its pin; the tool output follows a job, a
  lit beam, a dwell and the spindle, with its polarity in the core; the
  virtual firmware reads the keys too.
- Machine files: `[probe] pin`, `[output] pin`, `[enable]` (fitted, pin,
  invert); a pin named twice refused where the whole file is seen; `place`
  gone from the controls (still taken); the shipped files follow.
- Backend: `GET`, `PUT`, `DELETE /api/machines/{id}` and
  `POST /api/machines/{id}/check` through a machine file store; a file that
  does not read still opens with its problem; the listing names broken
  files by id.
- Page: a Config tab with the machine file panel (pick, new, delete,
  check, save, revert, load to board, save to flash) beside the firmware
  settings panel, moved off the machine's page; a shared TOML editor with
  Solarized syntax coloring and a live syntax check, used by the CAM page
  too; the jog panel as one bar per axis with step choices and a typed
  step, the cancel button in the panel's head; the mock reads the shipped
  machine files with the backend's checks and takes edits.

## Controls follow the machine file (2026-10-11)

- The jog panel and readout drew the defaults whenever the live settings
  were no file's (a setting changed by hand, firmware older than the
  file's newest keys), so a change to a machine file's `[controls]` did
  not show. The controls now come from the file the settings are, else
  the file last loaded from this host when it describes this kind of
  machine, else the one file for the kind, else the defaults;
  `GET /api/settings` says which in `controls_from`, the Config tab says
  whose controls the jog panel draws, and its Reload reads the settings
  again so a file edited by hand shows.
- The page's copy of the default controls is checked against a fixture
  the backend prints (`mise run controls-fixture`), not against the
  shipped machine files, which may now differ from the defaults: the mill
  file leaves the rail's bar out.
- `mise run uf2` builds the board firmware as a uf2 and `scp-uf2` copies
  it to a host given after `--`.

## Fourth full review (2026-10-11)

- Firmware: `$defaults` keeps the socket map, the pins and the tool
  output's polarity along with the other wiring settings, so it no longer
  drives an active-low tool output or remaps the motors; the brake of a
  hold runs dark by its own duty, so a resume before the ramp has run
  cannot relight it; a dwell with power kept for a latched hold is not lit
  before the hold darkens it; the tool output does not stay active through
  a held dwell; an axis a line leaves out stays on its step far from zero;
  `abort` judges the interrupt quiet before it reads the position; dead
  planner fields and an unused disconnect parameter are gone; the longest
  block test checks the minor axis too; a probe on the laser's pin reads
  the Z-STOP header instead.
- Virtual firmware and simulator: the burnt length counts the last
  stretch of a burn; the real-time tick schedule is phase locked like the
  board's; the stderr report prints the beam, not the pin; a stored blob
  winning over `--machine` is said; `--at` with a bad value is refused;
  an unread length and a misdescribed Drop are gone.
- Backend: a setting already in force to the firmware's three decimals is
  not sent again on every load.
- Docs: `$defaults`, the realtime bytes inside UTF-8, `tool_out` applying
  at once on a board that claimed its pin, the uncut stretch a hold leaves.
- Page: the joint goto row is labeled Joint again; the settings hint says
  which settings need a restart.
- American spelling throughout.


## Resume, stall detection, probing around the cuts (2026-10-13)

- Port select: the controller (it announces itself as `spinny laser
  controller`) is listed and picked first, by its stable by-id name; the
  list is polled every 10 s while disconnected; a toggle hides the
  built-in system ports.
- Delete all jobs, with a confirmation; Save job downloads the selected
  job's JSON.
- The Config editor keeps its caret and scroll across a tab switch, and
  its colored layer stays in step with the textarea.
- Probing around the job's cuts with a margin instead of the whole grid
  (`Grid.mask`); the preview and the map table show the points left out.
- The settings' Apply / Save to flash / Reload row stays in view while the
  table scrolls.
- Invert instructions: how each `invert` is checked by what the machine
  does (directions, probe readout, output, enable) in MACHINES.md and
  OPERATING.md, and a hint beside the probe settings.
- Probing stopped goes on with *Continue*, probing only what the map lacks.
- Dedicated Pi software: `mise run deploy-pi` installs the backend and the
  page as a service that keeps its own link to the controller
  (`spinny-web --connect auto`), so the Pi runs the whole thing.
- V bits in CAM profiles (`angle`, `tip`): the cut width follows the depth.
- Probing time estimate before and during probing (`/api/heightmap/estimate`,
  `remaining` in the progress).
- Page speed on complex boards: the preview caches its still layers, draws
  only when something moved, and not at all while its page is hidden.
- A Heights toggle in the preview.
- A single probe point: *Probe here* ties the map to the frame in use, or
  sets H 0 at the surface.
- The touch-off / focus offset field keeps what is typed until Set.
- Resume a job from the count of lines done (`/api/jobs/{id}/resume`), with
  a plan preview and a rewind to the path's start.
- Logging to `var/spinny.log` with a Log button in the console; a machine
  that stops answering is given up after 3 s and the run fails with the
  reason instead of waiting for ever.
- Spindle speed control can be turned off (`speed_control` host setting).
- The current position can be declared with typed values (*Here is* in the
  Jog panel, *Last known* from the record).
- The run's state is saved to `var/resume.json` as it goes, to resume from.
- *Probe nearest: tie map* in the Height map panel: the backend picks the
  probed point nearest the tip that the job's cuts keep 1 mm (plus half
  the spot) clear of, shows the point and distance for a yes, then goes
  there, probes and ties the map (`POST /api/heightmap/touch` with
  `at: nearest`, planned by `/touch/plan`).
- Tying the map no longer accumulates: the map keeps the gap over the
  contact (`focus_gap`), and a tie sets the offset to the gap plus the
  shift it measures, so tying again in the same frame changes nothing.
- A spindle's run or resume without the height map is refused when a
  probe in this frame found the copper more than 1 mm from H 0.
- Optional endstops and one or two directional homing per axis
  (2026-10-13): `<axis>_stop` says which ends have a switch, with
  `<axis>_stop_pin`, `stop_invert` and `limits` masks, `<axis>_home_pull`,
  `<axis>_home_pos` and `<axis>_home_travel`; `home [R-|+] [A] [H] [Z]`
  seeks, backs off, locates slowly and declares the switch's position,
  the status line's `D` field names what is homed, and a switch in
  `limits` halts a move that closes it (`ALARM:4`). Machine files take
  `endstop`, `endstop_pin`, `endstop_invert`, `endstop_halt`, `home_pull`,
  `home_pos`, `home_travel` per axis; the page has *Home* and a *Homed*
  readout, `POST /api/home`; the virtual firmware takes `--stop`.
- Crash diagnostics (2026-10-13): the board keeps a record in RAM across
  resets (main loop phase, uptime, lines, longest pass and gap; a panic's
  location and message or a hard fault's pc and lr), reads the reset
  registers and prints `[MSG:boot <reason>]` after its banner; a panic or
  hard fault writes the record and resets at once instead of spinning
  until the watchdog; `diag` prints the boot reason and this life's
  counters (USB state changes, DTR/RTS, bytes each way, the writer's wait
  for the host, dropped output, motor power losses). The backend logs
  the machine's own messages and asks `diag` at every connect, writes
  every line over the link to `var/wire.log` with the time, logs what
  it last sent and heard when a link closes, and takes `--log-level`;
  `GET /api/log?file=wire` and a *Wire* button in the console read it;
  the relay's socat prints its notices; `mise run usb-log`, `pi-logs`
  and `symbolize`. The watchdog question is answered: 1.5 s, fed once a
  main loop pass, and it is what brings a hung board back.
- deploy-pi as a bridge (2026-10-14): `spinny-bridge` serves the
  controller's port on the Pi's loopback, installed by default by
  `deploy-pi` (`--web` for the backend and page); `relay-pi` forwards it.
- The socat relay that had to be restarted (2026-10-14): a board that
  stopped taking bytes left socat's child blocked in a write and the next
  client unserved, which the bridge handles by giving the device up after
  3 s with the client told why; the link names that notice in the failed
  connect.
- No banner on a reconnect (2026-10-14): the firmware prints its banner
  and boot line when a program opens the port (DTR rising) and treats the
  port closing as a disconnect, as the virtual firmware already did per
  client.
- Assume the position from before the power-off (2026-10-14): the backend
  keeps the machine's last reported joints in `var/position.json` (once a
  second while they change, and at the link's close), run or no run, and
  *Last known* in the Jog panel fills them in for *Set position*.
- Dispensing, pad probing, the camera and alignment (2026-10-19): the
  firmware's `dispenser` setting makes the table's joint a paste
  dispenser's plunger in mm on a cartesian machine (`A` on go and cut, the
  output dark); the machine files take `tool = "dispenser"`, a
  `[dispenser]` section, the dispensing host values and a `[camera]`
  table, with `cartesian-dispenser` shipped; a board imports with mode
  `dispense` as dots on its pads and every board job carries its pads,
  holes and the design's map into the job frame; the height map can be a
  pad map probed at a job's pads; the camera is read through pcb-vision's
  new `pcbv serve`, with a routine that cuts a mark and measures the
  camera's offset, roll and scale from it; marks from the tool or the
  camera fit a turn and a shift that is applied to the job.
