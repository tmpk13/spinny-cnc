//! Whole requests on made up parts: a stepped plate with a pocket, a boss
//! and a hole through it, and a dome. Every operation is checked for moves
//! into the model, and the stock map for what was left where.

use carve::cutter::{Cutter, Shape, Surface};
use carve::link::{FEED, PLUNGE, RAPID};
use carve::mesh::Mesh;
use carve::plan::{plan_with_stock, Request, Response};
use carve::stock::Stock;
use serde_json::json;
use std::collections::HashMap;

/// A closed mesh of the voxels `filled` says are in, `size` mm a side.
fn voxels(n: [usize; 3], size: f64, filled: impl Fn(usize, usize, usize) -> bool) -> Mesh {
    let inside = |i: isize, j: isize, k: isize| {
        i >= 0 && j >= 0 && k >= 0 && (i as usize) < n[0] && (j as usize) < n[1] && (k as usize) < n[2] && filled(i as usize, j as usize, k as usize)
    };
    let mut mesh = Mesh::default();
    let mut seen: HashMap<[i64; 3], u32> = HashMap::new();
    let mut vertex = |c: [i64; 3], mesh: &mut Mesh| -> u32 {
        *seen.entry(c).or_insert_with(|| {
            mesh.vertices.push([c[0] as f64 * size, c[1] as f64 * size, c[2] as f64 * size]);
            (mesh.vertices.len() - 1) as u32
        })
    };
    // Each face: the neighbor's offset and the face's corners, counter
    // clockwise seen from outside.
    let faces: [([isize; 3], [[i64; 3]; 4]); 6] = [
        ([-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]),
        ([1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]),
        ([0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]),
        ([0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]),
        ([0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]),
        ([0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]),
    ];
    for i in 0..n[0] as isize {
        for j in 0..n[1] as isize {
            for k in 0..n[2] as isize {
                if !inside(i, j, k) {
                    continue;
                }
                for (d, corners) in &faces {
                    if inside(i + d[0], j + d[1], k + d[2]) {
                        continue;
                    }
                    let v: Vec<u32> = corners.iter().map(|c| vertex([i as i64 + c[0], j as i64 + c[1], k as i64 + c[2]], &mut mesh)).collect();
                    mesh.triangles.push([v[0], v[1], v[2]]);
                    mesh.triangles.push([v[0], v[2], v[3]]);
                }
            }
        }
    }
    mesh
}

/// A closed mesh under a height field over a rectangle, flat underneath.
fn heights(x: [f64; 2], y: [f64; 2], n: usize, bottom: f64, top: impl Fn(f64, f64) -> f64) -> Mesh {
    let mut mesh = Mesh::default();
    let at = |i: usize, j: usize| [x[0] + (x[1] - x[0]) * i as f64 / n as f64, y[0] + (y[1] - y[0]) * j as f64 / n as f64];
    for j in 0..=n {
        for i in 0..=n {
            let p = at(i, j);
            mesh.vertices.push([p[0], p[1], top(p[0], p[1])]);
        }
    }
    let base = mesh.vertices.len() as u32;
    for j in 0..=n {
        for i in 0..=n {
            let p = at(i, j);
            mesh.vertices.push([p[0], p[1], bottom]);
        }
    }
    let t = |i: usize, j: usize| (j * (n + 1) + i) as u32;
    let b = |i: usize, j: usize| base + t(i, j);
    for j in 0..n {
        for i in 0..n {
            mesh.triangles.push([t(i, j), t(i + 1, j), t(i + 1, j + 1)]);
            mesh.triangles.push([t(i, j), t(i + 1, j + 1), t(i, j + 1)]);
            mesh.triangles.push([b(i, j), b(i + 1, j + 1), b(i + 1, j)]);
            mesh.triangles.push([b(i, j), b(i, j + 1), b(i + 1, j + 1)]);
        }
    }
    for k in 0..n {
        let walls = [((k, 0), (k + 1, 0)), ((n, k), (n, k + 1)), ((k + 1, n), (k, n)), ((0, k + 1), (0, k))];
        for ((i0, j0), (i1, j1)) in walls {
            mesh.triangles.push([b(i0, j0), b(i1, j1), t(i1, j1)]);
            mesh.triangles.push([b(i0, j0), t(i1, j1), t(i0, j0)]);
        }
    }
    mesh
}

