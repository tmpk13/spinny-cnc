# spinny-fw: SKR Pico firmware

RP2040 firmware for the spinny laser. It runs the `spinny-core` control
core on a BTT SKR Pico: the radius motor on the X socket, the rotary table
on the Y socket, the laser TTL input from a PWM pin, and the line protocol
of `docs/PROTOCOL.md` over USB CDC. No endstops, no homing.

## Pins

| Function | GPIO | Note |
| --- | --- | --- |
| Radius STEP / DIR / EN | GP11 / GP10 / GP12 | X driver socket, EN active low |
| Table STEP / DIR / EN | GP6 / GP5 / GP7 | Y driver socket, EN active low |
| TMC2209 UART | GP8 TX, GP9 RX | one wire, 115200 baud, addresses X=0 Y=2, 110 mOhm sense |
| Laser TTL / PWM | GP29 | SERVOS header signal pin; 5V and GND beside it |

USB: VID 0x2E8A PID 0x000A, product "spinny laser controller", serial from
the flash unique id.

## Build and flash

Needs the `thumbv6m-none-eabi` target and `elf2uf2-rs`.

```
cd firmware/rp2040
cargo build --release
elf2uf2-rs target/thumbv6m-none-eabi/release/spinny-fw spinny-fw.uf2
```

Hold BOOTSEL while plugging the board in (or while pressing RESET), then
copy `spinny-fw.uf2` onto the `RPI-RP2` drive. `cargo run --release` does
the conversion and the copy when the drive is mounted.

The hardware-free parts (PWM and timer arithmetic, line assembly, output
framing, TMC2209 datagrams, settings sector) live in `../rp2040-logic` and
test on the host: `cd firmware && cargo test -p spinny-fw-logic`.

## Talking to it

```
picocom -b 115200 --imap lfcrlf /dev/serial/by-id/usb-spinny_spinny_laser_controller_*
```

The `[spinny v... lines:16 blocks:32]` banner arrives when the port is
opened. Type `help`, `?`, `$` or `$tmc`. Lines end with Enter; `?`, `!`
and `~` act at once, and Ctrl-X sends the realtime reset byte. Quit picocom
with Ctrl-A Ctrl-X.

`$tmc` prints one `[MSG:tmc ...]` line per driver with its IFCNT (the
number of UART writes it accepted) and DRV_STATUS, or `no reply`.

## Safety

- Verify direction and steps per unit at low speed first: `jog R1 F60`,
  `jog A5 F60`, then `$dir_invert`, `$r_steps` and `$a_steps` as needed.
- GP29 is an input from power-on until the firmware starts and again after
  a watchdog reset. Fit a pull-down on the laser TTL line, or use a module
  that stays off while its input floats.
- The EN lines are pulled low by the pads at reset, so the drivers are
  energized at their own default current until the firmware disables them
  a few milliseconds later.
- Nothing drives the laser until a command asks for it. Hold, reset, a USB
  disconnect and an empty planner all turn it off, and a stalled main loop
  resets the chip within 1.5 s.
