//! Cross sections of a mesh and its shadow: the area under everything
//! above a height, which a tool at that height has to keep its distance
//! from.
//!
//! For a closed mesh, the vertical line through a point of the solid above
//! z leaves the solid downward through a face that looks down, either below
//! z (the point is in the section at z) or above it. So the shadow at z is
//! the section at z together with the faces that look down above z, and
//! working down a list of heights it is the shadow at the height before,
//! the section, and the down facing faces in the slab between the two.

use clipper2_rust::{FillRule, Path64, Paths64};
use std::collections::HashMap;

use crate::mesh::{Mesh, V3};
use crate::region::{self, P2};

pub struct Slicer<'a> {
    mesh: &'a Mesh,
    /// Triangles by height band, each listed in every band it spans.
    bands: Vec<Vec<u32>>,
    low: f64,
    band: f64,
    /// Triangles that look down, with their lowest and highest z.
    down: Vec<(u32, f64, f64)>,
}

impl<'a> Slicer<'a> {
    pub fn new(mesh: &'a Mesh) -> Self {
        let (min, max) = mesh.bounds();
        let count = (mesh.triangles.len() / 8).clamp(1, 4096);
        let band = ((max[2] - min[2]) / count as f64).max(1e-6);
        let mut bands = vec![Vec::new(); count];
        let mut down = Vec::new();
        for i in 0..mesh.triangles.len() {
            let [a, b, c] = mesh.triangle(i);
            let lo = a[2].min(b[2]).min(c[2]);
            let hi = a[2].max(b[2]).max(c[2]);
            let first = (((lo - min[2]) / band) as usize).min(count - 1);
            let last = (((hi - min[2]) / band) as usize).min(count - 1);
            for slot in bands.iter_mut().take(last + 1).skip(first) {
                slot.push(i as u32);
            }
            let n = crate::mesh::cross(crate::mesh::sub(b, a), crate::mesh::sub(c, a));
            if n[2] < -1e-12 * crate::mesh::norm(n).max(1e-300) {
                down.push((i as u32, lo, hi));
            }
        }
        Slicer { mesh, bands, low: min[2], band, down }
    }

    fn candidates(&self, z: f64) -> &[u32] {
        if self.bands.is_empty() {
            return &[];
        }
        let slot = ((z - self.low) / self.band).floor();
        if slot < 0.0 {
            return &[];
        }
        let slot = (slot as usize).min(self.bands.len() - 1);
        &self.bands[slot]
    }

    /// The solid's cross section just above z, as an area: what is
    /// strictly higher than z. A face lying at z is not in it.
    pub fn section(&self, z: f64) -> Paths64 {
        let mut segments: Vec<([u32; 2], [u32; 2], P2, P2)> = Vec::new();
        for &i in self.candidates(z) {
            let t = self.mesh.triangles[i as usize];
            let above = t.map(|v| self.mesh.vertices[v as usize][2] > z);
            let count = above.iter().filter(|&&a| a).count();
            if count == 0 || count == 3 {
                continue;
            }
            let mut ends: Vec<([u32; 2], P2)> = Vec::with_capacity(2);
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if above[k] != above[(k + 1) % 3] {
                    let key = [a.min(b), a.max(b)];
                    ends.push((key, self.crossing(key, z)));
                }
            }
            if ends.len() == 2 {
                segments.push((ends[0].0, ends[1].0, ends[0].1, ends[1].1));
            }
        }
        let loops = chain(&segments);
        region::union(&loops, FillRule::EvenOdd)
    }

    /// Where the edge between two vertices crosses z, worked out from the
    /// lower index so both triangles on the edge get the same point.
    fn crossing(&self, key: [u32; 2], z: f64) -> P2 {
        let a = self.mesh.vertices[key[0] as usize];
        let b = self.mesh.vertices[key[1] as usize];
        let t = (z - a[2]) / (b[2] - a[2]);
        [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    }

    /// The faces that look down in the slab above z and up to `top`, as
    /// the area under them.
    pub fn down_faces(&self, z: f64, top: f64) -> Paths64 {
        let mut polygons = Paths64::new();
        for &(i, lo, hi) in &self.down {
            if hi <= z || lo > top {
                continue;
            }
            let tri = self.mesh.triangle(i as usize);
            let clipped = clip_slab(&tri, z, top);
            if clipped.len() >= 3 {
                let poly: Vec<P2> = clipped.iter().map(|v| [v[0], v[1]]).collect();
                if region::signed_area(&poly).abs() > 1e-12 {
                    polygons.push(region::path(&poly));
                }
            }
        }
        if polygons.is_empty() {
            return polygons;
        }
        region::union(&polygons, FillRule::NonZero)
    }

    /// The shadow at each height of a list running down: everything of the
    /// solid above it, seen from above.
    pub fn shadows(&self, heights: &[f64]) -> Vec<Paths64> {
        let mut out = Vec::with_capacity(heights.len());
        let mut shadow = Paths64::new();
        let mut above = f64::INFINITY;
        for &z in heights {
            debug_assert!(z <= above);
            let mut add = self.section(z);
            let faces = self.down_faces(z, above);
            if !faces.is_empty() {
                add = region::union2(&add, &faces);
            }
            if !add.is_empty() {
                shadow = if shadow.is_empty() { add } else { region::union2(&shadow, &add) };
            }
            out.push(shadow.clone());
            above = z;
        }
        out
    }

    /// Everything the solid covers seen from above.
    pub fn silhouette(&self) -> Paths64 {
        let faces = self.down_faces(f64::NEG_INFINITY, f64::INFINITY);
        if !faces.is_empty() {
            return faces;
        }
        // A mesh with no faces looking down is a surface, not a solid: its
        // cover is all of its faces.
        let mut polygons = Paths64::new();
        for i in 0..self.mesh.triangles.len() {
            let tri = self.mesh.triangle(i);
            let poly: Vec<P2> = tri.iter().map(|v| [v[0], v[1]]).collect();
            if region::signed_area(&poly).abs() > 1e-12 {
                polygons.push(region::path(&poly));
            }
        }
        region::union(&polygons, FillRule::NonZero)
    }
}

