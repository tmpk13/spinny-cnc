# Serial link, bridge and relay

## Controller relay through a Raspberry Pi (2026-10-06)
- Replaced the Pi deployment: the backend stays on the dev machine and the Pi only bridges the tty. The backend already takes socket:// urls, so no code changed.
- socat listens on the Pi's loopback and ssh -L carries it, so the laser is never open on the LAN without the ssh login. One long lived ssh session keeps connect latency low; an ssh per connection could miss the backend's 1 s version request.
- fork opens the device per connection, so a controller reset or replug between connections is picked up; max-children=1 keeps a second client off the line. -t makes Ctrl-C reach the remote socat.
- Tested with a stand-in ssh and a pty bridged to the virtual firmware; untested on a real Pi.

## Crash diagnostics (2026-10-13)

The board left nothing behind when it died: `panic_halt` spun with the
step interrupt still running the ring until the 1.5 s watchdog fired,
and the next life printed the same banner as a power-on. Now
`rp2040/src/diag.rs` keeps a `Record` in a `.uninit` section (SRAM is
not cleared by any reset short of a power cycle; cortex-m-rt zeroes only
`.bss`), armed at every boot and read before `embassy_rp::init`. The
reason comes from `WATCHDOG.REASON` (timer or force; cleared by a chip
level reset) and `VREG_AND_CHIP_RESET.CHIP_RESET` (`HAD_POR`, `HAD_RUN`).
The panic and `HardFault` handlers disable interrupts, write the stop
into the record and force a watchdog reset through `PSM.WDSEL` and
`WATCHDOG.CTRL.TRIGGER`, so the record says panic or hard fault while the
register says force; a timeout has no handler and is told by the armed
record's phase and uptime. The bootrom uses `SCRATCH4..7` for its own
reboot vectoring, so the scratch registers were left alone and the
record lives in RAM. Record fields are written with volatile stores:
nothing in a life reads them, so with fat LTO plain stores are dead.

Cortex-M0+ has no atomic read-modify-write; every counter has one
writer (a task or the main loop) and the others read. `AtomicBool::swap`
does not exist on thumbv6m, which the first build found.

`diag` is a core command answered `ok` with `events.diag` set, printed by
the port after the answer like `$tmc`, so the virtual firmware, the fake
and the mock answer it with one message each.

Host side: the wire log is written from the app's link event handler, not
the `Link`, so the transport stays transport; its logger is a child of
the backend's by name and does not propagate, or every line would land
in `spinny.log` too. The boot suffix was dropped from the "connected"
message: the `[MSG:boot ...]` follows the banner by a few milliseconds
and `open()` returns on the banner, so the message was there half the
time. The message itself reaches the page and the log either way.

## Banner on open, stop on close, and a bridge instead of socat (2026-10-14)

Three open items were one fault seen from three sides: "the socat has to
be restarted to reconnect", "no banner from firmware on a reconnect", and
part of "randomly disconnecting". Reproduced here with a pty nobody
read: `socat TCP-LISTEN:...,fork,max-children=1 FILE:/dev/pts/N,rawer`
blocks in `write()` once the tty stops taking bytes, the child outlives
its client (it never reads the EOF), and the parent logs `maxchildren
are active, waiting` for the next connection, which is accepted by the
kernel and served by nobody. The backend's connect then succeeds at TCP,
hears nothing, and reports "no banner: is that the firmware?". The
`nonblock` option on the FILE address changes nothing (the child keeps
the unwritten data and stays). A board whose USB reader wedges while its
main loop feeds the watchdog is exactly this case.

- `spinny_web/bridge.py` (`spinny-bridge`, `mise run bridge`) replaces
  socat: asyncio, the device's fd non-blocking with readiness-driven
  writes, bytes left waiting for 3 s end the session with the client told
  (`[MSG:bridge <device> took nothing for 3 s]`), a client holding more
  than 64 KB unread is dropped, a client quiet for 3 s is replaced by the
  next one while a live one keeps the port (`busy`). The device is looked
  up under `/dev/serial/by-id/usb-spinny_*` and opened at every connect,
  closed at every leave, with pyserial's flush at open disabled as in
  `link.open_serial`, since the firmware's banner now arrives on the DTR
  the open raises. The link names a bridge notice seen within 2 s in the
  port failure's reason, so a failed connect says what the Pi saw.
