//! Cuts joined into paths of moves.
//!
//! An operation hands over its cuts in order: loops and lines at the height
//! they finish the work at. The linker gets the tool from one to the next.
//! A cut close to the last one, which may be reached at depth without
//! touching the model, is fed to directly; when it lies lower and stock
//! stands over it, the tool crosses at its own height and comes down the
//! cut's ramp, as into any other cut. Otherwise the tool rises to just
//! over the material between the two, as the stock map has it, crosses, and
//! comes down; when that move would leave the area the operation cuts in,
//! or rise to the travel height, the path ends and the machine's own travel
//! takes the tool across. Coming down, the tool feeds through the air to
//! just over the material and ramps into it: round a loop, or back and
//! forth along the start of a line, so it never plunges into stock.

use crate::cutter::{Cutter, Surface};
use crate::mesh::V3;
use crate::region::{Piece, P2};
use crate::stock::Stock;

/// A move's kind, the fourth number of each point: how the tool gets there.
pub const RAPID: f64 = 0.0;
pub const FEED: f64 = 1.0;
pub const PLUNGE: f64 = 2.0;

pub type Move = [f64; 4];

/// Material thinner than this over a cut's start is plunged through.
const SLIVER: f64 = 0.05;
/// A ramp starts this far over the material.
const RAMP_GAP: f64 = 0.1;

#[derive(Clone, Debug)]
pub struct Cut {
    pub points: Vec<V3>,
    /// The last point is the first: a ramp may go round it, and the cut
    /// ends where it began.
    pub closed: bool,
    /// May be fed to at depth from the cut before when close enough.
    pub stay_down: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    /// A move that would have to rise this high ends the path.
    pub travel: f64,
    /// Over the material for every move across and every approach.
    pub clearance: f64,
    /// The steepest entry, rise over run; infinite plunges.
    pub ramp: f64,
    /// The longest move fed at depth from one cut to the next.
    pub link: f64,
    pub tolerance: f64,
}

pub struct Linker<'a> {
    cutter: Cutter,
    /// The shape a move at depth must keep off the model.
    check: Cutter,
    surface: &'a Surface,
    stock: &'a mut Stock,
    area: &'a [Piece],
    settings: Settings,
    paths: Vec<Vec<Move>>,
    path: Vec<Move>,
    at: Option<V3>,
    /// Cuts left out because there was nothing left for them to take.
    pub skipped: usize,
}

impl<'a> Linker<'a> {
    pub fn new(cutter: Cutter, check: Cutter, surface: &'a Surface, stock: &'a mut Stock, area: &'a [Piece], settings: Settings) -> Self {
        Linker { cutter, check, surface, stock, area, settings, paths: Vec::new(), path: Vec::new(), at: None, skipped: 0 }
    }

    /// The tool's reach less its last two tolerances: material only past
    /// it is the wall a finished loop ran against, which does not count as
    /// stock left to take.
    fn inner_reach(&self) -> f64 {
        (self.cutter.radius - 2.0 * self.settings.tolerance).max(self.cutter.radius / 2.0)
    }

    /// Whether any of the cut's moves has material over it, within the
    /// tool's inner reach: the stock map never shows less than there is,
    /// so a cut it calls empty is.
    fn takes_material(&self, cut: &Cut) -> bool {
        let r = self.inner_reach();
        let lift = self.settings.tolerance;
        if cut.points.len() == 1 {
            let p = cut.points[0];
            return self.stock.above([p[0], p[1]], [p[0], p[1]], r, p[2] + lift);
        }
        cut.points.windows(2).any(|w| self.stock.above([w[0][0], w[0][1]], [w[1][0], w[1][1]], r, w[0][2].min(w[1][2]) + lift))
    }

