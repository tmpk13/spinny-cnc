#!/usr/bin/env bash
# The backend's logs on a Pi that runs it as a service (deploy-pi): the
# service's own journal, then the tails of var/spinny.log and var/wire.log
# there. The wire log holds every line sent and received with the time;
# the last of them say what the machine did before it went quiet.
#
#   relay/pi-logs.sh user@host [lines]
#
# The repository is expected at ~/spinny on the Pi (SPINNY_PI_DIR to
# change), as deploy-pi puts it.
set -euo pipefail

host=${1:?usage: pi-logs.sh user@host [lines]}
lines=${2:-100}
dir=${SPINNY_PI_DIR:-spinny}

exec ssh "$host" "
journalctl -u spinny-web -n $lines --no-pager -o short-iso 2>/dev/null || true
echo '--- var/spinny.log'
tail -n $lines '$dir/spinny-laser-pcb/var/spinny.log' 2>/dev/null || echo '(none)'
echo '--- var/wire.log'
tail -n $lines '$dir/spinny-laser-pcb/var/wire.log' 2>/dev/null || echo '(none)'
"