- `deploy-pi` installs the bridge by default (`spinny-bridge.service`,
  loopback 2324, `relay-pi` forwards it and no longer starts socat when
  it finds a listener); `--web` installs the backend and page as before.
  Installing either disables the other: both want the port.
- Firmware: the banner was printed when the device was configured and
  sat in the endpoint for the first program to open the port; a program
  that closed and opened the port again got nothing (the device stays
  configured), and only `version` answered. Now the control task turns
  the host's DTR into `HostOpened` and `HostClosed` events: an open gets
  the banner and the boot line, a close is a disconnect (`machine.reset`:
  queue flushed, beam and spindle off, `Alarm:1` if moving), so a host
  that dies mid-job leaves nothing running. The virtual firmware already
  did both per client session, so the board now matches it and the
  backend's `restarts` snapshot after `open()` covers the banner. DTR
  falling also restarts the USB reader and writer (the half line and the
  unread packet of the closing program go with it; the device stays
  configured, so both come straight back). A bus
  reset drops DTR too (embassy-usb 0.6 resets the line state and signals
  the change), after the disconnect it already caused: a second reset of
  an idle machine, harmless.

## The board resetting on its own: power, on the K40 (2026-11-02)

Open since 2026-10-14. Evidence from the first K40 evening (board on this
laptop's USB, `k40` loaded): six drops between 00:03 and 02:13. Each time
the kernel logged `USB disconnect` with the last poll answered 20 ms
before, and five of the six came back as `boot power on` 8 s to 16 min
later (diag `up` matched the re-enumeration), so the RP2040's 3.3 V rail
went down: no watchdog, panic, hard fault or E15 lockup. Five were at
Idle, 6 s to 4 min after the last move, beam off (`L:0`), motors enabled
at 50% hold, so neither the motion nor the beam was the trigger. The
sixth (01:51:12, mid-cut, `L:1000`) re-enumerated in the same second as
`boot reset pin`: the RUN line pulled low while the tube fired, the
classic K40 HV noise. `docs/K40.md` left the 24 V source open (the
supply's 24 V terminal or a separate one); a stock K40 supply's 24 V
rail is small. Since then the backend names what the next boot means
after a link that failed on its own (`boot_after_loss`, `loss_verdict`,
in `_name_loss`): `lost power` with the time off, a RUN pin reset, or
`stayed up` when the uptime spans the failure (the boot line repeats the
old life's reason at every open, so the uptime decides).
The next step is on the machine: check the 24 V supply feeding the board
and its terminals (the TODO item that carried this was taken off the list
on 2026-11-08, these notes being its record).

## A starved backend is not a silent machine (2026-10-14)

The stall verdict (`no answer from the machine for 3 s`) compared the
clock with the last line heard, which the reader thread stamps. A
backend held for seconds by a C extension that keeps the interpreter (a
board upload's copper clearing on a Pi) has the answers sitting in the
port unread, and the poller, waking first, would have closed the link,
failed the run, and since the firmware now resets when the port closes,
stopped a machine that was fine. The reader now stamps every look at the
port (one per 50 ms read timeout), and the poller gives the machine up
only when the reader has looked within 0.25 s and still heard nothing
for the stall; a reader behind for three stalls is stuck in a read and
closes the link with that reason.

## The last line before a port fails was lost (2026-10-15)

The reader took a byte, then drained what else was waiting in a loop
inside the same `try`; when the far end closed right after its last
line (a bridge's `[MSG:bridge ... gone]`, a board's final `ALARM`), the
drain hit the closed socket and the exception path threw away the bytes
already read, so the line was never handled and the close reason named
the notice before it. The failure is now kept aside until the chunk's
lines have been handled. Found by the test that runs the real link
through the bridge to the pty board; a fake port that hands over its
last bytes and fails on the next read pins it. The "opened" greeting is
no longer taken as a reason for a close.

The `log_records` fixture in the backend tests sees every record twice
(two capture paths), so a test that indexes the second record of a
message gets the first one's twin: assert on the first and last, or on
presence, never on `[1]`.

## To verify on the bench (firmware of 2026-10-14, not yet flashed)

1. `mise run flash`, connect from the page twice in a row: each connect
   logs `machine banner` and `machine: boot ...` (the second boot line
   at info). No `no banner from ...` error.
2. Start a jog or a short job, then kill the backend (or pull the ssh
   tunnel): the machine must stop at once and report `Alarm:1` if it was
   moving; `Last known` then fills in its last reported position.
3. On the Pi: `mise run deploy-pi -- user@host`, then `mise run relay-pi
   -- user@host`, connect to `socket://127.0.0.1:2324`; `mise run
   pi-logs -- user@host` shows the bridge's `opened` and `closed` lines
   with the reasons.

## The machine went quiet with the board still on the bus: USB lockup (2026-10-27)

00:47 idle, 2342 s into a link: the status report for one poll never
arrived though the board counted it as sent (`tx` 78 bytes ahead of what
the host heard, `writer idle`), and from then on nothing either way.
Every reopen got no banner. The Pi's kernel logged nothing; `usbmon`
showed every transfer, SET_CONTROL_LINE_STATE on endpoint 0 included,
failing at once with -71 (no handshake). The board had not reset (`up`
matched the 23:52 enumeration), so the main loop was feeding the
watchdog all along. A USBDEVFS_RESET from the Pi brought it straight
back, with `diag` showing no USB event in between.

That is RP2040 erratum E15: a bus error during an IN transfer can leave
the device controller answering no token until a bus reset. embassy-rp
0.10 has no workaround (TinyUSB delays arming bulk IN in the last 200 us
of a frame; Raspberry Pi's debugprobe watches SOF_RD and forces a
disconnect). Done here the debugprobe way: `usb::guard_task` reads the
frame number every 10 ms, and 100 ms without movement while configured
and not suspended (SIE_STATUS) counts a `lockup`, signals the disconnect
(the machine stops as on an unplug) and drops the pull-up for 200 ms so
the host enumerates again. Logic in `rp2040-logic/src/usb_guard.rs`.
`mise run usb-reset -- user@host` recovers a board on older firmware.

Not the cause: the 00:08 `boot watchdog: the main loop stalled` is most
likely the bootrom's reboot after the 23:52 UF2 flash, which times the
watchdog out rather than triggering it. pyserial flushes input right
after open, so a probe with it never sees the banner.

To verify on the bench: flash, then on a lockup the Pi's kernel logs a
disconnect and a new device about 100 ms after the last answer, and the
next connect's `diag` shows `lockups 1`.

## USB drop mid-cut, keep focus, E15 early arming (2026-10-29)

- Run e633 died at 02:02:15 with `bridge ... gone: No such device`. Not a
  board reset: `diag` at the next connect showed `up 15572 s` and
  `lockups 1, last 121613 ms ago`, i.e. the E15 guard fired at the drop.
  Pi Zero 2 W kernel: disconnect at 15.254, back as ttyACM0 at 15.859.
  The guard reports through `disconnected()`, so the core reset
  (Alarm:1, spindle off, position kept) and the run failed.
- Ride-through (hold, resync line counts, resume) was offered; the user
  chose an operator override instead: `POST /api/heightmap/focus/keep`
  restores the offset a frame change dropped, offered by a banner in the
  status bar (sticky, so it stays in view).
- E15 prevention without forking embassy-rp: its `EndpointIn::write` arms
  the buffer in the same poll when the previous one was taken, so the
  writer waits for (no IN buffer armed) and (frame start placed between
  two looks <= 300 us apart, now < 700 us after the earlier look), then
  writes. 50 us looks (embassy-time is 1 MHz on rp2040), 500 us while a
  packet is still pending, gives up after 5 ms. Not yet on hardware.

## relay-pi and deploy-pi checks (2026-11-09)

relay-pi asks for socat only when no bridge listens (a deploy-pi Pi has
none); deploy-pi sends pcbv only when it built this time (or with
--no-build), and goes on without it when the cross strip is missing.
test_relay.py and test_deploy.py run the scripts with stand-in ssh, scp,
cargo and so on in a made-up tree.

## The link failure kept across failed connects (2026-11-09)

A close replaces the kept link failure (when and why the board went
away) only when none is kept or the closing link heard the board's
banner: through a bridge, every autoconnect try while the board was off
connected at TCP, heard 'no controller', failed, and moved the time
forward, so the power-loss note named the wrong time and reason.
test_link's 'stops answering' test races its own close (the link is
marked closed before the log line is written) and failed once.
