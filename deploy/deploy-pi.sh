#!/usr/bin/env bash
# Install on a Raspberry Pi the controller is plugged into, as a service.
#
#   deploy/deploy-pi.sh [--no-build] [--web] [--camera DEV ...] user@host [extra allowed host ...]
#
# Without --web the Pi is a bridge: `spinny-bridge` serves the controller's
# port on the Pi's loopback (socket://127.0.0.1:2324), one client at a
# time, and the backend and the page run here, connected through
# `mise run relay-pi -- user@host`, which forwards that port over ssh. The
# run lives here, so it ends if this machine does; the Pi needs only ssh,
# Python (from uv) and its user in dialout. A board that stops taking
# bytes is given up by the bridge with the reason told to the backend, and
# the next connect is served: nothing on the Pi needs a restart.
#
# With --web the Pi runs the whole thing: the backend and the built page as
# a service with its own link to the controller (--connect auto), so a job
# uploaded to the Pi's page at http://host.local:8000 streams from the Pi
# and the laptop that opened the page may go away. The page is built here
# (--no-build keeps the one in web/frontend/dist), so the Pi needs neither
# bun nor a compiler. The extra allowed hosts are names the Pi's page is
# reached by besides its own.
#
# The Pi needs a 64 bit OS, ssh access and passwordless sudo. The repository
# and its sibling kicad-to-gcode are copied to ~/spinny on the Pi (override
# with SPINNY_PI_DIR) and Python 3.12 comes from uv. The two services want
# the same port: installing one stops and disables the other, and the
# session relay (relay/relay-pi.sh) forwards to the bridge when it finds it.
#
# Cameras plugged into the Pi are read by pcbv from the sibling pcb-vision,
# copied along and built on the Pi with cargo (and libclang, for its V4L2
# bindings). With --web the backend there starts pcbv itself. As a bridge,
# each --camera (a device on the Pi, best a /dev/v4l/by-id name, which
# survives replugging) gets a unit serving `pcbv serve` on the Pi's
# loopback, the first on port 2325, the next on 2326 and so on; relay-pi
# forwards those ports too, and the camera panel here connects to
# socket://127.0.0.1:2325. Every deploy replaces the camera units with the
# ones named, so leaving --camera out removes them.
set -euo pipefail

usage() {
    echo "usage: $0 [--no-build] [--web] [--camera DEV ...] user@host [extra allowed host ...]" >&2
    exit 2
}

build=1
mode=bridge
cameras=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --no-build) build=0; shift ;;
        --web) mode=web; shift ;;
        --bridge) mode=bridge; shift ;;
        --camera) [[ $# -ge 2 ]] || usage; cameras+=("$2"); shift 2 ;;
        --) shift; break ;;
        -*) usage ;;
        *) break ;;
    esac
