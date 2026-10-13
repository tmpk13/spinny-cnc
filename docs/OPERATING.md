# Operating the machine

From the first connection to a probed, compensated run. The wiring and the bring-up order are in `firmware/rp2040/README.md`; the page's panels are described in `web/frontend/README.md`.

## Connecting and first moves

| `web/frontend` | the page | `cd web/frontend && bun install && bun run build` |

The line protocol is `docs/PROTOCOL.md`, the web API `docs/WEB_API.md`.
A board upload isolates its copper by default; with Board set to deposit,
for a process that lays copper down, it burns the copper itself and
nothing past its edge. The Layer field picks the layer a KiCad board is
read from: a copper layer, or F.Paste, which with deposit burns the paste
openings out of a film laid where the board would be, a solder paste
stencil. A gerber is its own layer.
Open `http://localhost:8000`, connect to the board (or to
`socket://127.0.0.1:2323` for the virtual firmware), jog the beam over the
axis with the radius buttons, press "Set R=0 here", then turn the table
with the turn buttons: a positive turn must swing the point under the beam
counterclockwise seen from above, otherwise set `$dir_invert`. Check steps
per unit at low speed before the first job. Every axis is a bar in the
jog panel, with its step choices and a field for any other step; *Cancel*
in the panel's head, or Escape, stops a move. The *Config* tab holds the
machine files, where the pins are set too (the laser output, the probe
and an optional tool output), and the live firmware settings.

### Probing and the height map

An optional focus axis (`H`, the E driver socket unless `$sockets` moves
it, `$h_axis=1`) carries a
touch probe on the Z-STOP input. The Height map panel probes a grid over
the board, and a run can then follow it: the focus axis tracks the board
under the beam, or, without a focus axis, the power is raised where the
board sits out of focus.

1. Jog the head up until the probe clears the board: probing travels at
   that height. Set the probe's offset from the beam under *Probe*.
2. *Fit to job* (the preview shows the grid), then *Probe*.
3. Jog the beam over the board, focus it by eye with the focus axis, and
   press *Focus here*.
4. Run with *height map: auto*.

Wiring and bring-up are in `firmware/rp2040/README.md`; nothing of this has
run on hardware yet.

### Cartesian and spindle

Two optional modes use the same machine; both are firmware settings, off
by default, and the page follows them. The quickest way between them is
the *Config* tab, which edits and loads a whole file from
`machines/` ([MACHINES.md](MACHINES.md)): `cartesian-laser` and
`cartesian-mill` are the two modes below with the slide's travel set to
30 mm either side; copy one and change the limit to yours. The settings
named below are what such a file writes.

`$cartesian=1` makes it an X/Y machine: the rail is X, the cross slide Y,
interpolated together, and the table holds its angle. Board X/Y is turned
by that angle, so a board placed for a polar job is cut in the same place.

1. With the polar machine centered, jog the cross slide until the rail
   passes over the axis and press *Set Z=0 here*.
2. Set `$z_max` to the slide's travel either side of that, then
   `$cartesian=1`.

`$spindle=1` puts a spindle on the laser output and uses the focus axis
(`$h_axis=1`) as its depth axis. A job is milled: the tool rises to the
travel height, the spindle starts and spins up, and every path is a plunge,
the cuts at depth and a rise, each pass of a group a step deeper. Groups
carry a depth and a plunge rate; the host keeps the travel clearance and
the spin-up (the Config tab's settings panel).

1. Touch the tool to the copper and press *Set H=0 here*: without a height
   map H 0 is the surface.
2. Or probe a height map (the tool can be its own probe, touching grounded
   copper, tip offsets 0), jog the tool down until it touches the copper,
   press *Touch off here*, and run with *height map: auto*: the cuts then
   follow the board.

FAN3 is a low side switch on the fan rail, not a logic output: see the
spindle note in `firmware/rp2040/README.md` before connecting one.

### Probing less: around the cuts, and one point

Probing every point of a grid over a sparse board measures mostly bare
board. Under the grid fields, *around the job's cuts* probes only the
points a cut of the selected job comes within the margin of (the corners
of every grid cell a cut passes through) and leaves the rest out: the
preview shows which, and the estimate beside it says how many points and
about how long. A run following such a map is refused where a cut would
land in a cell nobody probed, so probe with the job you will run.
Probing that was stopped goes on with *Continue*, which probes only the
points the map still lacks; the time left is shown as it goes.

*Probe here* lowers the probe where the head is and comes back up. *Tie
map* reads the surface against what the map says there and moves the
map's offset by the difference, so a map probed before a power cycle, a
restart or a position set follows the board again without being probed
anew: put the tip over copper the map covers, not in a cut. *Set H 0* (Z 0
on a mill) makes the surface found H 0, for milling without a map.

### Picking a run up where it stopped

A run that stopped short, this session's or an earlier one's, shows a
*Resume from line* row under its job with the count of lines done filled
in. The backend writes `var/resume.json` as a run goes, so the count
survives the host as well as the controller.

1. If the controller lost its position (it was powered down, or reset
   while moving), tell it where the head is first: *Here is* in the Jog
   panel declares the joints without moving them, and *Last known* fills
   in the position the record holds. The head sits where the run left
   it, so the X/Y screws keep that position across a power cycle; the
   depth axis may have sunk under the spindle's weight.
2. With a height map, tie it to the new frame: *Probe here: tie map* over
   copper the map covers (the map's offset is taken back by every
   position set, as a safeguard).
3. *Plan* says which line the run starts at, how the head gets there and
   what goes out first; *Resume from line* does it after a confirmation.
   Leave *from the start of its path* on: the run then redoes the path the
   line belongs to from its rapid, so a count one line off cannot leave a
   gap in a trace. A spindle rises to the travel height, goes over the
   point, starts at the job's speed there, spins up and plunges before the
   first cut.

A machine that stops answering is given up by the link after 3 s of
silence: the state badge first shows the age of its last report, then the
run ends as an error with the reason and the link closes. Reconnect, and
pick the job up as above; the console's *Log* shows the backend's log,
which keeps what happened when no page was open.

### Checking the directions and the probe

Every `invert` in the machine file is checked by what the machine does.
With the head clear of the board, jog each axis one step: X+ must move the
head toward board +X, Y+ toward +Y, Z+ or H+ up, and a positive turn must
swing the point under the beam counterclockwise seen from above; an axis
that goes the other way wants `invert = true` in its section
(`$dir_invert`). Then watch the *Probe* readout: it must say *up* with the
tip free and *down* while the tip touches; the other way round wants
`invert = true` under `[probe]` (`$probe_invert`), or the first probe
drives the head into the board. Load the file again after a change.
