//! Areas of the plane as Clipper polygons on an integer grid: unions,
//! differences and round offsets, the connected pieces of an area with
//! their holes, and the plain geometry of polylines.

use clipper2_rust::{
    boolean_op_64, boolean_op_tree_64, inflate_paths_64, point_in_polygon, ClipType, Clipper64, EndType, FillRule, JoinType, Path64,
    Paths64, Point64, PointInPolygonResult, PolyTree64,
};

/// Clipper units per mm: 0.1 um.
pub const SCALE: f64 = 10_000.0;

pub type P2 = [f64; 2];

pub fn to_int(v: f64) -> i64 {
    (v * SCALE).round() as i64
}

pub fn point(p: P2) -> Point64 {
    Point64::new(to_int(p[0]), to_int(p[1]))
}

pub fn mm(p: &Point64) -> P2 {
    [p.x as f64 / SCALE, p.y as f64 / SCALE]
}

pub fn path(points: &[P2]) -> Path64 {
    points.iter().map(|&p| point(p)).collect()
}

pub fn polyline(path: &Path64) -> Vec<P2> {
    path.iter().map(mm).collect()
}

pub fn union(paths: &Paths64, fill: FillRule) -> Paths64 {
    boolean_op_64(ClipType::Union, fill, paths, &Paths64::new())
}

pub fn union2(a: &Paths64, b: &Paths64) -> Paths64 {
    boolean_op_64(ClipType::Union, FillRule::NonZero, a, b)
}

pub fn difference(a: &Paths64, b: &Paths64) -> Paths64 {
    boolean_op_64(ClipType::Difference, FillRule::NonZero, a, b)
}

pub fn intersect(a: &Paths64, b: &Paths64) -> Paths64 {
    boolean_op_64(ClipType::Intersection, FillRule::NonZero, a, b)
}

/// The area grown by `delta` mm (shrunk when negative) with round corners
/// drawn to `tolerance` mm. The input must be oriented, as Clipper's own
/// output is: outer loops counterclockwise, holes clockwise.
///
/// The arcs are drawn to half the tolerance: a chord sags the whole of
/// Clipper's arc tolerance at its middle, and a tool run along it would
/// otherwise come the full tolerance, plus rounding, into what it skirts.
pub fn inflate(paths: &Paths64, delta: f64, tolerance: f64) -> Paths64 {
    if paths.is_empty() {
        return Paths64::new();
    }
    if delta == 0.0 {
        return paths.clone();
    }
    inflate_paths_64(paths, delta * SCALE, JoinType::Round, EndType::Polygon, 2.0, (tolerance * SCALE / 2.0).max(1.0))
}

/// Open polylines cut down to the parts inside an area.
pub fn clip_lines(lines: &Paths64, area: &Paths64) -> Paths64 {
    let mut clipper = Clipper64::new();
    clipper.add_open_subject(lines);
    clipper.add_clip(area);
    let mut closed = Paths64::new();
    let mut open = Paths64::new();
    clipper.execute(ClipType::Intersection, FillRule::NonZero, &mut closed, Some(&mut open));
    open
}

/// One connected piece of an area: its outer loop and the holes in it.
#[derive(Clone, Debug)]
pub struct Piece {
    pub outer: Path64,
    pub holes: Paths64,
}

impl Piece {
    pub fn paths(&self) -> Paths64 {
        let mut out = Vec::with_capacity(1 + self.holes.len());
        out.push(self.outer.clone());
        out.extend(self.holes.iter().cloned());
        out
    }

    /// Strictly inside, or on the edge.
    pub fn contains(&self, p: P2) -> bool {
        let q = point(p);
        if point_in_polygon(q, &self.outer) == PointInPolygonResult::IsOutside {
            return false;
        }
        self.holes.iter().all(|h| point_in_polygon(q, h) != PointInPolygonResult::IsInside)
    }

    /// Whether the straight move from `a` to `b` stays in the piece: both
    /// ends in it and no edge crossed.
    pub fn holds_segment(&self, a: P2, b: P2) -> bool {
        if !self.contains(a) || !self.contains(b) {
            return false;
        }
        let (a, b) = (point(a), point(b));
        std::iter::once(&self.outer).chain(self.holes.iter()).all(|loop_| !crosses(a, b, loop_))
    }

    pub fn area(&self) -> f64 {
        let mut area = clipper2_rust::area(&self.outer).abs();
        for h in &self.holes {
            area -= clipper2_rust::area(h).abs();
        }
        area / (SCALE * SCALE)
    }
}

