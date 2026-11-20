# Feeders plan

A plan, written 2026-11-19 and built the same day (f4ff832 to 36fac3f),
for five changes that make the feeders usable on the LumenPnP: a
pick-order bug, adding a feeder from the page, taking slot places with
the top camera, a Feeders step that checks the job, and Photon's
identify and floor commands. The options applied where only the owner
can decide are in [QUESTIONS.md](../QUESTIONS.md) (Q65 to Q67). How
feeders work now: [OPERATING.md](OPERATING.md) (Feeders, Feeders on a
bus), [MACHINES.md](MACHINES.md) (the keys),
[notes/feeders.md](../notes/feeders.md) (why, and where the build went
its own way).

## Where it stands

- All five items are built and tested against the virtual LumenPnP and
  the page's mock. None of it has run on the real machine yet: the bus
  code still rests on a reading of OpenPnP's and the feeders' firmware's
  source, and the virtual bus was written from the same reading, so a
  misreading would pass every test.
- Where the build differs from the text below: *Add feeder* makes bus
  feeders only (a strip or tray needs places measured at the machine);
  the check names no problem when a bus feeder's file `slot` differs
  from the address the bus answered at; the page cannot bound the
  address it offers by `max_address`, which the machine file's summary
  does not carry; the Feeders view holds exactly 40 controls, so the next
  control there goes under a fold.
- The first hardware steps: *Scan bus*, *Identify* and *Feed* one
  feeder, then feeders (*Add feeder*) and slots (*Slot here*, the first
  with the nozzle), the vacuum's `part_on` and `part_off`, and a
  `[motion] discard` checked with the top camera.

## Order

1 with 5a, then 4, 2, 3, 5b and 5c. Item 1 and 5a are small fixes, and
5a keeps a feeder with no address from turning a feed into one sent to
every feeder. Item 4 tells what is missing, and item 2 adds a feeder from
what it finds. Item 3 shares item 2's writer, the code that adds a table
to the machine file. Item 5c is the only one that writes to the
hardware: the slots' floors. Each item is its own commits with
`mise run test` green, the page's budget held (`mise run test-budget`:
40 controls and 200 words in a view's first sight), and its docs updated
in the same commit. Each new route gets its twin in the page's mock
(`web/frontend/src/mock/`), as every route has while Q9 stands.

## 1. Look into the pocket after the tape moves

**The bug.** `Placer._place` ([placer.py](../web/backend/src/spinny_web/placer.py))
looks into the pocket (`feeder.pocket`), then advances a bus feeder
(`_advance`), then sends `pick_lines`, which begin with the feeder's
`feed` lines. For a feeder that advances, the look sees the pocket
*before* the tape moves. On the first pick it sees the part about to be
moved on. From then on it sees the pocket the last pick emptied, calls
it empty, and goes on to the next try without advancing. Every try sees
the same empty pocket, the part is left out, and two parts left out in a
row stop the run. No test pairs `pocket` with `bus_id` or `feed`.

**The change.**

- A feeder advances when it has a `bus_id` or `feed` lines. For such a
  feeder each try runs in this order: advance (the bus feed and its wait,
  or the `feed` lines), then the pocket look, then the pick. A pocket
  that looks empty is counted taken, and the next try advances again.
- `pick_lines` gets a flag that leaves the feed lines out. The run sends
  them itself before the look. The program the Plan shows and downloads
  keeps them in place, so the text reads as it does now.
- Strips and trays keep the look before the pick, unchanged.
- A part rejected from a feeder that advances, with no `[motion]
  discard`: today it is put back at the pick point, and the next feed
  carries it away on the tape, loose. Q65 (recommended: stop the run
  with the part held, saying to set a discard place).

**Tests** (backend, `test_placer.py` with the bus fixture from
`test_feederbus.py`):

- A bus feeder with `pocket` places two parts. The bus log shows a feed
  before each look, and the run leaves nothing out.
- A pocket the camera sees empty after a feed: the next try feeds again,
  and the part is placed from the next pocket.
- A `feed`-lines feeder with `pocket`: its lines reach the machine before
  the look.
- The existing strip tests stay as they are. The program text is
  unchanged (compare a plan's text before and after).

## 4. The Feeders step checks the job

**Now.** The Run view's Feeders step ([areaviews.ts](../web/frontend/src/views/areaviews.ts),
`placingSteps`) is never done, and its tip promises "what is loaded, low
or missing". Only the Plan, under Place, says that a part has no feeder,
and the Plan needs the board's place first.

