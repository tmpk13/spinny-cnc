# spinny-fw: SKR Pico firmware

RP2040 firmware for the spinny laser. It runs the `spinny-core` control
core on a BTT SKR Pico: the radius motor on the X socket, the rotary table
on the Y socket, the cross slide on the Z socket, an optional focus axis
on the E socket with a touch probe on Z-STOP, the laser TTL input from a
PWM pin, and the line protocol of `docs/PROTOCOL.md` over USB CDC. No
endstops, no homing.

Two optional modes use the same wiring. `$cartesian=1` steps the cross
slide from the step timer as a fourth joint, so the rail is X and the
slide Y of an X/Y machine. `$spindle=1` makes the FAN3 output a spindle's
speed signal and the focus axis its depth axis.

## Pins

| Function | GPIO | Note |
| --- | --- | --- |
| Radius STEP / DIR / EN | GP11 / GP10 / GP12 | X driver socket, EN active low |
| Table STEP / DIR / EN | GP6 / GP5 / GP7 | Y driver socket, EN active low |
| Cross slide STEP / DIR / EN | GP19 / GP28 / GP2 | Z driver socket, EN active low |
| Focus axis STEP / DIR / EN | GP14 / GP13 / GP15 | E driver socket, EN active low; used with `$h_axis=1` |
| Probe | GP25 | Z-STOP header, internal pull-up, active low unless `$probe_invert=1` |
| TMC2209 UART | GP8 TX, GP9 RX | one wire, 115200 baud, addresses X=0 Y=2 Z=1 E=3, 110 mOhm sense |
| Laser | GP20 | FAN3 header, a low side MOSFET switching the fan rail |

The cross slide goes in the **Z** socket and the focus axis in the **E**
socket. The four enable pins are driven together, so an empty E socket
sees its enable line with the others, which does no harm; its driver is
only configured over UART with `$h_axis=1`.

The probe input is 3.3 V logic with no 5 V tolerance. A plain switch or
a pin that touches grounded copper goes between the Z-STOP signal and
GND. A powered probe must have an open drain (or open collector) output,
or a level shifter: one that drives 5 V into GP25 damages the RP2040.
Check the header's pinout on the board before wiring it, and check the
level with `?` (`P:1` while touching) before the first `probe`.

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
   from it, so they cannot answer without it; a configuration pushed
   while they were dark is retried every two seconds until it lands.
   `$tmc` should now report `micro=256` on all three axes (four with a
   focus axis), read back from
   the driver itself. Anything else means the configuration has not taken
   and the driver is on its MS1 and MS2 straps, which is 8 microsteps on
   the radius socket and 64 on the table: the radius would then be asked
   for thirty-two times the speed and distance and would sit and whine,
   while the table would turn four times too far and look like it worked.
   `no reply` means motor power or the UART wiring.
3. Set the currents low for the first moves: `$tmc_r_ma=400`,
   `$tmc_a_ma=400`, `$tmc_z_ma=400`.
4. `set R0 A0`, then `jog R1 F60`: the head must move away from the axis.
   If it goes the wrong way, `$dir_invert=1` (bit 0 is the radius, bit 1
   the table, bit 2 the cross slide).
5. `jog A5 F60`: seen from above the point under the beam must swing
   counterclockwise. If not, add 2 to `$dir_invert`.
6. Check the scales over a long move rather than a short one: `jog R50 F300`,
   measure, and scale `$r_steps` by what you asked over what you got. Same for
   the table with `jog A360 F600` and `$a_steps`.
7. `$r_rate`, `$a_rate`, `$r_accel` and `$a_accel` up until a move misses
   steps, then back off well clear of it. `$a_rate` is what decides how close
   to the axis the machine can still cut at speed.
8. The cross slide: `set Z0`, then `jog Z1 F60`. It must move the rail
   across the table, not along it; if it goes the wrong way, add 4 to
   `$dir_invert`. Check the scale the same way as the radius, over a long
   move, and set `$z_steps`. `Z` is a setup axis: it is taken only from
   `Idle`, it never moves with `R` or `A`, and the beam stays off.
