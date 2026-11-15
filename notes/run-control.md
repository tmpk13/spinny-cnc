# Stops, pauses, resets and resuming

## A reset takes the modal words with it

The firmware keeps `F` and `S` modal across `cut` lines and forgets them
on a reset, which is right: after a reset it deliberately knows nothing.
The streamer used to lean on that, writing them once per group and after
every rapid, so a machine reset part way through a run left every line
after it refused with `error:3 missing word`, one per line still on the
wire. Eight of them in a row is what that looks like from the console,
and none of them says the word reset.

Every cut now carries its own `F` and `S`. It is about a third more bytes
on a line that is nowhere near the wire's limit, and it removes the whole
class: no line depends on one before it. The runner also watches the
link's banner count, since the firmware announces itself at every reset,
and stops the run with "the machine reset during the run" rather than
streaming into a machine that has forgotten where it is.

## A stop that started the machine again

Hold, then stop, and the machine turned the laser on and swung the table
most of a turn. Two faults, one on each side of the wire, and the second
one was hidden by a bug until the other was fixed.

The host's one is the cause. A sender that has spent its credit waits for
one to come free, and the loop that waits checks the abort flag each time
round. But the credit came free precisely because the stop's reset failed
everything outstanding, so the waiter fell out of the loop and wrote its
line without looking at the flag again. The firmware, idle again after the
reset, took it and moved. The line was a ring piece whose angle was 402
degrees against a machine sitting at 15, so one line was most of a turn,
with the beam on. The check now happens after the wait as well as inside
it.

The firmware's one is that a reset threw away the planner, the pending
line and the motion, but not the lines already parsed and sitting in the
port's queue behind it. Those ran once the alarm was cleared. The reader
now drops them when the reset byte goes past, which keeps the byte order:
lines sent after the reset are the new host's and still run.

Both of these were what the earlier burst of `error:3 missing word` was:
the stray line was written after the stop, and until every cut carried its
own feed it was refused for want of one. That refusal was doing the work
of a safety interlock by accident, and fixing the feed turned it into
motion.

## A reset from the console during a run

Two more ways one line could go out after the machine had been emptied,
both on the host. The link dropped the outstanding lines before it wrote
the reset byte and announced the freed credits at once, so a sender that
had been waiting for one could write its line between the drop and the
byte: the firmware flushed a line the link still expected an answer for,
and every answer after it would have gone to the wrong line. And the
runner only learned of a reset it had not sent itself from the banner,
which arrives some milliseconds after the credits come free; the console's
reset during a held run let up to sixteen lines into a machine that was
Idle again and ran them.

The link now holds one reentrant write lock across a reset's drop plus its
byte and across a line's queueing plus its bytes, and tells the dropped
lines' callbacks before it announces the credits. The runner treats a line
dropped by a reset it did not send as the end of the run, checks the
restart count while it drains, and the console's reset tells the runner
before the byte goes out. Hold and resume from the console go through the
runner as well, so the run's state follows the machine's.

## The stop that reset a moving machine

The third pass over the findings went through the runner, the app
routes, the page's views and the mock.

- `!` put the machine in `Hold` at once and the report said so while up
  to a ring of motion plus the ramp still ran; every stop from motion
  reset a moving machine, raised `Alarm:1`, and the runner unlocked it
  in silence. The firmware now reports `Hold` only once the brake has
  finished, the runner never unlocks, retries the hold when a line the
  hold overtook starts motion, and leaves an alarm with a message.
- Hold/resume could overwrite a run that had just finished; a thread
  outliving the stop's join could reset the next run; the drain timeout
  reported `done` for a busy machine; jogs went through while a run was
  being planned from where the head stood. Runs now carry their identity,
  `start` refuses while the old thread lives and re-checks the start,
  and the drain ends as `error`.