/// The mesh as an STL file holds it: f32 coordinates, read back welded.
fn through_stl(mesh: &Mesh) -> Mesh {
    let mut bytes = vec![0u8; 80];
    bytes.extend_from_slice(&(mesh.triangles.len() as u32).to_le_bytes());
    for i in 0..mesh.triangles.len() {
        bytes.extend_from_slice(&[0u8; 12]);
        for v in mesh.triangle(i) {
            for c in v {
                bytes.extend_from_slice(&(c as f32).to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0u8; 2]);
    }
    Mesh::from_stl(&bytes).unwrap()
}

/// An L 30 long and 20 deep, its base 3.2 high and its first 10 mm 6.4
/// high, with two large triangles a face as CAD programs write them, drawn
/// where `place` puts (along, height, depth), as an STL file holds it.
fn l_block(place: impl Fn(f64, f64, f64) -> [f64; 3]) -> Mesh {
    let profile = [(0.0, 0.0), (30.0, 0.0), (30.0, 3.2), (10.0, 3.2), (10.0, 6.4), (0.0, 6.4)];
    let mut mesh = Mesh::default();
    let mut triangle = |corners: [[f64; 3]; 3]| {
        let first = mesh.vertices.len() as u32;
        mesh.vertices.extend_from_slice(&corners);
        mesh.triangles.push([first, first + 1, first + 2]);
    };
    let n = profile.len();
    for i in 0..n {
        let ((u0, h0), (u1, h1)) = (profile[i], profile[(i + 1) % n]);
        let (a, b, c, d) = (place(u0, h0, 0.0), place(u1, h1, 0.0), place(u1, h1, 20.0), place(u0, h0, 20.0));
        triangle([a, b, c]);
        triangle([a, c, d]);
    }
    for fan in [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]] {
        let [(u0, h0), (u1, h1), (u2, h2)] = fan.map(|k| profile[k]);
        triangle([place(u0, h0, 0.0), place(u2, h2, 0.0), place(u1, h1, 0.0)]);
        triangle([place(u0, h0, 20.0), place(u1, h1, 20.0), place(u2, h2, 20.0)]);
    }
    through_stl(&mesh)
}

/// 30 x 20 x 6 mm plate of 0.5 mm voxels: a 10 x 8 pocket 3 deep, a 4 x 4
/// hole through, and a 4 mm shoulder 2 down along one end.
fn plate() -> Mesh {
    voxels([60, 40, 12], 0.5, |i, j, k| {
        let pocket = (10..30).contains(&i) && (12..28).contains(&j) && k >= 6;
        let hole = (40..48).contains(&i) && (16..24).contains(&j);
        let shoulder = i >= 52 && k >= 8;
        !(pocket || hole || shoulder)
    })
}

fn request(model: &str, operations: serde_json::Value) -> Request {
    serde_json::from_value(json!({
        "model": model,
        "stock": { "margin": 4, "top": 0.5, "anchor": "corner" },
        "tolerance": 0.01,
        "travel": 5,
        "clearance": 1,
        "operations": operations,
    }))
    .unwrap()
}

fn run(mesh: &Mesh, operations: serde_json::Value) -> (Response, Stock, Mesh) {
    let mut placed = mesh.clone();
    let (response, stock) = plan_with_stock(&mut placed, &request("test.stl", operations)).unwrap();
    (response, stock, placed)
}

/// The shipped profile's rough and walls on aluminum with a 3 mm end mill:
/// a 0.6 mm step, a 2 degree ramp, a skin under the rough that the walls
/// cut through.
fn shipped_rough_and_walls() -> serde_json::Value {
    json!([
        { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
          "step_down": 0.6, "stepover": 0.9, "leave": 0.2, "leave_floor": 0, "below": -0.3, "ramp": 2 },
        { "name": "walls", "strategy": "waterline", "tool": { "shape": "flat", "diameter": 3 },
          "step_down": 3, "stepover": 1.2, "leave": 0, "below": 0, "ramp": 2 },
    ])
}

