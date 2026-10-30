//! The stock as a height map, cut down as the moves are written, so every
//! move between cuts knows how high the material still stands under it.
//!
//! A cell keeps the height of the material over its center. A cut lowers
//! every cell within the tool's radius of the move to the tool's lower
//! surface there. A move that changes height is taken in short pieces, each
//! at the higher of its two ends, so the map never shows less material than
//! is there: it errs toward keeping the tool up.

use crate::cutter::Cutter;
use crate::mesh::V3;
use crate::region::{segment_distance, P2};

pub struct Stock {
    origin: P2,
    cell: f64,
    nx: usize,
    ny: usize,
    height: Vec<f32>,
}

impl Stock {
    /// A block from `min` to `max` in the plane with its top at `top`; the
    /// cell is picked from the area, finer than `finest` never.
    pub fn new(min: P2, max: P2, top: f64, finest: f64) -> Stock {
        let width = (max[0] - min[0]).max(1e-6);
        let depth = (max[1] - min[1]).max(1e-6);
        let mut cell = finest.max((width * depth / 4.0e6).sqrt());
        while (width / cell).ceil() * (depth / cell).ceil() > 4.0e6 {
            cell *= 1.25;
        }
        let nx = ((width / cell).ceil() as usize).max(1);
        let ny = ((depth / cell).ceil() as usize).max(1);
        Stock { origin: min, cell, nx, ny, height: vec![top as f32; nx * ny] }
    }

    pub fn cell(&self) -> f64 {
        self.cell
    }

    fn center(&self, ix: usize, iy: usize) -> P2 {
        [self.origin[0] + (ix as f64 + 0.5) * self.cell, self.origin[1] + (iy as f64 + 0.5) * self.cell]
    }

    /// The cells whose centers may lie within `reach` of the box lo..hi.
    fn span(&self, lo: P2, hi: P2, reach: f64) -> Option<(usize, usize, usize, usize)> {
        let x0 = ((lo[0] - reach - self.origin[0]) / self.cell - 0.5).floor();
        let x1 = ((hi[0] + reach - self.origin[0]) / self.cell - 0.5).ceil();
        let y0 = ((lo[1] - reach - self.origin[1]) / self.cell - 0.5).floor();
        let y1 = ((hi[1] + reach - self.origin[1]) / self.cell - 0.5).ceil();
        if x1 < 0.0 || y1 < 0.0 || x0 >= self.nx as f64 || y0 >= self.ny as f64 {
            return None;
        }
        let clamp = |v: f64, n: usize| (v.max(0.0) as usize).min(n - 1);
        Some((clamp(x0, self.nx), clamp(x1, self.nx), clamp(y0, self.ny), clamp(y1, self.ny)))
    }

    /// The material's height over a point; minus infinity off the stock.
    pub fn at(&self, p: P2) -> f64 {
        let ix = ((p[0] - self.origin[0]) / self.cell).floor();
        let iy = ((p[1] - self.origin[1]) / self.cell).floor();
        if ix < 0.0 || iy < 0.0 || ix >= self.nx as f64 || iy >= self.ny as f64 {
            return f64::NEG_INFINITY;
        }
        self.height[iy as usize * self.nx + ix as usize] as f64
    }

    /// The highest material within `radius` of the segment a-b (a point
    /// when a == b), a cell's width wider to be safe.
    pub fn highest(&self, a: P2, b: P2, radius: f64) -> f64 {
        let reach = radius + self.cell;
        let lo = [a[0].min(b[0]), a[1].min(b[1])];
        let hi = [a[0].max(b[0]), a[1].max(b[1])];
        let Some((x0, x1, y0, y1)) = self.span(lo, hi, reach) else {
            return f64::NEG_INFINITY;
        };
        let mut best = f64::NEG_INFINITY;
        for iy in y0..=y1 {
            for ix in x0..=x1 {
                let h = self.height[iy * self.nx + ix] as f64;
                if h > best && segment_distance(self.center(ix, iy), a, b) <= reach {
                    best = h;
                }
            }
        }
        best
    }

