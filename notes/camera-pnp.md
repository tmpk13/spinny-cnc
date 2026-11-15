# Cameras, alignment, dispensing and pick and place

## Dispensing, pad probing, the camera and alignment (2026-10-19)

- The dispenser's plunger is the table joint. The SKR Pico has four
  drivers and a cartesian machine uses three (rail, slide, depth), so
  the plunger takes the table's socket and its settings, in mm, behind a
  `dispenser` flag that only acts with `cartesian`. `A` then goes on `go`
  and `cut`, moves no board (`joint_surface_length` drops it), and a
  line with no board length takes F as the speed along H and A. The
  output is dark as with a spindle. Nothing new in the step interrupt.
- `cut A` is absolute, so a plan starts with `set A0` and a pickup's
  approach restates `set A<where the plan had it>`: remaking the pieces
  from the plunger's live position would push every earlier dot's volume
  again on the first resumed dot.
- Dots, not beads: a dispensing group is one point a path with the pad's
  area beside it; a path group is refused on a dispenser with a message
  that says to import with mode dispense. Beads along a path would need
  a cross section nobody has measured.
- A pad map keeps the `HeightMap` shape (grid, heights) so the page and
  the coverage checks work unchanged, and adds `points` and
  `point_heights`; the grid heights are filled in from the pads after
  every probe. Between pads: a least squares plane plus the nearest six
  pads' residuals weighted by the inverse square of their distance, exact
  at a pad (a distance under a micron short circuits to that pad). The
  grid is the job's extent plus the pads' with a 1 mm margin at about
  2 mm spacing, so an outline cut past the pads is still "covered" (the
  plane extrapolates there).
- The find routine's geometry: a picture displacement (u right, v down)
  is `mm_per_px * R(roll) * (u, -v)` on the board. A head move of +step
  along X moves the spot by board -X in the picture, so the spot's move
  (du, dv) gives `roll = 180 - atan2(-dv, du)` degrees and the scale
  `step / hypot(du, dv)`. Centering is closed loop (three tries) so a
  rough scale still converges; the offset is the mark less the head once
  the center sits on the mark, which no scale error touches.
- The vision client keeps one request in flight under a lock and a reader
  thread that pairs replies by order, so a slow pcbv makes a request time
  out instead of blocking a route thread for good. The frame's JPEG rides
  after its reply line (`bytes`), read exactly.
- Jobs keep the design's map into their frame (`design`: gerber frame,
  which is KiCad X with Y negated, turned and shifted), updated by every
  shift and turn, so a camera pose in KiCad coordinates lands in the job's
  frame however the job has been moved. The uploaded `.kicad_pcb` is kept
  beside the job as `<id>.kicad_pcb` for pcbv to read.
- One camera mark aligns a job alone because the pose's angle and the
  camera's roll give the board's turn (`roll - angle_deg`, front side);
  two marks do without the roll. The scale a fit implies is reported and
  never applied.
- The firmware blob is at version 9 (one flag byte after the endstops);
  settings count 75 in the six places that enumerate them, the fixture
  of default controls has ten kinds (the dispenser is cartesian only).

## Pi CSI camera and pcbv
pcbv captures through V4L2 and takes only MJPG or YUYV. A CSI camera on the libcamera stack exposes raw Bayer nodes (unicam / rp1-cfe), which pcbv refuses. Bridge it: libcamerasrc into a v4l2loopback node as YUY2, or run pcbv under libcamerify. The backend reaches a pcbv on the Pi as socket://host:port.

## G-code pick and place device, OpenPnP compatible (2026-10-29)

- "OpenPnP compatible" taken as: a controller that takes the G-code
  OpenPnP's GcodeDriver sends, a line at a time, each answered `ok`
  (Marlin, Smoothieware, RepRapFirmware, Grbl). The page plans and sends
  the placement program itself; OpenPnP is not involved.
