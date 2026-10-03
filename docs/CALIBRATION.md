# Finding the axis and placing the board

How a burnt coupon shows where the rotation axis really is, how the fine pattern amplifies what is left, and where to put the board. The same patterns are built as jobs from *Centering test* in the web page's Jobs panel.

## Finding the axis

Two things can be out, and neither shows up in a cut until it is drawn.
The radius zero may sit short of or past the axis, and the rail may pass
to one side of it, which no radius offset can correct: that is what the
cross slide is for. `spinny-center` burns a pattern that separates them.

```sh
uv run spinny-center --rotary-max-rate 400
```

The web page builds the same pattern as a job, options included, from
*Centering test* in the Jobs panel, pacing it at the table rate it read.

A radial cut holds the table still and runs the head along the rail, so
what it burns is the rail itself: a straight line lying the rail's own
miss distance from the axis. Four of them a quarter turn apart land on the
four sides of a square centered on the axis, and that square's side is
twice the miss distance. A full turn with the head still burns a ring
centered on the axis exactly, however far out everything else is, which is
the reference the rest is measured from.

So on the coupon:

| What you see | What it means |
| --- | --- |
| the ring's center | the rotation axis |
| the ring's diameter, against the one asked for | twice the radius zero error, with its sign |
| the square the lines bound | side is twice the cross slide error |
| the gap between opposing lines, once the square has closed | twice the radius zero error |

The line ends carry the same reading and are on the coupon even when the
ring is not: they lie on a circle at the reach plus the radius zero error,
so the longest distance across the pattern from one end to another is
twice that. Longer than twice the reach means the head at radius zero
sits short of the axis, shorter means past it.

The ring carries the sign the lines cannot. It is burnt at a known
radius, so half its measured diameter less that radius is the radius zero
error with its sign: wider than asked for means the head at radius zero
sits short of the axis by that much, narrower means it sits past it. It is
also the scale check, being the one feature whose size is known in
advance.

Halve the square's side and take it out on the cross slide, then re-burn.
When the lines meet at a point the rail is over the axis; move the head
half of whatever gap is left and set the radius zero there.

Cut it in constant power mode. The inner end of each line is what gets
measured, and under dynamic power the beam fades exactly where a move
begins.

### Amplifying what is left

Once the square has closed, what remains is under the width of a burnt
line, and no pattern burnt from one side of the axis can show more than
that: every mark is displaced by the same two errors, turned to the table
angle. Burnt from the far side, with the head run past the axis and the
table half a turn on, the same board point is displaced the other way.
`--fine` uses that. It crosses marks burnt from the two sides at a shallow
angle, and a crossing moves by 2 / tan(angle) times the error: 38 times at
the default 3 degrees.

```sh
uv run spinny-center --fine --rotary-max-rate 400
uv run spinny-center --fine --show-error 0.02,0.01   # the coupon a machine that is out would burn
```

The head runs to R -7 for it, so the job is written for the web interface
(`var/out/center-fine.json`) rather than as gcode. Import it and run it in
`mode const`.

| What you see | What it means |
| --- | --- |
| the rail line burnt with the table at 0, crossing the two arms | the crossings sit 8 mm apart when the rail passes over the axis; each 0.01 mm it misses by moves them 0.76 mm apart or together |
| the two spirals, crossing the rail line burnt with the table at 90 | they cross on that line when the radius zero is right; each 0.01 mm of error moves the crossing 0.38 mm along them, toward the short spiral's inner end when the head sits short of the axis and toward its outer end when it sits past it |

The map written next to the job turns each distance into a correction.
Two lines meeting at 3 degrees merge for about 2 mm either side of their
crossing: read the middle of the merged stretch, not its ends.

## Placing the board

Board coordinates are what the controller turns into polar coordinates, so
where the board sits matters:

| Option | Effect |
| --- | --- |
| `--anchor center` | middle of the job on the axis (default) |
| `--anchor keep` | gerber origin on the axis |
| `--offset X,Y` | shift the placed board, to move copper off the axis |

The table has to turn fastest for cuts close to the axis. A path that passes
inside `--min-radius` (0.5 mm) is warned about; shift the board so nothing
does. The preview marks the axis, that radius, and the rail.