/// Several meshes as one, each keeping its own vertices.
fn joined(meshes: &[Mesh]) -> Mesh {
    let mut out = Mesh::default();
    for mesh in meshes {
        let offset = out.vertices.len() as u32;
        out.vertices.extend_from_slice(&mesh.vertices);
        out.triangles.extend(mesh.triangles.iter().map(|t| t.map(|v| v + offset)));
    }
    out
}

fn check_moves(response: &Response) {
    for op in &response.operations {
        assert!(op.gouge <= 0.02, "{} comes {} mm into the model", op.name, op.gouge);
        for path in &op.paths {
            assert_eq!(path[0][3], RAPID, "{}: a path starts with the tool coming down", op.name);
            for m in path {
                assert!(m.iter().all(|v| v.is_finite()));
                assert!([RAPID, FEED, PLUNGE].contains(&m[3]));
                assert!(m[2] <= 5.0 + 1e-9, "{}: {m:?} over the travel height", op.name);
            }
        }
    }
}

/// The model's top over a point: a needle dropped onto it.
fn top_at(surface: &Surface, p: [f64; 2]) -> f64 {
    surface.drop(&Cutter::new(Shape::Flat, 1e-3), p)
}

/// The feed moves that go down into material steeper than the ramp: every
/// move replayed over a fresh stock map, cut with a flat tool of each
/// operation's radius, and a descending feed named when the material under
/// the middle half of the tool stands more than 0.05 mm over its end.
fn steep_entries(response: &Response, radii: &[f64], ramp_degrees: f64) -> Vec<String> {
    let (min, max) = (response.stock.min, response.stock.max);
    let mut stock = Stock::new([min[0], min[1]], [max[0], max[1]], 0.0, 0.05);
    let slope = ramp_degrees.to_radians().tan();
    let mut found = Vec::new();
    for (op, &radius) in response.operations.iter().zip(radii) {
        let tool = Cutter::new(Shape::Flat, radius);
        for path in &op.paths {
            for w in path.windows(2) {
                let (a, b) = (w[0], w[1]);
                if b[3] == RAPID {
                    continue;
                }
                let run = (b[0] - a[0]).hypot(b[1] - a[1]);
                let drop = a[2] - b[2];
                let material = stock.highest([b[0], b[1]], [b[0], b[1]], radius / 2.0) - b[2];
                if b[3] == FEED && drop > slope * run * 1.05 + 1e-6 && material > 0.05 {
                    found.push(format!("{}: {a:?} -> {b:?} with {material:.3} mm of material", op.name));
                }
                stock.cut(&tool, [a[0], a[1], a[2]], [b[0], b[1], b[2]]);
            }
        }
    }
    found
}

#[test]
fn a_plate_is_roughed_to_the_leave_and_finished_to_size() {
    let plate = plate();
    let (response, stock, placed) = run(
        &plate,
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 1, "stepover": 1.2, "leave": 0.2, "leave_floor": 0.1 },
        ]),
    );
    check_moves(&response);
    assert!(response.notes.is_empty(), "{:?}", response.notes);
    let rough = &response.operations[0];
    assert!(!rough.paths.is_empty());
    // The stock's top at 0, the plate's top 0.5 under it, its bottom at -6.5.
    assert_eq!(response.model.max[2], -0.5);
    assert_eq!(response.model.min[2], -6.5);
    // Levels at the floors, lifted by the floor's leave.
    for floor in [-3.5, -2.5] {
        assert!(rough.levels.iter().any(|z| (z - (floor + 0.1)).abs() < 1e-9), "{floor} in {:?}", rough.levels);
    }
    assert_eq!(*rough.levels.last().unwrap(), -6.5);
    let surface = Surface::new(&placed, 0.1);
    let mut checked = 0;
    for (p, h) in stock.cells() {
        let model = top_at(&surface, p);
        // Never under the model, with the map's cell to spare.
        if model.is_finite() {
            assert!(h >= model - 0.06, "{p:?}: stock {h} under the model's {model}");
        }
        // The pocket's floor, away from its walls: down to the leave.
        let (x, y) = (p[0] - 4.0, p[1] - 4.0);
        if (6.5..13.5).contains(&x) && (7.5..12.5).contains(&y) {
            assert!((h - (-3.5 + 0.1)).abs() < 0.03, "{p:?}: pocket floor stock {h}");
            checked += 1;
        }
        // Beside the plate, a tool and more out: cut through.
        if ((-3.5..-2.0).contains(&x) && (0.0..20.0).contains(&y)) || ((21.0..23.0).contains(&y) && (0.0..30.0).contains(&x)) {
            assert!(h <= -6.5 + 1e-6, "{p:?}: the band round the plate is at {h}");
        }
    }
    assert!(checked > 500);
}