- An infinite tolerance was persisted and planned every board line as a
  spiral; a `spy://` url truncated any file; a board move past `r_max`
  ran to the limit before the refusal; a settings write applied values
  before a refused one; cross-origin form posts and websockets ran; the
  console's typed `!`/`~` bypassed the run; `passes` and upload size were
  unbounded; two jogs in flight shared a start.
- The page dropped the selection on a refused delete, deleted without
  asking, rebuilt the groups table under a field being typed into, hid
  the run's reason, dropped a zero tolerance as "nothing changed",
  confirmed a beam of "0 ms", filled a blank goto axis from a mid-move
  readout, and asked phones for a keypad without a minus.

## A pause that ended the job, and a hold that missed its line

- `go`/`cut` were refused with `error:5` in `Hold`, so a host that trailed
  the machine and sent its next line during an operator's pause had the
  run ended and the machine reset. The firmware takes motion lines in a
  hold of a run and keeps them for the resume, like a line taken in just
  before the hold; the runner also sends nothing while its run is held.
- `!` on an idle machine did nothing, even with a motion line taken in or
  still waiting: `go R10` followed at once by `!` ran the move, and the
  page said hold while the machine cut. The hold is latched onto the next
  motion push (or dwell start) when a line is pending or waiting, dropped
  again once nothing motion-like came of it, and cleared by resume and
  reset.
- The link's status request took the first report after its capture of
  the count, which could be the answer to a poll sent a moment earlier;
  in the stop sequence a pre-hold `Idle` then let the reset land on the
  brake. Requests are counted and each waits for its own report; an
  unanswered request resyncs the count rather than shifting every later
  answer.
- The axis snap was half a word quantum, so a pass 1 to 50 um from the
  axis went out as chords sweeping half a turn at the table's limit, tens
  of seconds of full power on one spot under `mode const`; the snap is
  the chord tolerance now, on the host and in the command line emitter.
- `laser off` and `mode` are sync commands: mid-run they stalled the cut
  and let it go on. The page's laser-off is the run's hold while a run is
  active, and `mode` answers 409.
- Angles keep growing with every pass round the axis and the firmware
  holds them in single precision; the runner renumbers the table angle
  within a turn (`set A`) before it plans a job.
- The laser pin was claimed low at boot, the lit level under
  `laser_invert`, until the settings were read; the polarity is read from
  flash first and the pin claimed at its off level.
- A reset that no banner answered was reported as a clean stop.

## A stalled controller, picking a run up, and probing less (2026-10-13)

The F.Paste stencil job on the mill stopped at 27213 of 33205 lines with
the host showing `Run` for 17 minutes: the controller's USB writer had
stopped (polls were still accepted at the Pi, nothing came back), the
host's credits were all out, and the sender waited on a credit for ever.
The job was then powered down. What came out of it:

- The link closes itself after `STALL_SECONDS` (3 s) with status polls
  unanswered, with that reason. Everything waiting fails, the run ends as
  an error naming it, and the page shows the report's age (`machine.age`)
  before that. Closing rather than flagging: late answers to the dropped
  lines would otherwise be matched to new ones. A port with nothing behind
  it closes the same way, which is what one wants.
- Picking a job up at a line: the plan is remade from the recorded start
  joint (the resume record keeps it; `var/resume.json`, written every
  second by the runner's checkpoint), the lines before the count are
  skipped, and an approach brings the head there: lift to the travel
  height, over the point, `spindle S` with the speed in force, the
  spin-up dwell, and a plunge to the depth the next cut starts at. Every
  piece now carries `h`, the height it leaves the head at, which is what
  the approach reads. `rewind` goes back to the path's first line (over
  cuts, turns and the plunge, then the rapid) so a count a line off cannot
  skip a segment. On the polar machine `renumber_for` declares the table's
  angle in the plan's unwrapping first; a cartesian plan's lines do not
  depend on the start beyond the first rapid, which is why the resume for
  a record without a start is still exact there.
