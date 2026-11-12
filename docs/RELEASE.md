# spinny release

A release is one archive per platform that runs with nothing installed:
it carries its own Python with every package the backend needs, the built
page, the programs the backend runs, and the firmware for the SKR Pico.

| Archive | For |
| --- | --- |
| `spinny-<version>-x86_64-linux.tar.gz` | a Linux PC |
| `spinny-<version>-aarch64-linux.tar.gz` | a Raspberry Pi with a 64-bit OS (Pi 3, 4, 5, Zero 2 W) |

Both need a Linux with glibc 2.28 or newer (Debian buster, Ubuntu 20.04,
any 64-bit Raspberry Pi OS); the `VERSION` file in an archive names the
floor its programs were measured at.

## Using a release

```sh
tar xzf spinny-<version>-<platform>.tar.gz
cd spinny-<version>-<platform>
bin/spinny-web
```

Then open `http://localhost:8000` (or the computer's name or address from
another one: the backend listens on every interface; `--host 127.0.0.1`
keeps it to this one). The account running it needs access to the serial
port: on most Linux systems `sudo usermod -aG dialout $USER`, then log in
again.

### What it does not carry

- KiCad. A `.kicad_pcb` upload is turned into gerbers by KiCad's
  `kicad-cli`, which has to be installed and on `PATH`; without it,
  upload the gerber and drill files exported from KiCad instead.
- The `claude` program, for the Auto tab's Claude Code provider.

### Where the files are

The first start makes a home directory, `~/.local/share/spinny` (or the
directory `SPINNY_HOME` names), with:

| Directory | Holds |
| --- | --- |
| `machines/` | machine files, edited on the Config tab |
| `cam/` | CAM profiles |
| `var/` | jobs, settings, the height map, logs |

`machines/` (a G-code pick and place machine's files among them) and
`cam/` start as copies of the ones the release
ships; once a directory exists it is yours and a later release leaves it
alone. To pick up the files of a newer release, delete or rename the
directory before starting it, or copy single files from
`python/lib/python3.12/site-packages/spinny_web/defaults/`.
`bin/spinny-web --help` lists options that point each directory
elsewhere.

Upgrading is unpacking the new archive and running its `bin/spinny-web`;
the home directory carries over.

### Firmware

Hold BOOTSEL on the SKR Pico while plugging it in (or while pressing
RESET), then copy `firmware/spinny-fw.uf2` onto the `RPI-RP2` drive that
appears. `firmware/spinny-fw.elf` is the same build with its symbols, for
reading a crash report's addresses.

### Without a machine

`bin/spinny-virtual` is the firmware on a TCP socket. Start it, then
connect the page to `socket://127.0.0.1:2323`:

```sh
bin/spinny-virtual --listen 127.0.0.1:2323 --fast
bin/spinny-virtual --machine ~/.local/share/spinny/machines/cartesian-mill.toml
```

`bin/spinny-virtual-pnp` is a LumenPnP pick and place machine the same
way: connect *Virtual LumenPnP* from the top bar (its machine file,
`virtual-pnp.toml`, is among the shipped ones) and give the cameras
`http://127.0.0.1:2328/snapshot` and `http://127.0.0.1:2329/snapshot`
([OPERATING.md](OPERATING.md#a-virtual-lumenpnp) in the repository).

### The other programs

| Program | Does |
| --- | --- |
| `bin/spinny-bridge` | serves a controller's serial port over TCP, for a backend on another computer |
| `bin/spinny-virtual-pnp` | a virtual LumenPnP: its Marlin on a TCP socket, its Photon feeders and its two cameras |
| `bin/spinny-mcp` | the backend's tools for Claude Code or another MCP client (only in archives built with `--extras mcp`) |
| `bin/spinny-carve` | the 3D kernel the CAM runs for STL models |
| `bin/pcbv` | the camera program (only in archives built beside pcb-vision) |

The command line twins of the page (`spinny-iso`, `spinny-polar`,
`spinny-center`, `spinny-cam`) and `spinny-jog` stay in a checkout: the
page does each of their jobs.

Each takes `--help`. The launchers put `bin/` first on `PATH`, so the
backend finds `spinny-carve` and `pcbv` beside them; a launcher linked
from elsewhere (`ln -s $PWD/bin/spinny-web ~/.local/bin/`) still works.

### Parts a plain release leaves out

The Auto tab's Anthropic provider needs the `anthropic` package, and its
Claude Code provider and `spinny-mcp` need `mcp`. A release built with
`--extras auto,mcp` has them; into one without them they install with
the release's own Python (this needs the internet):

```sh
python/bin/python3 -m pip install 'anthropic>=2' 'mcp>=2'
```

Such a release has no `bin/spinny-mcp`; `python/bin/python3 -I -m
spinny_web.mcp_server` is the same server.

## Building a release

```sh
mise run release                                          # every platform
mise run release -- --target aarch64-unknown-linux-gnu    # one platform
mise run release -- --extras auto,mcp                     # with the optional parts
```

The archives and a `SHA256SUMS` for them land in `dist/`. The build
needs what a checkout's own tasks need: uv, bun, cargo with the
`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` and
`thumbv6m-none-eabi` targets, `elf2uf2-rs`, the kicad-to-gcode repository
beside this one (pcb-vision beside it too for `pcbv`), and the internet
for cargo-zigbuild (run through uvx), the standalone Python
(python-build-standalone, checked against its published SHA256SUMS) and
the packages, at the versions in `uv.lock`.

- The version is the one in `web/backend/pyproject.toml`. When HEAD is
  not tagged `v<version>` the commit is added (`0.1.0-g4a67b63`).
- The source is the working tree. Uncommitted changes to anything that
  goes in are refused unless `--allow-dirty`, which adds `-dirty` to the
  name. `machines/` and `cam/` always come from HEAD, so local
  edits to them never ship.
- The Rust programs are release builds for each target, stripped, in
  `dist/build/cargo`, apart from a checkout's own builds. They are linked
  by cargo-zigbuild against glibc 2.28: a plain cargo build would ask for
  the build machine's newest glibc symbol versions (`fmod@GLIBC_2.38` from
  Ubuntu 24.04), which bookworm and Ubuntu 22.04 lack. The firmware is the
  same release build `mise run uf2` makes.