- The dialect is a profile (`pnp/*.toml`) because the firmwares agree on
  G0/G21/G90 but not on the vacuum (M106/M107, M10/M11, M42, switch
  module M-codes), the dwell (Grbl's G4 P is seconds, hence `{s}`), or the
  stop (Marlin M410 acts at once only with EMERGENCY_PARSER; otherwise it
  waits its turn behind the queued moves).
- `ok` after a move means queued: the wait command (M400) goes out before
  every vacuum switch, or the pump would switch while the head is still on
  its way.
- One line in flight, ping-pong, as GcodeDriver does. A refusal can come
  with its own `ok` after it (Marlin, Smoothie): taken within 0.3 s with
  the refusal, and anything still queued is cleared before the next line,
  so a late `ok` (the stop's) never answers the next line.
- `num()` first stripped the zeros of whole numbers too: `F600` went out
  as `F6`. Only digits after a decimal point are stripped now.
- The device has its own state (connected, references, feeder counts) and
  its own clock in the mock: it must not depend on the laser machine's
  connection (the mock first ran it only while that one was connected).
- Feeders count a part once its pick's lines are answered (placer.py), so
  a stop or a failure after a pick leaves the counts at what was really
  taken.
- Another shared-storage leak in the frontend tests: the device test left
  `spinny.pnp.target` = device for the PNP page test that ran after it.
- Up camera routines move through a `Mover` (pnp.py): this machine's
  joints and focus axis, or a G-code device's X/Y/Z with the wait command
  after each move (gcode_device.py `DeviceMover`). The calibration is per
  machine: this one's in the up camera settings, the device's in
  `pnp_device.camera` with the height from the profile's `[camera] z`.
- During a device run a vision part is looked at turned to the angle it
  goes down at (see "The device placing by its cameras and vacuum"
  below), and the run rises to the safe height after the look before the
  place moves across.
- `link.stopping` is the stop flag only while a run is alive: the flag
  stays set after a stopped run and would otherwise stop the next routine.
- The mock's planner must be told the camera is calibrated, as the
  backend's is, or every vision part is skipped.

## Cameras on a bridge Pi (2026-10-29)

- `pcbv serve --listen` ends the whole service when any TCP client sends
  `quit` (serve.rs breaks out of its accept loop). The backend sent `quit`
  in `VisionClient.close` for every stream, so stopping a remote camera
  killed it; now only a pcbv the backend started is told to quit.
- Over a socket the remote pcbv's capture mode comes from its own command
  line, so the camera settings' size and fps were silently ignored. After
  `hello` the backend sends `camera` with the path `hello` names and its
  own size and fps (costs one reopen, up to 3 s, per start).
- The unit listens on loopback only: pcbv has no authentication, and any
  client on the LAN could read frames. relay-pi carries the ports over the
  ssh login it already has.
- `StartLimitIntervalSec=0` on the unit: a camera not yet enumerated at
  boot makes pcbv exit, and with systemd's default burst limit (5 in 10 s)
  the unit would give up for good.
- pcbv is built on the Pi in the dev profile (deps at opt-level 3), not
  release: no LTO on a Pi, and `find_pcbv` looks in target/debug too.
  v4l2-sys-mit runs bindgen, so the Pi needs libclang (`libclang-dev`);
  deploy-pi checks for it rather than letting bindgen fail obscurely.
- Revised the same day: the Pi is a Zero 2 W (415 MB). rustc cannot build
  pcbv's eframe dependencies there, so the bridge Pi only streams:
  ustreamer `--encoder HW` passes the camera's MJPEG through undecoded and
  pcbv here reads `http://127.0.0.1:2325/stream` (pcb-vision 2de286c).
  ustreamer 5.4 (trixie) lists `JPEG` but not `MJPEG` as a format in its
  man page, newer ones have both; deploy-pi greps `ustreamer --help` for
  MJPEG and falls back to JPEG rather than guessing.
- `--web` still needs pcbv on the Pi: cross built here with
  aarch64-linux-gnu-gcc (dev profile, 513 MB, 23 MB stripped). It links
  against this machine's glibc (2.39 here), so it runs on trixie (2.41)
  but not bookworm (2.36); deploy-pi runs `pcbv --help` on the Pi before
  installing it.
- A pcbv that cannot open its camera exits with the reason on stderr; the
  page only saw "pcbv closed its output". The stderr thread keeps the last
  lines and start() joins it briefly to put the reason in the error.
- First try on the Zero: the pushed `/stream` at 1280x720 / 30 fps lagged
  seconds and then the Pi dropped off WiFi (no ARP answer; cause not yet
  known: brownout or the brcmfmac firmware). The relay's ssh connection
  had carried 122 MB at about 1.3 MB/s before going silent. Frames queued
  in the ssh channel window and TCP buffers, and the controller's link
  shares that connection. Now the device is `/snapshot`, which pcbv asks
  once per frame at most fps times a second (one picture in flight), and
  the unit has no `--slowdown` (snapshots are not stream clients).
- Measured on the Zero 2 W on 2026-10-30, 1280x720 MJPEG at about 120 KB
  a picture, age taken from ustreamer's `X-Timestamp` (both clocks on
  NTP): the tunnel carries about 12 Mbit/s, 12 pictures a second. `/stream`
  at 30 fps falls 0.6 s further behind every second (5.4 s after 8 s, no
  ceiling). `/snapshot` gives about 8 pictures a second, median 70 ms old,
  at most 0.2 s, whether fps is 10 or 30: the round trip per request is
  the limit. After the reboot `get_throttled` read 0x0 and the journal is
  volatile, so the earlier drop left no trace.

## Picking a camera from the ones attached (2026-11-03)

- The lists are filled when a panel comes into view and on Detect, never
  on a timer. Asking a port relay-pi forwards to nothing at the far end
  (2326 when only one camera is deployed) fails the ssh channel, which
  OpenSSH's client reports with `error()`, at its default log level, as
  "channel N: open failed: connect failed: ..." in the relay's terminal
  (from its source, not seen here); a 10 s poll like the serial ports'
  would fill that terminal.
- One raw request tells the two servers a forwarded port can have apart:
  `GET /state HTTP/1.0` gets `HTTP/...` from a ustreamer and a JSON error
  line (`not JSON`) from a pcbv, which then keeps the connection open, so
  the read stops at the first line rather than at the 1.5 s limit. A pcbv
  this backend's camera holds is listed unasked: pcbv serves one TCP
  client at a time, and the question would wait behind the backend's own
  connection.
- Alike USB cameras without serial numbers share one by-id name, which
  udev points at whichever came last, so a head camera and an up camera of
  the same make would swap on a replug. When a listed camera has no by-id
  link while another of its name has one, both go by `/dev/v4l/by-path`
  (the USB port). Every name reaching a camera is in its `names`, so a
  setting of `/dev/video0` still shows as that camera.
- `pcbv cameras --json` opens each node only for its formats: run beside
  a pcbv capturing from the same camera, it lists it and the capture's
  frames keep coming (checked with the integrated camera).
- Start sends the settings fields that differ from the state before
  starting (only the capture group, not the measured values): a pick or a
  typed device used to need Apply first, and Start alone ran the old one.
- Apply with another device, size, fps or program restarts a running
  camera (close, start, and the head camera loads its board again);
  refused while the camera's routine runs. A start that fails leaves the
  camera stopped with the new settings kept and the route answering 502,
  and the state event goes out anyway (`finally`), so the page shows it
  stopped. A machine file loaded with a camera section restarts it the
  same way; a failure there is a message, not a failed load, since the
  board already has the file's settings.

## The camera log (2026-11-05)

"A logging mode, mostly for the camera, photos with and without overlays,
the PNP part finder's steps with the bounding boxes" became the camera log
(`spinny_web.camlog`). The marked picture is an SVG holding the JPEG as a
data URL, because the backend has no image library (no Pillow, no numpy)
and pcbv's own `overlay` draws the localizer's spots and pose, not what a
`spot` request found; an SVG with the JPEG inside opens anywhere, an `<img>`
included, where one linking the JPEG beside it would show no picture in an
`<img>`. pcbv's `spot` gives a blob's center and axes but no angle, so the
"bounding box" is the axes' box, axis aligned. A look is logged before a
miss raises, since the miss is the picture to see; a picture that cannot be
had is a warning and never stops a routine. The frame is asked right after
the spot, so on a moving machine it may be a frame later than the spot's
(both read the newest frame); routines look only once the head has
settled. Full size JPEGs at quality 90 (about 64 kB from the laptop
camera, 1280x720) plus the SVG (a third more) per look; 300 entries kept.
The switch is in config.json (`camlog`). The mock keeps photos by hand
only; its routines' looks are not logged.

## Camera detection under localhost (2026-11-09)

A held pcbv is matched under both loopback names (`_aliases`), so a
camera set as socket://localhost:PORT is listed without being probed.

## The pcbv client under a silent pcbv (2026-11-09)

Each request carries its own id and takes only the reply with that id,
from a reply queue per connection: a late reply answered the next
request for good, so a spot after a move could get the spot from before
it. A request waits at most 1 s for its turn and is refused 'the camera
is busy' (the camera routes share the server's 40 threads, so callers
queued behind a silent pcbv used them up and Stop and Hold waited); a
request left unanswered past its time, or a failed connection, closes
the camera, which the operator starts again. Pictures and poses asked
during a board load (up to 30 s) are refused as busy.

