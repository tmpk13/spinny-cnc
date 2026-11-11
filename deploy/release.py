#!/usr/bin/env python3
"""Builds the release archives, one per platform, that run with nothing
installed beyond a Linux with glibc:

    python3 deploy/release.py [--target TRIPLE ...] [--extras auto,mcp] [--allow-dirty]

Each `dist/spinny-<label>-<platform>.tar.gz` unpacks to one directory with
a standalone CPython 3.12 holding the locked packages, the built page and
the machine, CAM and pick and place files as committed (`python/`), the
launchers and the Rust programs built for the platform (`bin/`), and the
SKR Pico firmware (`firmware/`). docs/RELEASE.md, which goes in as the
README, tells how to use one.

The source is the working tree, so a tree with changes to anything that
goes in is refused unless --allow-dirty; the configuration files always
come from HEAD, never from the working tree's edits.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import tomllib
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIBLING = REPO.parent / "kicad-to-gcode"
VISION = REPO.parent / "pcb-vision"
DIST = REPO / "dist"
BUILD = DIST / "build"
CACHE = DIST / "cache"
PYTHON = "3.12"
# The oldest glibc the Rust programs are linked for, through cargo-zigbuild
# (zig's linker with that glibc's symbol versions). A plain cargo build
# links against the build machine's glibc and asks for its newest symbol
# versions (fmod@GLIBC_2.38 from glibc 2.39), which Raspberry Pi OS
# bookworm (2.36) and Ubuntu 22.04 (2.35) lack. 2.28 is Debian buster; the
# standalone Python and the manylinux wheels ask for at most 2.17.
GLIBC = "2.28"
# cargo-zigbuild and zig itself, run through uvx from PyPI for the build only.
ZIGBUILD = ["uvx", "--from", "cargo-zigbuild==0.24.1", "cargo-zigbuild"]
# What the downloads call themselves; see fetch().
USER_AGENT = "spinny-release"
# Paths whose uncommitted changes would go into an archive.
SOURCES = ["toolpath", "web", "carve", "firmware", "deploy", "docs/RELEASE.md", "pyproject.toml", "uv.lock"]
# Committed directories shipped inside spinny_web, which seeds a new home
# with them.
SHIPPED = ["machines", "cam", "pnp"]
# The packages whose [project.scripts] the launchers come from.
SCRIPTED = [REPO / "toolpath" / "pyproject.toml", REPO / "web" / "backend" / "pyproject.toml"]
# The scripts a release has launchers for: the backend, and the serial
# bridge for a computer beside the controller. The other scripts are
# command line twins of what the page does (isolation, polar conversion,
# centering, CAM to gcode) or setup aids for the grblHAL controller the
# machine no longer runs (spinny-jog), and stay checkout tools.
LAUNCHED = ("spinny-web", "spinny-bridge")
# Scripts launched only when the archive carries the extra they need.
LAUNCHED_WITH = {"spinny-mcp": "mcp"}
EXTRAS = ("auto", "mcp")


@dataclass(frozen=True)
class Target:
    triple: str
    # In the archive's name.
    platform: str
    # python-build-standalone's name of the machine in `uv python list`.
    arch: str


TARGETS = {
    t.triple: t
    for t in (
        Target("x86_64-unknown-linux-gnu", "x86_64-linux", "x86_64"),
        Target("aarch64-unknown-linux-gnu", "aarch64-linux", "aarch64"),
    )
}


# --- pure parts, tested in deploy/tests -----------------------------------------


def label(version: str, commit: str, tagged: bool, dirty: bool) -> str:
    """The release's name: the package version, the commit when HEAD is
    not tagged v<version>, and -dirty for a tree with changes."""
    name = version if tagged else f"{version}-g{commit}"
    return f"{name}-dirty" if dirty else name


def entry_points(pyproject: str) -> dict[str, str]:
    """The [project.scripts] of a pyproject.toml: name to `module:function`."""
    return dict(tomllib.loads(pyproject).get("project", {}).get("scripts", {}))


def launched(scripts: dict[str, str], extras: list[str]) -> dict[str, str]:
    """The scripts, name to `module:function`, that get a launcher in an
    archive with these extras. A launched name missing from the scripts
    stops the build, so a renamed entry point cannot drop silently."""
    wanted = [*LAUNCHED, *(name for name, extra in LAUNCHED_WITH.items() if extra in extras)]
    missing = [name for name in wanted if name not in scripts]
    if missing:
        raise SystemExit(f"no [project.scripts] entry for {', '.join(missing)}: update LAUNCHED in deploy/release.py")
    return {name: scripts[name] for name in wanted}


def launcher(name: str, target: str) -> str:
    """A POSIX shell launcher running `module:function` with the bundle's
    Python, isolated from the user's Python settings, with the bundle's
    bin/ first on PATH so the programs find spinny-carve and pcbv there."""
    module, function = target.split(":")
    code = f"import sys; sys.argv[0] = {name!r}; from {module} import {function}; sys.exit({function}())"
    return (
        "#!/bin/sh\n"
        f"# {name} from this release, run with its own Python.\n"
        'bin=$(dirname "$(readlink -f "$0")")\n'
        'PATH="$bin:$PATH"\n'
        "export PATH\n"
        f'exec "$bin/../python/bin/python3" -I -c "{code}" "$@"\n'
    )


def python_url(listing: str, arch: str, version: str = PYTHON) -> str:
    """The newest CPython <version> build for <arch> Linux with glibc in the
    output of `uv python list --all-platforms --all-arches --show-urls`."""
    pattern = re.compile(rf"^cpython-{re.escape(version)}\.\d+-linux-{re.escape(arch)}-gnu\s+(https://\S+)$")
    for line in listing.splitlines():
        found = pattern.match(line.strip())
        if found:
            return found.group(1)
    raise SystemExit(f"uv knows no CPython {version} for {arch} Linux: update uv")


def glibc_floor(binaries: list[bytes]) -> tuple[int, int] | None:
    """The newest glibc symbol version any of the binaries asks for, as
    (major, minor), or None when none asks for one."""
    found = [(int(a), int(b)) for data in binaries for a, b in re.findall(rb"GLIBC_(\d+)\.(\d+)", data)]
    return max(found) if found else None


def requirements(exported: str) -> str:
    """`uv export` output with the lines pip cannot take from a file built
    elsewhere (editable paths) dropped."""
    return "".join(line + "\n" for line in exported.splitlines() if not line.startswith("-e "))


# --- the build --------------------------------------------------------------------


def run(cmd: Sequence[str | Path], cwd: Path = REPO, env: dict[str, str] | None = None, capture: bool = False) -> str:
    print("+", " ".join(str(part) for part in cmd), flush=True)
    done = subprocess.run(
        [str(part) for part in cmd],
        cwd=cwd,
        env={**os.environ, **(env or {})},
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return done.stdout or ""


def git(*args: str) -> str:
    return run(["git", *args], capture=True).strip()


def fresh(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def fetch(url: str, path: Path, tries: int = 4) -> Path:
    """The file at url saved to path unless it is there already. Astral's
    mirror of the python-build-standalone releases (the host newer uv
    versions list) refuses urllib's own User-Agent with 403, so the
    request names this script instead; GitHub's release downloads now and
    then answer 403 or drop the connection, so a failed try is retried
    after a pause."""
    if path.is_file():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {path.name}", flush=True)
    partial = path.with_name(path.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(request) as answer, partial.open("wb") as out:
                shutil.copyfileobj(answer, out)
            break
        except OSError as exc:
            if attempt == tries:
                raise SystemExit(f"{url}: {exc}") from exc
            print(f"{path.name}: {exc}; trying again", file=sys.stderr, flush=True)
            time.sleep(5 * attempt)
    partial.rename(path)
    return path


def download(url: str) -> Path:
    """The file at url, from the cache when there, checked against the
    SHA256SUMS published beside it (cached too, per release)."""
    folder, _, quoted = url.rpartition("/")
    name = urllib.parse.unquote(quoted)
    path = fetch(url, CACHE / name)
    sums = fetch(f"{folder}/SHA256SUMS", CACHE / f"SHA256SUMS-{folder.rsplit('/', 1)[1]}").read_text()
    expected = next((line.split()[0] for line in sums.splitlines() if line.split()[-1:] == [name]), None)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected != actual:
        path.unlink()
        raise SystemExit(f"{name}: sha256 {actual} is not the published {expected}")
    return path


def build_page() -> Path:
    page = REPO / "web" / "frontend"
    run(["bun", "install", "--silent"], cwd=page)
    run(["bun", "run", "--silent", "build"], cwd=page)
    return page / "dist"


def build_wheels() -> list[Path]:
    out = fresh(BUILD / "wheels")
    run(["uv", "build", "--wheel", "--package", "spinny-laser", "-o", out])
    run(["uv", "build", "--wheel", "--package", "spinny-web", "-o", out])
    run(["uv", "build", "--wheel", SIBLING, "-o", out])
    return sorted(out.glob("*.whl"))


def export_requirements(extras: list[str]) -> Path:
    cmd = ["uv", "export", "--locked", "--no-dev", "--no-hashes", "--package", "spinny-web", "--no-emit-workspace"]
    cmd += ["--no-emit-package", "laser-sweep", "--no-header"]
    for extra in extras:
        cmd += ["--extra", extra]
    path = BUILD / "requirements.txt"
    path.write_text(requirements(run(cmd, capture=True)))
    return path


def build_firmware() -> Path:
    out = fresh(BUILD / "firmware")
    run(["cargo", "build", "-q", "--release"], cwd=REPO / "firmware" / "rp2040")
    elf = REPO / "firmware" / "rp2040" / "target" / "thumbv6m-none-eabi" / "release" / "spinny-fw"
    run(["elf2uf2-rs", elf, out / "spinny-fw.uf2"])
    shutil.copy2(elf, out / "spinny-fw.elf")
    return out


def export_shipped() -> Path:
    """machines/, cam/ and pnp/ as committed."""
    out = fresh(BUILD / "shipped")
    archive = subprocess.run(["git", "archive", "--format=tar", "HEAD", *SHIPPED], cwd=REPO, check=True, capture_output=True)
    tar_path = BUILD / "shipped.tar"
    tar_path.write_bytes(archive.stdout)
    with tarfile.open(tar_path) as tar:
        tar.extractall(out, filter="data")
    tar_path.unlink()
    return out


def build_programs(target: Target) -> list[Path]:
    """spinny-carve, spinny-virtual and, when pcb-vision is beside this
    repository and builds, pcbv: release builds for the target and GLIBC,
    stripped."""
    env = {"CARGO_PROFILE_RELEASE_STRIP": "symbols"}
    common = [*ZIGBUILD, "build", "-q", "--release", "--target", f"{target.triple}.{GLIBC}", "--target-dir", BUILD / "cargo"]
    out = BUILD / "cargo" / target.triple / "release"
    run([*common, "--manifest-path", REPO / "carve" / "Cargo.toml", "--bin", "spinny-carve"], env=env)
    run([*common, "--manifest-path", REPO / "firmware" / "Cargo.toml", "-p", "spinny-virtual"], env=env)
    programs = [out / "spinny-carve", out / "spinny-virtual"]
    if (VISION / "Cargo.toml").is_file():
        try:
            run([*common, "--manifest-path", VISION / "Cargo.toml", "-p", "pcbv"], env=env)
            programs.append(out / "pcbv")
        except subprocess.CalledProcessError:
            print(f"pcbv did not build for {target.triple}: this archive has no camera program", file=sys.stderr)
    else:
        print("no pcb-vision beside this repository: this archive has no camera program", file=sys.stderr)
    return programs


def bundle(
    target: Target,
    name: str,
    wheels: list[Path],
    reqs: Path,
    page: Path,
    shipped: Path,
    firmware: Path,
    extras: list[str],
    stamp: dict[str, str],
) -> Path:
    root = fresh(BUILD / "stage" / target.triple) / name
    listing = run(["uv", "python", "list", PYTHON, "--all-platforms", "--all-arches", "--show-urls", "--only-downloads"], capture=True)
    url = python_url(listing, target.arch)
    with tarfile.open(download(url)) as tar:
        tar.extractall(root, filter="data")
    site = root / "python" / "lib" / f"python{PYTHON}" / "site-packages"
    if not site.is_dir():
        raise SystemExit(f"{url} has no {site.relative_to(root)}")
    install = ["uv", "pip", "install", "--target", site, "--python-platform", target.triple, "--python-version", PYTHON]
    install += ["--only-binary", ":all:", "--no-deps", "--link-mode", "copy", "--compile-bytecode"]
    run([*install, "-r", reqs, *wheels])

    shutil.copytree(page, site / "spinny_web" / "page")
    shutil.copytree(shipped, site / "spinny_web" / "defaults")

    bin_dir = root / "bin"
    bin_dir.mkdir()
    scripts = {}
    for path in SCRIPTED:
        scripts.update(entry_points(path.read_text()))
    for script, entry in launched(scripts, extras).items():
        launch = bin_dir / script
        launch.write_text(launcher(script, entry))
        launch.chmod(0o755)
    programs = build_programs(target)
    for program in programs:
        shutil.copy2(program, bin_dir / program.name)
    shutil.copytree(firmware, root / "firmware")
    shutil.copy2(REPO / "docs" / "RELEASE.md", root / "README.md")

    floor = glibc_floor([program.read_bytes() for program in programs])
    lines = {
        **stamp,
        "target": target.triple,
        "python": urllib.parse.unquote(url.rsplit("/", 1)[1]).split("-")[1],
        "glibc": f"{floor[0]}.{floor[1]} or newer" if floor else "any",
        "programs": " ".join(sorted(program.name for program in programs)),
    }
    (root / "VERSION").write_text("".join(f"{key}: {value}\n" for key, value in lines.items()))

    archive = DIST / f"{name}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(root, arcname=name)
    print(f"{archive.relative_to(REPO)}: {archive.stat().st_size / 1e6:.0f} MB, glibc {lines['glibc']}", flush=True)
    return archive


def write_sums(archives: list[Path]) -> None:
    """dist/SHA256SUMS with a line per archive, the ones just built replacing
    their earlier lines."""
    path = DIST / "SHA256SUMS"
    kept = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            digest, _, file = line.partition("  ")
            if (DIST / file).is_file():
                kept[file] = digest
    for archive in archives:
        kept[archive.name] = hashlib.sha256(archive.read_bytes()).hexdigest()
    path.write_text("".join(f"{digest}  {file}\n" for file, digest in sorted(kept.items())))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="release", description="Build the release archives in dist/, one per platform.")
    parser.add_argument(
        "--target",
        action="append",
        choices=sorted(TARGETS),
        help="a platform to build for; repeatable (default: all of them)",
    )
    parser.add_argument(
        "--extras",
        default="",
        help=f"comma separated spinny-web extras to put in ({', '.join(EXTRAS)}); a plain release leaves them out",
    )
    parser.add_argument("--allow-dirty", action="store_true", help="build from a working tree with uncommitted changes")
    args = parser.parse_args(argv)
    extras = [extra for extra in args.extras.split(",") if extra]
    unknown = sorted(set(extras) - set(EXTRAS))
    if unknown:
        parser.error(f"no such extra: {', '.join(unknown)}")

    dirty = bool(git("status", "--porcelain", "--", *SOURCES))
    if dirty and not args.allow_dirty:
        raise SystemExit("uncommitted changes in what goes into a release (git status -- " + " ".join(SOURCES) + "): commit them, or pass --allow-dirty")
    version = tomllib.loads((REPO / "web" / "backend" / "pyproject.toml").read_text())["project"]["version"]
    commit = git("rev-parse", "--short", "HEAD")
    tagged = f"v{version}" in git("tag", "--points-at", "HEAD").split()
    name = label(version, commit, tagged, dirty)
    sibling = run(["git", "-C", SIBLING, "rev-parse", "--short", "HEAD"], capture=True).strip()
    stamp = {
        "spinny": name,
        "commit": git("rev-parse", "HEAD"),
        "kicad-to-gcode": sibling,
        "extras": ",".join(extras) or "none",
        "built": date.today().isoformat(),
    }

    DIST.mkdir(exist_ok=True)
    page = build_page()
    wheels = build_wheels()
    reqs = export_requirements(extras)
    shipped = export_shipped()
    firmware = build_firmware()
    archives = []
    for triple in args.target or sorted(TARGETS):
        target = TARGETS[triple]
        archives.append(bundle(target, f"spinny-{name}-{target.platform}", wheels, reqs, page, shipped, firmware, extras, stamp))
    write_sums(archives)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
