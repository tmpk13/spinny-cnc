//! spinny-sim: plays back polar laser gcode on a model of the machine.
//!
//! World is Y up. The table turns about +Y, the rail runs along +X from the
//! axis, and a board point (bx, by) sits at world (bx, 0, -by) before the
//! table turns, so looking down from above with X to the right puts board Y
//! up the screen.

mod gcode;

use std::path::{Path, PathBuf};

use gcode::{board_point, lerp, Controller, Kind, Limits, Program};
use macroquad::prelude::*;
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct Sidecar {
    controller: Option<String>,
    rotary_axis: Option<String>,
    invert_rotary: Option<bool>,
    axis_x: Option<f64>,
    s_max: Option<f64>,
    x_rapid: Option<f64>,
    rotary_rapid: Option<f64>,
    x_max_rate: Option<f64>,
    rotary_max_rate: Option<f64>,
    spot: Option<f64>,
    radius: Option<f64>,
    #[serde(default)]
    copper: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    outline: Vec<Vec<[f64; 2]>>,
}

struct Options {
    file: PathBuf,
    limits: Limits,
    screenshot: Option<PathBuf>,
    at: Option<f64>,
}

fn usage() -> ! {
    eprintln!(
        "usage: spinny-sim <job.gcode> [options]\n\
         \n\
         A <job.gcode>.sim.json next to the file supplies the board, controller,\n\
         axis letter and direction; the options below override it.\n\
         \n\
         --controller grblhal|joint  grblhal: board X/Y, the controller transforms and\n\
                              splits cuts at 0.5 mm; joint: radius on X, angle on a letter\n\
         --rotary-axis L      joint: gcode letter of the table axis (default A)\n\
         --invert-rotary      table turns the other way\n\
         --axis-x MM          machine X over the rotation axis (default 0)\n\
         --x-rapid MM/MIN     G0 speed of X (default 3000)\n\
         --rotary-rapid D/MIN G0 speed of the table (default 3600)\n\
         --x-max MM/MIN       cut speed limit of X (default 3000)\n\
         --rotary-max D/MIN   cut speed limit of the table (default 3600)\n\
         --s-max S            full power (default 1000)\n\
         --screenshot PNG     render one frame to a file and exit\n\
         --at SECONDS         job time for the screenshot, or the start position\n\
         \n\
         keys: space play/pause, up/down speed, left/right step a move,\n\
         home/end start/end, g toggle ghost toolpath, mouse drag orbit, wheel zoom"
    );
    std::process::exit(2)
}

fn parse_args() -> Options {
    let mut args = std::env::args().skip(1);
    let mut file = None;
    let mut limits = Limits::default();
    let mut screenshot = None;
    let mut at = None;
    let mut overrides: Vec<(String, String)> = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--invert-rotary" => overrides.push((arg, String::new())),
            "--controller" | "--rotary-axis" | "--axis-x" | "--x-rapid" | "--rotary-rapid"
            | "--x-max" | "--rotary-max" | "--s-max" => {
                let value = args.next().unwrap_or_else(|| usage());
                overrides.push((arg, value));
            }
            "--screenshot" => screenshot = Some(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            "--at" => at = args.next().and_then(|v| v.parse().ok()),
            "-h" | "--help" => usage(),
            _ if file.is_none() && !arg.starts_with('-') => file = Some(PathBuf::from(arg)),
            _ => usage(),
        }
    }
    let file = file.unwrap_or_else(|| usage());
    let sidecar = load_sidecar(&file);
    if let Some(name) = &sidecar.controller {
        limits.controller = controller_named(name);
    }
    if let Some(letter) = sidecar.rotary_axis.as_ref().and_then(|s| s.chars().next()) {
        limits.rotary_axis = letter;
    }
    if let Some(invert) = sidecar.invert_rotary {
        limits.invert_rotary = invert;
    }
    if let Some(axis_x) = sidecar.axis_x {
        limits.axis_x = axis_x;
    }
    // The generator's limits, so the clock here matches its estimate.
    if let Some(v) = sidecar.s_max {
        limits.s_max = v;
    }
    if let Some(v) = sidecar.x_rapid {
        limits.x_rapid = v;
    }
    if let Some(v) = sidecar.rotary_rapid {
        limits.rotary_rapid = v;
    }
    if let Some(v) = sidecar.x_max_rate {
        limits.x_max = v;
    }
    if let Some(v) = sidecar.rotary_max_rate {
        limits.rotary_max = v;
    }
    for (key, value) in overrides {
        let number = || value.parse::<f64>().unwrap_or_else(|_| usage());
        match key.as_str() {
            "--controller" => limits.controller = controller_named(&value),
            "--rotary-axis" => limits.rotary_axis = value.chars().next().unwrap_or('A'),
            "--invert-rotary" => limits.invert_rotary = true,
            "--axis-x" => limits.axis_x = number(),
            "--x-rapid" => limits.x_rapid = number(),
            "--rotary-rapid" => limits.rotary_rapid = number(),
            "--x-max" => limits.x_max = number(),
            "--rotary-max" => limits.rotary_max = number(),
            "--s-max" => limits.s_max = number(),
            _ => {}
        }
    }
    Options { file, limits, screenshot, at }
}

