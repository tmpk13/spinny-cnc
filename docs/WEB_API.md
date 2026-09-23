# Web interface API

The backend (`web/backend`, Python) owns the serial link to the firmware and
serves the frontend (`web/frontend`, TypeScript) as static files. The
frontend only talks to the backend; it never sees the serial port.

Base URL: `http://<host>:8000`. Bodies and responses are JSON unless noted.

## Connection

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/ports` | | `{"ports": [{"url": "/dev/ttyACM0", "description": "..."}]}` plus any `socket://` url last used |
| `POST /api/connect` | `{"url": "/dev/ttyACM0"}` | state snapshot; `socket://host:port` reaches the virtual firmware; anything but a device path, a `COMn` port or a `socket://` url is refused with 400 |
| `POST /api/disconnect` | | state snapshot |
| `GET /api/state` | | state snapshot |

State snapshot:

```json
{
  "connected": true,
  "url": "/dev/ttyACM0",
  "firmware": {"version": "0.1.0", "lines": 16, "blocks": 32},
  "machine": {
    "state": "Idle", "alarm": null,
    "joint": {"r": 12.345, "a": 90.1234, "z": 0.0},
    "board": {"x": 0.0, "y": 12.345},
    "rate": 0.0, "laser": 0, "mode": "dyn", "enabled": true,
    "queue": {"planner": 32, "lines": 16}
  },
  "run": null
}
```

`board` is derived on the host from `joint`: `x = r cos a`, `y = r sin a`.

## Moving

| Method and path | Body |
| --- | --- |
| `POST /api/jog` | `{"kind": "joint", "dr": 1.0, "da": 0.0, "feed": null}` or `{"kind": "board", "dx": 0.0, "dy": -1.0, "feed": 500}` relative; `{"kind": "joint", "dz": 0.5}` moves the cross slide, which cannot be combined with `dr` or `da` |
| `POST /api/goto` | `{"kind": "joint", "r": 0, "a": 0}` or `{"kind": "board", "x": 3, "y": 4, "feed": 500}` absolute; an axis left out keeps the coordinate the head will have once the jog in progress ends, and is refused with 400 while that end is not known; `{"kind": "joint", "z": 0}` sends the cross slide there, again not with `r` or `a` |
| `POST /api/jog/cancel` | |
| `POST /api/position` | `{"r": 0}`, `{"a": 0}` and/or `{"z": 0}`: declare the current position |

A jog, a goto or a position declaration answers 409 while a run owns the
machine, from the moment the run is being planned. A board move whose
lines would pass the firmware's `r_max` is refused whole with 400 before
any of them goes out; a move within the limit chains from the end of the
jog in progress. Move requests are served one at a time.
| `POST /api/motors` | `{"enabled": false}` |
| `POST /api/unlock` | |
| `POST /api/realtime` | `{"action": "hold" \| "resume" \| "reset" \| "cancel" \| "status"}`; while a job runs, `hold` and `resume` are the run's own, and `reset` ends the run before the byte goes out |
| `POST /api/command` | `{"line": "cut R10 F300 S200"}` returns `{"lines": ["ok"]}`: what the command printed, then its answer; a line of `?`, `!` or `~` alone goes out as that realtime byte and returns `{"lines": []}`; status reports and `[MSG:...]` lines arrive as events, except that a `status` command's own report is in its `lines` |

Board jogs and gotos are turned into joint moves on the host with the chord
tolerance from the settings page, so a board move through the axis becomes
a radial move in, a turn, and a radial move out. Joint jogs move one motor
at a time when only one delta is given: that is the independent axis
control.

## Laser

| Method and path | Body |
| --- | --- |
| `POST /api/laser` | `{"power": 50, "ms": 2000}` constant beam with a timeout |
| `POST /api/laser/off` | |
| `POST /api/mode` | `{"mode": "dyn" \| "const"}` |

## Settings

| Method and path | Body |
| --- | --- |
| `GET /api/settings` | returns `{"values": {"r_steps": 256, ...}, "schema": [{"name", "unit", "help"}], "host": {"tolerance": 0.005}}` |
| `PUT /api/settings` | `{"values": {"r_rate": 800}, "host": {"tolerance": 0.005}}`; all or nothing: an unknown name, a value that is not a finite number, or a tolerance outside `(0, 10]` mm answers 400 with nothing applied, and a value the firmware refuses has the ones sent before it put back; the host tolerance is stored only once the values went through |
| `POST /api/settings/save` | writes the firmware settings to flash |

