# Moving and stopping from the page (2026-11-12)

The Connection tab, the big Stop, the jog panel's hold and Fine, the goto
plan line, and the feature search.

## The Connection tab and Stop

- The top bar keeps only the state (its badge a button to the Connection
  tab), the kind of machine, firmware, link and Stop. The port helpers
  (defaultPort, portLabel, machineOfPort) stayed in statusbar.ts, which
  the tests import; views/connection.ts uses them.
- "Touch toggle for laser/controller" was read as switching machines in
  one press, since one machine is connected at a time (fb8fe96): the tab
  keeps `spinny.recent` (url, machine file, label; four, newest first)
  and a big toggle button each; a press while another is connected
  disconnects first and stops if that fails. My question to the user on
  the phone (#97) had offered "a touch screen mode" instead; buttons were
  already 2.75rem, so that reading added little.
- POST /api/stop (Backend.stop_all) runs the gentlest stop that stops
  now: runner.stop or prober.stop (hold, then reset) when active; else the
  head and up camera routines are aborted, 0x85 cancels a jog or goto and
  `laser off`/`spindle off` goes out (a sync line, taken once the
  cancelled jog has stopped). A G-code machine goes through
  _gcode_realtime("reset"), which aborts the camera routines and sends
  the file's stop (gcode.stop also ends a placing run).

## The jog panel

- Hold to move: a piece every HOLD_TICK_MS (100) of the step per second
  times the time since the last piece (at least one tick's worth, at most
  three), one request in flight. The backend answers a jog once queued,
  so pacing by time keeps about a tick in the controller's queue. At the
  release this firmware gets a jog cancel; a G-code machine runs out its
  last piece (its cancel is M410, an abrupt stop). The click that follows
  a held press is swallowed so it is not a step too.
- A G-code jog now takes the feed given on any axis (it was X/Y only), so
  a held Z moves at the rate its pieces come.
- Shift: stepOf reads `shiftJog` for the fine step (Fine itself is one of
  the three step sizes since 2026-11-17, notes/views.md); a key jog sets
  shiftJog only around the synchronous request build, and a held key
  keeps the Shift it went down with.
- Escape blurs a focused field (and still cancels), so the next arrow key
  jogs. A test that said "the field keeps its arrow keys after Escape"
  was changed to say the opposite.
- [up_camera] `leave` (mm) lifts a G-code jog to safe_z first when the
  nozzle goes from within `leave` of the up camera's place to beyond it,
  off the safe height; openpnp.lifts_leaving, its mock twin liftsLeaving.

## The goto plan line

src/gotoplan.ts repeats the backend's rules (openpnp.goto_lines;
App._goto with _travel_rise) to say what Go will move before it is
pressed; it reads safe_z from `state.placing.document` and the travel
height from the settings. If those rules change, change it too.

## The feature search

src/views/search.ts collects pages, panels and the buttons in them when
it opens (the layer's head buttons and the setup steps' stops left out),
matches letters in order (fuzzyScore) and only focuses a button: a
search must never press Test beam or Run.

## The board pad, the bars' places, PageUp and PageDown (2026-11-14)

Built by an agent (todo-panels), cherry-picked.

- The pad (`jog.ts PAD`) is eight jog buttons around the board X/Y
  readout; a corner jogs X by the X bar's step and Y by the Y bar's, held
  each axis at its own step per second, the feed the two combined
  (`hypot`). The Board X and Y bars lost their own - and +; the pad's
  button text ("X+", "X- Y+") keeps `findButton` working. Keys still move
  one axis at a time.
- The other bars show their joint's place (`barPlace`, by unit), updated
  only when the text changes.
- `src/pagekeys.ts` listens on the window after the document's jog
  listener (which skips keys whose default is prevented) and prevents
  PageUp/PageDown except in a textarea, a select or editable text: a held
  jog key's repeats scrolled the column before.
- gotoplan.ts takes `seesaw`; the page passes true unless the file says
  `seesaw = false`, as the backend's needs_lift; the `leave` lift lifts
  only from below on a plain Z (2026-11-14).

## Holds, keys and pop-ups (2026-11-20)

A held jog ends at the release, Escape, a blur, the 60 s limit, the
panel's Cancel and any other press on the page (the big Stop's included:
with a key held, Stop stopped the machine and the next tick moved it
again). A piece still on its way at the release is cancelled again once
it is answered, as the backend takes the cancel and the piece side by
side. A held key is matched by `event.code`: its name can change during a
hold (Shift released over the keypad). Every key pressed in an open menu
stays there, and PageUp/PageDown in the to-do drawer and the page settings
too (machine files bind them to Z). Escape over a pop-up only closes it;
whether it should also stop is Q70.
