//! Triangle meshes: an STL read in (binary or ASCII) with its vertices
//! welded, turned and moved where a job wants it, and what the toolpaths
//! need to know about its shape: the flat areas, the undercuts a three axis
//! machine cannot reach, and the edges that leave it open.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub type V3 = [f64; 3];

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub vertices: Vec<V3>,
    pub triangles: Vec<[u32; 3]>,
}

/// Facts about a mesh's shape, in its own coordinates.
#[derive(Clone, Debug, Default)]
pub struct Shape {
    pub min: V3,
    pub max: V3,
    /// Heights of horizontal faces that look up, highest first, with their
    /// area in mm^2: pocket floors, shoulders, the top.
    pub flats: Vec<(f64, f64)>,
    /// Area of the faces that look down anywhere above the bottom, mm^2:
    /// what only a tool from below could cut.
    pub undercut: f64,
    /// Edges not shared by exactly two triangles.
    pub open_edges: usize,
}

impl Mesh {
    pub fn read_stl(path: &Path) -> Result<Mesh, String> {
        let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Mesh::from_stl(&bytes).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// A binary STL is recognized by its length (80 byte header, a count,
    /// 50 bytes a triangle); anything else is read as ASCII, whatever its
    /// first word says.
    pub fn from_stl(bytes: &[u8]) -> Result<Mesh, String> {
        let binary = bytes.len() >= 84 && {
            let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
            count.checked_mul(50).and_then(|n| n.checked_add(84)) == Some(bytes.len())
        };
        let mut welder = Welder::default();
        if binary {
            let count = (bytes.len() - 84) / 50;
            for i in 0..count {
                let at = 84 + i * 50 + 12;
                let mut corners = [0u32; 3];
                for (k, corner) in corners.iter_mut().enumerate() {
                    let base = at + k * 12;
                    let read = |o: usize| f32::from_le_bytes([bytes[base + o], bytes[base + o + 1], bytes[base + o + 2], bytes[base + o + 3]]);
                    let v = [read(0) as f64, read(4) as f64, read(8) as f64];
                    *corner = welder.index(v)?;
                }
                welder.triangle(corners);
            }
        } else {
            let text = std::str::from_utf8(bytes).map_err(|_| "neither a binary STL nor ASCII text".to_string())?;
            let mut tokens = text.split_ascii_whitespace();
            let mut corners: Vec<u32> = Vec::with_capacity(3);
            while let Some(token) = tokens.next() {
                if !token.eq_ignore_ascii_case("vertex") {
                    continue;
                }
                let mut v = [0.0; 3];
                for value in v.iter_mut() {
                    let word = tokens.next().ok_or("a vertex ends early")?;
                    *value = word.parse::<f64>().map_err(|_| format!("{word:?} is not a number"))?;
                }
                corners.push(welder.index(v)?);
                if corners.len() == 3 {
                    welder.triangle([corners[0], corners[1], corners[2]]);
                    corners.clear();
                }
            }
        }
        let mut mesh = Mesh { vertices: welder.vertices, triangles: welder.triangles };
        if mesh.triangles.is_empty() {
            return Err("no triangles in the file".into());
        }
        // A mesh wound inside out has a negative volume; turning every
        // triangle over makes its normals point out again.
        if mesh.volume() < 0.0 {
            for t in mesh.triangles.iter_mut() {
                t.swap(1, 2);
            }
        }
        Ok(mesh)
    }

    pub fn triangle(&self, i: usize) -> [V3; 3] {
        let t = self.triangles[i];
        [self.vertices[t[0] as usize], self.vertices[t[1] as usize], self.vertices[t[2] as usize]]
    }

    pub fn bounds(&self) -> (V3, V3) {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for v in &self.vertices {
            for k in 0..3 {
                min[k] = min[k].min(v[k]);
                max[k] = max[k].max(v[k]);
            }
        }
        (min, max)
    }

    /// Signed volume by the divergence theorem; positive for outward normals.
    pub fn volume(&self) -> f64 {
        let mut six = 0.0;
        for i in 0..self.triangles.len() {
            let [a, b, c] = self.triangle(i);
            six += dot(a, cross(b, c));
        }
        six / 6.0
    }

    /// Turned about X, then Y, then Z, by degrees, and scaled about the origin.
    pub fn turn(&mut self, degrees: V3, scale: f64) {
        let [ax, ay, az] = degrees.map(f64::to_radians);
        let (sx, cx) = ax.sin_cos();
        let (sy, cy) = ay.sin_cos();
        let (sz, cz) = az.sin_cos();
        for v in self.vertices.iter_mut() {
            let [x, y, z] = *v;
            let (y, z) = (y * cx - z * sx, y * sx + z * cx);
            let (x, z) = (x * cy + z * sy, -x * sy + z * cy);
            let (x, y) = (x * cz - y * sz, x * sz + y * cz);
            *v = [x * scale, y * scale, z * scale];
        }
        // Quarter turns land on numbers like 1e-16 instead of 0; snapping
        // them keeps flat faces flat.
        for v in self.vertices.iter_mut() {
            for c in v.iter_mut() {
                let rounded = (*c * 1e9).round() / 1e9;
                if (*c - rounded).abs() < 1e-12 {
                    *c = rounded;
                }
            }
        }
        if scale < 0.0 {
            for t in self.triangles.iter_mut() {
                t.swap(1, 2);
            }
        }
    }

    pub fn translate(&mut self, d: V3) {
        for v in self.vertices.iter_mut() {
            for k in 0..3 {
                v[k] += d[k];
            }
        }
    }

    pub fn shape(&self) -> Shape {
        let (min, max) = self.bounds();
        let height = (max[2] - min[2]).max(1e-9);
        let mut flats: HashMap<i64, (f64, f64)> = HashMap::new();
        let mut undercut = 0.0;
        let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
        for (i, t) in self.triangles.iter().enumerate() {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                *edges.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
            let [a, b, c] = self.triangle(i);
            let n = cross(sub(b, a), sub(c, a));
            let length = norm(n);
            if length <= 0.0 {
                continue;
            }
            let area = length / 2.0;
            let nz = n[2] / length;
            if nz > 1.0 - 1e-9 && a[2] == b[2] && b[2] == c[2] {
                let key = (a[2] * 1e4).round() as i64;
                let entry = flats.entry(key).or_insert((a[2], 0.0));
                entry.1 += area;
            } else if nz < -1e-9 && a[2].max(b[2]).max(c[2]) > min[2] + 1e-3 * height.max(1.0) {
                undercut += area * -nz;
            }
        }
        let mut flats: Vec<(f64, f64)> = flats.into_values().filter(|&(_, area)| area > 1e-4).collect();
        flats.sort_by(|a, b| b.0.total_cmp(&a.0));
        let open_edges = edges.values().filter(|&&n| n != 2).count();
        Shape { min, max, flats, undercut, open_edges }
    }
}

#[derive(Default)]
struct Welder {
    vertices: Vec<V3>,
    triangles: Vec<[u32; 3]>,
    seen: HashMap<[u64; 3], u32>,
}

impl Welder {
    fn index(&mut self, v: V3) -> Result<u32, String> {
        if !v.iter().all(|c| c.is_finite()) {
            return Err("a vertex is not a finite number".into());
        }
        // -0.0 and 0.0 are one point.
        let key = v.map(|c| if c == 0.0 { 0u64 } else { c.to_bits() });
        if let Some(&i) = self.seen.get(&key) {
            return Ok(i);
        }
        let i = u32::try_from(self.vertices.len()).map_err(|_| "too many vertices".to_string())?;
        self.vertices.push(v);
        self.seen.insert(key, i);
        Ok(i)
    }

