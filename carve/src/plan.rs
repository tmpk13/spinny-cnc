//! A request in, toolpaths out: the model read, turned and placed in its
//! stock with the stock's top at z 0, every operation's cuts linked into
//! paths over one stock map that each operation leaves for the next, and
//! each operation's paths checked against the model.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::cutter::{Cutter, Shape, Surface};
use crate::link::{self, Linker, Move, Settings};
use crate::mesh::{Mesh, V3};
use crate::ops::{self, Levels, Parallel, Part};
use crate::region;
use crate::slice::Slicer;
use crate::stock::Stock;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    /// The STL file.
    pub model: String,
    /// Degrees about X, then Y, then Z, before anything else.
    #[serde(default)]
    pub turn: [f64; 3],
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub stock: StockSpec,
    /// Chord tolerance of every curve, mm.
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    /// The travel height over the stock's top: a move between cuts that
    /// would need this much ends the path.
    #[serde(default = "default_travel")]
    pub travel: f64,
    /// Over the material for moves across and approaches, mm.
    #[serde(default = "default_clearance")]
    pub clearance: f64,
    #[serde(default)]
    pub operations: Vec<Operation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StockSpec {
    /// Round the model in X and Y, mm.
    #[serde(default)]
    pub margin: f64,
    /// Over the model's top, mm.
    #[serde(default)]
    pub top: f64,
    /// The block's size instead, mm: the model sits in its middle with its
    /// bottom on the block's.
    #[serde(default)]
    pub size: Option<[f64; 3]>,
    /// corner: the block's lower left on the origin; center: its middle;
    /// keep: the model's own X and Y.
    #[serde(default = "corner")]
    pub anchor: String,
    #[serde(default)]
    pub offset: [f64; 2],
}