/// The connected pieces of an area, each outer loop with its own holes;
/// islands inside holes are pieces of their own.
pub fn pieces(paths: &Paths64) -> Vec<Piece> {
    let mut tree = PolyTree64::new();
    boolean_op_tree_64(ClipType::Union, FillRule::NonZero, paths, &Paths64::new(), &mut tree);
    let mut out = Vec::new();
    let mut stack: Vec<usize> = tree.root().children().to_vec();
    while let Some(index) = stack.pop() {
        let node = &tree.nodes[index];
        let mut holes = Paths64::new();
        for &child in node.children() {
            let hole = &tree.nodes[child];
            holes.push(hole.polygon().clone());
            stack.extend_from_slice(hole.children());
        }
        out.push(Piece { outer: node.polygon().clone(), holes });
    }
    out
}

/// Whether segment a-b crosses or touches any edge of the closed loop.
fn crosses(a: Point64, b: Point64, loop_: &Path64) -> bool {
    let n = loop_.len();
    if n < 2 {
        return false;
    }
    let (min_x, max_x) = (a.x.min(b.x), a.x.max(b.x));
    let (min_y, max_y) = (a.y.min(b.y), a.y.max(b.y));
    for i in 0..n {
        let c = loop_[i];
        let d = loop_[(i + 1) % n];
        if c.x.max(d.x) < min_x || c.x.min(d.x) > max_x || c.y.max(d.y) < min_y || c.y.min(d.y) > max_y {
            continue;
        }
        if segments_cross(a, b, c, d) {
            return true;
        }
    }
    false
}

fn orient(a: Point64, b: Point64, c: Point64) -> i128 {
    (b.x - a.x) as i128 * (c.y - a.y) as i128 - (b.y - a.y) as i128 * (c.x - a.x) as i128
}

fn on_segment(a: Point64, b: Point64, p: Point64) -> bool {
    p.x >= a.x.min(b.x) && p.x <= a.x.max(b.x) && p.y >= a.y.min(b.y) && p.y <= a.y.max(b.y)
}

fn segments_cross(a: Point64, b: Point64, c: Point64, d: Point64) -> bool {
    let d1 = orient(c, d, a);
    let d2 = orient(c, d, b);
    let d3 = orient(a, b, c);
    let d4 = orient(a, b, d);
    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) {
        return true;
    }
    // Touching an edge counts only away from the move's own ends, which
    // may sit on the boundary.
    let inner = |p: Point64| p != a && p != b;
    (d3 == 0 && on_segment(a, b, c) && inner(c)) || (d4 == 0 && on_segment(a, b, d) && inner(d))
}

pub fn length(points: &[P2]) -> f64 {
    points.windows(2).map(|w| dist(w[0], w[1])).sum()
}

pub fn dist(a: P2, b: P2) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// The distance from p to the segment a-b.
pub fn segment_distance(p: P2, a: P2, b: P2) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    dist(p, [a[0] + t * dx, a[1] + t * dy])
}

pub fn signed_area(points: &[P2]) -> f64 {
    let n = points.len();
    let mut twice = 0.0;
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        twice += a[0] * b[1] - b[0] * a[1];
    }
    twice / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: f64, y0: f64, side: f64) -> Path64 {
        path(&[[x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side]])
    }

    #[test]
    fn a_square_with_a_hole_is_one_piece() {
        let area = union(&vec![square(0.0, 0.0, 10.0), square(3.0, 3.0, 4.0)], FillRule::EvenOdd);
        let found = pieces(&area);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].holes.len(), 1);
        assert!((found[0].area() - 84.0).abs() < 1e-6);
        assert!(found[0].contains([1.0, 1.0]));
        assert!(!found[0].contains([5.0, 5.0]));
        assert!(found[0].holds_segment([1.0, 1.0], [1.0, 9.0]));
        assert!(!found[0].holds_segment([1.0, 5.0], [9.0, 5.0]));
    }

    #[test]
    fn inflating_a_square_rounds_its_corners() {
        let grown = inflate(&vec![square(0.0, 0.0, 10.0)], 1.0, 0.001);
        let area = clipper2_rust::area(&grown[0]).abs() / (SCALE * SCALE);
        let exact = 100.0 + 40.0 + std::f64::consts::PI;
        assert!((area - exact).abs() < 0.01, "{area} against {exact}");
    }

    #[test]
    fn lines_are_clipped_to_an_area() {
        let lines = vec![path(&[[-5.0, 5.0], [15.0, 5.0]])];
        let area = vec![square(0.0, 0.0, 10.0)];
        let out = clip_lines(&lines, &area);
        assert_eq!(out.len(), 1);
        let pts = polyline(&out[0]);
        assert!((length(&pts) - 10.0).abs() < 1e-6);
    }
}
