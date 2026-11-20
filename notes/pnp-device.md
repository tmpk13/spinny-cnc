# The G-code machine, the LumenPnP, the OpenPnP import (2026-11-11)

## A G-code machine is a machine file (2026-11-11, later the same day)

Asked: "the PNP being a separate gcode machine is bad. It needs to be a
config that allows it to be used like the other machines." The device
(its own profile store in pnp/, its own port, connect, jog, console on
the PNP tab, a second link beside this machine's) is gone; a G-code
machine is a machine file with `controller = "gcode"`.

- One connection at a time: a G-code machine is connected from the top
  bar in this project's board's place, the way swapping machine files
  swaps machines. Asked on the phone which; no answer in an hour, so this
  was my reading. Two at once is two spinny-web with their own --data.
- The file keeps the profile's tables as they were ([port] gained
  `match`, [gcode] `motors_on`/`motors_off`); only the profile's
  [camera] became [up_camera], because a machine file's [camera] is the
  head camera's (pcbv device, offset) and the up camera's place is not
  that. spinny_laser.machines reads name, controller, controls and keeps
  the G-code tables raw; the backend's openpnp.machine_of reads them, and
  MachineStore.parse runs both so a save checks the file whole. The
  firmware sections are refused in a G-code file, the G-code tables in a
  spinny one (with the hint to add the controller line); the Rust twin
  refuses a G-code file outright.
- Joints: r = X, z = Y, h = Z, a = the rotation axis as the controller
  counts it (not turned for rotation_cw: the readout shows what M114
  says). That is the cartesian machine's mapping, so the jog panel,
  readout, goto rows, camera drag (a joint jog dr/dz) and controls fixture
  serve both without a second model. The nozzle's defaults have no Center
  and no zero on Z or A.
- Which port is which machine: the file's url, or a `match` word in the
  port's USB names; ports() marks each port with the file that claims it
  and lists a file whose url is not a listed port (a socket) as an entry
  of kind "machine". The page passes `machine` on connect from the port
  entry; a typed url no file claims connects as this project's firmware.
  No M115 sniffing: opening and closing a spinny board's port to ask
  would reset it (DTR drop resets it).