    /// The tool moved from a to b at feed.
    pub fn cut(&mut self, cutter: &Cutter, a: V3, b: V3) {
        let run = (b[0] - a[0]).hypot(b[1] - a[1]);
        if (a[2] - b[2]).abs() < 1e-9 || run < 1e-9 {
            let z = if run < 1e-9 { a[2].min(b[2]) } else { a[2] };
            self.sweep(cutter, [a[0], a[1]], [b[0], b[1]], z);
            return;
        }
        let pieces = (run / self.cell).ceil().max(1.0) as usize;
        for k in 0..pieces {
            let t0 = k as f64 / pieces as f64;
            let t1 = (k + 1) as f64 / pieces as f64;
            let p = |t: f64| [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
            let (p0, p1) = (p(t0), p(t1));
            self.sweep(cutter, [p0[0], p0[1]], [p1[0], p1[1]], p0[2].max(p1[2]));
        }
    }

    /// The tool's tip held at z along a-b.
    fn sweep(&mut self, cutter: &Cutter, a: P2, b: P2, z: f64) {
        let r = cutter.radius;
        let lo = [a[0].min(b[0]), a[1].min(b[1])];
        let hi = [a[0].max(b[0]), a[1].max(b[1])];
        let Some((x0, x1, y0, y1)) = self.span(lo, hi, r) else {
            return;
        };
        for iy in y0..=y1 {
            for ix in x0..=x1 {
                let index = iy * self.nx + ix;
                if (self.height[index] as f64) <= z {
                    continue;
                }
                let d = segment_distance(self.center(ix, iy), a, b);
                if d <= r {
                    let floor = (z + cutter.profile(d)) as f32;
                    if floor < self.height[index] {
                        self.height[index] = floor;
                    }
                }
            }
        }
    }

    /// Every cell's center and the material's height there.
    pub fn cells(&self) -> impl Iterator<Item = (P2, f64)> + '_ {
        (0..self.ny).flat_map(move |iy| (0..self.nx).map(move |ix| (self.center(ix, iy), self.height[iy * self.nx + ix] as f64)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cutter::Shape;

    #[test]
    fn a_flat_cut_lowers_a_slot_and_nothing_else() {
        let mut stock = Stock::new([0.0, 0.0], [20.0, 20.0], 0.0, 0.1);
        let flat = Cutter::new(Shape::Flat, 1.0);
        stock.cut(&flat, [5.0, 10.0, -2.0], [15.0, 10.0, -2.0]);
        assert_eq!(stock.at([10.0, 10.0]), -2.0);
        assert_eq!(stock.at([10.0, 10.8]), -2.0);
        assert_eq!(stock.at([10.0, 11.2]), 0.0);
        assert_eq!(stock.at([3.0, 10.0]), 0.0);
        assert_eq!(stock.highest([10.0, 10.0], [10.0, 10.0], 0.5), -2.0);
        assert_eq!(stock.highest([10.0, 10.0], [10.0, 10.0], 1.5), 0.0);
    }

    #[test]
    fn a_ramp_never_takes_more_than_it_cut() {
        let mut stock = Stock::new([0.0, 0.0], [20.0, 20.0], 0.0, 0.1);
        let ball = Cutter::new(Shape::Ball, 1.0);
        stock.cut(&ball, [2.0, 10.0, 0.0], [18.0, 10.0, -4.0]);
        // The ball's true envelope over a cell's center: the lowest its
        // surface came there anywhere along the ramp.
        let envelope = |c: P2| {
            let mut low = f64::INFINITY;
            for k in 0..=16000 {
                let s = 2.0 + k as f64 * 0.001;
                let d = (s - c[0]).hypot(10.0 - c[1]);
                if d <= 1.0 {
                    low = low.min(-(s - 2.0) / 4.0 + ball.profile(d));
                }
            }
            low
        };
        let mut checked = 0;
        for (c, h) in stock.cells() {
            if (c[1] - 10.05).abs() < 1e-9 && [4.05, 8.05, 12.05, 16.05].iter().any(|x| (c[0] - x).abs() < 1e-9) {
                let low = envelope(c);
                assert!(h >= low - 1e-6 && h <= low + 0.03, "{c:?}: {h} against {low}");
                checked += 1;
            }
        }
        assert_eq!(checked, 4);
    }
}
