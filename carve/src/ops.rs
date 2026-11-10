//! The strategies: what each operation cuts, as cuts in cutting order.
//!
//! - Rough: level by level down from the stock's top, the area the tool may
//!   be in at that height (inside the boundary, `leave` and its radius away
//!   from everything of the model above the level) is cleared with loops a
//!   stepover apart, the tool's radius at most, from the inside out. Levels
//!   are added at every flat face, so floors come out at their height. Each
//!   piece of a level is followed down through the pieces under it before
//!   the next one.
//! - Waterline: at each level, one loop along every wall at the tool's
//!   radius from it.
//! - Parallel: lines across the model a stepover apart, the tool dropped
//!   onto the mesh along them, back and forth.
//!
//! The level strategies treat the tool as a cylinder its full radius wide
//! from its tip up, which is exact on vertical walls and leaves stock on
//! slopes for a parallel pass to take.

use clipper2_rust::Paths64;
use rayon::prelude::*;

use crate::cutter::{Cutter, Surface};
use crate::link::Cut;
use crate::mesh::V3;
use crate::region::{self, Piece, P2};
use crate::slice::Slicer;

pub struct Part<'a> {
    pub slicer: Slicer<'a>,
    pub silhouette: Paths64,
    pub stock_min: V3,
    pub stock_max: V3,
    /// The model's lowest point.
    pub bottom: f64,
    pub flats: Vec<(f64, f64)>,
    pub tolerance: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Levels {
    /// The tool's radius, mm.
    pub radius: f64,
    /// Stock kept on the walls and on the floors, mm.
    pub leave: f64,
    pub leave_floor: f64,
    /// Between levels, mm; 0 cuts only at the flat faces and the floor.
    pub step_down: f64,
    /// Between loops of a level, mm.
    pub stepover: f64,
    /// How far past touching the model the tool's center goes round it.
    pub band: f64,
    /// The lowest level.
    pub floor: f64,
    pub climb: bool,
    pub flats: bool,
}

impl Part<'_> {
    fn stock_rect(&self) -> Paths64 {
        let (a, b) = (self.stock_min, self.stock_max);
        vec![region::path(&[[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]])]
    }

    /// Where the tool's center goes: `reach` round the model, and when
    /// `past_edge` says, no farther than that past the stock's edge.
    pub fn boundary(&self, reach: f64, past_edge: Option<f64>) -> Paths64 {
        let round = region::inflate(&self.silhouette, reach, self.tolerance);
        match past_edge {
            Some(past) => region::intersect(&round, &region::inflate(&self.stock_rect(), past.max(0.0), self.tolerance)),
            None => round,
        }
    }

    /// The heights to cut at, highest first: every step down from the top,
    /// each flat face lifted by `lift` when asked, and the floor last.
    pub fn levels(&self, step: f64, floor: f64, flats: bool, lift: f64) -> Vec<f64> {
        let top = self.stock_max[2];
        let mut out = Vec::new();
        if step > 0.0 {
            let mut k = 1;
            loop {
                let z = top - k as f64 * step;
                if z <= floor + 1e-6 {
                    break;
                }
                out.push(z);
                k += 1;
            }
        }
        if flats {
            for &(z, _) in &self.flats {
                let z = z + lift;
                if z > floor + 1e-6 && z < top - 1e-6 {
                    out.push(z);
                }
            }
        }
        if floor < top - 1e-6 {
            out.push(floor);
        }
        out.sort_by(|a, b| b.total_cmp(a));
        out.dedup_by(|b, a| (*a - *b).abs() < 1e-3);
        out
    }
}

/// A closed loop started at its point nearest to `p`, with that start
/// repeated at the end.
pub fn start_near(points: &[P2], p: P2) -> Vec<P2> {
    let n = points.len();
    let mut best = (f64::INFINITY, 0usize, points[0]);
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let q = [a[0] + t * dx, a[1] + t * dy];
        let d = region::dist(p, q);
        if d < best.0 {
            best = (d, i, q);
        }
    }
    let (_, i, q) = best;
    let mut out = Vec::with_capacity(n + 2);
    out.push(q);
    for k in 1..=n {
        let v = points[(i + k) % n];
        if region::dist(v, *out.last().unwrap()) > 1e-9 {
            out.push(v);
        }
    }
    if region::dist(q, *out.last().unwrap()) > 1e-9 {
        out.push(q);
    }
    out
}

