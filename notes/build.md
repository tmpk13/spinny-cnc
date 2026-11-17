# Repository, simulator and tests

## Reusing the Cartesian tool

`laser-sweep` in `../kicad-to-gcode` is a `[tool.uv.sources]` path dependency,
editable, rather than a copy. Gerber parsing, Clipper offsets, island and
bridge finding and the kicad-cli export are all unchanged by the kinematics,
so copying 1700 lines would only fork them. The price is that this repo does
not build without its sibling checked out next to it.

## Simulator

macroquad, Y up. Board `(x, y)` sits at world `(x, 0, -y)` before the table
turns; the table is turned by `beta = -A` counterclockwise from above, so the
board point at angle `A` lands on the `+X` rail. Trail, copper and outline
are stored in board coordinates and turned each frame, which keeps the
kinematics in one function.

Joint-space moves are drawn as chords every two degrees, since a long
tangential move is an arc on the board.

`get_screen_data()` after `next_frame().await` returns a black image: the
buffers have swapped. Capture before ending the frame, and not on the first
couple of frames, when the window may not have its final size.

`mouse_delta_position()` is already normalised to screen size, so the orbit
gains are unitless.

## Tests

The replay helper in `tests/polar_sim.py` interpolates every cut in joint
space, maps it back to the board and measures the distance to the intended
polyline, which is the property the whole tool exists for. Checking every
mark against every loop was 37 s on the fixture; filtering candidate loops by
bounding box first brought it to a second. The tolerance in the assertions is
the chord tolerance plus two coordinate quanta.

## Reorganization (2026-10-03)

The root was a Python package and the monorepo root at once, with a second
Python project under web/backend keeping its own venv and lock, runtime
files beside the sources, and a pixi lock from a one-day experiment. Now
the root pyproject is a virtual uv workspace (members toolpath and
web/backend): one .venv, one uv.lock, `uv run` from anywhere. Choices:

- `--import-mode=importlib` at the root, because both suites have a
  `test_center.py` and pytest's default mode refuses two test modules of
  one basename. Each suite's conftest puts its helper dir on sys.path,
  since importlib mode does not.
- `python-preference = "system"` moved to the root, so the workspace runs
  on the backend's established 3.12. The toolpath suite had been running
  on a managed 3.14, where argparse takes `-10,0` as a positional; on 3.12
  it is an option, so spinny-jog now marks coordinate-shaped arguments
  with a leading space before parsing.
- Runtime files under var/ (one ignored directory) rather than next to
  the sources; the backend's defaults come from the repo layout
  (`REPO_ROOT = parents[4]` of app.py), as the frontend dist already did.
- pixi removed: the mise tasks and both pyprojects used uv, the pixi
  config had no tools and only a frontend build task, and the lock had
  never been committed. To bring it back: `[tool.pixi.workspace]` with
  channels conda-forge and platform linux-64, `[tool.pixi.pypi-dependencies]`
  with the local packages editable, and `pixi.lock merge=binary` in
  .gitattributes.

## Firmware in its own repository (2026-11-16)

The user asked for the firmware to be its own repository. It is
`spinny-firmware`, checked out beside this one like kicad-to-gcode and
pcb-vision; its history came along with `git subtree split --prefix=firmware`
(55 commits), and `docs/PROTOCOL.md`, `notes/firmware.md` and
`notes/board.md` went with it. Choices:

- A sibling checkout, not a submodule or a cargo git dependency: the host
  needs a built program (`spinny-virtual`) and the board's uf2, not a
  library, and the other siblings already work this way.
- The host still uses it in four places, each naming `../spinny-firmware`:
  the `virtual*` and `build-virtual` tasks (`cargo --manifest-path`),
  `test-backend` (`SPINNY_VIRTUAL=../spinny-firmware/target/debug/spinny-virtual`),
  `flash` and `relay/load-uf2.sh` (`mise -C ../spinny-firmware run ...`;
  load-uf2 takes `SPINNY_FIRMWARE` for another checkout), and
  `deploy/release.py`, which builds the uf2 and `spinny-virtual` from it,
  stamps its commit into the archive and refuses a dirty firmware checkout
  like a dirty host one.
- `mise run test` here no longer runs the firmware's own tests; the end to
  end tests still drive it. Its tests: `mise -C ../spinny-firmware run test`.
- The virtual firmware's unit tests read seven shipped machine files; they
  are copies in its `virtual/tests/machines/` now. The cross-check of the
  current files is `test_machines.py`'s end to end test, which starts the
  virtual firmware with each and compares what the backend reads.
- An agent worktree under `.claude/worktrees/` needs a `spinny-firmware`
  symlink beside it, as it does for kicad-to-gcode.
- Links to the firmware's documents point at
  `https://github.com/tmpk13/spinny-firmware`, the origin set in the new
  checkout; nothing has been pushed there.

## load-uf2 over ssh (2026-10-27)

mise passes the `--` arguments only to the task named, never to its `depends`, so a task that depends on `scp-uf2` cannot hand it the host. `load-uf2` builds the uf2 itself (since 2026-11-16 the script runs `mise -C ../spinny-firmware run uf2`, as the firmware has its own repository) and streams the file: `ssh host 'cat > /mnt/pico/spinny-fw.uf2 && sync'`. That works without root only because the udev rule mounts the BOOTSEL drive with `umask=000`.

## Updates from GitHub (2026-11-12)

- An update unpacks the new release beside the running one and points a
  link `spinny` (in the same directory) at it with symlink + os.replace;
  `spinny.previous` names the one replaced. Not an in-place directory
  swap: a running backend loads modules lazily from its sys.path, and a
  swapped directory would mix the new code into the old process. The
  launcher resolves its own path (readlink -f), so a backend started from
  the link runs from the versioned directory and a later switch never
  changes code under it. Cost: after the first update the user must start
  from `<dir>/spinny/bin/spinny-web` (the panel and the CLI say so).
- release.py's VERSION now has `platform: x86_64-linux`; older archives
  are mapped from `target:`.
- Version order: numbers first; the same numbers with another suffix
  (`0.2.0-g4a67b63` vs tag `v0.2.0`) is "other" and offered (the tagged
  release replaces an untagged build).
- SHA256SUMS comes from the same release: integrity, not authenticity.
- A second update before the restart is refused (the target exists and
  the running version still reads older).
- SPINNY_UPDATE_URL points the check elsewhere (tests use a local fake).

## Pre-releases (2026-11-13, an agent's, 9f6e9b1)

- releases/latest never returns a pre-release. Following them, the check
  asks the release list (the latest address without `/latest`, plus
  `?per_page=100`; SPINNY_UPDATE_URL likewise) and takes the newest by
  version among releases carrying this platform's archive and SHA256SUMS,
  drafts skipped.
- Version order: numbers first; for equal numbers a pre-release word
  (dev, a, alpha, b, beta, c, rc, pre, preview, a whole word) sorts before
  the release, and post after it; the rest compares naturally (rc2 <
  rc10). compare() strips release.py's build suffix (-g<hash>, -dirty)
  first, so an untagged build is "other" to its release while rc1 to rc2
  is "newer".
- Config key `update_prereleases` (PUT /api/update/settings); a change
  forgets the last check. `--pre` applies to one call and is refused
  without --check-update or --update.