    /// The cut linked on from where the tool is; a cut that would take
    /// nothing, as the stock map has it, is left out (and counted), so a
    /// second, smaller tool only goes where the first could not.
    pub fn add(&mut self, cut: &Cut) {
        if cut.points.is_empty() {
            return;
        }
        if !self.takes_material(cut) {
            self.skipped += 1;
            return;
        }
        let q = cut.points[0];
        if let Some(p) = self.at {
            let (pxy, qxy) = ([p[0], p[1]], [q[0], q[1]]);
            let run = (q[0] - p[0]).hypot(q[1] - p[1]);
            if cut.stay_down && run <= self.settings.link && self.stay_down(p, cut) {
                return;
            }
            let high = self.stock.highest(pxy, qxy, self.cutter.radius).max(p[2]).max(q[2]) + self.settings.clearance;
            if high < self.settings.travel && self.area.iter().any(|piece| piece.holds_segment(pxy, qxy)) {
                if high > p[2] {
                    self.rapid([p[0], p[1], high]);
                }
                self.rapid([q[0], q[1], high]);
                self.enter(cut, high);
                return;
            }
            self.end_path();
        }
        self.enter(cut, self.settings.travel);
    }

    /// Onto a cut close to the last one without leaving the depth: fed
    /// straight to its start, unless that goes down into stock; then across
    /// at the tool's height and down the cut's own ramp. False, and nothing
    /// written, when the move would meet the model.
    fn stay_down(&mut self, p: V3, cut: &Cut) -> bool {
        let q = cut.points[0];
        if !self.down_into_stock(p, q) {
            if !self.clean(p, q) {
                return false;
            }
            self.feed(q, FEED);
            self.follow(cut, 1);
            return true;
        }
        // Across at the tool's height to over the cut's start, then down the
        // ramp as into any other cut.
        let over = [q[0], q[1], p[2]];
        if !self.clean(p, over) {
            return false;
        }
        if (q[0] - p[0]).hypot(q[1] - p[1]) > 1e-9 {
            self.feed(over, FEED);
        }
        self.enter(cut, p[2]);
        true
    }

    /// Whether the tool going from p down to q would take stock on the way:
    /// material within its inner reach anywhere along the move standing
    /// over q.
    fn down_into_stock(&self, p: V3, q: V3) -> bool {
        q[2] < p[2] - 1e-9 && self.stock.above([p[0], p[1]], [q[0], q[1]], self.inner_reach(), q[2] + self.settings.tolerance)
    }

    /// The paths, and how many cuts were left out as taking nothing.
    pub fn finish(mut self) -> (Vec<Vec<Move>>, usize) {
        self.end_path();
        (self.paths, self.skipped)
    }

    fn end_path(&mut self) {
        if !self.path.is_empty() {
            self.paths.push(std::mem::take(&mut self.path));
        }
        self.at = None;
    }

    fn rapid(&mut self, to: V3) {
        self.path.push([to[0], to[1], to[2], RAPID]);
        self.at = Some(to);
    }

    fn feed(&mut self, to: V3, kind: f64) {
        if let Some(from) = self.at {
            self.stock.cut(&self.cutter, from, to);
        }
        self.path.push([to[0], to[1], to[2], kind]);
        self.at = Some(to);
    }

    fn follow(&mut self, cut: &Cut, from: usize) {
        for &p in &cut.points[from..] {
            self.feed(p, FEED);
        }
    }

    /// Down onto the cut's start from `from` and along the cut.
    fn enter(&mut self, cut: &Cut, from: f64) {
        let q = cut.points[0];
        let qxy = [q[0], q[1]];
        let material = self.stock.highest(qxy, qxy, self.cutter.radius);
        let approach = (material.max(q[2]) + self.settings.clearance).min(from);
        if self.path.is_empty() {
            // The path's first point, which the machine comes down to from
            // its travel height.
            self.rapid([q[0], q[1], approach]);
        } else if approach < from - 1e-9 {
            self.rapid([q[0], q[1], approach]);
        }
        if material - q[2] <= SLIVER || !self.settings.ramp.is_finite() || cut.points.len() < 2 {
            self.feed(q, PLUNGE);
            self.follow(cut, 1);
            return;
        }
        let start = (material + RAMP_GAP).min(approach);
        if start < approach - 1e-9 {
            self.feed([q[0], q[1], start], PLUNGE);
        }
        let done = if cut.closed { self.helix(cut, start) } else { self.zigzag(cut, start) };
        if !done {
            self.feed(q, PLUNGE);
        }
        self.follow(cut, 1);
    }