- `ok` means queued, not run: the firmware had very likely run the 16
  unacked lines too, so the real resume point was `sent`, not `acked`.
  The default stays `acked`, the safe side; the record keeps both.
- Probing around a job: `Grid.mask`, the corners of every cell a cut
  passes through (segments marked in pieces of half a cell, bbox plus
  margin plus half the spot). `height_at` falls back to the nearest
  probed corner only for a corner left out on purpose; a wanted corner
  still null raises as before. `check_covers` samples every cut at half a
  cell and refuses one over a cell without all four corners probed.
- One probe under the head (`/api/heightmap/touch`): `map` sets
  `focus_offset = old + (contact - map.height_at(tip))`; `focus_known`
  survives frame changes so the shift applies to the eye-set offset of a
  laser, and a spindle's first touch (offset 0 + shift) is the touch-off
  itself. `zero` sends `set H{travel - contact}` after the rise.
- The spindle's speed control is a host setting (`speed_control`, in
  `[host]` too): off, every `spindle S` asks for `s_max`. Host side, since
  the firmware maps S to duty linearly and has no on/off mode; a relay
  behind the PWM pin would chatter at a group's rpm.
- V bits in CAM profiles: `angle` and `tip` give the cut width at the
  operation's depth (`tip + 2 d tan(angle/2)`, bounded by `diameter` as
  the shank); `resolve` puts it in `cutting["width"]`, and camjob reads
  that rather than `tool.width` everywhere a width shapes geometry.
- The Pi deployment is back (`deploy/deploy-pi.sh`), now with the backend
  keeping its own link (`spinny-web --connect auto`): a controller that
  is given up or replugged is taken up again every 5 s unless the
  operator closed the link from the page. The relay and the service
  cannot share the port.
- Frontend: Firefox positions a sticky box relative to the scroll
  container's content edge, Chrome and Safari to its padding edge, so the
  wide columns carry their top gap as the first panel's margin and both
  agree. The code editor's caret and scroll are remembered and restored
  across a page hide (`display:none` destroys the scroll box); the
  overlay layer gets the textarea's scrollbar gutter so both scroll
  ranges agree. The preview caches its still layers in offscreen canvases
  keyed by job, camera, size, colors and probe grid, and skips drawing
  while hidden.
- Tests that assert the shipped machine files' numbers (the slide's
  travel) were the user's measurement waiting to fail; they assert what
  the file says now.

## Writers of one job take turns (2026-11-09)

The job store holds a lock per job (`JobStore.editing`) from a writer's
read to its save, through the `editing_job` decorator in app.py: patch,
replace, another width or margin, alignment and Run. A patch made during
a width re-cut was lost when the re-cut saved over it, and a job deleted
during a re-cut came back. A delete waits for the write under way,
`save` refuses an id no longer stored, and a Run pressed during a re-cut
waits and runs the job made again. `NotFound` moved from cam.py to
jobs.py (cam.py imports it) so the store can raise it.

## Pickups after a change, and the last known position (2026-11-09)

- The estimate prints the plan's lines without their F, S, M, T and H
  words, and the record keeps it as `fingerprint`. A pickup whose plan
  prints otherwise (re-cut, regrouped, turned, paths deleted, the map
  followed otherwise) is 409 unless `changed: true`; power, speed, depth,
  focus value and a map re-tie still pick up. Old records have no print.
  The mock plans a pickup from the run's own start, as the backend does.
- The kept last position is held at every connect and when an unasked
  banner shows a restart (saved in position.json), so the power-on zeros
  no longer replace it before Last known can use it. It is let go when the
  new link's first report reads the same joints, the `diag` uptime shows
  the board was up before the kept report, a position is declared naming
  R, A or Z, or a home finds an R, A or Z switch. A focus height declared
  alone does not let it go.
- A run left `running` by a host that died counts as one that did not
  finish. test_resume's `acked == 5` raced the run's thread acking a line
  before the route read the progress.
