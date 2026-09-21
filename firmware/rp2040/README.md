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
| Laser | GP20 | FAN3 header, a low side MOSFET switching the fan rail |

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

## First bring-up

Nothing here has run on a machine yet. Do it in this order, with the laser
disconnected until the last step.

1. Flash the board and open the port: the banner should arrive and `$`
   should list the settings.
2. Motor power on, nothing coupled if you can help it. The drivers run
   from it, so they cannot answer without it. `$tmc` should now report a
   driver per axis with `ifcnt` at 3 or more, which counts the register
   writes it accepted. `no reply` means the UART wiring or the addresses
   are wrong. `refused config` on the console means the writes did not
   take, and the driver is then running at whatever MS1 and MS2 strap it
   to, which is 8 microsteps on the radius socket and 64 on the table.
3. Set the currents low for the first moves: `$tmc_r_ma=400`,
   `$tmc_a_ma=400`.
4. `set R0 A0`, then `jog R1 F60`: the head must move away from the axis.
   If it goes the wrong way, `$dir_invert=1` (bit 0 is the radius, bit 1
   the table).
5. `jog A5 F60`: seen from above the point under the beam must swing
   counterclockwise. If not, add 2 to `$dir_invert`.
6. Check the scales over a long move rather than a short one: `jog R50 F300`,
   measure, and scale `$r_steps` by what you asked over what you got. Same for
   the table with `jog A360 F600` and `$a_steps`.
7. `$r_rate`, `$a_rate`, `$r_accel` and `$a_accel` up until a move misses
   steps, then back off well clear of it. `$a_rate` is what decides how close
   to the axis the machine can still cut at speed.
8. `$save`, then power cycle and check `$` still reads back what you set.
9. Laser last, on a scrap board. Prove the wiring at full duty first,
   where the output is simply on: `laser S1000 T2000`, measuring at the
   header if it does not strike. Then `laser S500 T2000` and `laser S100
   T2000` to find where it stops firing, which is the bottom of the usable
   power range. Only then a single `cut` line at the speed and power you
   intend.
10. If the beam follows `S` poorly, the fan output's own smoothing is the
   first suspect: try `$laser_hz=200` and work up.

## Microstepping and speed

The drivers default to 256 microsteps, which fixes `r_steps` at 10240 per
mm and `a_steps` at 14222.222 per degree. The step generator tops out at
100000 steps a second, so that resolution caps the radius at 586 mm/min
and the table at 422 deg/min, whatever `$r_rate` and `$a_rate` say.

The table's rate is what decides how close to the axis a cut can still run
at speed: 400 mm/min of surface speed needs 54 mm of radius at 422
deg/min, against 21 mm at the 1080 deg/min the motor itself can do.

Coarser microstepping buys that back, 16 at a time, and costs nothing in
smoothness: `intpol` is on, so the driver interpolates whatever it is given
to 256 microsteps internally. What it does cost is positioning resolution,
which at 256 microsteps is 0.1 um on the radius and a quarter of an arc
second on the table, both far under what the mechanics can hold.

| `tmc_*_micro` | `r_steps` | radius ceiling | `a_steps` | table ceiling |
| --- | --- | --- | --- | --- |
| 16 | 640 | 9375 mm/min | 888.889 | 6750 deg/min |
| 32 | 1280 | 4688 mm/min | 1777.778 | 3375 deg/min |
| 64 | 2560 | 2344 mm/min | 3555.556 | 1688 deg/min |
| 256 | 10240 | 586 mm/min | 14222.222 | 422 deg/min |

Changing it means changing the scales with it, since the same distance is
then a different number of steps:

```
$tmc_r_micro=32
$tmc_a_micro=32
$r_steps=1280
$a_steps=1777.778
$r_rate=1000
$a_rate=1080
$save
```

## Safety

- Verify direction and steps per unit at low speed first: `jog R1 F60`,
  `jog A5 F60`, then `$dir_invert`, `$r_steps` and `$a_steps` as needed.
- GP20 is an input from power-on until the firmware starts and again after
  a watchdog reset. The pad's own pull-down holds the MOSFET off, but a
  module driven from a TTL line of its own needs a pull-down there too.
- The FAN3 output switches the board's fan rail, which is 12 V or 24 V
  depending on how the board is powered. Check what reaches the laser
  before connecting it to anything expecting 5 V logic.
- The EN lines are pulled low by the pads at reset, so the drivers are
  energized at their own default current until the firmware disables them
  a few milliseconds later.
- Nothing drives the laser until a command asks for it. Hold, reset, a USB
  disconnect and an empty planner all turn it off, and a stalled main loop
  resets the chip within 1.5 s.