## Jobs

| Method and path | Body |
| --- | --- |
| `POST /api/jobs` | multipart: `file` plus optional fields `power`, `speed`, `spot`, `anchor` (`center`/`keep`), `offset_x`, `offset_y`, `passes` (1 to 50); a file over 64 MB answers 413 |
| `GET /api/jobs` | `{"jobs": [summary]}`: the job without coordinates, each group's `paths` being the count |
| `GET /api/jobs/{id}` | the job |
| `PATCH /api/jobs/{id}` | `{"groups": [{"index": 0, "power": 500, "speed": 400, "enabled": true}], "offset": {"x": 0, "y": 14}}` |
| `DELETE /api/jobs/{id}` | |
| `POST /api/jobs/{id}/run` | starts streaming |
| `POST /api/run/hold`, `/api/run/resume`, `/api/run/stop` | |
| `GET /api/run` | progress, or `null` before any job has run |

Accepted uploads: `.svg` (paths, lines, polylines, polygons, rects,
circles; curves flattened; mm from the viewBox), `.gcode`/`.nc` (absolute
X/Y `G0`/`G1` with `S` and `F`), `.json` (a job), `.gbr` (copper layer,
isolation loops through the sibling geometry engine), `.kicad_pcb`.

Job:

```json
{
  "id": "a1b2", "name": "board", "source": "gerber",
  "spot": 0.1, "offset": {"x": 0, "y": 14},
  "groups": [
    {"label": "isolation loop 1", "power": 500, "speed": 400, "enabled": true,
     "paths": [[[x, y], ...], ...]},
    {"label": "rail line through the axis", "power": 400, "speed": 200, "enabled": true,
     "paths": [[[x, y], ...]], "joints": [[[r, a], ...]]}
  ],
  "outline": [[[x, y], ...]], "copper": [[[x, y], ...]],
  "stats": {"length_mm": 0, "seconds": 0, "max_radius": 0, "min_radius": 0,
            "limited_fraction": 0, "moves": 0}
}
```

Path coordinates are board mm with the rotation axis at the origin; the
offset is already applied. A group may instead carry `joints`: polylines
in joint space, radius mm and angle degrees, each pair of points streamed
as one `cut` with no kinematics in between, and a negative radius meaning
the far side of the axis. Such a group is written about the axis, so a
job holding one cannot be given an offset; its `paths` are only what the
preview draws, and the importer fills them in from the joints when they
are left out. Progress:

```json
{"job": "a1b2", "state": "running", "sent": 120, "acked": 118, "total": 900,
 "seconds": 12.5, "estimate": 95.0, "group": 0, "error": null}
```

`state` is `running`, `hold`, `done`, `stopped`, or `error`; `error` carries
the reason when it is `error`, why a run was stopped from outside (a reset
from the console), and what a stop cost when it was not clean: the machine
did not come to rest in time and was reset moving, or is in an alarm the
operator has to clear. A stop that could not reach the machine ends the run
as `error`, since the machine is still cutting what it had. `done` means
every line was answered and the machine came to rest; a machine still busy
an hour after the last answer, holds not counted, ends the run as `error`
with a stop. `acked` counts lines the firmware answered; lines a stop
flushed are not answered.

A `POST` from a page on another origin is refused with 403, and so is a
websocket opened by one; only the server's own origin and any
`--cors-origin` pass. Requests without an `Origin` header (scripts, curl)
are not a page's and pass. `--allowed-host` restricts the `Host` header as
well.

## Events

`WS /ws` sends JSON events; the client sends nothing. The payload's fields
sit next to `type` in one flat object: `{"type": "console", "dir": "rx",
"text": "ok"}`.

| `type` | Payload |
| --- | --- |
| `state` | the state snapshot, at 5 Hz idle and 10 Hz while moving |
| `console` | `{"dir": "rx" \| "tx", "text": "...", "poll": false}` every line either way; `poll` marks the status poll the backend sends several times a second and the report it brings back, which a console should hide by default or it buries everything else |
| `progress` | the progress object |
| `message` | `{"level": "info" \| "error", "text": "..."}` |
