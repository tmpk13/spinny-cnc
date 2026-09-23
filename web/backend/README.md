# spinny-web backend

Python backend for the web interface of the rotary table laser. It owns the
serial link to the firmware, turns board geometry into joint-space lines,
streams jobs, and serves the frontend. The firmware does no kinematics.

```sh
cd web/backend
uv sync
uv run spinny-web --host 0.0.0.0 --port 8000
uv run pytest
```

A page from another origin cannot drive the machine: its posts and
websockets are refused (browsers name the origin on both, and CORS alone
would only stop the page reading the answer). `--cors-origin
http://localhost:3000` (repeatable) admits a page served from elsewhere,
such as the frontend's dev server. `--allowed-host spinny.local`
(repeatable) also pins the `Host` header, against a page that points its
own name at this address. Anything without an `Origin` header, such as a
script, is admitted; the backend is meant for a trusted network.

The API is `docs/WEB_API.md`; the firmware protocol is `docs/PROTOCOL.md`.
`../frontend/dist` is served at `/` when it exists.

## Modules

| Module | Job |
| --- | --- |
| `link.py` | `serial_for_url` port (`/dev/ttyACM0` or `socket://host:port`), reader thread, line classification, credit flow control, realtime bytes, status poll |
| `kinematics.py` | board polylines to `cut`/`go`/`jogto` lines through `spinny_laser.polar`, joint-space polylines streamed as they are (a negative radius is the far side of the axis), time estimate against the axis limits, the cross slide's own `Z` lines |
| `jobs.py` | the job model (board `paths`, or `joints` for a group written in joint space), importers (`.svg`, `.gcode`/`.nc`, `.json`, `.gbr`, `.kicad_pcb`), the on-disk store in `jobs/` |
| `runner.py` | streams a job lazily, hold/resume/stop, progress events |
| `app.py` | FastAPI routes, the `/ws` fan-out, settings, the frontend |

## Events

`/ws` sends one JSON object per event with the payload flattened next to
`type`: `{"type": "state", "connected": ..., "machine": ...}`,
`{"type": "console", "dir": "rx", "text": "ok"}`,
`{"type": "progress", "state": "running", ...}` and
`{"type": "message", "level": "info", "text": "..."}`. Console events
include the status polls and reports.

`GET /api/run` answers `null` before any job has run, like the snapshot's
`run`. A progress object also carries `error` with the reason when the
state is `error`.

## Files

- `config.json` (ignored): the host tolerance and the last url.
- `jobs/*.json` (ignored): one file per imported job.

## Architecture

```mermaid
classDiagram
    class app {
        Backend
        Broadcast
        create_app(backend) FastAPI
    }
    class link {
        Link.send(line) Pending
        Link.request(line) lines
        Link.realtime(byte)
        parse_status(text) Status
    }
    class kinematics {
        Streamer.job_pieces(job, start)
        Streamer.estimate(job) Stats
        Streamer.board_jog / board_goto
        Streamer.joint_jog / joint_goto
        Streamer.slide_jog / slide_goto
    }
    class jobs {
        Job, Group, JobStats
        import_file(path, options)
        JobStore
    }
    class runner {
        Runner.start(job, link, streamer)
        Runner.hold / resume / stop
    }
    class spinny_laser_polar {
        subdivide(start, end, joint, kin)
    }
    class laser_sweep {
        gerber, geom, isolate, isocli
    }
    app --> link
    app --> jobs
    app --> runner
    app --> kinematics
    runner --> link
    runner --> kinematics
    jobs --> kinematics
    jobs --> laser_sweep
    kinematics --> spinny_laser_polar
```

## Tests

`uv run pytest` runs everything on the host against a fake serial port that
feeds bytes one at a time. The end-to-end test is marked `e2e` and runs
only when `SPINNY_VIRTUAL` names a built virtual firmware binary that takes
`--listen 127.0.0.1:PORT --fast`.