impl Default for StockSpec {
    fn default() -> Self {
        StockSpec { margin: 0.0, top: 0.0, size: None, anchor: corner(), offset: [0.0, 0.0] }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub name: String,
    /// rough | waterline | parallel
    pub strategy: String,
    pub tool: Tool,
    /// Between levels, mm.
    #[serde(default)]
    pub step_down: f64,
    /// Between loops or lines, mm.
    pub stepover: f64,
    #[serde(default)]
    pub leave: f64,
    #[serde(default)]
    pub leave_floor: Option<f64>,
    /// Steepest entry, degrees; 90 plunges.
    #[serde(default = "default_ramp")]
    pub ramp: f64,
    /// climb | conventional
    #[serde(default = "climb")]
    pub direction: String,
    /// How far past touching the model the tool's center goes, mm.
    #[serde(default)]
    pub band: Option<f64>,
    /// How far under the model's bottom the last level goes, mm; less
    /// than 0 leaves a skin holding the part.
    #[serde(default)]
    pub below: f64,
    #[serde(default = "yes")]
    pub flats: bool,
    /// Parallel lines, degrees from X.
    #[serde(default)]
    pub angle: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    /// flat | ball | bull | vee
    pub shape: String,
    pub diameter: f64,
    /// A bull nose's corner radius, mm.
    #[serde(default)]
    pub corner: f64,
    /// A V bit's included angle, degrees.
    #[serde(default)]
    pub angle: f64,
    /// A V bit's tip width, mm.
    #[serde(default)]
    pub tip: f64,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub model: ModelInfo,
    pub stock: Block,
    /// The model's outline seen from above, where it was placed.
    pub silhouette: Vec<Vec<[f64; 2]>>,
    pub operations: Vec<OperationOut>,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub triangles: usize,
    pub size: V3,
    pub min: V3,
    pub max: V3,
    /// Heights of the flat faces looking up, highest first.
    pub flats: Vec<f64>,
    pub open_edges: usize,
}

#[derive(Debug, Serialize)]
pub struct Block {
    pub min: V3,
    pub max: V3,
}

#[derive(Debug, Serialize)]
pub struct OperationOut {
    pub name: String,
    /// Every path's moves: x, y, z and how the tool gets there (0 a rapid,
    /// 1 a feed, 2 a plunge). The first point of a path is where the tool
    /// comes down to from the travel height, over the path's start.
    pub paths: Vec<Vec<Move>>,
    pub levels: Vec<f64>,
    /// mm of feed moves.
    pub length: f64,
    /// The deepest any move comes into the model, mm.
    pub gouge: f64,
    pub notes: Vec<String>,
}

fn one() -> f64 {
    1.0
}
fn default_tolerance() -> f64 {
    0.01
}
fn default_travel() -> f64 {
    5.0
}
fn default_clearance() -> f64 {
    1.0
}
fn default_ramp() -> f64 {
    3.0
}
fn corner() -> String {
    "corner".into()
}
fn climb() -> String {
    "climb".into()
}
fn yes() -> bool {
    true
}

fn round(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

pub fn cutter_of(tool: &Tool) -> Result<Cutter, String> {
    if !(tool.diameter.is_finite() && tool.diameter > 0.0) {
        return Err(format!("the tool's diameter {} must be above 0", tool.diameter));
    }
    let radius = tool.diameter / 2.0;
    let shape = match tool.shape.as_str() {
        "flat" => Shape::Flat,
        "ball" => Shape::Ball,
        "bull" => {
            if !(tool.corner > 0.0 && tool.corner <= radius) {
                return Err(format!("a bull nose's corner {} must be above 0 and at most its radius {radius}", tool.corner));
            }
            Shape::Bull { corner: tool.corner }
        }
        "vee" => {
            if !(tool.angle > 0.0 && tool.angle < 180.0) {
                return Err(format!("a V bit's angle {} must be between 0 and 180 degrees", tool.angle));
            }
            if !(tool.tip >= 0.0 && tool.tip / 2.0 < radius) {
                return Err(format!("a V bit's tip {} must be narrower than the bit", tool.tip));
            }
            Shape::Vee { half_angle: (tool.angle / 2.0).to_radians(), tip: tool.tip / 2.0 }
        }
        other => return Err(format!("unknown tool shape {other:?}: flat, ball, bull or vee")),
    };
    Ok(Cutter::new(shape, radius))
}

pub fn plan(request: &Request) -> Result<Response, String> {
    let mut mesh = Mesh::read_stl(Path::new(&request.model))?;
    plan_with_stock(&mut mesh, request).map(|(response, _)| response)
}

/// The answer and the stock map as the last operation left it.
pub fn plan_with_stock(mesh: &mut Mesh, request: &Request) -> Result<(Response, Stock), String> {
    let tolerance = request.tolerance;
    if !(1e-4..=1.0).contains(&tolerance) {
        return Err(format!("the tolerance {tolerance} must be 0.0001 to 1 mm"));
    }
    if !(request.scale.is_finite() && request.scale > 0.0) {
        return Err(format!("the scale {} must be above 0", request.scale));
    }
    if !(request.clearance.is_finite() && request.clearance > 0.0) {
        return Err("the clearance must be above 0".into());
    }
    if !(request.travel.is_finite() && request.travel > request.clearance) {
        return Err("the travel height must be over the clearance".into());
    }
    mesh.turn(request.turn, request.scale);
    let (min, max) = mesh.bounds();
    let size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let spec = &request.stock;
    let (margin, top) = match spec.size {
        Some(block) => {
            let short = (0..3).find(|&k| block[k] < size[k] - 1e-6);
            if let Some(k) = short {
                return Err(format!(
                    "the stock is {} mm in {}, the model {:.3} mm: the model does not fit",
                    block[k],
                    ["X", "Y", "Z"][k],
                    size[k]
                ));
            }
            ([(block[0] - size[0]) / 2.0, (block[1] - size[1]) / 2.0], block[2] - size[2])
        }
        None => {
            if !(spec.margin >= 0.0 && spec.top >= 0.0) {
                return Err("the stock's margin and top must not be negative".into());
            }
            ([spec.margin, spec.margin], spec.top)
        }
    };
    let low = [min[0] - margin[0], min[1] - margin[1]];
    let high = [max[0] + margin[0], max[1] + margin[1]];
    let shift_xy = match spec.anchor.as_str() {
        "corner" => [-low[0], -low[1]],
        "center" => [-(low[0] + high[0]) / 2.0, -(low[1] + high[1]) / 2.0],
        "keep" => [0.0, 0.0],
        other => return Err(format!("unknown anchor {other:?}: corner, center or keep")),
    };
    let shift = [shift_xy[0] + spec.offset[0], shift_xy[1] + spec.offset[1], -(max[2] + top)];
    mesh.translate(shift);
    let stock_min = [low[0] + shift[0], low[1] + shift[1], min[2] + shift[2]];
    let stock_max = [high[0] + shift[0], high[1] + shift[1], 0.0];
    let shape = mesh.shape();
    let mut notes = Vec::new();
    if shape.undercut > 0.5 {
        notes.push(format!(
            "{:.0} mm^2 of the model faces down above its bottom: a tool from above cannot reach under it; turn the model or leave those faces be",
            shape.undercut
        ));
    }
    if shape.open_edges > 0 {
        notes.push(format!(
            "the mesh has {} open edges: it is not closed, so its sections may be wrong; repair it in the CAD program",
            shape.open_edges
        ));
    }
    let bottom = shape.min[2];
    let slicer = Slicer::new(mesh);
    let silhouette = slicer.silhouette();
    let part = Part { slicer, silhouette, stock_min, stock_max, bottom, flats: shape.flats.clone(), tolerance };
    let mut stock = Stock::new([stock_min[0], stock_min[1]], [stock_max[0], stock_max[1]], 0.0, 0.05);
    let mut operations = Vec::new();
    for op in &request.operations {
        operations.push(operation(mesh, &part, &mut stock, op, request).map_err(|e| format!("{}: {e}", op.name))?);
    }
    let response = Response {
        model: ModelInfo {
            triangles: mesh.triangles.len(),
            size: size.map(round),
            min: shape.min.map(round),
            max: shape.max.map(round),
            flats: shape.flats.iter().map(|f| round(f.0)).collect(),
            open_edges: shape.open_edges,
        },
        stock: Block { min: stock_min.map(round), max: stock_max.map(round) },
        silhouette: part.silhouette.iter().map(|p| region::polyline(p).iter().map(|q| q.map(round)).collect()).collect(),
        operations,
        notes,
    };
    Ok((response, stock))
}

/// What the tool could not get into, a few by name.
fn gap_notes(gaps: &[ops::Gap], tool: &Tool, notes: &mut Vec<String>) {
    const NAMED: usize = 6;
    for gap in gaps.iter().take(NAMED) {
        notes.push(format!(
            "a {:.1} x {:.1} mm gap at X {:.1} Y {:.1}, from Z {:.2} down, is narrower than the {} mm tool and is left: drill it, or add a smaller tool",
            gap.size[0], gap.size[1], gap.at[0], gap.at[1], gap.z, tool.diameter
        ));
    }
    if gaps.len() > NAMED {
        notes.push(format!("and {} more gaps the tool cannot get into", gaps.len() - NAMED));
    }
}

fn operation(mesh: &Mesh, part: &Part, stock: &mut Stock, op: &Operation, request: &Request) -> Result<OperationOut, String> {
    let cutter = cutter_of(&op.tool)?;
    let tolerance = request.tolerance;
    let radius = cutter.radius;
    for (what, value) in [("stepover", op.stepover), ("step_down", op.step_down), ("leave", op.leave), ("below", op.below.abs()), ("angle", op.angle.abs())] {
        if !value.is_finite() {
            return Err(format!("{what} is not a number"));
        }
    }
    if !(op.stepover > 0.0 && op.stepover <= 2.0 * radius) {
        return Err(format!("the stepover {} must be above 0 and at most the tool's diameter", op.stepover));
    }
    if op.step_down < 0.0 || op.leave < 0.0 {
        return Err("the step down and the stock left must not be negative".into());
    }
    if !(op.ramp > 0.0 && op.ramp <= 90.0) {
        return Err(format!("the ramp {} must be above 0 and at most 90 degrees", op.ramp));
    }
    let climb = match op.direction.as_str() {
        "climb" => true,
        "conventional" => false,
        other => return Err(format!("unknown direction {other:?}: climb or conventional")),
    };
    let floor = part.bottom - op.below;
    let leave_floor = op.leave_floor.unwrap_or(op.leave);
    let ramp = if op.ramp >= 89.9 { f64::INFINITY } else { op.ramp.to_radians().tan() };
    let surface = Surface::new(mesh, radius + op.leave);
    let mut notes = Vec::new();
    let (cuts, area, levels, check, link) = match op.strategy.as_str() {
        "rough" | "waterline" => {
            if matches!(cutter.shape, Shape::Vee { .. }) {
                return Err("a V bit cuts parallel passes only".into());
            }
            let settings = Levels {
                radius,
                leave: op.leave,
                leave_floor,
                step_down: op.step_down,
                stepover: op.stepover,
                band: op.band.unwrap_or(if op.strategy == "rough" { radius } else { 0.0 }).max(0.0),
                floor,
                climb,
                flats: op.flats,
            };
            let levels = part.levels(settings.step_down, floor, settings.flats, leave_floor);
            let (cuts, area) = if op.strategy == "rough" {
                if op.stepover > radius {
                    notes.push(format!(
                        "its loops run {:.2} mm apart, not the stepover's {:.2}: farther apart than the tool's radius, they would leave the middle of a wide area standing",
                        ops::ring_pitch(&settings, tolerance),
                        op.stepover
                    ));
                }
                let (cuts, area, gaps) = ops::rough(part, &settings, &levels);
                gap_notes(&gaps, &op.tool, &mut notes);
                (cuts, area)
            } else {
                ops::waterline(part, &settings, &levels)
            };
            // A link fed at depth keeps the leave, less two tolerances, and
            // never comes closer than the gouge check below allows.
            let check = Cutter::new(Shape::Flat, (radius + op.leave - 2.0 * tolerance).max(radius - tolerance).max(radius * 0.5));
            let link = if op.strategy == "rough" { 2.0 * op.stepover } else { 2.0 * radius };
            (cuts, area, levels, check, link)
        }
        "parallel" => {
            let settings = Parallel { leave: op.leave, stepover: op.stepover, angle: op.angle, band: op.band.unwrap_or(0.0), floor };
            let (cuts, area) = ops::parallel(part, &surface, &cutter, &settings);
            (cuts, area, Vec::new(), cutter, 0.0)
        }
        other => return Err(format!("unknown strategy {other:?}: rough, waterline or parallel")),
    };
    if cuts.is_empty() {
        notes.push("nothing to cut".into());
    }
    let settings = Settings { travel: request.travel, clearance: request.clearance, ramp, link, tolerance };
    let mut linker = Linker::new(cutter, check, &surface, stock, &area, settings);
    for cut in &cuts {
        linker.add(cut);
    }
    let (paths, skipped) = linker.finish();
    if skipped > 0 && !cuts.is_empty() {
        notes.push(format!("{skipped} of its {} cuts left out: nothing was left there for them", cuts.len()));
    }
    let gouge = link::gouge(&paths, &surface, &cutter.shrunk(tolerance), link::check_step(radius), tolerance);
    if gouge > 2.0 * tolerance {
        notes.push(format!("the moves come {gouge:.3} mm into the model: a fault in the toolpaths, do not run them"));
    }
    let mut length = 0.0;
    for path in &paths {
        for w in path.windows(2) {
            if w[1][3] != link::RAPID {
                let d = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]];
                length += (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            }
        }
    }
    Ok(OperationOut {
        name: op.name.clone(),
        paths: paths.into_iter().map(|path| path.into_iter().map(|m| [round(m[0]), round(m[1]), round(m[2]), m[3]]).collect()).collect(),
        levels: levels.into_iter().map(round).collect(),
        length: round(length),
        gouge: round(gouge),
        notes,
    })
}