**The change.**

- Backend: split the loop at the top of `plan()`
  ([openpnp.py](../web/backend/src/spinny_web/openpnp.py)) into
  `part_feeders(machine, parts, refs)`. It returns each part to place with
  its feeder, or why it is left out, and needs no fit. `plan()` calls it,
  so the check and the plan cannot disagree.
- `feeder_check(machine, parts, taken, seen)` turns that into:
  - each part with its feeder;
  - each feeder with the parts it must give, what it has left (`count`
    less taken; none for a feeder with no count), and whether its place
    is known;
  - for a bus feeder, the address it last answered at, if any;
  - a list of problems in words.
- The backend remembers where the scans found each bus feeder (`seen`,
  from a scan or from a run's search by id) until the machine
  disconnects. The check never asks the bus, so it costs no line time
  and can run on every refresh.
- Route `POST /api/pnp/feeders/check` `{"job", "refs"?}`. Nothing moves.
- Page: the Feeders step is done when every part to place has a feeder,
  every such feeder's place is known (a bus feeder: a `[[slot]]` for the
  address it answered at, or its `slot` key), and no feeder has fewer
  parts left than the job needs. Its line counts them: "14 parts from 6
  feeders; R3 and R4 have no feeder; c-100n has 3 left of 5." The step
  stops being optional for a G-code machine.
- The Feeders panel shows the parts with no feeder above its list, each
  with *Add feeder* (item 2).
- It refreshes when a job or its parts are picked, on a `placing` event
  (the file or the counts changed) and after a scan. It is never polled.

**Tests.** `part_feeders` gives the same parts and reasons as `plan()` on
the existing plan fixtures. The check's results: no feeder, empty, short,
slot unknown, seen on the bus. The route, and its mock twin (the mock's
`feederFor` already matches parts). The page: the step's done and its
line for each case.

## 2. Add a feeder from the page

**Now.** A scan row whose id no feeder has says "no feeder in the machine
file has this id" and offers nothing ([pnpfeeders.ts](../web/frontend/src/views/pnpfeeders.ts)).
The panel says to write `[[feeder]]` tables by hand on the Machines page.

**The change.**

- Backend: `append_table(text, name, values)` in
  [cam.py](../toolpath/src/spinny_laser/cam.py), beside `set_value`. It
  adds a `[[name]]` table at the end of the text, keeps the comments, and
  is refused when the result does not read back. `MachineStore.append`
  and the route `POST /api/machines/{id}/tables` `{"table", "values"}` use
  it. The store's parse checks the whole file, as a save does now.
- Page: *Add feeder* on a scan row with an unknown id, and on each part
  with no feeder (item 4). The form opens in place (UI_PRINCIPLES:
  rows that open in place) with these fields:
  - `id`: suggested from the part's value and footprint, e.g.
    `10k-r0603`.
  - The parts: one of the job's value and footprint pairs that no feeder
    holds yet. This writes `match` as the value and the footprint's name.
    The other choice is the picked references, which writes `refs`.
  - `bus_id`, from the scan row.
  - `advance`, the part pitch: 2, 4 or 8 mm, else typed.
  - *Save* writes the table. Then the panel refreshes, and the step check
    with it.
