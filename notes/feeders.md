# Feeders (2026-11-19)

The feeders plan as built ([docs/FEEDERS.md](../docs/FEEDERS.md)): what
was not obvious, and why it is the way it is.

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
  asked that did not answer. Were the first answer kept, a feeder taken
  out of its slot would still show its place known. `_close_gcode`
  forgets all of it (a disconnect, another machine connected, a lost link
  connected again), and it is read only while that machine is connected.
- A bus feeder whose file names its `slot` has its place known whatever
  the bus answered: the file says where it is. Moved to another slot, a
  run's advance at the file's address fails and leaves its parts out; the
  check shows the address it answered at but names no problem.
- `append_table` (cam.py, beside `set_value`) refuses a null rather than
  leave its key out: TOML has no null, and a key dropped without a word
  would hide a value the page meant to set. The new table goes at the
  file's end after one blank line, as the page's `withSlot` put a slot;
  in TOML a `[[feeder]]` after other tables is still the array's next
  element. It checks only that the table reads back; the store's save
  reads the whole file, so a second feeder of one id or a key the table
  does not take is refused there, with the machine parse's words.
- A slot taken with the top camera (`POST /api/pnp/bus/slot`) adds the
  measured offset only, never the file's as designed: the file keeps
  plain numbers, which cannot follow a later offset the way a reference
  does (`reference_place`), and the design offset missed on a LumenPnP.
  The camera gives no height, so Z is the slot's own, else the mean of
  the other slots when they lie within 0.05 mm (Q66 A): the LumenPnP's
  slots share one height, so one careful descent with the nozzle serves
  every slot after it.
- Slots are written with 3 decimals spelled out (`100.000`), as the
  page's `withSlot` wrote them, through a `Decimal` that `format_value`
  writes as spelled; a float would have come out `100.0`.
- `MachineStore.put_slot` finds the slot's index in the text it read
  under the store's write lock, not in the parse the request began with,
  so an edit by hand in between cannot put the place in another slot. The
  answer's slot comes from the saved document, not from the store's parse
  cache, which is keyed by the file's mtime and would hand back the old
  parse after two writes within one timestamp tick.
- `find` runs in the request, not on the top camera's routine thread,
  since the answer carries the slot; it holds the move lock and builds
  its own `GcodeMover`, as the routines do. It passes the measured offset
  to `look_at`, so a scale not measured says so instead of "offset not
  measured". The slot is the look's last `seen` (the head plus the offset
  plus what the picture still showed), finer than the head plus the
  offset by up to the centering tolerance. The shade is the pocket of the
  feeder the bus last answered for at that address, else of the feeder
  whose `slot` it is.

## The page

- **The check is the store's, asked by the page and never polled**
  (src/views/feedercheck.ts). It keeps a key of everything its answer
  depends on in the page's state (the job, the parts asked for, the
  machine and whether it is connected, the file's feeders and slots, the
  counts), so a `placing` event, which comes with every status report,
  asks nothing unless one of those changed. A scan asks again whatever the
  key says: where the bus answered is known to the backend alone. A kept
  out part ticked to be placed changes only localStorage, so the Parts
  panel's box asks itself.
- **A failed check is kept with its reason, not toasted.** It runs by
  itself on every change; the Feeders step's line says why there is none.
- **The step's line is made from the check's fields, not its `problems`.**
  The line has room for one sentence: the counts first, then the parts no
  feeder holds (three named, the rest counted), then two feeders' wants and
  a count of the rest. `problems` are the backend's words for a list.
- **Auto stops at Feeders only when a check is back and not ready.** With
  none back (a page that never mounted the panel) it goes on to "Ready to
  place" as before, rather than wait for an answer nothing will ask for.
- **The mock's plan loop is split as the backend's** (`partFeeders` in
  src/mock/openpnp.ts, the twin of `part_feeders`): the plan and the check
  take the same parts for the same reasons. Each entry keeps its place in
  the plan's order, so `skipped` lists the job's reasons and the parts no
  feeder holds interleaved, as before the split.
- **The panel's rows hold one button at most, for the budget.** A feeder's
  row has none: Feed and Count again act on the feeders picked, in a row
  under the list put away while none is picked (a pick is what they
  need, and the row comes with it). A scan's row opens in place on what is
  done to its address now and then, and shows the one button it wants:
  Add feeder for an id the file lacks, Slot here for a slot with no place.
  Opening Add feeder draws the rows again, so a test reads the row anew.
- **Add feeder makes a feeder on the bus only.** A strip or a tray needs a
  place, a pitch and a count measured at the machine, which the plan
  leaves to typing by hand; a file with no `[bus]` lists the parts with no
  feeder and offers nothing. The form never sends a null (the backend's
  writer refuses one: TOML has none), so a part named by reference leaves
  `match` out. Its advance is guessed from the footprint (2 mm for 0201
  and 0402, else 4), and its id from the value and the footprint's kind and
  size ("10k-r0603"), numbered when the file has it.
- **The mock's LumenPnP has feeders of its own** (`MOCK_LUMEN_FEEDERS` in
  src/mock/machines.ts, appended to the shipped file's text; the shipped
  file stays without), and its bus a feeder no file names
  (`MOCK_BUS_LOOSE`, address 3), so the budget's Feeders shot, which opens
  the mock's board and scans, is measured full: a part no feeder holds,
  three feeders, three scanned rows: 40 controls and 161 words with the
  More of item 5, the budget's limit, so the next control there goes
  under a fold.
- **The feeders table's place cell wraps.** With every cell on one line,
  the place pushed what a feeder has given, where the check's want shows,
  out of the side panel's width.
- **Slot here goes by the camera once the top camera's offset is measured**
  (`placing.top.offset`; the file's design offset does not count, as the
  backend refuses it), else by the nozzle; the tooltip says which, and the
  other way is under the row, locked with its reason while it cannot act.
  Whether a slot has a place is read from the file now, not from the
  scan's answer: a slot taken since the scan would otherwise still ask
  for Slot here and offer no Camera over slot. The page no longer writes a
  slot's text (`withSlot` went): the backend is the slots' one writer.
- **Identify and the two floor writes.** Identify sits with Feed in the
  picks' row (the picked feeders on the bus flash in turn) and under a
  scanned row (that id). Set address is under a row, Address a new slot
  under the panel's More: both write to the hardware and are not undone
  by a press, so both ask first, the address in the question and on the
  button. The address offered is the lowest no feeder answered at in the
  last scan and no `[[slot]]` names; the page does not know the file's
  `max_address` (the document carries no bus profile), so the backend's
  refusal says the range.
- **The mock's bus models the floors.** `MOCK_BUS_LOOSE` units may have no
  address (the LumenPnP has one: Address a new slot finds it) or no floor
  chip (`floor: false`: the write fails); an address written is kept by
  the feeder's id (`busFloors`) and outdoes the file's slot and the
  fixture's address. Identify and program act on that state directly,
  not through packets.
- **A test's afterEach must not set a shared knob to anything but what
  tests/setup.ts sets.** bun runs every file in one process: a reset of
  `confirmSettle.ms` to the page's 250 made every later file's confirm
  ignore its press, and the failing run climbed past 6 GB before it was
  killed; a green run peaks near 1 GB.

