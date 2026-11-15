# Backend: link, runner, moves and requests

## Serial port

pyserial's `open()` ends with a flush of the input buffer, for both device
paths and `socket://` urls. The firmware prints its banner the moment the
host connects, so that flush would eat it. `open_serial` replaces
`reset_input_buffer` and `_reset_input_buffer` on the instance with no-ops
before opening, and the link asks `version` when no banner shows up within
300 ms anyway.

Bytes are accumulated and split on newline before decoding, so a status
report cut in half by a read boundary is never seen as two lines. On a
`socket://` port `in_waiting` is only ever 0 or 1, so the reader blocks on
`read(1)` and then drains whatever `in_waiting` reports.

## Credits

The firmware answers every line in order, so the oldest outstanding line
owns the next `ok` or `error:` and any unclassified line (settings, help)
before it. Senders take a lock while they append to the outstanding queue
and write, so two threads cannot interleave a line and its answer.

A reset byte drops every outstanding line locally: the firmware flushes
them and will not answer. The banner the firmware prints after a reset is
expected and does not count as a second restart; an unasked banner at any
other time does, and drops the outstanding lines as well. `version` answers
with a banner too, which is attached to that request instead.

## Axis crossings

`polar.subdivide` only recognizes a turn when the current point is exactly
on the axis. A segment through the axis but not bisected onto it would
otherwise become a chain of micron pieces sweeping the angle by nearly half
a turn at radius zero, which is inside tolerance but pointless. The
streamer pre-splits any segment whose closest approach is under half a
coordinate quantum (0.0005 mm at three decimals) at that point, snapped to
the axis, so the crossing is a radial cut in, `go A` on the spot with the
beam off, and a radial cut out. The snap moves the line by less than the
rounding already does.

Exact half turns are ambiguous: `unwrap` picks the negative direction, so
a jog from `(5, 0)` to `(-5, 0)` turns to `A-180`. Tests accept either.

## Time estimate

Per piece `max(surface / F, |dr| / r_rate, |da| / a_rate)` in minutes, with
the firmware's surface length `hypot(dr, r_mean * da_rad)`, plus rapids at
the max rates. Acceleration is ignored, as in the gcode tool. The job's
`stats` are computed from joint `(0, 0)` when imported and again from the
machine's real position when a run starts, since the first rapid depends
on it.

## SVG units

svgelements parses with 96 dpi and applies the viewBox and the root width
and height, so a file with `width="100mm"` comes out in millimeters after
dividing by its own px-per-mm factor; a file with a bare viewBox is in CSS
pixels, 25.4/96 mm each, which is what browsers and Inkscape assume. Y is
flipped so the board has y up. Every shape type is read through
`Path(element)` plus `reify()`, which applies nested transforms.

## Jogs while jogging

A board jog is absolute (`jogto`), so it has to know where it starts. The
reported position is wherever the previous jog has got to, so two quick
clicks would aim the second jog from a point the machine was already
leaving. The backend keeps the end of the last jog it sent and, while the
machine reports `Jog`, starts the next board move from there. A relative
joint `jog` only records its end when it started from `Idle`, since what
the firmware takes a relative jog from mid-move is not pinned down. A
cancel, a reset, a refused line or a `set` forgets the target.

## Runner

A refused line (`error:`) sets the abort flag from the reader thread; the
streaming thread then holds, resets and unlocks exactly as a stop does,
because the rest of the planner queue would otherwise keep cutting. The
run only reports `done` once every line is acked and the status shows the
machine idle, since an ack only means the move was queued.

`Runner.start` asks for a fresh status instead of using the cached one:
after a stop the cached report still says `Alarm` for up to one poll
period. The status and the estimate run outside the runner's lock: the
status answer is delivered on the reader thread, which takes that lock for
every snapshot it publishes, so holding it while waiting would stall the
reader. The stop sequence likewise asks for fresh reports only and stops
waiting as soon as the machine is held, idle or alarmed.

The stop sequence is hold, wait for rest, reset. The firmware reports
`Hold` only once its brake has finished (until then the report keeps
`Run`/`Jog`), so a reset sent on seeing `Hold` lands on a still machine
and raises no alarm; the runner therefore never sends `unlock` on its
own. When the machine is still moving after `HOLD_WAIT` the reset goes
out anyway, since a stop must stop, and the run carries a note that the
position may be off with the alarm left for the operator; a reset the
operator sent from the console keeps its alarm the same way, because the
thread does not halt a machine that has announced itself again. A hold
that goes out ahead of a line the machine has not taken up yet finds
nothing to hold, so the wait sends `!` again whenever a fresh report says
`Run`/`Jog`, and an `Idle` report with line slots in use is not rest yet.
A stop whose bytes cannot reach the machine ends the run as `error`: the
machine is still cutting what it had.

Each run's thread and callbacks carry their own `Progress`; `_fail`,
`_finish` and `_on_ack` act only while that object is still the current
one, and `start` refuses while the previous thread is alive, so a slow
halt cannot reset the run after it. `hold`/`resume` change the state only
from the state they checked; a run that ended in between stays ended. A
run is `active` from the moment its plan is being made, which refuses
jogs and position declarations for that window, and the start re-reads
the status after the estimate to be sure the head did not move. The
drain gives up as `error` an hour after the last answer, time spent held
not counted, rather than reporting `done` for a machine still busy.