fn closed_cut(points: &[P2], z: f64) -> Cut {
    Cut { points: points.iter().map(|p| [p[0], p[1], z]).collect(), closed: true, stay_down: true }
}

fn perimeter(path: &[P2]) -> f64 {
    let n = path.len();
    (0..n).map(|i| region::dist(path[i], path[(i + 1) % n])).sum()
}

struct Node {
    level: usize,
    piece: Piece,
    /// Loops by their ring, the innermost ring first, as Clipper gave them.
    rings: Vec<Vec<Vec<P2>>>,
    children: Vec<usize>,
}

/// A gap in the model the tool cannot get into at some level: its box's
/// middle, its width and length, and the highest level it was seen at.
#[derive(Clone, Copy, Debug)]
pub struct Gap {
    pub at: P2,
    pub size: P2,
    pub z: f64,
}

/// The gaps of a level the tool's center cannot reach: the places inside
/// the model's outline, notches narrower than the tool closed over, that
/// are free of the model at the level and that no position of the tool
/// touches. Holes and slots narrower than the tool; a corner's fillet is
/// part of a gap the tool does reach, and is not one.
fn unreachable_gaps(part: &Part, shadow: &Paths64, free: &Paths64, keep: f64, z: f64) -> Vec<Gap> {
    let tolerance = part.tolerance;
    let closed = region::inflate(&region::inflate(&part.silhouette, keep, tolerance), -keep, tolerance);
    let gaps = region::difference(&closed, shadow);
    if gaps.is_empty() {
        return Vec::new();
    }
    let swept = region::inflate(free, keep, tolerance);
    let mut out = Vec::new();
    for piece in region::pieces(&gaps) {
        if piece.area() < 16.0 * tolerance * tolerance {
            continue;
        }
        let paths = piece.paths();
        // A sliver along the tool's reach is the stock it leaves, not a gap.
        if region::inflate(&paths, -2.0 * tolerance, tolerance).is_empty() {
            continue;
        }
        if !region::intersect(&paths, &swept).is_empty() {
            continue;
        }
        let points = region::polyline(&piece.outer);
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for p in &points {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        out.push(Gap { at: [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0], size: [hi[0] - lo[0], hi[1] - lo[1]], z });
    }
    out
}

/// How far apart a rough's loops run: the stepover, but never more than the
/// tool's radius less two tolerances. A point deeper in a piece than its
/// innermost loop is less than one pitch from it, so with loops farther
/// apart than the tool reaches, the middle of a piece of the wrong width
/// would stand uncut at every level.
pub fn ring_pitch(s: &Levels, tolerance: f64) -> f64 {
    s.stepover.min((s.radius - 2.0 * tolerance).max(s.radius / 2.0))
}

/// A rough at `levels`, the heights `Part::levels` gives for `s`.
pub fn rough(part: &Part, s: &Levels, levels: &[f64]) -> (Vec<Cut>, Vec<Piece>, Vec<Gap>) {
    let tolerance = part.tolerance;
    let pitch = ring_pitch(s, tolerance);
    // Past the block's edge only as far as the outer loop still takes a
    // pitch off it.
    let area = part.boundary(s.radius + s.leave + s.band, Some(s.radius - pitch));
    let shadows = part.slicer.shadows(levels);
    let keep = s.radius + s.leave;
    let per_level: Vec<(Vec<Node>, Vec<Gap>)> = levels
        .par_iter()
        .enumerate()
        .map(|(level, &z)| {
            let free = region::difference(&area, &region::inflate(&shadows[level], keep, tolerance));
            let gaps = unreachable_gaps(part, &shadows[level], &free, keep, z);
            let nodes = region::pieces(&free)
                .into_iter()
                .filter(|piece| piece.area() > tolerance * tolerance)
                .map(|piece| {
                    let paths = piece.paths();
                    let mut rings = Vec::new();
                    for k in 0.. {
                        let ring = region::inflate(&paths, -(k as f64) * pitch, tolerance);
                        let loops: Vec<Vec<P2>> =
                            ring.iter().map(region::polyline).filter(|l| l.len() >= 3 && perimeter(l) > 2.0 * tolerance).collect();
                        if loops.is_empty() || k > 100_000 {
                            break;
                        }
                        rings.push(loops);
                    }
                    rings.reverse();
                    Node { level, piece, rings, children: Vec::new() }
                })
                .collect();
            (nodes, gaps)
        })
        .collect();
    // A gap is named once, at the highest level it shows at.
    let mut gaps: Vec<Gap> = Vec::new();
    for (_, found) in &per_level {
        for gap in found {
            if !gaps.iter().any(|g| region::dist(g.at, gap.at) < keep) {
                gaps.push(*gap);
            }
        }
    }
    // Each piece hangs under the piece of the level above that holds it.
    let mut nodes: Vec<Node> = Vec::new();
    let mut first_of_level = Vec::with_capacity(levels.len());
    for (list, _) in per_level {
        first_of_level.push(nodes.len());
        nodes.extend(list);
    }
    first_of_level.push(nodes.len());
    let mut roots = Vec::new();
    for index in 0..nodes.len() {
        let level = nodes[index].level;
        if level == 0 {
            roots.push(index);
            continue;
        }
        let probe = region::mm(&nodes[index].piece.outer[0]);
        let above = first_of_level[level - 1]..first_of_level[level];
        let parent = above
            .clone()
            .find(|&j| nodes[j].piece.contains(probe))
            .or_else(|| above.min_by(|&a, &b| distance_to(&nodes[a].piece, probe).total_cmp(&distance_to(&nodes[b].piece, probe))));
        match parent {
            Some(j) => nodes[j].children.push(index),
            None => roots.push(index),
        }
    }
    let mut cuts = Vec::new();
    let mut at: P2 = [part.stock_min[0], part.stock_min[1]];
    // Depth first: a piece, then the nearest of what hangs under it.
    let mut stack: Vec<Vec<usize>> = vec![roots];
    while let Some(siblings) = stack.last_mut() {
        if siblings.is_empty() {
            stack.pop();
            continue;
        }
        let pick = siblings
            .iter()
            .enumerate()
            .min_by(|a, b| distance_to(&nodes[*a.1].piece, at).total_cmp(&distance_to(&nodes[*b.1].piece, at)))
            .map(|(i, _)| i)
            .unwrap();
        let index = siblings.swap_remove(pick);
        let node = &nodes[index];
        let z = levels[node.level];
        for ring in &node.rings {
            let mut left: Vec<&Vec<P2>> = ring.iter().collect();
            while !left.is_empty() {
                let pick = left
                    .iter()
                    .enumerate()
                    .min_by(|a, b| loop_distance(a.1, at).total_cmp(&loop_distance(b.1, at)))
                    .map(|(i, _)| i)
                    .unwrap();
                let chosen = left.swap_remove(pick);
                let mut points = chosen.clone();
                if s.climb {
                    points.reverse();
                }
                let points = start_near(&points, at);
                at = points[0];
                cuts.push(closed_cut(&points, z));
            }
        }
        let children = node.children.clone();
        stack.push(children);
    }
    (cuts, region::pieces(&area), gaps)
}

/// A waterline at `levels`, the heights `Part::levels` gives for `s`.
pub fn waterline(part: &Part, s: &Levels, levels: &[f64]) -> (Vec<Cut>, Vec<Piece>) {
    let tolerance = part.tolerance;
    // Every wall's loop is inside: a wall is finished wherever it stands.
    let area = part.boundary(s.radius + s.leave + s.band.max(4.0 * tolerance), None);
    let pieces = region::pieces(&area);
    let shadows = part.slicer.shadows(levels);
    let keep = s.radius + s.leave;
    let per_level: Vec<Vec<(Vec<P2>, bool)>> = shadows
        .par_iter()
        .map(|shadow| {
            let walls = region::inflate(shadow, keep, tolerance);
            let mut out = Vec::new();
            for wall in &walls {
                let mut points = region::polyline(wall);
                if points.len() < 3 || perimeter(&points) <= 2.0 * tolerance {
                    continue;
                }
                if !s.climb {
                    points.reverse();
                }
                if points.iter().all(|&p| pieces.iter().any(|piece| piece.contains(p))) {
                    out.push((points, true));
                    continue;
                }
                let mut open = points.clone();
                open.push(points[0]);
                for part in region::clip_lines(&vec![region::path(&open)], &area) {
                    let mut line = region::polyline(&part);
                    // Clipper may hand an open path back reversed.
                    if line.len() >= 2 && !follows(&open, &line) {
                        line.reverse();
                    }
                    if line.len() >= 2 && region::length(&line) > 2.0 * tolerance {
                        out.push((line, false));
                    }
                }
            }
            out
        })
        .collect();
    let mut cuts = Vec::new();
    let mut at: P2 = [part.stock_min[0], part.stock_min[1]];
    for (level, mut walls) in per_level.into_iter().enumerate() {
        let z = levels[level];
        while !walls.is_empty() {
            let pick = walls
                .iter()
                .enumerate()
                .min_by(|a, b| {
                    let da = if a.1 .1 { loop_distance(&a.1 .0, at) } else { region::dist(a.1 .0[0], at) };
                    let db = if b.1 .1 { loop_distance(&b.1 .0, at) } else { region::dist(b.1 .0[0], at) };
                    da.total_cmp(&db)
                })
                .map(|(i, _)| i)
                .unwrap();
            let (points, closed) = walls.swap_remove(pick);
            if closed {
                let points = start_near(&points, at);
                at = points[0];
                cuts.push(closed_cut(&points, z));
            } else {
                at = *points.last().unwrap();
                cuts.push(Cut { points: points.iter().map(|p| [p[0], p[1], z]).collect(), closed: false, stay_down: true });
            }
        }
    }
    (cuts, pieces)
}

#[derive(Clone, Copy, Debug)]
pub struct Parallel {
    pub leave: f64,
    pub stepover: f64,
    /// Degrees from X of the lines.
    pub angle: f64,
    pub band: f64,
    pub floor: f64,
}

pub fn parallel(part: &Part, surface: &Surface, cutter: &Cutter, s: &Parallel) -> (Vec<Cut>, Vec<Piece>) {
    let tolerance = part.tolerance;
    let area = part.boundary(s.band.max(0.0), Some(cutter.radius));
    let pieces = region::pieces(&area);
    let grown = cutter.grown(s.leave);
    let (sin, cos) = s.angle.to_radians().sin_cos();
    // Lines run along u; v is across them.
    let to_uv = |p: P2| [p[0] * cos + p[1] * sin, -p[0] * sin + p[1] * cos];
    let to_xy = |q: P2| [q[0] * cos - q[1] * sin, q[0] * sin + q[1] * cos];
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for path in &area {
        for p in path {
            let q = to_uv(region::mm(p));
            for k in 0..2 {
                lo[k] = lo[k].min(q[k]);
                hi[k] = hi[k].max(q[k]);
            }
        }
    }
    if !lo[0].is_finite() {
        return (Vec::new(), pieces);
    }
    let count = ((hi[1] - lo[1]) / s.stepover).ceil().max(0.0) as usize;
    let height = |p: P2| {
        let h = surface.drop(&grown, p);
        let h = if h.is_finite() { h + s.leave } else { s.floor };
        h.max(s.floor)
    };
    let lines: Vec<Vec<Vec<V3>>> = (0..=count)
        .into_par_iter()
        .map(|j| {
            let v = (lo[1] + j as f64 * s.stepover).min(hi[1]);
            let line = vec![region::path(&[to_xy([lo[0] - 1.0, v]), to_xy([hi[0] + 1.0, v])])];
            let mut segments: Vec<(f64, Vec<V3>)> = region::clip_lines(&line, &area)
                .iter()
                .map(|segment| {
                    let mut pts = region::polyline(segment);
                    if to_uv(pts[0])[0] > to_uv(*pts.last().unwrap())[0] {
                        pts.reverse();
                    }
                    let a = pts[0];
                    let b = *pts.last().unwrap();
                    (to_uv(a)[0], sample(a, b, &height, cutter.radius, tolerance))
                })
                .filter(|(_, pts)| pts.len() >= 2)
                .collect();
            segments.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut out: Vec<Vec<V3>> = segments.into_iter().map(|(_, pts)| pts).collect();
            if j % 2 == 1 {
                out.reverse();
                for pts in out.iter_mut() {
                    pts.reverse();
                }
            }
            out
        })
        .collect();
    let mut cuts: Vec<Cut> = Vec::new();
    for segment in lines.into_iter().flatten() {
        if let Some(last) = cuts.last_mut() {
            let end = *last.points.last().unwrap();
            let start = segment[0];
            let (a, b) = ([end[0], end[1]], [start[0], start[1]]);
            if region::dist(a, b) <= 2.0 * s.stepover + 1e-9 && pieces.iter().any(|piece| piece.holds_segment(a, b)) {
                let bridge = sample(a, b, &height, cutter.radius, tolerance);
                last.points.extend_from_slice(&bridge[1..]);
                last.points.extend_from_slice(&segment[1..]);
                continue;
            }
        }
        cuts.push(Cut { points: segment, closed: false, stay_down: false });
    }
    for cut in cuts.iter_mut() {
        cut.points = simplify(&cut.points, tolerance / 2.0);
    }
    (cuts, pieces)
}

/// The tool's heights along a-b: a point every so often, and more where the
/// surface bends away from a straight line by more than half the tolerance.
fn sample(a: P2, b: P2, height: &impl Fn(P2) -> f64, radius: f64, tolerance: f64) -> Vec<V3> {
    let run = region::dist(a, b);
    let step = (radius / 2.0).clamp(0.05, 0.5);
    let n = (run / step).ceil().max(1.0) as usize;
    let at = |t: f64| [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    let mut out: Vec<V3> = Vec::with_capacity(n + 1);
    let first = at(0.0);
    out.push([first[0], first[1], height(first)]);
    for k in 0..n {
        let (t0, t1) = (k as f64 / n as f64, (k + 1) as f64 / n as f64);
        let p1 = at(t1);
        let end = [p1[0], p1[1], height(p1)];
        let begin = *out.last().unwrap();
        refine(&mut out, t0, t1, begin, end, &at, height, run, tolerance, 0);
        out.push(end);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn refine(
    out: &mut Vec<V3>,
    t0: f64,
    t1: f64,
    p0: V3,
    p1: V3,
    at: &impl Fn(f64) -> [f64; 2],
    height: &impl Fn(P2) -> f64,
    run: f64,
    tolerance: f64,
    depth: u32,
) {
    if depth >= 7 || (t1 - t0) * run < 0.01 {
        return;
    }
    let tm = (t0 + t1) / 2.0;
    let m = at(tm);
    let pm = [m[0], m[1], height(m)];
    if (pm[2] - (p0[2] + p1[2]) / 2.0).abs() <= tolerance / 2.0 {
        return;
    }
    refine(out, t0, tm, p0, pm, at, height, run, tolerance, depth + 1);
    out.push(pm);
    refine(out, tm, t1, pm, p1, at, height, run, tolerance, depth + 1);
}

/// Douglas-Peucker in three dimensions.
pub fn simplify(points: &[V3], tolerance: f64) -> Vec<V3> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((i, j)) = stack.pop() {
        let (a, b) = (points[i], points[j]);
        let mut worst = (0.0, 0usize);
        for (k, &p) in points.iter().enumerate().take(j).skip(i + 1) {
            let d = distance_3d(p, a, b);
            if d > worst.0 {
                worst = (d, k);
            }
        }
        if worst.0 > tolerance {
            keep[worst.1] = true;
            stack.push((i, worst.1));
            stack.push((worst.1, j));
        }
    }
    points.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn distance_3d(p: V3, a: V3, b: V3) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = if l2 > 0.0 { ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let d = [ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// Whether `line` runs the same way as `along`, by where their ends fall.
fn follows(along: &[P2], line: &[P2]) -> bool {
    let position = |p: P2| {
        let mut best = (f64::INFINITY, 0.0);
        let mut walked = 0.0;
        for w in along.windows(2) {
            let d = region::segment_distance(p, w[0], w[1]);
            if d < best.0 {
                best = (d, walked + region::dist(w[0], p).min(region::dist(w[0], w[1])));
            }
            walked += region::dist(w[0], w[1]);
        }
        best.1
    };
    position(line[0]) <= position(*line.last().unwrap())
}

fn loop_distance(points: &[P2], p: P2) -> f64 {
    let n = points.len();
    (0..n).map(|i| region::segment_distance(p, points[i], points[(i + 1) % n])).fold(f64::INFINITY, f64::min)
}

fn distance_to(piece: &Piece, p: P2) -> f64 {
    loop_distance(&region::polyline(&piece.outer), p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loop_starts_at_the_point_nearest_and_closes() {
        let square = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let out = start_near(&square, [4.0, -3.0]);
        assert_eq!(out[0], [4.0, 0.0]);
        assert_eq!(*out.last().unwrap(), [4.0, 0.0]);
        assert_eq!(out.len(), 6);
        assert_eq!(out[1], [10.0, 0.0]);
    }

    #[test]
    fn simplify_drops_points_on_a_straight_line() {
        let line: Vec<V3> = (0..=10).map(|k| [k as f64, 0.0, 0.5 * k as f64]).collect();
        assert_eq!(simplify(&line, 0.001).len(), 2);
        let bent: Vec<V3> = (0..=10).map(|k| [k as f64, 0.0, (k as f64 - 5.0).abs()]).collect();
        assert_eq!(simplify(&bent, 0.001), vec![[0.0, 0.0, 5.0], [5.0, 0.0, 0.0], [10.0, 0.0, 5.0]]);
    }
}