- To keep the view's first sight within budget, each row has one button
  (*Add feeder*, or none). *Feed*, *Count again* and item 5's *Identify*
  move to a row of buttons that act on the picked feeders, using the
  Shift and Ctrl picks the list already has. The budget already
  measures the Feeders view (`docs/ui/budget.json`, "pick and place:
  feeders", over the mock as the LumenPnP). The mock's machine then gets
  feeders, a scan result and a part with no feeder, so the view is
  measured full rather than empty.

**Tests.** `append_table`: comments kept, the table at the end, a value
that does not read back refused, a second `[[feeder]]` with the same id
refused by the parse. The route, then reading the file back. The page:
the form's POST body from a scan row and from a part with no feeder. The
mock twin.

## 3. Take a slot's place with the top camera

**Now.** *Slot here* takes X, Y and Z from where N1 is, so the operator
lowers the nozzle by eye onto the pick point of every slot. That is slow
over 20 or more slots, and lowering a nozzle near feeders without
looking first is what went wrong on 2026-11-14 (N1 came down over a
tape). The rule since then: look with the top camera before any descent
in Z.
The new slot's text is also written by the page (`withSlot`).

**The change.**

- Route `POST /api/pnp/bus/slot` `{"address", "by": "camera" | "nozzle"}`.
  It reads the head (`_here`, M114) and writes the slot through
  `set_value` (a slot already there) or `append_table` (a new one). The
  page's `withSlot` goes, so slots have one writer.
  - `by: "nozzle"`: as *Slot here* now, X, Y and Z from the head.
  - `by: "camera"`: X and Y are the head plus the top camera's measured
    offset, which is the nozzle's place over the picture's center, as a
    reference taken by camera is read. It is refused without a measured
    offset: a file keeps plain numbers, and a slot cannot follow a later
    offset change as a reference does. Z comes from the slot itself when
    it has one, else from the other slots when they agree within 0.05 mm,
    else the request is refused with "take one slot with the nozzle
    first". Q66.
- *Find the part* (optional, second step): before taking the place, the
  top camera looks for the part in the pick window with the pocket shade
  and centers on it (`top.look_at(..., center=True)`, as a feeder's marks
  are found). The slot is then the part's center, not where the operator
  aimed.
- *Camera over slot*: the head moves at the safe height so the top
  camera's center is over a slot's place. The operator checks each slot
  without lowering anything. Only X and Y move, through `goto_lines`.
- Page: the scan row's slot button takes the place by camera when the
  offset is measured, else by nozzle. Its tooltip says which. The other
  way is under the row's More.

**Tests.** Route tests over the virtual Marlin: the camera place is head
plus offset; Z comes from the slot, then from the other slots; it is
refused with no offset, and on a first slot by camera; the nozzle way
gives the same text `withSlot` gave. *Camera over slot* sends only X and
Y at the safe height. The page and the mock twin.

## 5. Identify a feeder, program a slot's floor

**Sources**, read 2026-11-19:

- OpenPnP's `src/main/java/org/openpnp/machine/photon/` on `main` at
  5bd404c (https://github.com/openpnp/openpnp).
- The feeders' firmware, `photon/src/` on `main` at dc0fd2f
  (https://github.com/photonfirmware/photon). Opulo's feeder repository
  points there.
- Upstream Marlin's `M485.cpp`. Opulo's own Marlin build was not found,
  so whether it sets `M485_PROTOCOL` is still open; protocol 2 adds an
  `echo:` prefix, which our reply pattern's search already allows.

Nothing in them contradicts what the host does now: the header order,
the CRC-8 (polynomial 7, start 0, over every header byte but the crc and
the payload), the host at address 0, and the find (0xC0) sent to 255.

**What the feeder does.**

| Command | Code | Sent to | Payload after the code | Answer |
| --- | --- | --- | --- | --- |
| Identify | 0xC1 | 255 | the 12-byte id | status only, from its address; then it flashes white 3 times (1.8 s) and hears nothing meanwhile |
| Program floor | 0xC2 | 255 | the id, then the address (1 byte) | status only: ok from the *new* address, or 0x05 (fail) from the old one |
| Uninitialized, answer | 0xC3 | 255 | none | `[ok, id]` from every feeder not yet initialized |

- A feeder whose id does not match stays silent, so identify and program
  floor work with any address, a missing one included. Neither needs the
  feeder initialized.
- The floor write goes to the DS28E07 1-wire memory in the slot, is read
  back, and is ok only when the byte read back is the address. With no
  chip in the slot it fails (0x05).
- A feeder's address is the floor's byte 0. With no floor chip it is 255
  (the LED turns red); a byte of 0 counts as not programmed (blue). The
  firmware takes any byte; OpenPnP lets 1 to 254 be programmed.
- OpenPnP's wizard (Machine Setup, Photon, Program Feeder Slots, Start
  Wizard) asks for every feeder to be taken out first. Then it takes one
  feeder at a time into slot 1, 2 and on: it asks 0xC3 until an id comes
  back, programs that id with the slot's number, then initializes the
  feeder there, which stops it from answering 0xC3 again. Two feeders
  that are not initialized would answer 0xC3 at once and garble each
  other.

**5a. A feeder with no address (a safety fix, with item 1).** The find
(0xC0) is answered from the feeder's own address, which is 0 or 255 when
its slot was never programmed or has no floor chip. `FeederBus.find`
keeps whatever address answers. A run would then send its initialize and
feed packets to 0, the host's own address, or to 255, the broadcast,
which every feeder hears. The firmware's feed checks no id, so a feed
sent to 255 moves every feeder that is initialized. The fix:

- `find` treats an answer from 0, 255 or above `max_address` as no slot,
  and says why ("feeder X has no address: its slot's floor is not
  programmed").
- `advance` refuses those addresses outright, whatever gave them.

**5b. Identify.**

- Profile: `[bus] identify = 193` (0xC1), with the default in
  `BusProfile`; the LumenPnP and virtual files spell it out.
- `FeederBus.identify(feeder_id)` sends it to the broadcast address with
  the id. It then waits 2 s before it speaks to that address again,
  because the feeder hears nothing while it flashes.
- Route `POST /api/pnp/bus/identify` `{"feeders": [...]}`: the picked
  feeders flash one after another, and the answer names any that did not
  answer. On a scan row, the row's id is sent.
- Page: *Identify* acts on the picked feeders (item 2's row of buttons)
  and on a scan row, to tell which feeder in the machine is which line.

**5c. Program a slot's address.**

- Profile: `program_floor = 194` (0xC2), `unready = 195` (0xC3), and the
  answer code `fail = 5`, in `[bus]` beside the others.
- `FeederBus.program(feeder_id, address)` sends the floor packet. It
  needs ok from the new address, then initializes the feeder there and
  asks it for its id to confirm. A fail answer is reported as "the slot's
  floor did not take the address: no floor chip, or the write did not
  read back".
- `FeederBus.unready()` sends 0xC3 to the broadcast address and returns
  the one id that answers, or none. A garbled answer means more than one
  feeder answered.
- Two ways in, under the Feeders panel's More (both write to the floor,
  each behind a confirm that names the address):
  - *Set address* on a scan row, for a feeder whose address is known:
    `program(id, N)`. When N changes, the file's `[[slot]]` for the old
    address moves to N, because the place belongs to the slot, not to
    the number (Q67).
  - *Address a new slot*, for a feeder the scan cannot see (no floor
    address). The backend first scans and initializes every feeder that
    answers, so none of them answers 0xC3. Then it asks 0xC3. One id: it
    programs that one with N. None: "no feeder without an address
    answered". Garbled: "more than one feeder has no address: leave one
    in". This spares OpenPnP's "take every feeder out" step.
- Both refuse an N that another feeder answers at (a GetFeederId at N
  first) and an N outside 1 to `max_address`. N is suggested as the
  lowest address no feeder answered at and no `[[slot]]` names.
- Route `POST /api/pnp/bus/program` `{"address", "feeder"?}`: with
  `feeder` (an id from a scan row) it sets that feeder's address; without
  it, it addresses a new slot. The answer gives the address, the id and
  the scan again.

**The virtual bus** (`virtual_pnp.PhotonBus`) learns the three commands
as the firmware answers them:

- Identify: ok, then deaf to that feeder for 1.8 s of the clock.
- Program floor: the feeder moves to the new address and answers from
  there; a slot with no floor chip answers fail.
- 0xC3: one feeder not initialized answers with its id. Two or more give
  a reply that does not check, as a collision on the wire would.
- `spinny-virtual-pnp --unaddressed N`: N feeders sit at no address, to
  try *Address a new slot*.

**Tests.**

- 5a: a find answered from 0 or 255 is no slot, and a run leaves that
  feeder's parts out with the reason. `advance` never sends to 0 or 255.
- Identify: the packet's bytes against the table above; the 2 s wait;
  the route.
- Program: ok from the new address; fail from the old one; a garbled
  0xC3; an N that is taken; the slot's place moving with its address in
  the file. The virtual bus's collision is what makes the "initialize the
  others first" step needed, and a test without that step must fail.
- The page and the mock twins.

## Not in this plan

- Teaching a cut-tape strip from two pockets (its `at`, `pitch`,
  `rotation` and `count` are typed by hand).
- The bottom camera's nozzle centering, which `vision = true` rests on
  ([notes/nozzle-finder.md](../notes/nozzle-finder.md)).
- The hardware steps listed under Where it stands. They need the
  operator at the machine, and the hardware rule applies: ask before
  lowering a nozzle near the bed or the feeders.

## Done when

- All five items are built, with `mise run test` and `mise run
  test-budget` green.
- On the LumenPnP: *Scan bus* lists the feeders, *Identify* flashes the
  right one, *Feed* moves a tape, a slot is taken by camera and checked
  with *Camera over slot*, and a short run picks from a Photon feeder
  with `pocket` set. That run is recorded in notes/pnp-device.md. Floor
  programming is tried on hardware only when a slot needs it, and only
  after asking.
