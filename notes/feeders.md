# Feeders: the plan in docs/FEEDERS.md as built

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
