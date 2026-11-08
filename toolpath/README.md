# spinny-laser toolpath

The Python library behind the web backend and the command line tools:
polar kinematics (`polar`), copper clearing (`clear`) and deposition
(`deposit`), solder paste stencils (`stencil`), the centering coupons
(`center`, `fine`), the pads and holes
of a board layer (`pads`), the turn and shift that line a job up with the
board (`align`), the Plot page's simple operations (`mill`: drilling,
a line, facing, pockets and profiles), the machine configuration files
(`machines`), the CAM
profiles (`cam`, `camjob`, `post`: a design through a profile's
operations, gcode for the profile's controller; `carve` runs the 3D
kernel in `carve/` for an STL model), and the gcode emitter for a
grblHAL controller (`gcode`, `machine`, `report`, `preview`).

| Command | Job |
| --- | --- |
| `spinny-iso` | KiCad board or gerber to isolation gcode placed on the axis |
| `spinny-polar` | re-place and pre-split an existing X/Y laser job |
| `spinny-jog` | MDI rapids for setup: move radially or turn the table |
| `spinny-center` | a burn that shows where the rotation axis really is; `--fine` amplifies what is left |
| `spinny-sim` | play a job back on a model of the machine |
| `spinny-cam` | a board, an X/Y gcode design or an STL model through a CAM profile in `cam/`, gcode for that profile's controller |

Usage, the grblHAL setup and what the files contain are in
[docs/GCODE.md](../docs/GCODE.md); reading the coupons is in
[docs/CALIBRATION.md](../docs/CALIBRATION.md); the CAM profiles are
[docs/CAM.md](../docs/CAM.md). The outputs go to `var/out/` unless `-o`
says otherwise.

```sh
uv run pytest toolpath/tests
```

## Architecture

```mermaid
classDiagram
    class cli {
        main(argv)  spinny-iso
    }
    class convert {
        main(argv)  spinny-polar
        read_paths(text)
    }
    class jog {
        main(argv)  spinny-jog
        radial(start, radius)
        turn(start, degrees, step)
    }
    class center {
        main(argv)  spinny-center
        spokes(count, inner, outer)
        ring(radius)
    }
    class clear {
        clear(copper, keep, spot, pattern, outline, pace) strokes
        perimeter(copper, keep, spot, outline)
        chains(paths) outline pieces joined
        spokes(area, pitch, pace) shaped to the area, ordered by travel
        rings / rows(area, pitch)
        clip_open(lines, area)
    }
    class stencil {
        stencil(paste, spot, margin, pace) Stencil
        Stencil  loops, narrow, closed
        middle(piece, radius) the stroke along an opening too narrow for a loop
    }
    class deposit {
        deposit(copper, spot, fill, passes, centers, pace) Deposition
        Deposition  edges, fill, thin
        centerlines(image) the strokes' middles
    }
    class fine {
        Design  reach, angle, cross, arm, spiral
        build(design, ...) JointGroup[]
        burnt(groups, along, across)
        readings(design, groups, along, across)
        job_document(groups, name, spot)
    }
    class pads {
        pads_of(image) the layer's fills as pads: centroid and area
        holes_of(drills) the drill file's holes
        tour(points) / spread(points, count) / nearest(points, to)
    }
    class align {
        fit_rigid(pairs, angle) Fit: rotation, shift, scale, rms, residuals
        turn(point, degrees) / turned_paths(paths, degrees)
    }
    class machines {
        load(path) Machine
        load_all(directory) machines, problems
        current(machines, values) id
        cli_defaults(machine)
    }
    class controls {
        default_controls(kinematics, tool, focus) the page's controls for a machine file that says nothing
        parse_controls(reader, top, ...) the [controls] table, filled in from the defaults
    }
    machines --> controls
    class cam {
        Profile  axes, tools, operations, post, placement, materials, stock, model, spindle
        load / load_all(directory) / parse(text, id)
        _Feeds  a material's rpm and feed, held to the spindle and the axes
        resolve(tool, settings, defaults, source) cutting
        set_value(text, path, value) text, comments kept
    }
    class camjob {
        read_board(path, layer) Design
        read_gcode(text) / place_paths(sets, anchor, offset)
        read_model(path) Design  an STL
        build(profile, design) BuiltJob  groups per operation, notes; a model's groups carry moves
        model_request(profile, design, operations) the kernel's request
    }
    class carve {
        find() the spinny-carve program
        run(request) answer  one JSON document each way
    }
    class post {
        post(built, profile) Program  text, Report
        _Cartesian  safe height, parks, spindle or laser, passes, a model's moves in X Y Z, homes
        _polar  through gcode.generate
    }
    class camcli {
        main(argv)  spinny-cam
    }
    class machine {
        add_machine_arguments(parser)  --machine FILE
        parse_args(parser, argv)
        options_from(args)
        sim_document(...)
        write_outputs(...)
    }
    class polar {
        joint_of(point, previous)
        subdivide(start, end, joint, kin)
        unwrap(angle, previous)
        far_side(joint)
        displaced(joint, along, across)
        sample_joints(poly, limit)
    }
    class gcode {
        PolarOptions  controller grblhal|joint
        PathGroup
        generate(groups, options, header) Job
    }
    class Job {
        text, cut_seconds
        limited_length, peak_rotary_rate
        total_rotation, near_axis_paths
    }
    class preview {
        render(copper, groups, ...) svg
    }
    class mill {
        drill / line / face  points and rows
        pocket_rect / pocket_circle  out from the middle to the walls
        profile_rect / profile_circle  outside, inside or on, climb or conventional
    }
    class report {
        render(job, ...) markdown
    }
    class laser_sweep {
        gerber, geom, isolate
        excellon, isocli.resolve
        postprocess.parse_line
    }
    class sim_gcode {
        parse(text, limits) Program
        grblhal_joint(point, last)
    }
    class sim_main {
        scene, camera, playback
    }

    camcli --> cam
    camcli --> camjob
    camcli --> post
    camjob --> cam
    camjob --> carve : a model's toolpaths
    camjob --> clear : clearing strokes
    camjob --> deposit : edges, fill, thin
    camjob --> laser_sweep : copper, loops, outline, drills
    camjob --> convert : gcode paths
    post --> cam
    post --> gcode : a polar profile
    cam ..> web_backend : listed, saved, patched; a design through a profile
    cli --> laser_sweep : copper, loops
    cli --> machine
    convert --> laser_sweep : line parser
    convert --> machine
    machine --> gcode
    machine --> report
    machine --> machines : defaults from a file
    machines ..> web_backend : listed, matched, loaded
    cli --> preview
    cli --> clear : outline pieces
    convert --> preview
    gcode --> polar
    jog --> polar
    clear --> laser_sweep : offsets
    deposit --> clear : fills, travel order
    stencil --> deposit : hairline opening
    stencil --> clear : travel order
    deposit --> laser_sweep : offsets, loops
    deposit ..> web_backend : board import, deposit mode
    center --> machine
    center --> preview
    center --> fine : --fine
    fine --> polar
    fine --> preview
    fine ..> web_backend : job json with joints
    gcode --> Job
    sim_main --> sim_gcode
    sim_gcode ..> gcode : reads its output
    sim_main ..> machine : reads .sim.json
```
