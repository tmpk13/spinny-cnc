# Feeders (2026-11-19)

The plan these were built from is [docs/FEEDERS.md](../docs/FEEDERS.md).

## The run and the bus (2026-11-19)

- The run looked into a feeder's pocket before it advanced the feeder:
  from the second pick on it saw the pocket the last pick had emptied,
  passed it over without advancing, and left every part out. A feeder
  advances when it has a `bus_id` or `feed` lines; the run now sends the
  advance itself (the bus feed and its wait, then the feed lines) before
  the look, and `pick_lines(..., advance=False)` leaves it out of the
  pick. The plan keeps it in the pick lines, so the program shown and
  downloaded reads as before. The feed lines' moves are over before the
  look because every move of a look is followed by the wait command
  (M400 on Marlin).
- Q65 A as applied: every pick rejected from a feeder that advances stops
  the run when the file has no `[motion] discard`, not only one known to
  hold a part. A vacuum reading between `part_on` and `part_off` (a part
  held crooked) reads as "no part held" while a part hangs on the nozzle,
  and going back down to the pocket to let go is what the question rules
  out. So a missed pick stops such a run until a discard place is set,
  and the message says to set one. Reading to correct if the user wants
  the camera's rejections only.
- A feeder's address is its slot floor's byte 0 (the photon firmware's
  PhotonNetworkLayer reads it at start, 0xFF with no 1-wire chip; main.cpp
  lights the feeder red for 0xFF, blue for 0). Its address filter takes
  packets to its own address and to 0xFF, and its feed checks no id, so a
  feed sent to 255 moves every feeder that is initialized, and a feeder
  at 0 hears every packet sent to the host. `find` raises NoAddress for an
  answer from 0, the host's, the broadcast or one past `max_address`, and
  `advance` refuses such an address whatever gave it. The search at a
  run's start says it as a warning per feeder (at each plan, as the "no
  [[slot]] place" warning is said); the plan's skip reason stays "slot is
  not known", as `plan()` also serves the feeder check.
- Identify (0xC1): the photon firmware answers ok, then flashes white
  three times with `delay()`, 1.8 s, and unlike a feed it does not clear
  what reached it meanwhile, so a packet sent during the flash is acted on
  late, after M485 has timed out. `FeederBus.identify` therefore waits 2 s
  (on its injectable `sleep`) before it returns, and the route flashes the
  feeders one after another: a request to that feeder right after would
  read as no answer, and a feed would still happen, later. The virtual
  bus plays the flash as 1.8 s of its clock in which the feeder hears
  nothing.
- Answers that collide: Marlin's M485 takes the answer through the rs485
  library's PhotonProtocol packetizer, whose `isPacket` checks the CRC, so
  two feeders answering 0xC3 at once never print as a reply that does not
  check, as the plan assumed: M485 prints `rs485-reply: TIMEOUT`, or one
  feeder's whole answer when its driver wins on the wire. The virtual bus
  does the same by default; `PhotonBus(checked=False)` plays a controller
  that prints what it got, and `FeederBus.unready` raises Collision for
  that. So the route's "no feeder without an address answered" says that
  several at once read as none, and asks to leave one in. A winner's
  answer is programmed by its id, so the floor written is never another
  feeder's, but it may be a slot the operator did not mean: Identify
  after shows which.
- Address a new slot initializes every feeder the scan finds before it
  asks 0xC3, as OpenPnP's wizard does (it has the operator take every
  feeder out instead). Without that step even an addressed feeder that
  merely is not initialized yet answers, and alone it would be given the
  new address; the route test fails that way when the step is taken out.
- Set address moves the file's [[slot]] for the old address to the new
  one (Q67 A), and every feeder whose `slot` named the old one. The
  store's `patch` writes one value and checks the whole file, and a
  feeder's `slot` must name a [[slot]], so the pins are taken out first
  and put back after: one write for the slot and two for each pin, each
  of a file that reads.
  Address a new slot moves nothing: a feeder with no address has no
  [[slot]] (the parse takes 1 to 254 only).
- The photon firmware answers a feed before it moves and hears nothing
  during the move (it clears what came meanwhile), so status asks during
  a feed time out rather than answer busy (STATUS_FEEDING_IN_PROGRESS is
  never sent). The host keeps asking either way; the virtual bus still
  answers busy, as OpenPnP's reading has it.

## The check, the file writer, slots by camera

- `part_feeders` (openpnp.py) is the top of `plan()`'s loop, taken out
  whole: the job's own reasons, then `feeder_for`, then "no feeder holds
  it". It needs no fit and no counts, so the check reads the list a plan
  reads and the two cannot disagree. The bottom camera, a slot not known
  and an empty feeder stay in `plan()`: they need the nozzle centered,
  the slots the run's search found and the counts. The check says the
  last two in its own words (`place_known`, `left`).
- Where the bus last answered (`Backend._bus_seen`, bus id to address)
  is read from `FeederBus.found` once a scan, a scan by id or
  `_found_slots`'s search is done, so the bus code and `_found_slots`'s
  `except` stay as they were. The newest answer stands: a scan of every
  address replaces it all, and a scan by id or a search forgets an id it
  asked that did not answer. Kept only the first answer, a feeder taken
  out of its slot would still show its place known. `_close_gcode`
  forgets all of it (a disconnect, another machine connected, a lost link
  connected again), and it is read only while that machine is connected.
- A bus feeder whose file names its `slot` has its place known whatever
  the bus answered, as the contract between the agents has it. Moved to
  another slot, a run's advance at the file's address fails and leaves
  its parts out; the check shows where it answered and calls it no
  problem.
