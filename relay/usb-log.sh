#!/usr/bin/env bash
# Follows the kernel's USB and serial lines, here or on a Raspberry Pi over
# ssh. Whether the controller dropped off the bus, enumerated again or
# stayed put while the link went quiet is settled here, not in the
# backend's log: a reset of the board is a disconnect and a new device, a
# firmware that only stopped answering leaves these lines silent.
#
#   relay/usb-log.sh            # this computer
#   relay/usb-log.sh user@host  # a Pi
#
# Reading the kernel's journal takes the systemd-journal or adm group;
# sudo is used when the user has neither. Ctrl-C ends it.
set -euo pipefail

script='
filter="usb|ttyACM|cdc_acm|dwc2|xhci|ch341|cp210"
if journalctl -k -n 1 >/dev/null 2>&1; then j=journalctl; else j="sudo journalctl"; fi
$j -k -f -n 100 -o short-precise --no-pager | grep -E --line-buffered -i "$filter"
'

if [[ $# -ge 1 ]]; then
    exec ssh -t "$1" "$script"
fi
bash -c "$script"
