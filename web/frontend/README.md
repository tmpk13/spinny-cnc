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
points the page at a backend elsewhere.

Board coordinates are mm with the rotation axis at the origin: `x = r cos a`,
`y = r sin a`, y up in the preview. The DRO shows the joint (`R` mm, `A` deg),
the cross slide (`Z` mm) and the board position the backend derives from the
joint. The cross slide is a setup axis: the jog panel moves it on its own,
in the small steps a centering burn is measured into.

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
        statusbar dro jog laser jobs previewpanel console settings toasts
    }
    class preview {
        Preview  canvas around the axis, y up
    }
    class kinematics {
        segmentBoardMove(from, to, tolerance)
        moveMinutes(from, to, feed, rRate, aRate)
    }
    class mock {
        MockBackend  Api and EventFeed in one
        MockMachine  joint motion at the rates, cross slide on its own
    }
    class mockjobs {
        parseSvg parseGcode placeJob computeStats
    }
    main --> api
    main --> ws
    main --> state
    main --> views
    views --> preview
    mock --> kinematics
    mock --> mockjobs
    main ..> mock : ?mock=1
```
