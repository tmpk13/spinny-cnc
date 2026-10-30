//! The drop cutter: how low a tool's tip can come down at a point of the
//! plane before it touches the mesh, for flat, ball, bull nose and V bits.
//!
//! A round tool's lower surface rises `profile(d)` over its tip at the
//! distance d from its axis. Over one triangle the tip has to clear every
//! point: a corner at the height z minus the profile at its distance, an
//! edge at the most of that along it (the function is concave along an edge,
//! so there is one top), and the face where a plane rising with slope s is
//! met first, at the distance where the profile's slope equals s. The tip's
//! height is the most of these over every triangle under the tool.

use rayon::prelude::*;

use crate::mesh::{Mesh, V3};
use crate::region::P2;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Flat,
    Ball,
    /// A bull nose: a flat end with its corners rounded to `corner` mm.
    Bull { corner: f64 },
    /// A V bit: the half of its included angle, radians, and the radius of
    /// its flat tip.
    Vee { half_angle: f64, tip: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cutter {
    pub shape: Shape,
    pub radius: f64,
}

impl Cutter {
    pub fn new(shape: Shape, radius: f64) -> Self {
        Cutter { shape, radius }
    }

    /// The height of the tool's lower surface over its tip at the distance
    /// `d` from its axis, 0 <= d <= radius.
    pub fn profile(&self, d: f64) -> f64 {
        let r = self.radius;
        match self.shape {
            Shape::Flat => 0.0,
            Shape::Ball => r - (r * r - d * d).max(0.0).sqrt(),
            Shape::Bull { corner } => {
                let inner = r - corner;
                if d <= inner {
                    0.0
                } else {
                    let e = (d - inner).min(corner);
                    corner - (corner * corner - e * e).max(0.0).sqrt()
                }
            }
            Shape::Vee { half_angle, tip } => {
                if d <= tip {
                    0.0
                } else {
                    (d - tip) / half_angle.tan()
                }
            }
        }
    }

    /// The distance from the axis at which a plane rising with slope `s`
    /// (rise over run) touches the tool first.
    fn facet_radius(&self, s: f64) -> f64 {
        if s <= 0.0 {
            return 0.0;
        }
        let r = self.radius;
        let lean = s / (1.0 + s * s).sqrt();
        match self.shape {
            Shape::Flat => r,
            Shape::Ball => r * lean,
            Shape::Bull { corner } => (r - corner) + corner * lean,
            Shape::Vee { half_angle, tip } => {
                if s > 1.0 / half_angle.tan() {
                    r
                } else {
                    tip
                }
            }
        }
    }

    /// The tool narrowed by `by` mm with its tip where it was: a shape
    /// inside the tool's own, for telling a cut into the model from the
    /// tool's side brushing a wall it was put against.
    pub fn shrunk(&self, by: f64) -> Cutter {
        let radius = (self.radius - by).max(self.radius / 2.0);
        let shape = match self.shape {
            Shape::Bull { corner } => Shape::Bull { corner: corner.min(radius) },
            Shape::Vee { half_angle, tip } => Shape::Vee { half_angle, tip: tip.min(radius) },
            other => other,
        };
        Cutter { shape, radius }
    }

    /// The tool grown by `leave` mm all round: driving the grown tool over
    /// the model and lowering its tip by `leave` leaves that much stock on
    /// every surface. A V bit has no exact grown shape; its leave is taken
    /// straight up.
    pub fn grown(&self, leave: f64) -> Cutter {
        if leave <= 0.0 {
            return *self;
        }
        let radius = self.radius + leave;
        let shape = match self.shape {
            Shape::Flat => Shape::Bull { corner: leave },
            Shape::Ball => Shape::Ball,
            Shape::Bull { corner } => Shape::Bull { corner: corner + leave },
            vee @ Shape::Vee { .. } => return Cutter { shape: vee, radius: self.radius },
        };
        Cutter { shape, radius }
    }
}

/// A triangle as the drop cutter uses it.
#[derive(Clone, Debug)]
struct Tri {
    v: [V3; 3],
    top: f64,
    /// z = a x + b y + c, for a face that is not vertical.
    plane: Option<[f64; 3]>,
}

impl Tri {
    fn new(v: [V3; 3]) -> Self {
        let n = crate::mesh::cross(crate::mesh::sub(v[1], v[0]), crate::mesh::sub(v[2], v[0]));
        let length = crate::mesh::norm(n);
        let plane = if length > 0.0 && n[2].abs() > 1e-9 * length {
            let a = -n[0] / n[2];
            let b = -n[1] / n[2];
            Some([a, b, v[0][2] - a * v[0][0] - b * v[0][1]])
        } else {
            None
        };
        Tri { v, top: v[0][2].max(v[1][2]).max(v[2][2]), plane }
    }

    fn contains(&self, p: P2) -> bool {
        let [a, b, c] = self.v;
        let side = |u: V3, w: V3| (w[0] - u[0]) * (p[1] - u[1]) - (w[1] - u[1]) * (p[0] - u[0]);
        let (d1, d2, d3) = (side(a, b), side(b, c), side(c, a));
        let scale = 1e-12 * (1.0 + a[0].abs() + a[1].abs());
        let negative = d1 < -scale || d2 < -scale || d3 < -scale;
        let positive = d1 > scale || d2 > scale || d3 > scale;
        !(negative && positive)
    }

    /// The lowest the tip may be at `p`, or minus infinity when the tool
    /// does not reach the triangle.
    fn drop(&self, cutter: &Cutter, p: P2) -> f64 {
        let r = cutter.radius;
        let mut best = f64::NEG_INFINITY;
        for v in &self.v {
            let d = (v[0] - p[0]).hypot(v[1] - p[1]);
            if d <= r {
                best = best.max(v[2] - cutter.profile(d));
            }
        }
        if let Some([a, b, c]) = self.plane {
            let s = a.hypot(b);
            let d = cutter.facet_radius(s);
            let q = if s > 0.0 { [p[0] + d * a / s, p[1] + d * b / s] } else { p };
            if self.contains(q) {
                best = best.max(a * q[0] + b * q[1] + c - cutter.profile(d));
            }
        }
        for k in 0..3 {
            best = best.max(edge_drop(cutter, p, self.v[k], self.v[(k + 1) % 3]));
        }
        best
    }
}

fn edge_drop(cutter: &Cutter, p: P2, a: V3, b: V3) -> f64 {
    let r = cutter.radius;
    let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let l2 = dx * dx + dy * dy;
    if l2 < 1e-18 {
        // A vertical edge: its top corner is the highest point the tool meets.
        return f64::NEG_INFINITY;
    }
    let (fx, fy) = (a[0] - p[0], a[1] - p[1]);
    let qb = 2.0 * (fx * dx + fy * dy);
    let qc = fx * fx + fy * fy - r * r;
    let disc = qb * qb - 4.0 * l2 * qc;
    if disc < 0.0 {
        return f64::NEG_INFINITY;
    }
    let root = disc.sqrt();
    let lo = ((-qb - root) / (2.0 * l2)).max(0.0);
    let hi = ((-qb + root) / (2.0 * l2)).min(1.0);
    if lo > hi {
        return f64::NEG_INFINITY;
    }
    let height = |t: f64| {
        let d = (fx + t * dx).hypot(fy + t * dy).min(r);
        a[2] + t * dz - cutter.profile(d)
    };
    match cutter.shape {
        Shape::Flat => height(lo).max(height(hi)),
        Shape::Ball => {
            // The sphere's center over p touching the edge's line: a
            // quadratic in its height.
            let (wx, wy) = (-fx, -fy);
            let full = l2 + dz * dz;
            let k = wx * dx + wy * dy;
            let qa = l2;
            let qb = -2.0 * k * dz;
            let qc = full * (wx * wx + wy * wy) - k * k - r * r * full;
            let disc = (qb * qb - 4.0 * qa * qc).max(0.0);
            let s = (-qb + disc.sqrt()) / (2.0 * qa);
            let t = (k + s * dz) / full;
            if t >= lo && t <= hi {
                a[2] + s - r
            } else {
                height(lo).max(height(hi))
            }
        }
        _ => {
            // Concave along the edge: golden section to its top.
            let golden = 0.618_033_988_749_895;
            let (mut x0, mut x1) = (lo, hi);
            let mut m0 = x1 - golden * (x1 - x0);
            let mut m1 = x0 + golden * (x1 - x0);
            let (mut h0, mut h1) = (height(m0), height(m1));
            for _ in 0..48 {
                if h0 < h1 {
                    x0 = m0;
                    m0 = m1;
                    h0 = h1;
                    m1 = x0 + golden * (x1 - x0);
                    h1 = height(m1);
                } else {
                    x1 = m1;
                    m1 = m0;
                    h1 = h0;
                    m0 = x1 - golden * (x1 - x0);
                    h0 = height(m0);
                }
            }
            h0.max(h1).max(height(lo)).max(height(hi))
        }
    }
}

/// The mesh indexed for drop cutting with tools up to `reach` mm in radius.
pub struct Surface {
    tris: Vec<Tri>,
    origin: P2,
    cell: f64,
    nx: usize,
    ny: usize,
    /// Triangles near each cell, highest first.
    cells: Vec<Vec<u32>>,
    reach: f64,
}

impl Surface {
    pub fn new(mesh: &Mesh, reach: f64) -> Surface {
        let (min, max) = mesh.bounds();
        let width = (max[0] - min[0]).max(1e-6) + 2.0 * reach;
        let depth = (max[1] - min[1]).max(1e-6) + 2.0 * reach;
        let typical = (width * depth / mesh.triangles.len().max(1) as f64).sqrt();
        let mut cell = reach.max(2.0 * typical).max(0.05);
        while (width / cell).ceil() * (depth / cell).ceil() > 4.0e6 {
            cell *= 1.5;
        }
        let origin = [min[0] - reach, min[1] - reach];
        let nx = ((width / cell).ceil() as usize).max(1);
        let ny = ((depth / cell).ceil() as usize).max(1);
        let tris: Vec<Tri> = (0..mesh.triangles.len()).map(|i| Tri::new(mesh.triangle(i))).collect();
        let mut cells: Vec<Vec<u32>> = vec![Vec::new(); nx * ny];
        for (i, t) in tris.iter().enumerate() {
            let lo_x = t.v.iter().map(|v| v[0]).fold(f64::INFINITY, f64::min) - reach;
            let hi_x = t.v.iter().map(|v| v[0]).fold(f64::NEG_INFINITY, f64::max) + reach;
            let lo_y = t.v.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min) - reach;
            let hi_y = t.v.iter().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max) + reach;
            let ix0 = (((lo_x - origin[0]) / cell).floor().max(0.0) as usize).min(nx - 1);
            let ix1 = (((hi_x - origin[0]) / cell).floor().max(0.0) as usize).min(nx - 1);
            let iy0 = (((lo_y - origin[1]) / cell).floor().max(0.0) as usize).min(ny - 1);
            let iy1 = (((hi_y - origin[1]) / cell).floor().max(0.0) as usize).min(ny - 1);
            for iy in iy0..=iy1 {
                for ix in ix0..=ix1 {
                    cells[iy * nx + ix].push(i as u32);
                }
            }
        }
        cells.par_iter_mut().for_each(|list| list.sort_by(|&a, &b| tris[b as usize].top.total_cmp(&tris[a as usize].top)));
        Surface { tris, origin, cell, nx, ny, cells, reach }
    }

    pub fn reach(&self) -> f64 {
        self.reach
    }

    /// The lowest the tool's tip may be over `p`: minus infinity when no
    /// part of the mesh is under the tool.
    pub fn drop(&self, cutter: &Cutter, p: P2) -> f64 {
        debug_assert!(cutter.radius <= self.reach + 1e-9);
        let ix = ((p[0] - self.origin[0]) / self.cell).floor();
        let iy = ((p[1] - self.origin[1]) / self.cell).floor();
        if ix < 0.0 || iy < 0.0 || ix >= self.nx as f64 || iy >= self.ny as f64 {
            return f64::NEG_INFINITY;
        }
        let mut best = f64::NEG_INFINITY;
        for &i in &self.cells[iy as usize * self.nx + ix as usize] {
            let t = &self.tris[i as usize];
            if t.top <= best {
                break;
            }
            best = best.max(t.drop(cutter, p));
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::tests::block;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn every_tool_rests_on_a_flat_top() {
        let mesh = block([0.0, 0.0, -5.0], [10.0, 10.0, 0.0]);
        let surface = Surface::new(&mesh, 3.0);
        for shape in [Shape::Flat, Shape::Ball, Shape::Bull { corner: 0.5 }, Shape::Vee { half_angle: 0.5, tip: 0.0 }] {
            let cutter = Cutter::new(shape, 1.5);
            assert!(close(surface.drop(&cutter, [5.0, 5.0]), 0.0), "{shape:?}");
            assert_eq!(surface.drop(&cutter, [20.0, 20.0]), f64::NEG_INFINITY);
        }
    }

    #[test]
    fn a_flat_tool_overhanging_an_edge_still_rests_on_it() {
        let mesh = block([0.0, 0.0, -5.0], [10.0, 10.0, 0.0]);
        let surface = Surface::new(&mesh, 3.0);
        let flat = Cutter::new(Shape::Flat, 1.0);
        assert!(close(surface.drop(&flat, [10.9, 5.0]), 0.0));
        assert_eq!(surface.drop(&flat, [11.1, 5.0]), f64::NEG_INFINITY);
        // A ball past the edge rests on the corner line lower down.
        let ball = Cutter::new(Shape::Ball, 1.0);
        let d: f64 = 0.6;
        assert!(close(surface.drop(&ball, [10.0 + d, 5.0]), (1.0 - d * d).sqrt() - 1.0));
    }

    #[test]
    fn a_ball_on_a_slope_sits_where_the_sphere_meets_the_plane() {
        // A wedge rising 1 in 2 along x: z = x / 2 over 0..10.
        let mut mesh = Mesh::default();
        mesh.vertices = vec![[0.0, 0.0, 0.0], [10.0, 0.0, 5.0], [10.0, 10.0, 5.0], [0.0, 10.0, 0.0]];
        mesh.triangles = vec![[0, 1, 2], [0, 2, 3]];
        let surface = Surface::new(&mesh, 2.0);
        let r = 1.0;
        let ball = Cutter::new(Shape::Ball, r);
        let s: f64 = 0.5;
        // The sphere's center is r / cos over the plane; its tip r below it.
        let expected = 2.5 + r * (1.0 + s * s).sqrt() - r;
        assert!(close(surface.drop(&ball, [5.0, 5.0]), expected));
        let flat = Cutter::new(Shape::Flat, r);
        assert!(close(surface.drop(&flat, [5.0, 5.0]), 2.5 + r * s));
    }

    #[test]
    fn a_bull_nose_matches_a_ball_when_its_corner_is_its_radius() {
        let mut mesh = Mesh::default();
        mesh.vertices = vec![[0.0, 0.0, 0.0], [10.0, 0.0, 3.0], [5.0, 8.0, 1.0]];
        mesh.triangles = vec![[0, 1, 2]];
        let surface = Surface::new(&mesh, 2.0);
        let ball = Cutter::new(Shape::Ball, 1.5);
        let bull = Cutter::new(Shape::Bull { corner: 1.5 }, 1.5);
        for p in [[5.0, 3.0], [0.5, -0.8], [10.6, 0.4], [5.2, 8.9], [3.0, 5.5]] {
            let (a, b) = (surface.drop(&ball, p), surface.drop(&bull, p));
            assert!((a - b).abs() < 1e-7, "{p:?}: {a} {b}");
        }
    }

    #[test]
    fn a_grown_ball_leaves_its_growth_on_a_slope() {
        let mut mesh = Mesh::default();
        mesh.vertices = vec![[0.0, 0.0, 0.0], [10.0, 0.0, 5.0], [10.0, 10.0, 5.0], [0.0, 10.0, 0.0]];
        mesh.triangles = vec![[0, 1, 2], [0, 2, 3]];
        let surface = Surface::new(&mesh, 2.0);
        let ball = Cutter::new(Shape::Ball, 1.0);
        let leave = 0.3;
        let grown = ball.grown(leave);
        let tip = surface.drop(&grown, [5.0, 5.0]) + leave;
        // The ball's center is then 1.3 from the plane, 0.3 more than touching.
        let center = [5.0, 5.0, tip + 1.0];
        let distance = (center[2] - center[0] / 2.0) / (1.0f64 + 0.25).sqrt();
        assert!((distance - 1.3).abs() < 1e-9, "{distance}");
    }
}
