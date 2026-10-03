# spinny-laser toolpath

The Python library behind the web backend and the command line tools:
polar kinematics (`polar`), copper clearing (`clear`) and deposition
(`deposit`), the centering coupons (`center`, `fine`), the machine
configuration files (`machines`), and the gcode emitter for a grblHAL
controller (`gcode`, `machine`, `report`, `preview`).

| Command | Job |
| --- | --- |
| `spinny-iso` | KiCad board or gerber to isolation gcode placed on the axis |
| `spinny-polar` | re-place and pre-split an existing X/Y laser job |
| `spinny-jog` | MDI rapids for setup: move radially or turn the table |
| `spinny-center` | a burn that shows where the rotation axis really is; `--fine` amplifies what is left |
| `spinny-sim` | play a job back on a model of the machine |

Usage, the grblHAL setup and what the files contain are in
[docs/GCODE.md](../docs/GCODE.md); reading the coupons is in
[docs/CALIBRATION.md](../docs/CALIBRATION.md). The outputs go to
`var/out/` unless `-o` says otherwise.

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
    class machine {
        add_machine_arguments(parser)
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

    cli --> laser_sweep : copper, loops
    cli --> machine
    convert --> laser_sweep : line parser
    convert --> machine
    machine --> gcode
    machine --> report
    cli --> preview
    cli --> clear : outline pieces
    convert --> preview
    gcode --> polar
    jog --> polar
    clear --> laser_sweep : offsets
    deposit --> clear : fills, travel order
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
