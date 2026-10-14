#!/usr/bin/env bash
# Install on a Raspberry Pi the controller is plugged into, as a service.
#
#   deploy/deploy-pi.sh [--no-build] [--web] user@host [extra allowed host ...]
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
set -euo pipefail

usage() {
    echo "usage: $0 [--no-build] [--web] user@host [extra allowed host ...]" >&2
    exit 2
}

build=1
mode=bridge
while [[ $# -gt 0 ]]; do
    case $1 in
        --no-build) build=0; shift ;;
        --web) mode=web; shift ;;
        --bridge) mode=bridge; shift ;;
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

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sibling=$(cd "$here/../kicad-to-gcode" && pwd)

if [[ $mode == web ]]; then
    if [[ $build == 1 ]]; then
        (cd "$here/web/frontend" && bun install --silent && bun run --silent build)
    fi
    if [[ ! -f "$here/web/frontend/dist/index.html" ]]; then
        echo "no built page in web/frontend/dist; run without --no-build" >&2
        exit 1
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
scp -q "$here/deploy/spinny-web.service" "$here/deploy/spinny-bridge.service" "$target:/tmp/"

ssh "$target" bash -s -- "$remote_dir" "$mode" "${extra_hosts[@]}" <<'REMOTE'
set -euo pipefail
dir=$(cd "$1" && pwd)
mode=$2
shift 2

export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
uv python install 3.12
(cd "$dir/spinny-laser-pcb" && uv sync --no-dev --python 3.12)

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
rm -f /tmp/spinny-web.service /tmp/spinny-bridge.service

# The board shows up as a serial device owned by dialout.
sudo usermod -aG dialout "$USER"
sudo systemctl daemon-reload
# The other service would hold the controller's port.
sudo systemctl disable --now "$remove.service" 2>/dev/null || true
sudo systemctl enable "$install.service"
sudo systemctl restart "$install.service"
sleep 3
systemctl is-active "$install.service"
if [[ $mode == web ]]; then
    echo "http://$(hostname).local:8000"
else
    echo "the bridge serves the controller on the Pi's loopback port 2324:"
    echo "  mise run relay-pi -- $USER@$(hostname).local"
    echo "then connect the page here to socket://127.0.0.1:2324"
fi
REMOTE
