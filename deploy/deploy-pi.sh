#!/usr/bin/env bash
# Install on a Raspberry Pi the controller is plugged into, as a service.
#
#   deploy/deploy-pi.sh [--no-build] [--web] [--camera DEV[@WxH[@FPS]] ...] user@host [extra allowed host ...]
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
# Cameras plugged into a bridge Pi are only streamed there: each --camera
# (a device on the Pi, best a /dev/v4l/by-id name, which survives
# replugging; 1280x720 at 30 fps unless given) gets a unit running
# ustreamer (from apt) on the Pi's loopback, passing the camera's own
# MJPEG through undecoded, the first on port 2325, the next on 2326 and so
# on. relay-pi forwards those ports too, and the camera device here is
# http://127.0.0.1:2325/snapshot: pcbv runs here and asks for one picture
# at a time, at most the camera settings' fps a second, so a slow WiFi
# link lowers the frame rate rather than queueing seconds of frames as
# the pushed /stream does. Every deploy
# replaces the camera units with the ones named, so leaving --camera out
# removes them. With --web the backend on the Pi runs pcbv itself on the
# Pi's cameras; pcbv is cross built here for it (aarch64-linux-gnu-gcc and
# the aarch64-unknown-linux-gnu Rust target), as a small Pi cannot build
# it, and installed as /usr/local/bin/pcbv.
set -euo pipefail

