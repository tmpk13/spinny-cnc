# The G-code link: answers, timeouts, homes and the poll

How the backend keeps a G-code machine's answers in step with its lines
(web/backend/src/spinny_web/gcode_link.py and gcode_part.py). The machine
file side of a G-code machine is in `notes/pnp-device.md`, its axes' skew
in `notes/square-axes.md`.

## Answers in step (2026-11-20)

- An `ok` does not say which line it answers. A line that timed out may
  still be answered after the next line went out, and that `ok` was taken
  for the next one's, every answer after it one off: an M114 read no
  place, an M400 returned while the head still moved. Clearing stale
  answers before each write cannot catch one that comes after the write.
  So a line not answered in time loses the link, as a port that fails
  does, and nothing more goes out until a new connect. Marlin's `busy:`
  lines keep a home or a wait alive past the timeout, so only a machine
  that stopped answering loses it. A choice the user may correct; counting
  owed answers instead would hang on firmware whose stop line is never
  answered (Grbl's `!`).
- A line waiting for its answer reads only its own connection's answers
  and ends as soon as the port is let go. A Disconnect during a home or a
  goto's M400 used to leave the request waiting out its timeout (180 s)
  holding the link's lock, and a connect in that time hung in its init
  lines.
- A connect whose M115 is never answered is refused: the link is already
  lost there. One refused with an error (Grbl) still connects.
- Each connection's poll has its own stop. A disconnect and a connect
  within one poll interval, or another machine file on the same port, left
  the old poll thread sending M114 beside the new one.

## When Z is trusted

`homed`, which the lift before a home reads as "Z is where it says", is
set only by a home of every axis or of X, Y and Z. A `G28 X` used to set
it, and the next Home lifted Z to the safe height from a Z never homed;
on the LumenPnP's seesaw that can drive the other nozzle down. A home of Z
alone leaves it as it was. A choice the user may correct.

The virtual LumenPnP's G28 homes only the axes it names, as Marlin does;
it homed every axis.

## Left open

- Marlin answers M410, the stop, right after the line in flight: a line
  written before that `ok` arrives takes it. Counting owed answers would
  hang on firmware whose stop is never answered.
- A G91 typed at the console, or an init line that leaves it, makes every
  later backend move relative: nothing sends G90 before them.
- The poll can write an older place over the one a jog just set, for up
  to a second; `_top_look_place` (placing_part.py) reads that place.
- pyserial's socket read raises at the peer's close and drops what it read
  in that call, so a socket peer's last line before it closes is lost.