fn controller_named(name: &str) -> Controller {
    match name {
        "grblhal" => Controller::Grblhal,
        "joint" => Controller::Joint,
        _ => usage(),
    }
}

fn sidecar_path(file: &Path) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(".sim.json");
    file.with_file_name(name)
}

fn load_sidecar(file: &Path) -> Sidecar {
    std::fs::read_to_string(sidecar_path(file))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Board coordinates to world, with the table turned by `beta` degrees
/// counterclockwise as seen from above.
fn world(point: (f64, f64), beta: f64, height: f32) -> Vec3 {
    let t = beta.to_radians();
    let x = point.0 * t.cos() - point.1 * t.sin();
    let y = point.0 * t.sin() + point.1 * t.cos();
    vec3(x as f32, height, -y as f32)
}

struct Camera {
    yaw: f32,
    pitch: f32,
    distance: f32,
}

impl Camera {
    fn camera3d(&self) -> Camera3D {
        let position = vec3(
            self.distance * self.pitch.cos() * self.yaw.sin(),
            self.distance * self.pitch.sin(),
            self.distance * self.pitch.cos() * self.yaw.cos(),
        );
        Camera3D {
            position,
            target: vec3(0.0, 0.0, 0.0),
            up: vec3(0.0, 1.0, 0.0),
            ..Default::default()
        }
    }

    fn update(&mut self) {
        if is_mouse_button_down(MouseButton::Left) || is_mouse_button_down(MouseButton::Right) {
            let delta = mouse_delta_position();
            self.yaw += delta.x * 3.0;
            self.pitch = (self.pitch - delta.y * 2.0).clamp(0.05, 1.55);
        }
        let wheel = mouse_wheel().1;
        if wheel != 0.0 {
            self.distance *= if wheel > 0.0 { 0.9 } else { 1.1 };
        }
    }
}

fn beam_color(intensity: f32) -> Color {
    let i = intensity.clamp(0.0, 1.0);
    Color::new(0.35 + 0.65 * i, 0.15 * (1.0 - i), 0.6 + 0.4 * i, 0.25 + 0.75 * i)
}

fn trail_color(intensity: f32) -> Color {
    // Full power burns bright red; a cut held back by an axis limit fades
    // towards a dull brick, so the slow stretches stand out on the board.
    let i = intensity.clamp(0.0, 1.0);
    Color::new(0.55 + 0.45 * i, 0.10 + 0.15 * i, 0.05, 1.0)
}

fn window_conf() -> Conf {
    Conf {
        window_title: "spinny-sim".to_owned(),
        window_width: 1280,
        window_height: 800,
        ..Default::default()
    }
}

#[macroquad::main(window_conf)]
async fn main() {
    let options = parse_args();
    let text = match std::fs::read_to_string(&options.file) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("{}: {}", options.file.display(), error);
            std::process::exit(1);
        }
    };
    let sidecar = load_sidecar(&options.file);
    let program: Program = gcode::parse(&text, &options.limits);
    if program.moves.is_empty() {
        eprintln!("{}: no moves found (rotary axis {})", options.file.display(), options.limits.rotary_axis);
        std::process::exit(1);
    }
    let spot = sidecar.spot.unwrap_or(0.1) as f32;
    let table_radius = sidecar.radius.unwrap_or(program.max_radius).max(1.0) as f32 + 3.0;
    let rail_length = table_radius + 5.0;
    let head_height = 10.0f32;
    let plate = 0.0f32;
    let plate_thickness = 1.6f32;
    let table_top = plate - plate_thickness;
    let limited_moves = program.moves.iter().filter(|m| m.limited).count();

    // Board plate: the outline's box, or the copper's, or the table.
    let mut lo = (f64::INFINITY, f64::INFINITY);
    let mut hi = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for path in sidecar.outline.iter().chain(sidecar.copper.iter()) {
        for p in path {
            lo = (lo.0.min(p[0]), lo.1.min(p[1]));
            hi = (hi.0.max(p[0]), hi.1.max(p[1]));
        }
    }
    let plate_box = if lo.0.is_finite() {
        Some((lo, hi))
    } else {
        None
    };

    let mut camera = Camera {
        yaw: 0.6,
        pitch: 0.9,
        distance: table_radius * 3.2,
    };
    let mut time = options.at.unwrap_or(0.0).min(program.total);
    let mut playing = options.screenshot.is_none() && options.at.is_none();
    let mut speed = 1.0f64;
    let mut ghost = true;
    let mut frame = 0;

    loop {
        camera.update();
        if is_key_pressed(KeyCode::Space) {
            playing = !playing;
        }
        if is_key_pressed(KeyCode::Up) {
            speed = (speed * 2.0).min(1024.0);
        }
        if is_key_pressed(KeyCode::Down) {
            speed = (speed / 2.0).max(1.0 / 64.0);
        }
        if is_key_pressed(KeyCode::Home) {
            time = 0.0;
        }
        if is_key_pressed(KeyCode::End) {
            time = program.total;
        }
        if is_key_pressed(KeyCode::G) {
            ghost = !ghost;
        }
        if let Some((index, _)) = program.at(time) {
            if is_key_pressed(KeyCode::Right) && index + 1 < program.moves.len() {
                time = program.ends[index];
                playing = false;
            }
            if is_key_pressed(KeyCode::Left) {
                time = if index == 0 { 0.0 } else { program.ends[index - 1] - 1e-6 };
                time = time.max(0.0);
                playing = false;
            }
        }
        if playing {
            time += get_frame_time() as f64 * speed;
            if time >= program.total {
                time = program.total;
                playing = false;
            }
        }

        let (index, t) = program.at(time).unwrap();
        let current = &program.moves[index];
        let joint = lerp(current.from, current.to, t);
        let beta = -joint.1;
        let intensity = (current.effective / options.limits.s_max) as f32;

        clear_background(Color::new(0.08, 0.09, 0.11, 1.0));
        set_camera(&camera.camera3d());

        // Table and its axis.
        draw_cylinder(
            vec3(0.0, table_top - 2.0, 0.0),
            table_radius,
            table_radius,
            2.0,
            None,
            Color::new(0.30, 0.31, 0.34, 1.0),
        );
        draw_cylinder_wires(
            vec3(0.0, table_top - 2.0, 0.0),
            table_radius,
            table_radius,
            2.0,
            None,
            Color::new(0.45, 0.46, 0.5, 1.0),
        );
        draw_line_3d(
            vec3(0.0, table_top - 4.0, 0.0),
            vec3(0.0, head_height + 4.0, 0.0),
            Color::new(0.9, 0.5, 0.1, 0.5),
        );
        // A tick on the table rim so its turning is visible.
        let tick = world((table_radius as f64 - 1.5, 0.0), beta, table_top + 0.01);
        let tick_end = world((table_radius as f64 + 0.5, 0.0), beta, table_top + 0.01);
        draw_line_3d(tick, tick_end, Color::new(0.95, 0.8, 0.2, 1.0));

        // Board.
        if let Some((lo, hi)) = plate_box {
            let origin = world((lo.0, lo.1), beta, table_top);
            let ex = world((hi.0, lo.1), beta, table_top) - origin;
            let ez = world((lo.0, hi.1), beta, table_top) - origin;
            let up = vec3(0.0, plate_thickness, 0.0);
            let green = Color::new(0.10, 0.36, 0.20, 1.0);
            let side = Color::new(0.55, 0.50, 0.30, 1.0);
            draw_affine_parallelogram(origin + up, ex, ez, None, green);
            draw_affine_parallelogram(origin, ex, up, None, side);
            draw_affine_parallelogram(origin, ez, up, None, side);
            draw_affine_parallelogram(origin + ex, ez, up, None, side);
            draw_affine_parallelogram(origin + ez, ex, up, None, side);
        }
        let copper = Color::new(0.85, 0.62, 0.30, 1.0);
        for contour in &sidecar.copper {
            for pair in contour.windows(2) {
                draw_line_3d(
                    world((pair[0][0], pair[0][1]), beta, plate + 0.02),
                    world((pair[1][0], pair[1][1]), beta, plate + 0.02),
                    copper,
                );
            }
            if let (Some(first), Some(last)) = (contour.first(), contour.last()) {
                draw_line_3d(
                    world((last[0], last[1]), beta, plate + 0.02),
                    world((first[0], first[1]), beta, plate + 0.02),
                    copper,
                );
            }
        }
        let edge = Color::new(0.9, 0.9, 0.9, 1.0);
        for path in &sidecar.outline {
            for pair in path.windows(2) {
                draw_line_3d(
                    world((pair[0][0], pair[0][1]), beta, plate + 0.02),
                    world((pair[1][0], pair[1][1]), beta, plate + 0.02),
                    edge,
                );
            }
        }

        // Toolpath still to come, faint; every cut so far, dark; the cut in
        // progress up to the beam. All in board coordinates, turned with it.
        for (i, m) in program.moves.iter().enumerate() {
            if m.kind != Kind::Cut || m.power <= 0.0 {
                continue;
            }
            if i < index {
                draw_joint_segment(m.from, m.to, beta, plate + 0.05, trail_color((m.effective / options.limits.s_max) as f32));
            } else if i == index {
                draw_joint_segment(m.from, joint, beta, plate + 0.05, trail_color(intensity));
                if ghost {
                    draw_joint_segment(joint, m.to, beta, plate + 0.05, Color::new(0.5, 0.5, 0.55, 0.35));
                }
            } else if ghost {
                draw_joint_segment(m.from, m.to, beta, plate + 0.05, Color::new(0.5, 0.5, 0.55, 0.35));
            }
        }

        // Rail and head. X is machine space, so the head never turns.
        draw_cube(
            vec3(rail_length / 2.0 - 2.0, head_height + 3.0, 0.0),
            vec3(rail_length + 4.0, 1.5, 3.0),
            None,
            Color::new(0.55, 0.55, 0.6, 1.0),
        );
        let head_x = joint.0 as f32;
        draw_cube(
            vec3(head_x, head_height, 0.0),
            vec3(3.0, 5.0, 3.0),
            None,
            Color::new(0.2, 0.2, 0.22, 1.0),
        );
        let spot_point = vec3(head_x, plate + 0.05, 0.0);
        if current.effective > 0.0 {
            draw_line_3d(vec3(head_x, head_height - 2.5, 0.0), spot_point, beam_color(intensity));
            draw_sphere(spot_point, (spot * 3.0).max(0.15), None, beam_color(intensity));
        } else {
            draw_line_3d(vec3(head_x, head_height - 2.5, 0.0), spot_point, Color::new(0.4, 0.4, 0.45, 0.3));
            draw_sphere_wires(spot_point, (spot * 3.0).max(0.15), None, Color::new(0.6, 0.6, 0.65, 0.6));
        }

        // HUD.
        set_default_camera();
        let (bx, by) = board_point(joint);
        let lines = [
            format!("{}", options.file.display()),
            format!(
                "time {:>7.1} / {:.1} s   speed x{}   {}",
                time,
                program.total,
                speed,
                if playing { "playing" } else { "paused" }
            ),
            format!(
                "line {:>5}  {}",
                current.line,
                current.text
            ),
            format!(
                "radius {:>8.3}  angle {:>10.4}   board ({:.3}, {:.3})   {}",
                joint.0,
                joint.1,
                bx,
                by,
                match options.limits.controller {
                    Controller::Grblhal => "grblHAL polar",
                    Controller::Joint => "joint file",
                }
            ),
            format!(
                "{}  S {:.0} -> {:.0} effective{}",
                if current.kind == Kind::Cut { "cut  " } else { "rapid" },
                current.power,
                current.effective,
                if current.limited { "  (held by an axis limit)" } else { "" }
            ),
            format!(
                "moves {}/{}   rotary-limited cuts {}   space play, arrows speed/step, g ghost",
                index + 1,
                program.moves.len(),
                limited_moves
            ),
        ];
        let size = (screen_height() * 0.024).max(14.0);
        for (i, line) in lines.iter().enumerate() {
            draw_text(line, size * 0.8, size * 1.4 * (i as f32 + 1.0), size, WHITE);
        }
        // Progress bar.
        let margin = size * 0.8;
        let bar_y = screen_height() - size * 1.2;
        let width = screen_width() - 2.0 * margin;
        draw_rectangle(margin, bar_y, width, size * 0.4, Color::new(0.3, 0.3, 0.32, 1.0));
        draw_rectangle(
            margin,
            bar_y,
            width * (time / program.total.max(1e-9)) as f32,
            size * 0.4,
            Color::new(0.9, 0.5, 0.1, 1.0),
        );

        if let Some(path) = &options.screenshot {
            // The first frames can render before the window has its size.
            frame += 1;
            if frame >= 3 {
                get_screen_data().export_png(&path.to_string_lossy());
                println!("wrote {}", path.display());
                break;
            }
        }
        next_frame().await
    }
}

/// A joint-space move is a spiral on the board; draw it as short chords.
fn draw_joint_segment(from: (f64, f64), to: (f64, f64), beta: f64, height: f32, color: Color) {
    let da = (to.1 - from.1).abs();
    let steps = ((da / 2.0).ceil() as usize).clamp(1, 90);
    let mut previous = world(board_point(from), beta, height);
    for i in 1..=steps {
        let joint = lerp(from, to, i as f64 / steps as f64);
        let next = world(board_point(joint), beta, height);
        draw_line_3d(previous, next, color);
        previous = next;
    }
}