#[test]
fn a_waterline_after_roughing_runs_the_pocket_walls_at_the_tool_radius() {
    let (response, _, _) = run(
        &plate(),
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 1, "stepover": 1.2, "leave": 0.2 },
            { "name": "walls", "strategy": "waterline", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 3, "stepover": 1.2, "leave": 0 },
        ]),
    );
    check_moves(&response);
    let walls = &response.operations[1];
    // The pocket, 10 x 8 at x 5..15, y 6..14 on the plate, which sits 4 in:
    // its loop at the floor runs 1.5 inside its walls.
    let at_floor: Vec<[f64; 2]> =
        walls.paths.iter().flatten().filter(|m| (m[2] - -3.5).abs() < 1e-9 && m[3] == FEED).map(|m| [m[0], m[1]]).collect();
    let corners = [[10.5, 11.5], [17.5, 11.5], [17.5, 16.5], [10.5, 16.5]];
    let found = corners.iter().all(|c| at_floor.iter().any(|p| (p[0] - c[0]).abs() < 1e-3 && (p[1] - c[1]).abs() < 1e-3));
    assert!(found, "no loop round the pocket at its floor");
}

#[test]
fn the_tool_ramps_down_into_every_level_and_never_feeds_straight_into_stock() {
    let (response, _, _) = run(&plate(), shipped_rough_and_walls());
    check_moves(&response);
    let steep = steep_entries(&response, &[1.5, 1.5], 2.0);
    assert!(steep.is_empty(), "{} feeds go straight down into stock: {:?}", steep.len(), &steep[..steep.len().min(4)]);
}

#[test]
fn a_part_stood_up_by_a_quarter_turn_has_its_top_faced_and_its_floor_cut_to_height() {
    // Drawn with Y up and stood up front down, as the page's Model choice
    // does.
    let mut placed = l_block(|u, h, w| [u, h, -w]);
    let request: Request = serde_json::from_value(json!({
        "model": "test.stl",
        "turn": [90, 0, 0],
        "stock": { "margin": 3, "top": 0.5, "anchor": "corner" },
        "tolerance": 0.01,
        "travel": 5,
        "clearance": 1,
        "operations": shipped_rough_and_walls(),
    }))
    .unwrap();
    let (response, stock) = plan_with_stock(&mut placed, &request).unwrap();
    check_moves(&response);
    assert_eq!(response.model.open_edges, 0);
    // The top 0.5 under the block's top, the low base 3.2 under that.
    assert_eq!(response.model.flats, vec![-0.5, -3.7]);
    for op in &response.operations {
        for flat in [-0.5, -3.7] {
            assert!(op.levels.contains(&flat), "{}: {flat} not in {:?}", op.name, op.levels);
        }
    }
    // The high end along X from the model's side, the low base past it.
    let (lo, hi) = (response.model.min, response.model.max);
    let mut checked = [0, 0];
    for (p, h) in stock.cells() {
        let u = p[0] - lo[0];
        if p[1] < lo[1] + 2.0 || p[1] > hi[1] - 2.0 {
            continue;
        }
        if (2.0..8.0).contains(&u) {
            assert!(h <= -0.5 + 0.01, "{p:?}: stock at {h} over the top at -0.5");
            checked[0] += 1;
        }
        if (13.0..28.0).contains(&u) {
            assert!(h <= -3.7 + 0.01, "{p:?}: stock at {h} over the floor at -3.7");
            checked[1] += 1;
        }
    }
    assert!(checked[0] > 1000 && checked[1] > 1000, "{checked:?}");
}

#[test]
fn a_part_of_two_overlapping_bodies_is_cut_round_both() {
    // Two 20 x 20 x 6 boxes overlapping by 10 mm, as a part exported as two
    // bodies: the mesh is closed, so no note points at it, and where the
    // bodies overlap the part is solid at every level.
    let box_from = |x0: f64| heights([x0, x0 + 20.0], [0.0, 20.0], 1, 0.0, |_, _| 6.0);
    let two = through_stl(&joined(&[box_from(0.0), box_from(10.0)]));
    let (response, _, _) = run(&two, shipped_rough_and_walls());
    check_moves(&response);
    assert!(response.notes.is_empty(), "{:?}", response.notes);
    assert_eq!(response.model.size, [30.0, 20.0, 6.0]);
}

