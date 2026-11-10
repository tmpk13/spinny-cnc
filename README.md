# spinny-laser

A laser PCB machine with a rail over a rotary table: the head rides the
radius `R` on a rail that passes over the rotation axis of a harmonic
drive table, the angle `A`, that the board turns on. It runs its own
firmware on a BTT SKR Pico and is driven from a browser; an optional focus
axis `H` carries a touch probe, and the cross slide `Z` makes it an X/Y
machine with a spindle on the laser output or a solder paste dispenser's
plunger on the table's driver. A camera on the head, read through the
sibling [pcb-vision](https://github.com/tmpk13/pcb-vision) repository,
lines a job up with the board, and parts are placed with a nozzle on the
head or on another G-code machine.

- `mise run web`: build the page and serve it with the backend at `http://localhost:8000`
- `mise run dev`: the page from Bun's dev server with live reload
- `mise run virtual`: the virtual firmware at `socket://127.0.0.1:2323`, as the polar laser
- `mise run flash`: build the board firmware and copy it to an SKR Pico in BOOTSEL mode
- `mise run relay-pi -- pi@host`: forward a Pi's bridge to `socket://127.0.0.1:2324` here over ssh
- `mise run cam -- cam/mill-3axis.toml board.kicad_pcb`: a design through a CAM profile, gcode in `var/out/`
- `mise run mcp`: the backend's tools for Claude Code or another MCP client, none of which moves the machine ([setting one up](docs/OPERATING.md#the-tools-in-claude-code-or-another-mcp-client))
- `mise run test`: every suite
- `mise run release`: archives in `dist/` that run with nothing installed, one per platform ([using one](docs/RELEASE.md))

`mise tasks` lists the rest. Components: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Reference: [operating](docs/OPERATING.md), [machine files](docs/MACHINES.md),
[CAM](docs/CAM.md), [calibration](docs/CALIBRATION.md),
[protocol](docs/PROTOCOL.md), [web API](docs/WEB_API.md),
[gcode toolchain](docs/GCODE.md), [M2 Nano assessment](docs/M2_NANO.md),
[releases](docs/RELEASE.md).
