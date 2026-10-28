#!/usr/bin/env bash
# Writes the built firmware onto a board held in BOOTSEL, here or on a
# Raspberry Pi over ssh, through the /mnt/pico automount that
# relay/pico-udev-setup.sh installs (mounted with umask=000, so no root).
#
#   relay/load-uf2.sh            # this computer
#   relay/load-uf2.sh user@host  # a Pi
#
# The board reboots into the new firmware as soon as the last block lands.
set -euo pipefail

uf2=firmware/rp2040/target/thumbv6m-none-eabi/release/spinny-fw.uf2
[ -f "$uf2" ] || { echo "no $uf2, run: mise run uf2" >&2; exit 1; }

if [ $# -eq 0 ]; then
    cp "$uf2" /mnt/pico/ && sync
else
    ssh "$1" 'cat > /mnt/pico/spinny-fw.uf2 && sync' < "$uf2"
fi
