#!/usr/bin/env bash
# Install the web backend and the built page on a Raspberry Pi and run them
# there as a service, so the Pi drives the controller on its own: a job is
# uploaded to the Pi's page and streamed from the Pi, and the laptop that
# opened the page may go away. The backend keeps its own link to the
# controller up (--connect auto), so a run survives the page closing and a
# controller that is replugged comes back by itself.
#
#   deploy/deploy-pi.sh [--no-build] user@host [extra allowed host ...]
#
# The Pi needs a 64 bit OS, ssh access and passwordless sudo. The repository
# and its sibling kicad-to-gcode are copied to ~/spinny on the Pi (override
# with SPINNY_PI_DIR), Python 3.12 comes from uv, and the page is built here
# so the Pi needs neither bun nor a compiler. The relay (relay/relay-pi.sh)
# and this service both want the controller's port: stop the relay before
# starting the service, or the Pi's backend finds the port busy.
set -euo pipefail

build=1
if [[ "${1:-}" == "--no-build" ]]; then
    build=0
    shift
fi
if [[ $# -lt 1 ]]; then
    echo "usage: $0 [--no-build] user@host [extra allowed host ...]" >&2
    exit 2
fi
target=$1
shift
extra_hosts=("$@")
remote_dir=${SPINNY_PI_DIR:-spinny}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sibling=$(cd "$here/../kicad-to-gcode" && pwd)

if [[ $build == 1 ]]; then
    (cd "$here/web/frontend" && bun install --silent && bun run --silent build)
fi
if [[ ! -f "$here/web/frontend/dist/index.html" ]]; then
    echo "no built page in web/frontend/dist; run without --no-build" >&2
    exit 1
fi

ssh "$target" mkdir -p "$remote_dir/spinny-laser-pcb" "$remote_dir/kicad-to-gcode"

# Virtual environments and build output are for this machine's architecture;
# the runtime files (jobs, the height map, the resume record) are the Pi's
# own and are left alone.
rsync -az --delete \
    --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' \
    --exclude 'node_modules/' --exclude 'var/' --exclude 'target/' \
    --exclude 'firmware/' --exclude 'sim/' --exclude '.claude/' \
    "$here/" "$target:$remote_dir/spinny-laser-pcb/"
rsync -az --delete \
    --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' \
    --exclude 'out/' --exclude '*.egg-info/' \
    "$sibling/" "$target:$remote_dir/kicad-to-gcode/"

# The unit is a template; the remote side fills in its own user, paths and host
# names, so a hostname or address the Pi answers to is always allowed.
scp -q "$here/deploy/spinny-web.service" "$target:/tmp/spinny-web.service.in"

ssh "$target" bash -s -- "$remote_dir" "${extra_hosts[@]}" <<'REMOTE'
set -euo pipefail
dir=$(cd "$1" && pwd)
shift

export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
uv python install 3.12
(cd "$dir/spinny-laser-pcb" && uv sync --no-dev --python 3.12)

allowed=""
for host in "$@" "$(hostname)" "$(hostname).local" localhost $(hostname -I); do
    allowed+=" --allowed-host $host"
done
sed -e "s|@USER@|$USER|" -e "s|@DIR@|$dir|" -e "s|@UV@|$(command -v uv)|" \
    -e "s|@ALLOWED@|${allowed# }|" /tmp/spinny-web.service.in \
    | sudo tee /etc/systemd/system/spinny-web.service >/dev/null
rm -f /tmp/spinny-web.service.in

# The board shows up as a serial device owned by dialout.
sudo usermod -aG dialout "$USER"
sudo systemctl daemon-reload
sudo systemctl enable spinny-web.service
sudo systemctl restart spinny-web.service
sleep 3
systemctl is-active spinny-web.service
echo "http://$(hostname).local:8000"
REMOTE