A `Pending` distinguishes an answer (`ok`, `error:`) from a local drop (a
reset, a lost port); only answers count towards `acked`. An answer that is
already on the wire when the reset byte goes out is dropped as well: its
pending was failed before the bytes arrived, and an `ok` with nothing
waiting is ignored. Any exception in the streaming thread, not just link
errors, ends the run as `error` after the usual halt, so a fault can never
leave the run marked as running.

## WebSocket

Events are flattened, `{"type": ..., ...payload}`, because the API doc
lists payload fields rather than a wrapper key. One asyncio queue per client
with `put_nowait`; a full queue drops the event for that client only.

## The cross slide

`Z` never shares a line with `R` or `A`: the firmware refuses the
combination, since the three are not interpolated together. So
`POST /api/jog` and `POST /api/goto` refuse a body that carries `dz`/`z`
beside a radius or an angle, and `POST /api/position` sends the `R`/`A`
declaration and `set Z` as two lines when it is given all three.

A slide move is sent straight to the link rather than through the jog
bookkeeping: it leaves the beam where it is on the board, so the end of the
last board jog still stands as the start of the next one.

`Status.z` defaults to 0.0 and the field is read only if the report carries
it, so a firmware built before the axis existed still connects and reads as
a machine with the slide at zero.

## Requests a page from elsewhere can make

CORS only decides whether a page may read an answer; a browser sends a
form post, or opens a websocket, to any origin without a preflight. Every
body-less route (`/api/run/resume`, `/api/unlock`, ...) and the multipart
upload would run from a hostile page's auto-submitted form. `OriginGuard`
refuses a non-GET request or a websocket whose `Origin` is neither the
server's own (scheme and `Host` header) nor a `--cors-origin`; requests
with no `Origin` are not a page's and pass. `--allowed-host` adds
Starlette's trusted-host check for DNS rebinding, off by default because
the operator reaches the backend by whichever name or address they like.

## Settings, all or nothing

Values are checked here first (finite numbers or bools; a string must
parse as a number), and a value the firmware still refuses has the ones
already sent put back to their previous readings; the host tolerance is
stored only after the machine's part went through. The tolerance is
bounded to `(0, 10]` mm and `config.json` is written with `allow_nan`
off: an infinite tolerance once reached the file as `Infinity`, came back
on every start, and planned every board line as one joint line.

## Serial urls

pyserial resolves more schemes than the two the machine is reached by,
and `spy://` opens a file named in the url for writing before the port
behind it. `check_url` admits only a `/dev/...` path, a `COMn` port or
`socket://host:port`, before the url is handed over.

## Board moves and the soft limit

The firmware checks `r_max` a line at a time; a board move sent as
several `jogto` lines would run the ones inside the limit before the
refusal came back. The backend refuses the whole move against the cached
`r_max` first, and a `$name=value` typed at the console clears that cache.
Move requests are served one at a time, since each plans from the end of
the last.

## The feed floor

The firmware refuses an `F` below 0.001 mm/min, and the host writes `F`
with three decimals, so a speed or feed in (0, 0.001) passed every host
check and went out as `F0`: a job died on its first cut, a jog answered
400 from the machine. `check_speed` and `check_feed` refuse at the
firmware's floor. `split_at_axis` lives in the shared `polar` module now,
since the command line emitter cuts paths at the axis the same way.

## Which report answers a status request

Reports answer `?` bytes in order, and the poll thread sends one every
100 ms or so. A request that waited for "the next report after now" could
take the answer to a poll sent just before it, a report from before its
own byte arrived; `status_now` counts requests and waits for the report
numbered after every request already out. A request that times out
resyncs the count to the reports seen, so a machine that restarted under
an unanswered `?` does not put every later answer one behind.

## Machine files on the page

`machines.py` is the CAM profile store's twin for `machines/`: listed,
read, checked, saved whole after a parse and removed. A file that does
not read is listed by id with its problem and still opens with its text,
unlike a CAM profile, because the Config page exists to mend such a file.
Two pin settings on one GPIO are refused by the parser, not the firmware:
the firmware takes settings one at a time, so a swap could never go
through if it checked, and a load of a file that moves the laser onto the
tool output's default pin would be refused on the first write. The pins
and `tool_out` are read at boot; the page compares them before and after a
load and says to save to flash and restart.

## To-do, reports, plugins (2026-11-13, an agent's)

- FastAPI 0.142: include_router puts an _IncludedRouter entry in
  app.routes, not APIRoutes, so test_tools.py's route lists cannot see
  them; new modules register with add_routes(app, ...) (skill
  fastapi-include-router-hidden-routes).
- todo.py: the list and its revision in var/todo.json, written whole
  under a lock. reports.py: ReportDesk on app.state.reports (tests swap
  its httpx transport); ids are time plus a serial as the search log's;
  a GitHub link gets the newest actions that fit under 6000 characters
  (found by halving), the text cut with a note past that; the report is
  kept whatever the link does; a POST waits 10 s and follows no
  redirects. plugins.py: plugins.json keeps the `written` and `enabled`
  SHA-256 per plugin and a `rewritten` mark; module.js is served only
  while on, as the hash in ?v=, which closes the race of a rewrite
  between the page's list and its import; every change through the
  routes publishes {"type": "plugins", ...}. A file edited by hand sends
  no event: pages pick it up at load, on the Plugins tab, or on a
  reconnect.
