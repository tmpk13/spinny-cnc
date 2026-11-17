#!/usr/bin/env bash
# Writes the built firmware onto a board held in BOOTSEL, here or on a
# Raspberry Pi over ssh, through the /mnt/pico automount that
# relay/pico-udev-setup.sh installs (mounted with umask=000, so no root).
#
#   relay/load-uf2.sh            # this computer
#   relay/load-uf2.sh user@host  # a Pi
#
# The firmware is built first, in the spinny-firmware repository beside
# this one (SPINNY_FIRMWARE names another checkout). The board reboots into
# the new firmware as soon as the last block lands.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
firmware="${SPINNY_FIRMWARE:-$here/../spinny-firmware}"
[ -f "$firmware/Cargo.toml" ] || { echo "no spinny-firmware repository at $firmware" >&2; exit 1; }
mise -C "$firmware" run uf2
uf2="$firmware/rp2040/target/thumbv6m-none-eabi/release/spinny-fw.uf2"

if [ $# -eq 0 ]; then
    cp "$uf2" /mnt/pico/ && sync
else
    ssh "$1" 'cat > /mnt/pico/spinny-fw.uf2 && sync' < "$uf2"
fi