    /// Round a closed cut from `start` down to its height, a whole number
    /// of turns so the ramp ends at the cut's first point. False when the
    /// loop is too small to ramp round.
    fn helix(&mut self, cut: &Cut, start: f64) -> bool {
        let points = &cut.points;
        let perimeter: f64 = points.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum();
        let drop = start - points[0][2];
        let needed = drop / self.settings.ramp;
        if perimeter < 4.0 * self.settings.tolerance || needed / perimeter > 50.0 {
            return false;
        }
        let turns = (needed / perimeter).ceil().max(1.0);
        let slope = drop / (turns * perimeter);
        let mut walked = 0.0;
        for _ in 0..turns as usize {
            for w in points.windows(2) {
                walked += (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
                let z = (start - walked * slope).max(w[1][2]);
                self.feed([w[1][0], w[1][1], z], FEED);
            }
        }
        true
    }

    /// Back and forth along the start of an open cut from `start` down to
    /// its height, ending at its first point.
    fn zigzag(&mut self, cut: &Cut, start: f64) -> bool {
        let reach = (2.0 * self.cutter.radius).max(2.0);
        let mut leg: Vec<V3> = vec![cut.points[0]];
        let mut length = 0.0;
        for w in cut.points.windows(2) {
            let step = (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
            if length + step >= reach {
                let t = if step > 0.0 { (reach - length) / step } else { 0.0 };
                leg.push([w[0][0] + t * (w[1][0] - w[0][0]), w[0][1] + t * (w[1][1] - w[0][1]), w[0][2] + t * (w[1][2] - w[0][2])]);
                length = reach;
                break;
            }
            length += step;
            leg.push(w[1]);
        }
        if length < 4.0 * self.settings.tolerance {
            return false;
        }
        let drop = start - cut.points[0][2];
        let needed = drop / self.settings.ramp;
        let pairs = (needed / (2.0 * length)).ceil().max(1.0);
        if pairs > 50.0 {
            return false;
        }
        let slope = drop / (pairs * 2.0 * length);
        let mut walked = 0.0;
        let mut last = leg[0];
        for _ in 0..pairs as usize {
            let there = leg.iter().skip(1);
            let back = leg.iter().rev().skip(1);
            for &p in there.chain(back) {
                walked += (p[0] - last[0]).hypot(p[1] - last[1]);
                last = p;
                let z = (start - walked * slope).max(p[2]);
                self.feed([p[0], p[1], z], FEED);
            }
        }
        true
    }

    /// Whether the tool may feed straight from p to q at the heights of
    /// the move without meeting the model, looked at as closely as the
    /// gouge check looks at the paths.
    fn clean(&self, p: V3, q: V3) -> bool {
        let n = pieces(p, q, check_step(self.cutter.radius), self.settings.tolerance);
        (0..=n).all(|k| {
            let t = k as f64 / n as f64;
            let xy: P2 = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
            let z = p[2] + t * (q[2] - p[2]);
            self.surface.drop(&self.check, xy) <= z + self.settings.tolerance
        })
    }
}

/// How far apart along a move's run the checks against the model look: a
/// quarter of the tool's radius, 0.02 to 0.1 mm.
pub fn check_step(radius: f64) -> f64 {
    (radius / 4.0).clamp(0.02, 0.1)
}

/// How many pieces a move is checked in: one every `step` of its run and
/// one every `rise` of its height, so a steep move is looked at between its
/// ends and not only where its short run would put the samples. A move
/// straight up or down is checked at its ends: the drop cutter's height is
/// the same all along it, and the lower end is the worst.
fn pieces(a: V3, b: V3, step: f64, rise: f64) -> usize {
    let run = (b[0] - a[0]).hypot(b[1] - a[1]);
    if run <= 1e-9 {
        return 1;
    }
    (run / step).max((b[2] - a[2]).abs() / rise).ceil().max(1.0) as usize
}

/// The deepest the paths cut into the model: how far below the drop
/// cutter's height for the tool any move comes, sampled along every move
/// every `step` of its run and every `rise` of its height. Pass the tool
/// narrowed by the tolerance, or a side that only touches a wall reads as a
/// cut the wall's height deep.
pub fn gouge(paths: &[Vec<Move>], surface: &Surface, cutter: &Cutter, step: f64, rise: f64) -> f64 {
    use rayon::prelude::*;
    let moves: Vec<(Move, Move)> = paths.iter().flat_map(|path| path.windows(2).map(|w| (w[0], w[1]))).collect();
    moves
        .par_iter()
        .map(|&(a, b)| {
            let n = pieces([a[0], a[1], a[2]], [b[0], b[1], b[2]], step, rise);
            let mut worst: f64 = 0.0;
            for k in 0..=n {
                let t = k as f64 / n as f64;
                let xy = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                let z = a[2] + t * (b[2] - a[2]);
                let floor = surface.drop(cutter, xy);
                if floor > z {
                    worst = worst.max(floor - z);
                }
            }
            worst
        })
        .reduce(|| 0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cutter::Shape;
    use crate::mesh::tests::block;
    use crate::region;

    #[test]
    fn a_link_down_past_an_edge_through_air_is_not_fed_through_the_edge() {
        // A block's top edge at x 10. One cut ends with the tool on the top
        // at x 10.9; the next starts 3 mm lower at x 11, clear of the block.
        // The air between them is already cut down, so nothing but the model
        // is in the way, and the straight move would take the edge with the
        // tool's side though both its ends are clear.
        let surface = Surface::new(&block([0.0, 0.0, -5.0], [10.0, 10.0, 0.0]), 2.0);
        let mut stock = Stock::new([-5.0, -5.0], [20.0, 20.0], 1.0, 0.05);
        stock.cut(&Cutter::new(Shape::Flat, 1.2), [10.95, 5.0, -3.0], [10.95, 5.0, -3.0]);
        let area = region::pieces(&vec![region::path(&[[-5.0, -5.0], [20.0, -5.0], [20.0, 20.0], [-5.0, 20.0]])]);
        let tolerance = 0.01;
        let cutter = Cutter::new(Shape::Flat, 1.0);
        let settings = Settings { travel: 5.0, clearance: 1.0, ramp: 3f64.to_radians().tan(), link: 2.0, tolerance };
        let mut linker = Linker::new(cutter, Cutter::new(Shape::Flat, 1.0 - tolerance), &surface, &mut stock, &area, settings);
        let line = |points: Vec<V3>| Cut { points, closed: false, stay_down: true };
        linker.add(&line(vec![[10.9, 2.0, 0.0], [10.9, 5.0, 0.0]]));
        linker.add(&line(vec![[11.0, 5.0, -3.0], [11.0, 8.0, -3.0]]));
        let (paths, skipped) = linker.finish();
        assert_eq!(skipped, 0);
        let deepest = gouge(&paths, &surface, &cutter.shrunk(tolerance), check_step(cutter.radius), tolerance);
        assert!(deepest <= 2.0 * tolerance, "{deepest}: {paths:?}");
    }

    #[test]
    fn a_steep_move_is_checked_between_its_ends() {
        // A flat tool 1 mm in radius going down past a block's top edge at
        // x 10: over the top at its start, clear beside it at its end, and
        // through the edge in between, on a run shorter than the step.
        let surface = Surface::new(&block([0.0, 0.0, -5.0], [10.0, 10.0, 0.0]), 2.0);
        let flat = Cutter::new(Shape::Flat, 1.0);
        let step = check_step(flat.radius);
        let past = vec![[10.97, 5.0, 0.0, FEED], [11.04, 5.0, -5.0, FEED]];
        let deepest = gouge(&[past], &surface, &flat, step, 0.01);
        assert!(deepest > 2.0, "{deepest}");
        // Straight down beside the block: clear all the way.
        let beside = vec![[11.04, 5.0, 0.0, FEED], [11.04, 5.0, -5.0, FEED]];
        assert_eq!(gouge(&[beside], &surface, &flat, step, 0.01), 0.0);
    }
}
