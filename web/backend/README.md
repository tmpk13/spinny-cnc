# spinny-web backend

Python backend for the web interface of the rotary table laser. It owns the
serial link to the firmware, turns board geometry into joint-space lines,
streams jobs, and serves the frontend. The firmware does no kinematics.

```sh
uv sync                                     # once, at the repository root
uv run spinny-web --host 0.0.0.0 --port 8000
uv run spinny-bridge --device auto --port 2324   # the controller's port over TCP for a backend elsewhere
uv run spinny-mcp --url http://127.0.0.1:8000    # the tools for an MCP client, over stdio
uv run pytest web/backend/tests
```

A page from another origin cannot drive the machine: its posts and
websockets are refused (browsers name the origin on both, and CORS alone
would only stop the page reading the answer). `--cors-origin
http://localhost:3000` (repeatable) admits a page served from elsewhere,
such as the frontend's dev server. `--allowed-host spinny.local`
(repeatable) also pins the `Host` header, against a page that points its
own name at this address. Anything without an `Origin` header, such as a
script, is admitted; the backend is meant for a trusted network. The
loopback names `127.0.0.1` and `localhost` are always allowed as the host,
since the backend's own tools come in under them.

The API is `docs/WEB_API.md`; the firmware protocol is `docs/PROTOCOL.md`.
`../frontend/dist` is served at `/` when it exists.

## Modules

