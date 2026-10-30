# spinny-carve

The 3D kernel of the CAM: an STL model and a CAM request in, three axis
toolpaths out (rough, waterline, parallel), one JSON document each way on
standard input and output. The CAM profiles drive it; what the request and
the answer hold, and what each operation cuts, is in
[docs/CAM.md](../docs/CAM.md).

| Command | Job |
| --- | --- |
| `mise run build-carve` | build `target/debug/spinny-carve`, optimized even in debug |
| `mise run test-carve` | the unit tests and whole requests on made up parts |
| `spinny-carve request.json` | answer one request from a file instead of standard input |

```mermaid
classDiagram
    class mesh {
        Mesh  welded STL, binary or ASCII
        turn(degrees, scale) / translate
        shape() flats, undercut, open edges
    }
    class slice {
        Slicer  triangles by height band
        section(z) what is strictly above z
        shadows(levels) everything above each level, overhangs included
        silhouette() the model seen from above
    }
    class region {
        inflate / union / difference / clip_lines  Clipper2 on a 0.1 um grid
        pieces(area) outer loops with their holes
    }
    class cutter {
        Cutter  flat, ball, bull nose, V bit
        Surface  triangles by cell, highest first
        drop(cutter, p) the lowest the tip may be
    }
    class ops {
        rough / waterline  levels, rings, depth first by piece
        parallel  lines, adaptive samples, zigzag bridges
    }
    class stock {
        Stock  height map cut down by every feed move
        highest(a, b, radius)
    }
    class link {
        Linker  stay down, low links, helix and zigzag ramps
        gouge(paths, surface, cutter)
    }
    class plan {
        Request / Response
        plan(request) placed model, every operation over one stock map
    }
    plan --> mesh
    plan --> slice
    plan --> ops
    plan --> link
    plan --> stock
    ops --> slice
    ops --> region
    ops --> cutter
    link --> cutter
    link --> stock
    link --> region
    slice --> region
```