done
[[ $# -ge 1 ]] || usage
target=$1
shift
extra_hosts=("$@")
remote_dir=${SPINNY_PI_DIR:-spinny}
if [[ $mode == web && ${#cameras[@]} -gt 0 ]]; then
    echo "--camera is for the bridge: with --web the backend on the Pi opens its cameras itself" >&2
    exit 2
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sibling=$(cd "$here/../kicad-to-gcode" && pwd)
# pcb-vision is wanted only where a camera may be read on the Pi.
vision=0
if [[ $mode == web || ${#cameras[@]} -gt 0 ]]; then
    if [[ -d "$here/../pcb-vision" ]]; then
        vision=1
    elif [[ ${#cameras[@]} -gt 0 ]]; then
        echo "no pcb-vision next to this repository: the cameras need its pcbv" >&2
        exit 1
    fi
fi

if [[ $mode == web ]]; then
    if [[ $build == 1 ]]; then
        (cd "$here/web/frontend" && bun install --silent && bun run --silent build)
    fi
    if [[ ! -f "$here/web/frontend/dist/index.html" ]]; then
        echo "no built page in web/frontend/dist; run without --no-build" >&2
        exit 1
    fi
fi

ssh "$target" mkdir -p "$remote_dir/spinny-laser-pcb" "$remote_dir/kicad-to-gcode" "$remote_dir/pcb-vision"

# Virtual environments and build output are for this machine's architecture;
# the runtime files (jobs, the height map, the resume record) are the Pi's
# own and are left alone. The sibling is the toolpath package's dependency,
# so it goes along in both modes.
rsync -az --delete \
    --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' \
    --exclude 'node_modules/' --exclude 'var/' --exclude 'target/' \
    --exclude 'firmware/' --exclude 'sim/' --exclude '.claude/' \
    "$here/" "$target:$remote_dir/spinny-laser-pcb/"
rsync -az --delete \
    --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' \
    --exclude 'out/' --exclude '*.egg-info/' \
    "$sibling/" "$target:$remote_dir/kicad-to-gcode/"
# Its reference pictures and test boards are not needed to build pcbv.
if [[ $vision == 1 ]]; then
    rsync -az --delete \
        --exclude '.git/' --exclude 'target/' --exclude 'ref/' \
        --exclude 'fixtures/' --exclude '.claude/' \
        "$here/../pcb-vision/" "$target:$remote_dir/pcb-vision/"
fi

# The units are templates; the remote side fills in its own user, paths and
# host names, so a hostname or address the Pi answers to is always allowed.
scp -q "$here/deploy/spinny-web.service" "$here/deploy/spinny-bridge.service" \
    "$here/deploy/spinny-pcbv.service" "$target:/tmp/"

ssh "$target" bash -s -- "$remote_dir" "$mode" "$vision" "${#cameras[@]}" "${cameras[@]}" "${extra_hosts[@]}" <<'REMOTE'
set -euo pipefail
dir=$(cd "$1" && pwd)
mode=$2
vision=$3
cameras=("${@:5:$4}")
shift $((4 + $4))

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
uv python install 3.12
(cd "$dir/spinny-laser-pcb" && uv sync --no-dev --python 3.12)

# pcbv is built for the Pi on the Pi, in the dev profile (its dependencies
# fully optimized), where the backend's lookup finds it. The first build
# takes a while on a Pi; later ones only rebuild what changed.
pcbv="$dir/pcb-vision/target/debug/pcbv"
if [[ $vision == 1 ]]; then
    if ! command -v cargo >/dev/null; then
        echo "no cargo on the Pi: the cameras need pcbv, built with cargo in pcb-vision/" >&2
    elif ! compgen -G '/usr/lib/llvm-*/lib/libclang*.so*' >/dev/null \
        && ! compgen -G '/usr/lib/*/libclang*.so*' >/dev/null; then
        echo "no libclang on the Pi, which pcbv's V4L2 bindings are generated with: sudo apt install libclang-dev" >&2
    else
        (cd "$dir/pcb-vision" && cargo build -q -p pcbv) \
            || echo "pcbv did not build: the cameras will not run on the Pi" >&2
    fi
fi

# The CAM's 3D kernel is built for the Pi on the Pi; without Rust there the
# backend runs, and only an STL job says the kernel is missing.
if [[ $mode == web ]]; then
    if command -v cargo >/dev/null; then
        (cd "$dir/spinny-laser-pcb/carve" && cargo build -q) \
            || echo "the 3D kernel did not build: STL jobs will not run on the Pi" >&2
    else
        echo "no cargo on the Pi: STL jobs need the 3D kernel, built with cargo in carve/" >&2
    fi
fi

fill() {
    sed -e "s|@USER@|$USER|" -e "s|@DIR@|$dir|" -e "s|@UV@|$(command -v uv)|" -e "s|@ALLOWED@|$1|" "/tmp/$2.service" \
        | sudo tee "/etc/systemd/system/$2.service" >/dev/null
}
if [[ $mode == web ]]; then
    allowed=""
    for host in "$@" "$(hostname)" "$(hostname).local" localhost $(hostname -I); do
        allowed+=" --allowed-host $host"
    done
    fill "${allowed# }" spinny-web
    install=spinny-web
    remove=spinny-bridge
else
    fill "" spinny-bridge
    install=spinny-bridge
    remove=spinny-web
fi

# The camera units are the ones named this time, or none: a unit left from
# before would hold its camera, which the backend under --web wants too.
for unit in /etc/systemd/system/spinny-pcbv-*.service; do
    [[ -e $unit ]] || continue
    sudo systemctl disable --now "$(basename "$unit")" 2>/dev/null || true
    sudo rm -f "$unit"
done
ports=()
if [[ ${#cameras[@]} -gt 0 && ! -x $pcbv ]]; then
    echo "no pcbv built on the Pi: the camera units are not installed" >&2
elif [[ ${#cameras[@]} -gt 0 ]]; then
    for i in "${!cameras[@]}"; do
        port=$((2325 + i))
        sed -e "s|@USER@|$USER|" -e "s|@DIR@|$dir|" -e "s|@PORT@|$port|" -e "s|@CAMERA@|${cameras[$i]}|" \
            /tmp/spinny-pcbv.service | sudo tee "/etc/systemd/system/spinny-pcbv-$port.service" >/dev/null
        ports+=("$port")
    done
fi
rm -f /tmp/spinny-web.service /tmp/spinny-bridge.service /tmp/spinny-pcbv.service

# The board shows up as a serial device owned by dialout, a camera as one
# owned by video.
sudo usermod -aG dialout "$USER"
sudo usermod -aG video "$USER"
sudo systemctl daemon-reload
# The other service would hold the controller's port.
sudo systemctl disable --now "$remove.service" 2>/dev/null || true
sudo systemctl enable "$install.service"
sudo systemctl restart "$install.service"
for port in "${ports[@]}"; do
    sudo systemctl enable "spinny-pcbv-$port.service"
    sudo systemctl restart "spinny-pcbv-$port.service"
done
sleep 3
systemctl is-active "$install.service"
if [[ $mode == web ]]; then
    echo "http://$(hostname).local:8000"
else
    echo "the bridge serves the controller on the Pi's loopback port 2324:"
    echo "  mise run relay-pi -- $USER@$(hostname).local"
    echo "then connect the page here to socket://127.0.0.1:2324"
    for i in "${!ports[@]}"; do
        echo "camera ${cameras[$i]}: $(systemctl is-active "spinny-pcbv-${ports[$i]}.service" || true)," \
            "socket://127.0.0.1:${ports[$i]} here while relay-pi runs"
    done
fi
# The names to give --camera, or the camera device under --web.
if compgen -G '/dev/v4l/by-id/*' >/dev/null; then
    echo "cameras on the Pi:"
    ls -1 /dev/v4l/by-id/ | sed 's|^|  /dev/v4l/by-id/|'
fi
REMOTE
