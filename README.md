# spinny-laser

A laser PCB machine with a rail over a rotary table. The head rides a
linear axis, the radius `R`, whose rail passes over the rotation axis of a
harmonic drive table, the angle `A`, that the board turns on. The machine
runs its own firmware on a BTT SKR Pico and is driven from a browser. An
optional focus axis `H` carries a touch probe, and the cross slide `Z` can
make it an X/Y machine, with a spindle on the laser output for milling.

| Directory | What | Stack |
| --- | --- | --- |
| `firmware/` | the controller: portable core, SKR Pico port, virtual firmware on TCP | Rust |
| `web/backend/` | serial link, job import, streaming, probing, API, serves the page | Python, FastAPI |
| `web/frontend/` | the page: position, jog, jobs, height map, 3D preview, settings | TypeScript, Bun |
| `toolpath/` | `spinny_laser`: polar kinematics, copper clearing and deposition, centering coupons, machine configs, gcode tools | Python |
| `machines/` | machine configurations in TOML, one file per axis setup | |
| `sim/` | plays gcode jobs back on a model of the machine | Rust |
| `docs/` | protocol, web API, architecture, machine configs, operating, calibration, gcode toolchain | |
| `var/` | runtime files: jobs, config, height map, tool output (not tracked) | |

## Quick start

Tools: [mise](https://mise.jdx.dev) (installs Python and uv), Bun, and a
Rust toolchain with the `thumbv6m-none-eabi` target for the board. The
toolpath library pulls in `laser-sweep` from `../kicad-to-gcode`.

| Task | Does |
| --- | --- |
| `mise run web` | build the page and serve it with the backend at `http://localhost:8000` |
| `mise run virtual` | the virtual firmware at `socket://127.0.0.1:2323`, as the polar laser |
| `mise run virtual-mill` | the same as the cartesian spindle machine over a tilted board |
| `mise run flash` | build the board firmware and copy it to an SKR Pico in BOOTSEL mode |
| `mise run dev` | the page from Bun's dev server with live reload |
| `mise run test` | every suite; `test-firmware`, `test-toolpath`, `test-backend`, `test-frontend`, `test-sim` run one |

Connect the page to the board, or to the virtual firmware's socket, and
pick the machine in the Settings panel: a file in `machines/` describes
the axes, their scales and limits, the kinematics (polar or cartesian) and
the tool (laser or spindle), and loading it writes every firmware setting.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the parts, how they talk, where the files go
- [docs/OPERATING.md](docs/OPERATING.md): first moves, probing and the height map, cartesian and spindle
- [docs/MACHINES.md](docs/MACHINES.md): the machine configuration files
- [docs/CALIBRATION.md](docs/CALIBRATION.md): finding the rotation axis with the centering coupons
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the firmware's line protocol
- [docs/WEB_API.md](docs/WEB_API.md): the backend's API and events
- [docs/GCODE.md](docs/GCODE.md): the gcode toolchain and simulator for a grblHAL controller
- Per part: [firmware/README.md](firmware/README.md), [firmware/rp2040/README.md](firmware/rp2040/README.md) (pins, bring-up, safety), [web/backend/README.md](web/backend/README.md), [web/frontend/README.md](web/frontend/README.md), [toolpath/README.md](toolpath/README.md)

## Development

The Python packages share one `uv` workspace at the root: `uv sync` once,
then `uv run spinny-web`, `uv run spinny-iso ...` and `uv run pytest` from
anywhere in the repository. The backend's end to end tests run only when
`SPINNY_VIRTUAL` names a built virtual firmware, which `mise run
test-backend` builds and passes. The firmware crates are one Cargo
workspace in `firmware/` with the board port excluded, since it pins its
target; the simulator is its own crate in `sim/`.
