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
