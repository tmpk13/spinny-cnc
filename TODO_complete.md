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