#[test]
fn a_rough_stepover_over_the_radius_leaves_nothing_standing() {
    // Loops asked for 0.7 of a 3 mm tool apart: the middle of an area deeper
    // than the radius past the innermost loop would stand uncut. First a
    // 10 x 10 x 5 block in a band 8 mm wide.
    let mut placed = voxels([20, 20, 10], 0.5, |_, _, _| true);
    let request: Request = serde_json::from_value(json!({
        "model": "test.stl",
        "stock": { "margin": 12, "top": 0, "anchor": "corner" },
        "tolerance": 0.01,
        "travel": 5,
        "clearance": 1,
        "operations": [
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 1, "stepover": 2.1, "leave": 0, "band": 8 },
        ],
    }))
    .unwrap();
    let (response, stock) = plan_with_stock(&mut placed, &request).unwrap();
    check_moves(&response);
    let notes = &response.operations[0].notes;
    assert!(notes.iter().any(|n| n.contains("its loops run 1.48 mm apart, not the stepover's 2.10")), "{notes:?}");
    let (lo, hi) = (response.model.min, response.model.max);
    let mut checked = 0;
    for (p, h) in stock.cells() {
        let dx = (lo[0] - p[0]).max(p[0] - hi[0]).max(0.0);
        let dy = (lo[1] - p[1]).max(p[1] - hi[1]).max(0.0);
        let from_block = dx.hypot(dy);
        if from_block > 1.0 && from_block < 10.0 {
            assert!(h <= lo[2] + 0.5, "{p:?}: stock at {h}, {from_block:.2} from the block");
            checked += 1;
        }
    }
    assert!(checked > 10_000, "{checked}");
    // An 11 mm square pocket 4 deep in a 20 x 20 x 5 plate, with the
    // shipped rough's leave: the tool's area in it is 7.6 mm across.
    let pocketed = voxels([40, 40, 10], 0.5, |i, j, k| !((9..31).contains(&i) && (9..31).contains(&j) && k >= 2));
    let (response, stock, _) = run(
        &pocketed,
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 1, "stepover": 2.1, "leave": 0.2, "leave_floor": 0 },
        ]),
    );
    check_moves(&response);
    // The plate sits 4 in, so the pocket's walls are at 8.5 and 19.5 and
    // its middle at 14; its floor is 4 under the plate's top at -0.5.
    let mut checked = 0;
    for (p, h) in stock.cells() {
        if (p[0] - 14.0).abs() < 3.0 && (p[1] - 14.0).abs() < 3.0 {
            assert!(h <= -4.5 + 0.5, "{p:?}: stock at {h} in the pocket");
            checked += 1;
        }
    }
    assert!(checked > 10_000, "{checked}");
}

#[test]
fn a_dome_is_finished_with_a_ball_to_the_scallop() {
    let radius = 20.0;
    let dome = heights([-10.0, 10.0], [-10.0, 10.0], 80, -8.0, |x, y| ((radius * radius - x * x - y * y).sqrt() - radius).max(-6.0));
    let (response, stock, placed) = run(
        &dome,
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 4 },
              "step_down": 1.5, "stepover": 1.6, "leave": 0.3 },
            { "name": "finish", "strategy": "parallel", "tool": { "shape": "ball", "diameter": 3 },
              "stepover": 0.3, "angle": 0 },
        ]),
    );
    check_moves(&response);
    assert!(!response.operations[1].paths.is_empty());
    let surface = Surface::new(&placed, 0.1);
    // A 3 mm ball 0.3 apart leaves scallops r - sqrt(r^2 - (s/2)^2) high.
    let scallop = 1.5 - (1.5f64 * 1.5 - 0.15 * 0.15).sqrt();
    let mut worst: f64 = 0.0;
    let mut cells = 0;
    let (min, _) = placed.bounds();
    for (p, h) in stock.cells() {
        let (x, y) = (p[0] - min[0], p[1] - min[1]);
        // Inside the dome's footprint, away from its edges and its foot.
        if !((3.0..17.0).contains(&x) && (3.0..17.0).contains(&y)) {
            continue;
        }
        let model = top_at(&surface, p);
        assert!(h >= model - 0.06, "{p:?}: stock {h} under the model's {model}");
        worst = worst.max(h - model);
        cells += 1;
    }
    assert!(cells > 10_000);
    assert!(worst < scallop + 0.08, "{worst} left against a scallop of {scallop}");
}

