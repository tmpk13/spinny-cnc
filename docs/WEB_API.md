# Web interface API

The backend (`web/backend`, Python) owns the serial link to the firmware and
serves the frontend (`web/frontend`, TypeScript) as static files. The
frontend only talks to the backend; it never sees the serial port.

Base URL: `http://<host>:8000`. Bodies and responses are JSON unless noted.

## Connection

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/ports` | | `{"ports": [{"url": "/dev/ttyACM0", "description": "..."}]}` plus any `socket://` url last used |
| `POST /api/connect` | `{"url": "/dev/ttyACM0"}` | state snapshot; `socket://host:port` reaches the virtual firmware |
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
    "joint": {"r": 12.345, "a": 90.1234},
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
| `POST /api/jog` | `{"kind": "joint", "dr": 1.0, "da": 0.0, "feed": null}` or `{"kind": "board", "dx": 0.0, "dy": -1.0, "feed": 500}` relative |
| `POST /api/goto` | `{"kind": "joint", "r": 0, "a": 0}` or `{"kind": "board", "x": 3, "y": 4, "feed": 500}` absolute |
| `POST /api/jog/cancel` | |
| `POST /api/position` | `{"r": 0}` and/or `{"a": 0}`: declare the current position |
| `POST /api/motors` | `{"enabled": false}` |
| `POST /api/unlock` | |
| `POST /api/realtime` | `{"action": "hold" \| "resume" \| "reset" \| "cancel" \| "status"}` |
| `POST /api/command` | `{"line": "cut R10 F300 S200"}` returns `{"lines": ["ok"]}` |

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
| `PUT /api/settings` | `{"values": {"r_rate": 800}, "host": {"tolerance": 0.005}}` |
| `POST /api/settings/save` | writes the firmware settings to flash |

## Jobs

| Method and path | Body |
| --- | --- |
| `POST /api/jobs` | multipart: `file` plus optional fields `power`, `speed`, `spot`, `anchor` (`center`/`keep`), `offset_x`, `offset_y` |
| `GET /api/jobs` | `{"jobs": [summary]}` |
| `GET /api/jobs/{id}` | the job |
| `PATCH /api/jobs/{id}` | `{"groups": [{"index": 0, "power": 500, "speed": 400, "enabled": true}], "offset": {"x": 0, "y": 14}}` |
| `DELETE /api/jobs/{id}` | |
| `POST /api/jobs/{id}/run` | starts streaming |
| `POST /api/run/hold`, `/api/run/resume`, `/api/run/stop` | |
| `GET /api/run` | progress |

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
     "paths": [[[x, y], ...], ...]}
  ],
  "outline": [[[x, y], ...]], "copper": [[[x, y], ...]],
  "stats": {"length_mm": 0, "seconds": 0, "max_radius": 0, "min_radius": 0,
            "limited_fraction": 0, "moves": 0}
}
```

Path coordinates are board mm with the rotation axis at the origin; the
offset is already applied. Progress:

```json
{"job": "a1b2", "state": "running", "sent": 120, "acked": 118, "total": 900,
 "seconds": 12.5, "estimate": 95.0, "group": 0}
```

`state` is `running`, `hold`, `done`, `stopped`, or `error`.

## Events

`WS /ws` sends JSON events; the client sends nothing.

| `type` | Payload |
| --- | --- |
| `state` | the state snapshot, at 5 Hz idle and 10 Hz while moving |
| `console` | `{"dir": "rx" \| "tx", "text": "..."}` every line either way |
| `progress` | the progress object |
| `message` | `{"level": "info" \| "error", "text": "..."}` |