| Module | Job |
| --- | --- |
| `link.py` | `serial_for_url` port (`/dev/ttyACM0` or `socket://host:port`), reader thread, line classification, credit flow control, realtime bytes, status poll |
| `bridge.py` | `spinny-bridge`: the controller's port served over TCP for a backend elsewhere, one client at a time, the device opened per client; a device that takes nothing is given up with the client told why, a client that stops reading dropped, a quiet one replaced |
| `kinematics.py` | board polylines to `cut`/`go`/`jogto` lines through `spinny_laser.polar`, joint-space polylines streamed as they are (a negative radius is the far side of the axis), time estimate against the axis limits, the cross slide's own `Z` lines; `CartesianStreamer` for `$cartesian=1` (straight `R Z` lines in the table's frame); milling with a `Spindle` (lift, spin-up, plunge, step-down passes, rise) |
| `jobs.py` | the job model (board `paths`, or `joints` for a group written in joint space), importers (`.svg`, `.gcode`/`.nc`, `.json`, `.gbr`, `.kicad_pcb`), the on-disk store in `jobs/` |
| `center.py` | the `spinny-center` test burn built in place as a job, coarse (board paths) or fine (joint space) |
| `runner.py` | streams a job lazily, hold/resume/stop, progress events |
| `vision.py` | the camera through pcb-vision's `pcbv serve`: the program started on a device here, or one reached at a `socket://` device, one JSON request a line and the frame's bytes after its reply |
| `camera.py` | the camera's settings and state, its picture and pose, the mark the tool made, and the routine that finds the mark in the picture and measures the camera's offset, roll and scale |
| `pnp.py` | pick and place: the parts of a board job read from its kept `.kicad_pcb` (an s-expression reader, KiCad 5 to 10) and placed in the job's frame, and the up camera fixed to the machine, with the routine that centers the nozzle over it (measuring where it is and how its picture scales, turns and mirrors) and the one that reads where a part sits on the nozzle |
| `openpnp.py` | a pick and place machine driven with the G-code OpenPnP's GcodeDriver sends: device profiles in `pnp/` (port, dialect, heights, feeders) read and checked, the board's fit on the device from reference parts, and the placement program (pick from the first feeder whose words the part holds, place turned from the feeder's angle, the wait command before every vacuum switch) |
| `gcode_device.py` | the link to that machine: a serial port or a `socket://` url, a line at a time, each answered `ok` (a refusal's trailing `ok` taken with it, Marlin's `busy:` keeping a slow line alive), a program sent on its own thread and stopped with the profile's quickstop |
| `align.py` | marks that pair a job's design points (pads, holes, any point) with where the machine or the camera found them, the fit (`spinny_laser.align`) and its application to the job |
| `resume.py` | the resume record (`var/resume.json`, how far the last run got and the plan it was made from) and the machine's last reported position (`var/position.json`), both kept across sessions |
| `heightmap.py` | the probed height map (a grid in board mm, bilinear between points), its file, and the run compensation: focus heights on every line, or power raised for the defocus |
| `prober.py` | probes a grid with the touch probe on the focus axis, point by point, one line answered before the next |
| `cam.py` | the CAM profiles in `cam/` (listed, read, saved whole, patched one value at a time), the uploaded files through a profile into a job (`spinny_laser.camjob`), a stored job as gcode for the profile's controller (`spinny_laser.post`) |
| `tools.py` | the tools a language model gets, one registry for both front ends: each a name, a description, a JSON schema, the routes it calls and the call itself on the backend's HTTP API through httpx; arguments checked against the schema before anything is sent, every request outside the registry's routes answered 403 before it leaves (`RouteGuard`), answers cut to 20000 characters and a job counted rather than listed. None moves the machine: the tests hold the routes against a list of routes that do not |
| `mcp_server.py` | `spinny-mcp`: the tools over MCP on stdio (the `mcp` SDK's low-level server), calling the backend at `--url` |
| `app.py` | FastAPI routes, the `/ws` fan-out, settings, the machine files in `machines/` (listed, matched against the live settings, loaded whole, their controls sent with the settings; read, checked, saved and removed through `machines.py`), the machine profile (polar or cartesian, laser or spindle) that picks the streamer, the frontend |

## Events

`/ws` sends one JSON object per event with the payload flattened next to
`type`: `{"type": "state", "connected": ..., "machine": ...}`,
`{"type": "console", "dir": "rx", "text": "ok"}`,
`{"type": "progress", "state": "running", ...}`,
`{"type": "heightmap", "map": ..., "probe": ..., "settings": ...}`,
`{"type": "message", "level": "info", "text": "..."}`,
`{"type": "camera", ...the camera state...}`,
`{"type": "pnp", ...the up camera state...}`,
`{"type": "pnp_device", ...the G-code device state...}` and
`{"type": "align", "job": ..., "marks": ..., "fit": ...}`. Console events
include the status polls and reports.

`GET /api/run` answers `null` before any job has run, like the snapshot's
`run`. A progress object also carries `error` with the reason when the
state is `error`.

## Files

Runtime files go to `var/` at the repository root, or wherever `--data`
points; none of them is tracked.

- `config.json`: the host tolerance, the milling clearance and spin-up, the last url and the probe settings.
- `heightmap.json`: the last probed height map and its focus offset. The offset is taken back (the heights kept) on a connect, a restart, a position set, a setting that rescales or turns the axes and a map put back, since the focus axis has no home: focus here again before a compensated run.
- `jobs/*.json`: one file per imported job.
- `spinny.log`: the backend's log, rotated at 1 MB (`--log-level debug` for more): the link's opening and closing with what it last sent and heard, runs, probing, settings written, messages shown on the page and the machine's own messages, its boot reason and `diag` answer among them.
- `wire.log`: every line sent and received with the time to the millisecond, the link's own status polls marked, rotated at 8 MB with four kept; the last lines before a machine went quiet.

## Architecture

```mermaid
classDiagram
    class app {
        Backend
        Backend.profile polar or cartesian, laser or spindle
        Backend.streamer(status) Streamer
        Backend owner lock, a run or probing
        Backend focus axis frame, height map anchoring
        Broadcast
        create_app(backend) FastAPI
    }
    class link {
        Link.send(line) Pending
        Link.request(line) lines
        Link.realtime(byte)
        Link.age / stall: closed after 3 s unanswered
        parse_status(text) Status
    }
    class kinematics {
        Streamer.job_pieces(job, start)
        Streamer.estimate(job) Stats
        Streamer.board_jog / board_goto
        Streamer.joint_jog / joint_goto
        Streamer.slide_jog / slide_goto
        CartesianStreamer(angle) R and Z in the table frame
        Streamer.rewind / approach / renumber_for picking a job up
        Spindle clearance, spinup, full (speed control off)
    }
    class jobs {
        Job, Group, JobStats, Recipe
        import_file(path, options)
        remake_upload(job, kept, width) / with_width / carry_settings
        JobStore  keep_upload, upload_path
    }
    class mill {
        MillOperation
        build(op, holes) Job, notes  the Plot page's operations
        remake(job, tool) the job again for another bit
    }
    class markers {
        Marker, checked(markers)  kept in config.json
    }
    class spinny_laser_mill {
        drill, line, face, pocket_rect, pocket_circle, profile_rect, profile_circle
    }
    class center {
        CenterRequest
        build(request, streamer, rate) CenterResult
    }
    class runner {
        Runner.start(job, link, streamer, compensation, skip, pieces, plan_start)
        Runner.hold / resume / stop
        Runner.record() the resume record, checkpointed as the run goes
        halt(link) stop at rest
    }
    class resume {
        ResumeStore var/resume.json
    }
    class log {
        setup(root, level) var/spinny.log, rotated
        wire_line / wire_note var/wire.log, every line with the time
        tail(path, lines)
    }
    class heightmap {
        Grid, HeightMap, HeightMapStore
        Grid.mask / with_mask_for(job, margin) only around the cuts
        HeightMap.for_points(points, box) a pad map: a plane through the pads, the nearest pads' deviations between
        estimate_points_seconds(points, settings, rates)
        Compensation focus / power
        check_covers(map, job) every cut over probed cells
    }
    class vision {
        VisionClient.start(device, size, fps, pcbv) / board / pose / frame / spot
        find_pcbv(name) PATH, else ../pcb-vision/target
    }
    class camera {
        CameraSettings device, size, fps, side, finish, offset, roll, mm_per_px
        Camera.start / stop / load_board / frame / pose / state
        Camera.find(access, step) lift, move, scale, center, the offset saved
        pixel_to_board / scale_from_shift
    }
    class pnp {
        footprints_of(text) the parts of a board file
        job_components(job, path) in the job's frame
        UpCameraSettings device, size, fps, spots, position, height, mm_per_px, roll, mirror
        UpCamera.center_nozzle(access, step) lift, over the camera, down, scale, center, the position saved
        UpCamera.measure_part(access) the part's offset from the nozzle
        picture_to_machine / calibrate
    }
    class openpnp {
        parse(text, id) Device: port, dialect, heights, feeders
        DeviceStore.list / document / check / save
        board_fit(references, angle) a turn and a shift
        plan(device, parts, fit, taken, refs) head, blocks per part, tail, skipped
    }
    class gcode_device {
        GcodeDevice.connect(url, baud, wait_ms, init, timeout) / disconnect
        GcodeDevice.command(line, timeout) the answer, or a refusal
        GcodeDevice.run(plan, timeout, on_block) / stop(line)
    }
    class align {
        Alignment.mark_tool(job, machine, design, nearest, within)
        Alignment.mark_camera(job, design, machine, angle)
        Alignment.fit / apply(job) a turn and a shift
    }
    class tools {
        TOOLS  name, schema, routes, the call on the API
        ToolBox.in_process(app) / over_http(url)
        RouteGuard  only the tools' routes leave
    }
    class mcp_server {
        build_server(toolbox)  spinny-mcp on stdio
    }
    class prober {
        Prober.start(grid, settings, link, spindle_off, keep_focus, resume, touch, points, box)
        Prober.stop / cancel, also while starting
        probe_joint(point, offset)
        cartesian_probe_joint(point, offset, angle)
    }
    class spinny_laser_polar {
        subdivide(start, end, joint, kin)
    }
    class spinny_laser_machines {
        load_all(directory) the machine files
        current(machines, values) which one is loaded
    }
    class cam {
        ProfileStore list / document / save / patch / remove
        build_job(profile, folder, name, streamer) Job, notes
        gcode_of(job, profile) text, report
    }
    class spinny_laser_cam {
        cam.parse / set_value
        camjob.read_board / build
        post.post(built, profile) Program
    }
    class spinny_laser_center {
        center.build / fine.build
    }
    class spinny_laser_clear {
        clear(copper, keep, spot, pattern, outline)
    }
    class spinny_laser_deposit {
        deposit(copper, spot, fill, passes, centers)
        centerlines(image)
    }
    class laser_sweep {
        gerber, geom, isolate, isocli
    }
    app --> link
    app --> jobs
    mcp_server --> tools
    tools ..> app : HTTP
    app --> runner
    app --> kinematics
    app --> center
    app --> mill
    app --> markers
    mill --> jobs
    mill --> spinny_laser_mill
    app --> heightmap
    app --> prober
    app --> spinny_laser_machines
    app --> cam
    app --> vision
    app --> camera
    app --> pnp
    app --> openpnp
    app --> gcode_device
    gcode_device --> openpnp
    app --> align
    camera --> vision
    camera --> link
    pnp --> vision
    pnp --> link
    align --> jobs
    cam --> jobs
    cam --> spinny_laser_cam
    prober --> link
    prober --> heightmap
    prober --> runner
    runner --> heightmap
    heightmap --> kinematics
    center --> jobs
    center --> spinny_laser_center
    runner --> link
    runner --> kinematics
    jobs --> kinematics
    jobs --> laser_sweep
    jobs --> spinny_laser_clear
    jobs --> spinny_laser_deposit
    spinny_laser_deposit --> spinny_laser_clear
    kinematics --> spinny_laser_polar
```

## Tests

`uv run pytest web/backend/tests` runs everything on the host against a fake serial port that
feeds bytes one at a time. The end-to-end test is marked `e2e` and runs
only when `SPINNY_VIRTUAL` names a built virtual firmware binary that takes
`--listen 127.0.0.1:PORT --fast`; the probing one also gives it a board
surface and a probe offset, and one probing test runs it in real time.