## The device placing by its cameras and vacuum (2026-11-09)

- The run is a placement (placer.py) on the link's run thread, not a
  fixed program: each next line comes from what a camera or the vacuum
  said. The plan text stays the plan before the run (vacuum reads and
  notes where a camera looks), and the mock's twin matches it line for line.
- Every device place is the head's with the tip turned to 0 over a point.
  The up camera's `position` is the head's with that tip over the center,
  `runout` the tip off the turning axis at 0. A part is looked at turned to
  the angle it goes down at (head = axis - turn(runout, a)), so its offset
  needs no turning and the axis's direction only matters for the small
  correction; placed at a': head = X + e - turn(s + axis - head, a' - a).
  The angle error is the part's long side against its angle on the board
  (Block.angle), mod 90 since a footprint's long side at 0 may lie along X
  (0603) or Y (SOIC). Measuring it against the feeder's angle plus the
  nozzle's current angle turned the part again on every look (caught by
  the landing test).
- Runout: centering turns the nozzle to 0 first; six tips at 60 degree
  steps, Kasa's circle fit; the tip at 0 less the center is the runout.
  The same circle tells which way the nozzle went round, so a reversed
  axis is named (rotation_cw) when the runout is over 2 px and 10 um.
- pcbv's spot reply gained `angle` and `rect` (pcb-vision b4d1299). Its
  checkout held 2,200 lines of pending work, so only that hunk was
  committed (patch on HEAD into the index); the pending work does not
  compile, so the pcbv binary lacks `rect` until it is built from HEAD or
  the work is done. Without `rect` the run falls back to the ellipse's
  axis for long parts and otherwise places uncorrected, saying so once.
  `rect` hulls whole pixel squares: about 3 px long per side on a slanted
  part, hence the 0.3 size tolerance.