/// Segments joined end to end into loops by the mesh edges they end on. A
/// chain that cannot close (an open mesh) is closed straight across.
fn chain(segments: &[([u32; 2], [u32; 2], P2, P2)]) -> Paths64 {
    let mut at: HashMap<[u32; 2], Vec<usize>> = HashMap::with_capacity(segments.len() * 2);
    for (i, s) in segments.iter().enumerate() {
        at.entry(s.0).or_default().push(i);
        at.entry(s.1).or_default().push(i);
    }
    let mut used = vec![false; segments.len()];
    let mut loops = Paths64::new();
    for start in 0..segments.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let first_key = segments[start].0;
        let mut points: Vec<P2> = vec![segments[start].2, segments[start].3];
        let mut key = segments[start].1;
        loop {
            if key == first_key {
                break;
            }
            let next = at.get(&key).and_then(|list| list.iter().copied().find(|&j| !used[j]));
            let Some(j) = next else { break };
            used[j] = true;
            let s = &segments[j];
            let (other_key, other_point) = if s.0 == key { (s.1, s.3) } else { (s.0, s.2) };
            if other_key != first_key {
                points.push(other_point);
            }
            key = other_key;
        }
        if points.len() >= 3 {
            let path: Path64 = region::path(&points);
            loops.push(path);
        }
    }
    loops
}

/// A triangle cut down to lo < z <= hi, as a polygon.
fn clip_slab(tri: &[V3; 3], lo: f64, hi: f64) -> Vec<V3> {
    let mut poly: Vec<V3> = tri.to_vec();
    if lo.is_finite() {
        poly = clip_plane(&poly, |v| v[2] - lo);
    }
    if hi.is_finite() {
        poly = clip_plane(&poly, |v| hi - v[2]);
    }
    poly
}

/// The part of a polygon where `side` is not negative.
fn clip_plane(poly: &[V3], side: impl Fn(&V3) -> f64) -> Vec<V3> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n + 2);
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let (sa, sb) = (side(&a), side(&b));
        if sa >= 0.0 {
            out.push(a);
        }
        if (sa >= 0.0) != (sb >= 0.0) {
            let t = sa / (sa - sb);
            out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::tests::block;

    fn area(paths: &Paths64) -> f64 {
        clipper2_rust::area_paths(paths) / (region::SCALE * region::SCALE)
    }

    #[test]
    fn a_block_cut_through_its_middle_is_its_footprint() {
        let mesh = block([0.0, 0.0, 0.0], [10.0, 20.0, 5.0]);
        let slicer = Slicer::new(&mesh);
        assert!((area(&slicer.section(2.5)) - 200.0).abs() < 1e-6);
        assert!(slicer.section(5.0).is_empty(), "nothing is above the top");
        assert!((area(&slicer.section(0.0)) - 200.0).abs() < 1e-6, "the bottom face is not above 0, the walls are");
        assert!((area(&slicer.silhouette()) - 200.0).abs() < 1e-6);
    }

    #[test]
    fn an_overhang_between_two_heights_is_in_the_shadow() {
        // A thin wide plate floating over a narrow post: slicing only at 0
        // and 10 never meets the plate, the faces looking down do.
        let mut mesh = block([4.0, 4.0, 0.0], [6.0, 6.0, 5.0]);
        let plate = block([0.0, 0.0, 5.0], [10.0, 10.0, 6.0]);
        let offset = mesh.vertices.len() as u32;
        mesh.vertices.extend_from_slice(&plate.vertices);
        mesh.triangles.extend(plate.triangles.iter().map(|t| t.map(|v| v + offset)));
        let slicer = Slicer::new(&mesh);
        let shadows = slicer.shadows(&[10.0, 3.0]);
        assert!(shadows[0].is_empty());
        assert!((area(&shadows[1]) - 100.0).abs() < 1e-6, "{}", area(&shadows[1]));
    }
}