#[test]
fn an_overhang_is_named_and_kept_clear_of() {
    // A mushroom: a 4 mm post under a 12 mm cap.
    let mushroom = voxels([24, 24, 16], 0.5, |i, j, k| {
        let post = (10..14).contains(&i) && (10..14).contains(&j);
        let cap = k >= 10;
        post || cap
    });
    let (response, _, _) = run(
        &mushroom,
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 2 },
              "step_down": 1, "stepover": 0.8, "leave": 0 },
        ]),
    );
    check_moves(&response);
    assert!(response.notes.iter().any(|n| n.contains("faces down")), "{:?}", response.notes);
}

#[test]
fn a_fine_mesh_plans_in_good_time() {
    let wavy = heights([0.0, 40.0], [0.0, 30.0], 200, -10.0, |x, y| -4.0 + 1.5 * (x / 5.0).sin() * (y / 4.0).cos());
    let started = std::time::Instant::now();
    let (response, _, _) = run(
        &wavy,
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 1, "stepover": 1.2, "leave": 0.3 },
            { "name": "finish", "strategy": "parallel", "tool": { "shape": "ball", "diameter": 2 },
              "stepover": 0.25, "angle": 45 },
        ]),
    );
    check_moves(&response);
    let seconds = started.elapsed().as_secs_f64();
    assert!(seconds < 60.0, "{seconds} s for {} triangles", response.model.triangles);
    eprintln!("{} triangles planned in {seconds:.1} s", response.model.triangles);
}

#[test]
fn a_hole_too_small_for_the_rough_is_named_and_a_smaller_tool_takes_only_what_is_left() {
    // 20 x 12 x 3 mm with a 2 x 2 mm hole through at x 9..11, y 5..7.
    let part = voxels([40, 24, 6], 0.5, |i, j, _| !((18..22).contains(&i) && (10..14).contains(&j)));
    let (response, stock, _) = run(
        &part,
        json!([
            { "name": "rough", "strategy": "rough", "tool": { "shape": "flat", "diameter": 3 },
              "step_down": 1, "stepover": 1.2, "leave": 0 },
            { "name": "rest", "strategy": "rough", "tool": { "shape": "flat", "diameter": 1 },
              "step_down": 1, "stepover": 0.4, "leave": 0 },
        ]),
    );
    check_moves(&response);
    let rough = &response.operations[0];
    let named: Vec<&String> = rough.notes.iter().filter(|n| n.contains("narrower than the 3 mm tool")).collect();
    assert_eq!(named.len(), 1, "{:?}", rough.notes);
    // The block sits 4 mm round the part: the hole's middle is at 14, 10.
    assert!(named[0].contains("2.0 x 2.0 mm gap at X 14.0 Y 10.0"), "{}", named[0]);
    // The smaller tool cuts the hole and the corners the first one left,
    // and nothing it already cleared.
    let rest = &response.operations[1];
    assert!(rest.notes.iter().any(|n| n.contains("cuts left out")), "{:?}", rest.notes);
    assert!(rest.length < rough.length / 4.0, "{} against {}", rest.length, rough.length);
    let in_hole = rest.paths.iter().flatten().any(|m| m[3] == FEED && (m[0] - 14.0).abs() < 0.6 && (m[1] - 10.0).abs() < 0.6 && m[2] < -3.0);
    assert!(in_hole, "the 1 mm tool goes down the hole");
    let mut cleared = 0;
    for (p, h) in stock.cells() {
        if (p[0] - 14.0).abs() < 0.4 && (p[1] - 10.0).abs() < 0.4 {
            assert!(h <= -3.5 + 1e-6, "{p:?}: the hole still holds stock at {h}");
            cleared += 1;
        }
    }
    assert!(cleared > 100);
}