9. Find the axis before any real job: `spinny-center` burns a pattern
   whose square gives the cross slide error and whose closing gap gives
   the radius zero error. Run it in `mode const`, then move the slide by
   the error it reports and burn it again. Once the square has closed,
   `spinny-center --fine` burns the amplifying pattern: the head runs
   past the axis for it, to R -7, so check the rail allows that (or set
   `$r_max`), import its job in the web interface, and read the map.
10. The focus axis, if one is fitted, with the probe wired and the laser
    still disconnected: `$h_axis=1`, `$tmc_h_ma=400`, then `?` must end in
    `|H:0.000|P:0>`, and `P:1` while you close the probe by hand. If it
    reads the other way round, `$probe_invert=1`. Then `jog H1 F60`: the
    head must rise. If it goes down, add 8 to `$dir_invert`. Check
    `$h_steps` over a long move as for the radius. Before the first
    `probe`, hold the head well above the board and try `probe H-2 F60`
    in the air: it must stop with `ALARM:2` after 2 mm, and a touch of
    the probe during a second try must stop it with `[PRB:...:1]`. Only
    then `probe` toward the board, from a few mm above it.
11. `$save`, then power cycle and check `$` still reads back what you set.
    The stored blob carries a version byte, so a settings sector written by
    an earlier firmware is discarded rather than misread and the defaults
    come back.
12. Laser last, on a scrap board. Prove the wiring at full duty first,
    where the output is simply on: `laser S1000 T2000`, measuring at the
    header if it does not strike. Then `laser S500 T2000` and `laser S100
    T2000` to find where it stops firing, which is the bottom of the
    usable power range. Only then a single `cut` line at the speed and
    power you intend.
13. If the beam follows `S` poorly, the fan output's own smoothing is the
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
  `jog A5 F60`, `jog Z1 F60`, then `$dir_invert` (bit 0 radius, bit 1
  table, bit 2 cross slide), `$r_steps`, `$a_steps` and `$z_steps` as
  needed.
- The cross slide has no limit switches. It is a setup axis with a short
  travel, so drive it in small steps and watch it; a `jogto Z` to a
  position declared before the slide was moved by hand will run into the
  end of its travel and stall. Set `$z_max` to its travel either side of
  `Z0` before using it as a cartesian Y axis: a cartesian job moves it
  across the whole board.
- The cross slide is stepped from the main loop, at up to 20 kHz. It only
  ever moves alone, from rest, with the beam off, so its timing matters to
  nothing; a jog cancel brakes it and a reset or a USB disconnect stops
  it, in both cases keeping the steps it actually took. With
  `$cartesian=1` the step timer steps it instead, under the same ceiling
  as the other joints, and a reset while it moves raises `ALARM:1` like
  theirs.
- A spindle on FAN3 (`$spindle=1`) keeps turning through moves and holds;
  only `spindle off`, `laser off`, a reset, a USB disconnect or an alarm
  stop it. FAN3 is a low side switch on the fan rail, not a logic output:
  a spindle controller's PWM or enable input needs an interface that suits
  it (an opto-isolator, or a pull-up to the controller's own logic
  supply), checked with a meter before the spindle is connected, and
  `$laser_hz` set to the frequency the controller expects.
- The focus axis has no limit switches and no soft limit either. A probe
  that finds nothing goes its whole distance down and raises `ALARM:2`, so
  keep the distance to what the head can travel before anything but the
  probe meets the board. A probe that stays below the focal point once it
  has touched (a fixed pin rather than a retracting one) drags across the
  board during the cut: retract or remove it before running a job.
- GP20 is an input from power-on until the firmware starts and again after
  a watchdog reset. The pad's own pull-down holds the MOSFET off, but a
  module driven from a TTL line of its own needs a pull-down there too.
- The FAN3 output switches the board's fan rail, which is 12 V or 24 V
  depending on how the board is powered. Check what reaches the laser
  before connecting it to anything expecting 5 V logic.
- The EN lines are pulled low by the pads at reset, so all four drivers
  are energized at their own default current until the firmware disables
  them a few milliseconds later.
- Nothing drives the laser until a command asks for it. Hold, reset, a USB
  disconnect and an empty planner all turn it off, and a stalled main loop
  resets the chip within 1.5 s.