- The top camera's offset is its picture's center less the tip's place
  for one head place: a point is looked at from point - offset, a spot is
  at head + offset + its displacement. It rides on the head, so calibrate()
  gets the spot's moves negated. Measured from a mark the tip was put on
  (Nozzle on mark keeps the head's place).
- Fiducials are footprints FID* or named Fiducial, kept even with
  exclude_from_pos_files (KiCad's own fiducials carry it). Two or more
  found replace the hand references; one is fitted with the hand ones.
- The vacuum is read after the pick's rise, so a part left in its pocket
  reads as none. Marlin answers M105 on its `ok` line, which the link
  keeps in the reply. OpenPnP's `(?<Value>...)` becomes Python's
  `(?P<Value>...)`.
- A failed pick goes back into its pocket by default, never over the up
  camera (a part dropped on its lens), and counts the pocket as taken.
  Two parts left out in a row stop the run: a wrong shade or range would
  otherwise use up every pocket. With `part_off`, the nozzle is read empty
  after a let go too: a part stuck there would make the next pick read as
  held whatever it took.
- The mock's run looks once at the place angle with the true part, and
  its vacuum reads the middle of the range for how the vacuum stands; it
  does not play retries.

## Upright pictures, the top camera's file roll (2026-11-14)

- Upright (picture.ts) turns the stage, the image and the SVG marks together, by the camera's roll to the nearest quarter turn, flipped first for a mirrored camera, so screen right is +X and up is +Y as on the jog pad. Quarter turns only: any other angle would leave empty corners or crop the picture. Words in the marks get `levelText`, the turn undone about their anchor. pcbv's own overlay, drawn into the JPEG, turns with the picture.
- The pointer is turned back from the stage's bounding box, its width and height swapped when on its side, not from `offsetWidth`: the page tests fake only `getBoundingClientRect`, and a quarter turn's bounding box is exact.
- `[top_camera] roll` is the design's turn, used while the camera's `mm_per_px` is 0 (`_top_roll`, the page's `topOrientation`). Measure offset sets the scale and the roll together, so a scale means a measured roll; clearing the offset keeps both. It matters to the backend too: the board look takes its scale from a pcbv lock and its offset from the file, so an unmeasured upside-down camera put the board 180 degrees off before.

- Corner references (2026-11-14): a corner taken with the top camera is a
  reference (`by "corner"`, `point`, `angle` for one found by its edges);
  `_board_fit` uses `point`, a lone reference turned by the typed angle,
  else the edges'. `_top_known` leaves corner references out while the
  look holds its corners (no double count) and counts them after a
  restart (the look keeps corners in memory only). Use as board place
  replaces them; Clear corners forgets them.
- Part shapes: the board file keeps a pad's whole angle (the footprint's
  included), so the pad's own turn is its angle less the footprint's;
  points turned on screen as x' = x cos + y sin, y' = -x sin + y cos (y
  down), then `board_to_job`; the body is F.Fab, else the courtyard;
  cached per file by mtime. Find home fiducial is `POST /api/pnp/top/home
  {"home": false}`.
