- Randomly disconnecting and restarting is a critical flaw.
  - Host side done 2026-10-14: the socat relay that served nobody after a
    wedge is replaced by the bridge, a starved backend no longer closes a
    live link, and a port close is a clean stop on the board. What is
    left is the board resetting on its own: the next connect after one
    logs `machine: boot ...` with the reason and `diag` the counters.


# Don't do yet

- Live json viewer, user can edit json and see path that aligns. When user clicks on json block the segment is highlighted in preview.
- Make buttons grow on hover, without moving items around them.
- Make machine center after running programs.
- Disconnect and connect should happen then wait for reponse not lock ui?