    fn triangle(&mut self, t: [u32; 3]) {
        if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] {
            self.triangles.push(t);
        }
    }
}

pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A closed box with outward normals, from `min` to `max`.
    pub fn block(min: V3, max: V3) -> Mesh {
        let v = |x: usize, y: usize, z: usize| [if x == 0 { min[0] } else { max[0] }, if y == 0 { min[1] } else { max[1] }, if z == 0 { min[2] } else { max[2] }];
        let mut mesh = Mesh::default();
        for x in 0..2 {
            for y in 0..2 {
                for z in 0..2 {
                    mesh.vertices.push(v(x, y, z));
                }
            }
        }
        let i = |x: u32, y: u32, z: u32| x * 4 + y * 2 + z;
        let quads = [
            [i(0, 0, 0), i(0, 1, 0), i(1, 1, 0), i(1, 0, 0)], // bottom, looking down
            [i(0, 0, 1), i(1, 0, 1), i(1, 1, 1), i(0, 1, 1)], // top
            [i(0, 0, 0), i(1, 0, 0), i(1, 0, 1), i(0, 0, 1)], // front, -y
            [i(0, 1, 0), i(0, 1, 1), i(1, 1, 1), i(1, 1, 0)], // back, +y
            [i(0, 0, 0), i(0, 0, 1), i(0, 1, 1), i(0, 1, 0)], // left, -x
            [i(1, 0, 0), i(1, 1, 0), i(1, 1, 1), i(1, 0, 1)], // right, +x
        ];
        for q in quads {
            mesh.triangles.push([q[0], q[1], q[2]]);
            mesh.triangles.push([q[0], q[2], q[3]]);
        }
        mesh
    }

    pub fn to_binary_stl(mesh: &Mesh) -> Vec<u8> {
        let mut out = vec![0u8; 80];
        out.extend_from_slice(&(mesh.triangles.len() as u32).to_le_bytes());
        for i in 0..mesh.triangles.len() {
            out.extend_from_slice(&[0u8; 12]);
            for v in mesh.triangle(i) {
                for c in v {
                    out.extend_from_slice(&(c as f32).to_le_bytes());
                }
            }
            out.extend_from_slice(&[0u8; 2]);
        }
        out
    }

    #[test]
    fn a_block_reads_back_from_binary_and_ascii() {
        let block = block([0.0, 0.0, 0.0], [10.0, 20.0, 5.0]);
        let binary = Mesh::from_stl(&to_binary_stl(&block)).unwrap();
        assert_eq!(binary.vertices.len(), 8);
        assert_eq!(binary.triangles.len(), 12);
        assert!((binary.volume() - 1000.0).abs() < 1e-6);
        let mut text = String::from("solid block\n");
        for i in 0..block.triangles.len() {
            text.push_str("facet normal 0 0 0\nouter loop\n");
            for v in block.triangle(i) {
                text.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
            }
            text.push_str("endloop\nendfacet\n");
        }
        text.push_str("endsolid block\n");
        let ascii = Mesh::from_stl(text.as_bytes()).unwrap();
        assert_eq!(ascii.vertices.len(), 8);
        assert!((ascii.volume() - 1000.0).abs() < 1e-6);
    }

    #[test]
    fn an_inside_out_mesh_is_turned_over() {
        let mut block = block([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
        for t in block.triangles.iter_mut() {
            t.swap(1, 2);
        }
        let read = Mesh::from_stl(&to_binary_stl(&block)).unwrap();
        assert!(read.volume() > 0.0);
    }

    #[test]
    fn the_shape_finds_flats_and_no_undercut_on_a_block() {
        let shape = block([0.0, 0.0, -5.0], [10.0, 10.0, 0.0]).shape();
        assert_eq!(shape.flats.len(), 1);
        assert_eq!(shape.flats[0].0, 0.0);
        assert!((shape.flats[0].1 - 100.0).abs() < 1e-9);
        assert_eq!(shape.undercut, 0.0);
        assert_eq!(shape.open_edges, 0);
    }

    #[test]
    fn a_half_turn_about_x_puts_the_top_at_the_bottom() {
        let mut mesh = block([0.0, 0.0, 0.0], [10.0, 10.0, 2.0]);
        mesh.turn([180.0, 0.0, 0.0], 1.0);
        let (min, max) = mesh.bounds();
        assert_eq!(min[2], -2.0);
        assert_eq!(max[2], 0.0);
        assert!(mesh.volume() > 0.0);
        assert_eq!(mesh.shape().flats.len(), 1);
    }
}
