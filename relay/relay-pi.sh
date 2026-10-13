#!/usr/bin/env bash
# Forwards the spinny controller plugged into a Raspberry Pi to this computer.
#
#   relay/relay-pi.sh user@host [port]
#
# then connect the page to socket://127.0.0.1:<port> (default 2324). The Pi
# needs ssh, socat and its user in the dialout group; nothing is installed.
# Ctrl-C ends the relay.
#
# socat on the Pi listens on its loopback only and ssh carries that port
# here, so the machine is reachable only through the ssh login. One client
# at a time; the device is opened per connection, so a controller that
# reset or was replugged between connections is found again. A listener
# already on that port of the Pi is reused rather than replaced.
set -euo pipefail

host=${1:?usage: relay-pi.sh user@host [port]}
port=${2:-2324}
# A device path on the Pi; empty picks the controller by its USB name.
device=${SPINNY_DEVICE:-}

remote=$(cat <<EOF
set -e
command -v socat >/dev/null || { echo "socat is missing on the Pi: sudo apt install socat" >&2; exit 1; }
if ss -Hltn "sport = :$port" | grep -q .; then
    echo "a relay already listens on port $port on the Pi; forwarding to it" >&2
    exec sleep infinity
fi
dev='$device'
[ -n "\$dev" ] || dev=\$(ls /dev/serial/by-id/usb-spinny_* 2>/dev/null | head -n 1)
[ -n "\$dev" ] || { echo "no spinny controller under /dev/serial/by-id on the Pi" >&2; exit 1; }
[ -r "\$dev" ] && [ -w "\$dev" ] || { echo "no access to \$dev: sudo usermod -aG dialout \$USER, then log in again" >&2; exit 1; }
echo "relaying \$dev to socket://127.0.0.1:$port here" >&2
exec socat TCP-LISTEN:$port,bind=127.0.0.1,reuseaddr,fork,max-children=1 FILE:"\$dev",rawer
EOF
)

# -t gives the remote socat a terminal, so Ctrl-C and a dropped session
# stop it instead of leaving it holding the port and the device.
exec ssh -t -o ExitOnForwardFailure=yes -L "127.0.0.1:$port:127.0.0.1:$port" "$host" "$remote"
