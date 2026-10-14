#!/usr/bin/env bash
# The logs on a Pi set up by deploy-pi: the bridge's journal (every client,
# device opened and closed, and why), or the backend service's own journal
# with the tails of var/spinny.log and var/wire.log there. The wire log
# holds every line sent and received with the time; the last of them say
# what the machine did before it went quiet.
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
journalctl -u spinny-bridge -n $lines --no-pager -o short-iso 2>/dev/null || true
journalctl -u spinny-web -n $lines --no-pager -o short-iso 2>/dev/null || true
echo '--- var/spinny.log'
tail -n $lines '$dir/spinny-laser-pcb/var/spinny.log' 2>/dev/null || echo '(none)'
echo '--- var/wire.log'
tail -n $lines '$dir/spinny-laser-pcb/var/wire.log' 2>/dev/null || echo '(none)'
"