- Moves: a jog reads M114 first (Marlin's planned position) and sends one
  absolute move, answered once queued, so held keys chain (the old device
  jog did the same). A goto sends only the axes named, rises to safe_z
  only when X or Y changes, puts Z last and skips a Z already reached,
  then M400 and M114. That answers TODO items from testing (Z going down
  then up on a goto with X unchanged, the nozzle going down before
  arriving over the camera, not rising before leaving it).
- Status: M114 at the connect, before each jog, after each goto, and once
  a second from a poll thread that only takes the line lock when it is
  free and no run is under way (`gcode_poll_seconds`; tests set 0 so line
  sequences stay exact). Console events carry G-code lines, the poll's
  marked poll. State is Idle, Jog during a goto, Home, Run during a
  placing run or a camera routine; age is 0.
- What needs this firmware (laser, spindle, runs, probing, settings,
  unlock, the head camera's routines) goes through require_link, which
  says "<name> is a G-code machine: this is for a machine on this
  project's firmware". Hold/resume are refused; reset/cancel send the
  file's stop and stop a run or routine.
- What the PNP tab keeps is per machine id under config `placing`
  (references, angle, taken, boards, the up camera's place, the top
  camera's settings); the tab places with the connected G-code machine,
  else the last connected (`placing_machine`), else the only G-code file.
  Old `pnp_device` config moves there at load; old pnp/*.toml in an
  installed home are written into machines/ at start (move_device_profiles).
- API: /api/pnp/device/* became /api/pnp/* (run stop /api/pnp/run/stop;
  nozzle and goto merged with the up camera's, dispatched by machine kind),
  the profile routes are the machine routes plus PATCH, the event is
  `placing`. The page lost the device panel, its jog and the profile
  editor; the Head panel keeps lights, vacuum, park, swap, over camera and
  the tunables (PATCH on the machine file); the OpenPnP import is its own
  panel on the Config page and writes a machine file.

## The LumenPnP profile

- `machines/opulo-lumen-rev5.toml` comes from Opulo's stock OpenPnP
  machine.xml (github.com/opulo-inc/lumenpnp, openpnp/machine.xml at
  64cf68d, fetched 2026-11-11), not from memory. The page's importer
  reads that file back into the same values, which checks both.
- OpenPnP keeps places as the tool's point: the head (controller X/Y) is
  where the top camera looks (its head offset 0), N1 sits at -23.544,
  -65.188 from it. A profile keeps controller places with the nozzle over
  the point, so every OpenPnP place loses the nozzle's head offset:
  controller = point - offset. Checked on the manual tip change places:
  N1's (31.456, 86.812) and N2's (78.922, 87.607) both come to (55, 152).
- Z is a seesaw: N2's Z is a ReferenceMappedAxis, 63 - Z. Both nozzles are
  up only at 31.5 (OpenPnP's safe zone 26.5 to 36.5, home 31.5): a Z above
  it lowers N2. So DeviceMover.lift goes to safe_z from either side now
  (it was rise-only, which on a seesaw would have left N2 down). On a
  plain machine coming down to safe_z is safe by its definition.
- VAC1 is two lines each way: `M106 P1 S180` (its valve on fan 1, held at
  180) and `M106` (its pump on fan 0); off `M107 P1`, `M107`. Hence
  `pick`/`place` as lists. The sensor is an XGZP6857D behind an I2C mux at
  112 (address 109): three lines, the reading in M261's `data:` (the
  pressure's top byte, lower with more vacuum: held 220-241, empty
  248-255 for the N045 tip). Opulo's OpenPnP does not check those levels
  by default (method None), so the profile ships the read without ranges
  and `part_on` became optional: a sensor read by hand only.
- The connect lines set both sensors converting (M260 sequences); the
  ring light is `M150 P255 R255 U255 B255` / `M150 P0`, shared by both
  cameras. The bottom camera's location Z (4.0) is where N1's tip is sharp.
- place_z is a safe 20 until measured (the tip changer and discard sit at
  Z 5.5, the bed around there): a part dropped from height is the worst.
- Photon feeders run through feederbus.py, a generic bus whose framing
  (send line, reply pattern, header byte order, CRC-8 poly 7), addresses
  and command/answer codes all come from the profile's `[bus]`; the
  LumenPnP profile spells out Photon's values (from OpenPnP's
  PhotonFeeder source): GetFeederId 1, Initialize 2 (12-byte uuid; wrong
  id answers 1), MoveFeedForward 4 (tenths of mm; ok carries the expected
  ms), MoveFeedStatus 6 (busy 4, could not reach 2), GetFeederAddress
  0xC0 to broadcast 255, answered from the feeder's own address;
  uninitialized is 3, and a feeder that says so is initialized again.
  The feed wait is bounded at 3x the expected ms (2 s floor) so a stuck
  status poll cannot hang a run. Untested on a LumenPnP: written against
  the fake in tests/device_fakes.py, which follows the same source.
- Slot places live in `[[slot]]` (address -> at, rotation) since the
  address a feeder sits at changes when it is moved; a bus feeder's
  `slot` is optional, and the run (and a connected plan) finds it by id.
  A plan without the device skips such a feeder's parts rather than guess.
- The USB name: STM32duino's product string is `<board> CDC in FS Mode`;
  the port's by-id name carries MARLIN_OPULO_LUMEN_REV5. `gcodePort`
  (src/ports.ts) knows it by words and by 0483:5740, and the top bar no
  longer offers such a port for this machine.

## Moves by hand

- A jog reads M114 first: Marlin reports the planned position (where the
  queued moves end), so jogs pressed quickly add up right. A rotation jog
  needs the axis in M114's answer (the LumenPnP's has A and B).

## The OpenPnP import

- In the page, not the backend: the mock would have needed a twin of the
  same reader, and the backend still checks the profile on save.
  happy-dom's DOMParser refuses OpenPnP's machine.xml (PARSERERROR), so
  src/openpnp.ts has a small XML reader of its own.
- Trays walk Y first when X has the most (OpenPnP's major axis rule);
  strips put the part `tapeWidth/2 - 0.5` beside the hole line and 2 mm
  past the first hole, turned with the tape (EIA-481 adds 90 degrees);
  an imported strip starts at OpenPnP's next part (its feed-count).
- A Photon feeder has no place in machine.xml: its slot address is not
  saved (PhotonFeeder.slotAddress has no @Attribute); OpenPnP asks the bus
  for it by the feeder's hardware id (GetFeederAddress) and adds the
  feeder's `offset` to that slot's place from the machine property
  PhotonFeeder.FeederSlots. Its `location` element is all zeros: the
  first import kept that, and a run would have taken N1 down to Z 0. The
  import now writes Photon feeders as bus feeders (`bus_id` from
  `hardware-id`, `offset`, `advance` from `part-pitch`) with the slots
  from FeederSlots less N1's head offset; one without a 24-hex id, and
  any other feeder at 0, 0, 0, is left out with a warning.
- A feeder's parts by part id do not match our words (R0603-10k against
  "10k R_0603_..."), so a feeder may name `refs`; a job's placements give
  them.

## The page

- The run's steps follow the newest line only while scrolled to the
  bottom; an old console set scrollTop on every state event, so it
  snapped down while being read.
- A setup step's panel pulses until a press inside it (the flash was gone
  before the eye found it).

## The virtual LumenPnP (2026-11-12)

- pcbv's HTTP camera decodes only JPEG (camera/src/http.rs wants
  `Content-Type: image/jpeg`, decode via zune-jpeg); a picture file or a
  directory is loaded once at open (live.rs spawn_replay), so a file that
  changes is never re-read. The virtual cameras therefore write JPEG
  themselves: virtual_camera.jpeg, baseline grayscale, quantized by 1,
  flat Huffman tables (DC sizes 4 bits, AC symbols 8 bits). Flat 8x8
  blocks are a lone DC term; only edge blocks go through the DCT, so a
  640x480 picture takes 30-50 ms in pure Python. Checked: Pillow reads it
  (max error 1 on noise), pcbv finds spots to 0.01 px.
- pcbv's luma-local detector loses a big blob's interior: a 1.6 x 0.8 mm
  part at 12 um a pixel (133 x 67 px) came back with area 6040 instead of
  8900 and major 174 px. At 20 um a pixel (80 x 40 px) area and axes are
  right, so the virtual bottom camera is 20 um a pixel. A real camera
  with big parts in the picture may meet the same; the new pcbv's `rect`
  is unaffected (smallest rectangle around the pixels).
- Stale frames: routines asked for a spot right after the wait command
  answered, and a snapshot camera asked 10 times a second often gave a
  frame from before the move ended (Measure offset failed). The tools
  worktree fixed it in VisionClient.spot (poll pose age_ms); that commit
  was left out for the camera worktree's settle wait in camera.py
  (228cd79), which covers every routine look.
- The test FakeMarlin is now spinny_web.virtual_pnp.VirtualMarlin; it runs
  its commands on a worker thread (so M400 can wait while M410 is acted on
  as it arrives, Marlin's emergency parser). Kept for the tests: BAD
  lines, M105 `readings`, `silent`, `hold`, `report_angle`, G28 answering
  busy then ok without moving unless `home` is given.
- Choices the user may correct: G28 homes to X0 Y0 at the safe Z (Opulo's
  real home place unknown here); parts lie everywhere on the bed (picked
  wherever the tip comes down to safe_z - 15 = Z 16.5 or lower with
  suction), all 1.6 x 0.8 mm along X; sensor readings 254 air, 251 open,
  231 held (inside Opulo's commented ranges, now set in virtual-pnp.toml);
  ports 2327 (G-code), 2328/2329 (cameras); the cameras are not on the
  backend's detected list unless SPINNY_CAMERA_PORTS names 2328 and 2329.

## OpenPnP parts and packages (2026-11-14)

- Checked against OpenPnP's Part.java, Package.java, Footprint.java and
  Configuration.java (develop branch): the serializer uses HyphenStyle
  (`height-units`, `package-id`); both files are inline lists
  (`<openpnp-parts><part .../>`, `<openpnp-packages><package><footprint
  units body-width body-height>`); body-width runs along X, body-height
  along Y.
- A feeder's `place_z` is the job's board top plus the part height, as
  OpenPnP places at board Z plus part height; without a job only `size`
  and a comment are written.
- machines/virtual-pnp.toml names its cameras (ports 2328 and 2329,
  640x480), so OPERATING.md no longer asks for them to be typed in.

## Heights, the homing fiducial, feeder picks (2026-11-14)

Built by an agent (todo-pnp), cherry-picked; the default changed after.

- `[motion] seesaw` says what Z is: true, a seesaw (moves across come to
  safe_z from either side, `seesaw_jog` stops a Z jog at safe_z and goes
  no higher from there, saying why at most every 5 s since a held jog
  sends a piece every 0.1 s); false, a plain Z (`openpnp.needs_lift` rises
  only from below: a nozzle above safe_z stays up); left out, as before
  (from either side, jogs not stopped). The agent made "left out" plain;
  it was turned back (8143332) because a seesaw nobody marked would cross
  with its other nozzle hanging down. The shipped LumenPnP and virtual
  files say true; the OpenPnP import writes it when another nozzle's Z is
  a ReferenceMappedAxis of the chosen nozzle's Z. Nozzle to Part and Camera to Part read M114
  first and uses goto_lines; the run's own pick and place lines are
  unchanged. Cause found on the virtual LumenPnP: "N1 up" past 31.5
  lowered N2, and every later move across brought Z back down to 31.5.
- Virtual LumenPnP: picks work once a feeder holds the parts (offset, Home
  by fiducial, centering, runout, Find fiducials to under 1 um and a run
  were checked); the homing fiducial was drawn too faint (230 on a 205
  bed) for pcbv, now a bright dot on a dark 5 mm square (`HOME_PATCH`).
  Its board search still finds nothing: the virtual board draws only its
  outline and fiducials.
- Feeders panel picks: `pickAfter`; Shift counts from the anchor,
  Ctrl/Cmd toggles, a plain press on the only pick lets it go;
  `/api/pnp/bus/scan` takes `{"feeders": [...]}` and answers `missing`.

## The Machine view and the board area (2026-11-14, Q39)

Built by an agent in a worktree (cv-view). Asked: by default the full
bed, a machine file entry for where boards are placed, and a machine view
panel with a picture or model of the machine on which the area is chosen.

- Keys: `[top_camera] board_area` (x0 y0 x1 y1 in bed's frame, the places
  the top camera's picture center goes over; x0 < x1, y0 < y1, inside bed
  when bed is given, checked against bed's own min and max since bed's
  order is not checked) and `board_area_only` (false: near it, a search
  with nothing known looks there first, then the rest of the bed; true:
  boards only within it, a search never looks outside). A dangling
  `board_area_only` with no area is allowed and means nothing, so taking
  the area out by hand never makes a file unreadable. The search's use of
  them is boardlook/top_search's, not this branch's.
- `[motion] travel` is new too: the head's reach as places of the nozzle
  (the LumenPnP's Marlin soft limits 0..433 by 0..487). The lead's brief
  said "the travel from the machine file's limits", but a G-code file had
  none; nothing moves by it, only the view draws it. Without it the view
  boxes the places the file names (bed, area, park, bottom camera, homing
  fiducial, discard, slots, feeders), drawn dashed.
- The view's frame is the file's: the head's X and Y with the nozzle over
  a point, +Y up. bed and board_area are in it already (the top camera's
  center = head + offset), as are the look's estimate and the mosaic's
  tile centers, so nothing is converted; the head is drawn at the nozzle
  and the top camera's center and view at head + offset.
- The panel is an SVG with `vector-effect: non-scaling-stroke`, rebuilt
  per placing event (a few dozen nodes); the picture and model `<image>`
  nodes persist so their href is set only when it changes. Pointer to
  machine assumes `preserveAspectRatio="xMidYMid meet"` (clientToMachine).
- A drag or the fields make a pending box (setPending "machine-view", so
  leaving asks); Save writes. The area is cut to the bed before it is
  pending, so a save never fails on "inside bed". Two PATCHes: put in,
  board_area first then board_area_only; taken out, the flag first. Then
  refreshPlacing and refreshMachines, as the Head panel's tunables do.
- Pictures and models live in `machine-views/<id>/` beside config.json
  (var/ in a checkout, spinny_laser.home's folder when installed), with
  `view.json` holding name, type, bytes, version and box; a new upload
  keeps the box. Types by magic bytes: PNG, JPEG, WebP, GIF; no SVG (a
  script in it would run if the address were opened). STL binary is told
  by its length (84 + 50n), since binary headers may start with "solid".
  16 MB pictures, 64 MB models. The page asks by `?v=version`, served
  with max-age so a version is fetched once.
- Defaults: a picture is stretched over the travel (else the places'
  box); a model is drawn at its own coordinates (a CAD export in the
  machine's frame lands right). Either takes a box (Drag sets: Picture's
  box, Model's box). No turn or flip of a picture: turn it before upload.
- The model is drawn by the page (src/stl.ts), not the WebGL preview: the
  preview's worker draws toolpath lines, and a top view needs only one
  orthographic depth-buffered pass, done once per version into a 1024 px
  image. Shade = normal against a light from the upper left, times
  0.55..1 by height (flat tops all face the light alike and showed as one
  shade). The mock reuses stlTriangleCount for its twin of the check.
- The search's stops are the top camera's mosaic tiles (a search keeps a
  picture a stop since 026ec94), read again when the look's scan version
  changes. Untested on hardware.

## The top camera's offset applied after (2026-11-18)

Finding a board needed the offset first only on paper: the camera goes
to a place and reads it off its own picture, so the offset drops out
until the nozzle has to go there.

- A reference taken through the camera (`by` camera, fiducial, look,
  corners, corner) keeps `offset`, the one in use then; it is read as
  `at + (offset now - offset then)` (`reference_place`). Corrected at
  reading, not rewritten on a change: the offset changes on four paths
  (Measure offset on its thread, a typed one, an Undo, the file), and a
  reference kept before has no `offset` and stays put.
- Every change moves them, a second measurement too: right while the
  camera sits where it did; a camera remounted mid-board wants the
  board found again anyway.
- With none known (none measured, none in the file) the offset is 0, 0
  and the places are the camera's own. `_board_fit(frame=)` then refuses
  the nozzle over camera places, the camera over nozzle places, and a
  mix; with any offset known nothing is refused. The file's `bed` and
  `board_area` are then read as the head's places.
- Find fiducials goes by the offset in use and needs only the scale.
  Home by fiducial and a placing run keep needing the measured one:
  they tie the nozzle's own numbers.
- The look's corners and places found move (`BoardLook.shift`), its
  guesses start over: moving every look, frame, hypothesis and mosaic
  picture was more to get wrong than one stop to confirm. Kept per
  machine: another machine's offset only replaces the note.
