# Ensure mount directory exists
sudo mkdir -p /mnt/pico

# Write udev rules
sudo tee /etc/udev/rules.d/99-pico.rules << 'EOF'
# ----------------------------------------------------------------------------------
# Raspberry Pi Pico (Vendor ID: 2e8a)
# ----------------------------------------------------------------------------------

# BOOTSEL Mode (Mass Storage Drive - RP2040: 0003, RP2350: 000f)
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="0003", MODE="0666", GROUP="plugdev", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="000f", MODE="0666", GROUP="plugdev", TAG+="uaccess"
SUBSYSTEM=="block", ATTRS{idVendor}=="2e8a", SYMLINK+="pico_disk%n"

# Serial CDC / ACM Mode (MicroPython / CircuitPython console)
SUBSYSTEM=="tty", ATTRS{idVendor}=="2e8a", MODE="0666", GROUP="dialout", SYMLINK+="pico"

# Picoprobe / Raspberry Pi Debug Probe (CMSIS-DAP SWD)
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="0004", MODE="0666", GROUP="plugdev", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="000c", MODE="0666", GROUP="plugdev", TAG+="uaccess"

# Mount partition on insert
ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="partition", ATTRS{idVendor}=="2e8a", RUN+="/usr/bin/systemd-mount --no-block --automount=yes %E{DEVNAME} /mnt/pico"

# Unmount cleanly on removal
ACTION=="remove", SUBSYSTEM=="block", ENV{DEVTYPE}=="partition", ENV{ID_VENDOR_ID}=="2e8a", RUN+="/usr/bin/systemd-mount --umount /mnt/pico"
EOF

# Reload udev engine
sudo udevadm control --reload-rules && sudo udevadm trigger

sudo usermod -aG plugdev,dialout $USER