usage() {
    echo "usage: $0 [--no-build] [--web] [--camera DEV[@WxH[@FPS]] ...] user@host [extra allowed host ...]" >&2
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
        --camera)
            [[ $# -ge 2 ]] || usage
            IFS=@ read -r device size fps <<<"$2"
            size=${size:-1280x720}
            fps=${fps:-30}
            if [[ -z $device || ! $size =~ ^[0-9]+x[0-9]+$ || ! $fps =~ ^[0-9]+$ ]]; then
                echo "--camera takes DEV, DEV@WIDTHxHEIGHT or DEV@WIDTHxHEIGHT@FPS, not $2" >&2
                exit 2
            fi
            cameras+=("$device@$size@$fps")
            shift 2 ;;
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
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

if [[ $mode == web ]]; then
    if [[ $build == 1 ]]; then
        (cd "$here/web/frontend" && bun install --silent && bun run --silent build)
    fi
    if [[ ! -f "$here/web/frontend/dist/index.html" ]]; then
        echo "no built page in web/frontend/dist; run without --no-build" >&2
        exit 1
    fi
    # pcbv for the Pi, in the dev profile (its dependencies fully
    # optimized), stripped of its debug info to a size worth copying.
    vision="$here/../pcb-vision"
    cross="$vision/target/aarch64-unknown-linux-gnu/debug/pcbv"
    built=0
    if [[ ! -d $vision ]]; then
        echo "no pcb-vision next to this repository: the Pi's cameras will not run" >&2
    elif [[ $build == 1 ]]; then
        if command -v aarch64-linux-gnu-gcc >/dev/null \
            && rustup target list --installed 2>/dev/null | grep -qx aarch64-unknown-linux-gnu; then
            if CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
                cargo build -q -p pcbv --target aarch64-unknown-linux-gnu --manifest-path "$vision/Cargo.toml"; then
                built=1
            else
                echo "pcbv did not build for the Pi: its cameras will not run" >&2
            fi
        else
            echo "pcbv for the Pi needs aarch64-linux-gnu-gcc and rustup target add aarch64-unknown-linux-gnu here" >&2
        fi
    fi
    # Only the pcbv built now goes, or with --no-build the one there: one
    # left by an earlier build may lack what the backend now asks of it.
    if [[ -x $cross ]] && [[ $built == 1 || $build == 0 ]]; then
        if command -v aarch64-linux-gnu-strip >/dev/null; then
            aarch64-linux-gnu-strip -o "$staging/pcbv" "$cross"
        else
            echo "no aarch64-linux-gnu-strip here to make pcbv small enough to copy: the Pi's cameras will not run" >&2
        fi
    fi
fi

ssh "$target" mkdir -p "$remote_dir/spinny-laser-pcb" "$remote_dir/kicad-to-gcode"

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

# The units are templates; the remote side fills in its own user, paths and
# host names, so a hostname or address the Pi answers to is always allowed.
cp "$here/deploy/spinny-web.service" "$here/deploy/spinny-bridge.service" \
    "$here/deploy/spinny-camera.service" "$staging/"
scp -q "$staging"/* "$target:/tmp/"

ssh "$target" bash -s -- "$remote_dir" "$mode" "${#cameras[@]}" "${cameras[@]}" "${extra_hosts[@]}" <<'REMOTE'
set -euo pipefail
dir=$(cd "$1" && pwd)
mode=$2
cameras=("${@:4:$3}")
shift $((3 + $3))

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
uv python install 3.12
(cd "$dir/spinny-laser-pcb" && uv sync --no-dev --python 3.12)

# pcbv built here links against this machine's glibc, so a Pi with an
# older one cannot run it: tried before it replaces the one installed.
if [[ -f /tmp/pcbv ]]; then
    chmod +x /tmp/pcbv
    if /tmp/pcbv --help >/dev/null 2>&1; then
        sudo install -m 755 /tmp/pcbv /usr/local/bin/pcbv
    else
        echo "pcbv built for the Pi does not run there ($(/tmp/pcbv --help 2>&1 | head -n 1)): its cameras will not run" >&2
    fi
    rm -f /tmp/pcbv
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
# spinny-pcbv-* are an earlier kind, pcbv itself served on the Pi.
for unit in /etc/systemd/system/spinny-camera-*.service /etc/systemd/system/spinny-pcbv-*.service; do
    [[ -e $unit ]] || continue
    sudo systemctl disable --now "$(basename "$unit")" 2>/dev/null || true
    sudo rm -f "$unit"
done
# A value for the right side of a sed s|||: & and | and \ taken literally.
literal() {
    local v=${1//\\/\\\\}
    v=${v//&/\\&}
    printf '%s' "${v//|/\\|}"
}
ports=()
if [[ ${#cameras[@]} -gt 0 ]]; then
    if ! command -v ustreamer >/dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        sudo -E apt-get install -y -qq ustreamer >/dev/null \
            || { sudo apt-get update -qq && sudo -E apt-get install -y -qq ustreamer >/dev/null; }
    fi
    ustreamer=$(command -v ustreamer)
    # Older ustreamer names the camera's MJPEG JPEG; newer has MJPEG too.
    format=JPEG
    if "$ustreamer" --help 2>&1 | grep -q MJPEG; then
        format=MJPEG
    fi
    for i in "${!cameras[@]}"; do
        port=$((2325 + i))
        IFS=@ read -r device size fps <<<"${cameras[$i]}"
        sed -e "s|@USER@|$USER|" -e "s|@USTREAMER@|$ustreamer|" -e "s|@PORT@|$port|" \
            -e "s|@CAMERA@|$(literal "$device")|" -e "s|@FORMAT@|$format|" \
            -e "s|@SIZE@|$size|" -e "s|@FPS@|$fps|" \
            /tmp/spinny-camera.service | sudo tee "/etc/systemd/system/spinny-camera-$port.service" >/dev/null
        ports+=("$port")
    done
fi
rm -f /tmp/spinny-web.service /tmp/spinny-bridge.service /tmp/spinny-camera.service

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
    sudo systemctl enable "spinny-camera-$port.service"
    sudo systemctl restart "spinny-camera-$port.service"
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
        echo "camera ${cameras[$i]}: $(systemctl is-active "spinny-camera-${ports[$i]}.service" || true)," \
            "http://127.0.0.1:${ports[$i]}/snapshot here while relay-pi runs"
    done
fi
# The names to give --camera, or the camera device under --web.
if compgen -G '/dev/v4l/by-id/*' >/dev/null; then
    echo "cameras on the Pi:"
    ls -1 /dev/v4l/by-id/ | sed 's|^|  /dev/v4l/by-id/|'
fi
REMOTE
