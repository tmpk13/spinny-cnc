- Randomly disconnecting and restarting is a critical flaw.
  - Host side done 2026-10-14: the socat relay that served nobody after a
    wedge is replaced by the bridge, a starved backend no longer closes a
    live link, and a port close is a clean stop on the board.
  - 2026-11-02 (K40): every drop was the board losing power (`boot power
    on`, off 8 s to 16 min, at idle, beam off), one a RUN pin reset while
    the tube fired. Check the 24 V supply and its terminals. The next
    connect now says "lost power" with the time off, or that the USB link
    dropped with the board up.


# Don't do yet
- Make buttons grow on hover, without moving items around them.
- Make option for machine to center after running programs. Machine setting.
- Disconnect and connect should happen then wait for reponse not lock ui?