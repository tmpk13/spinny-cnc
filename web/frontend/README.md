# spinny-web frontend

Browser interface for the rotary table laser, built with Bun and plain
TypeScript: no framework, one store, views that draw from it.

```sh
cd web/frontend
bun install
bun run check && bun test && bun run build
bun run dev            # serves index.html with the sources
```

`bun run build` writes `dist/`, which the backend serves at `/`. Open
`?mock=1` for an in-page machine that needs no backend; `?api=http://host:8000`
points the page at a backend elsewhere, which must have been started with
that page's origin allowed: `spinny-web --cors-origin http://localhost:3000`
for the dev server. Without it the browser refuses every call.

Board coordinates are mm with the rotation axis at the origin: `x = r cos a`,
`y = r sin a`, y up in the preview. The DRO shows the joint (`R` mm, `A` deg),
the cross slide (`Z` mm), the focus axis (`H` mm) and the probe on a machine
with one, and the board position the backend derives from the joint. The
cross slide is a setup axis: the jog panel moves it on its own, in the small
steps a centering burn is measured into.

The page follows what the machine is (`profile` in the backend's state,
from `$cartesian` and `$spindle`), with a badge in the status bar when it
is not the polar laser. On a cartesian machine the cross slide is the Y
axis: it steps like the rail, at the feed given, and the joint goto takes
`r` and `z`. With a spindle the laser panel starts and stops the spindle,
the groups table has depth and plunge in place of the power floor, the
focus axis is the depth axis, "Focus here" is "Touch off here", and the
settings panel has the travel clearance and spin-up. The in-page mock
takes those settings and runs a spindle, but it moves as the polar
machine.

The Height map panel probes a grid (drawn on the preview before and while it
is probed), shows the heights as a map of the board seen from above, blue
below the mean and red above it, and sets the focus offset. The run button
sends the chosen compensation, which turns to `auto` once a map is usable.

## Architecture

```mermaid
classDiagram
    class main {
        createContext(api, store) Ctx
    }
    class api {
        HttpApi  typed routes of WEB_API.md
    }
    class ws {
        EventSocket  reconnects with backoff
        parseEvent(raw) WsEvent
    }
    class state {
        Store  shallow merge, key filtered listeners
        AppState
    }
    class views {
        statusbar dro jog laser jobs center heightmap previewpanel console settings toasts
    }
    class preview {
        Preview  canvas around the axis, y up, probe grid
    }
    class profile {
        profileOf(snapshot) Profile
        isCartesian / isMilling
    }
    class kinematics {
        segmentBoardMove(from, to, tolerance)
        moveMinutes(from, to, feed, rRate, aRate)
    }
    class mock {
        MockBackend  Api and EventFeed in one
        MockMachine  joint motion at the rates, cross slide on its own, focus axis and probe
    }
    class mockjobs {
        parseSvg parseGcode placeJob computeStats centerJob
    }
    main --> api
    main --> ws
    main --> state
    main --> views
    views --> preview
    views --> profile
    mock --> kinematics
    mock --> mockjobs
    main ..> mock : ?mock=1
```
