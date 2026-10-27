#!/usr/bin/env bash
# Resets the spinny controller's USB port from the host, here or on a
# Raspberry Pi over ssh: the same as unplugging and plugging it back,
# without a power cycle, so the board's record of this life survives.
#
#   relay/usb-reset.sh            # this computer
#   relay/usb-reset.sh user@host  # a Pi
#
# This is what brings back a board whose USB controller locked up (RP2040
# erratum E15): it stays on the bus, every transfer fails with a protocol
# error the kernel does not log, and only a bus reset clears it. Firmware
# from 2026-10-27 on drops off the bus by itself when that happens.
# The reset takes root; sudo is used.
set -euo pipefail

script='
import fcntl, glob, os, sys
USBDEVFS_RESET = 0x5514
for dev in glob.glob("/sys/bus/usb/devices/*"):
    try:
        with open(dev + "/product") as f:
            product = f.read().strip()
    except OSError:
        continue
    if product != "spinny laser controller":
        continue
    bus = int(open(dev + "/busnum").read())
    num = int(open(dev + "/devnum").read())
    node = "/dev/bus/usb/%03d/%03d" % (bus, num)
    fd = os.open(node, os.O_WRONLY)
    try:
        fcntl.ioctl(fd, USBDEVFS_RESET, 0)
    finally:
        os.close(fd)
    print("reset", node)
    sys.exit(0)
sys.exit("no spinny controller on the bus")
'

if [[ $# -ge 1 ]]; then
    exec ssh "$1" "sudo python3 -c '$script'"
fi
exec sudo python3 -c "$script"
