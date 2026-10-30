//! Three axis toolpaths from a triangle mesh: the model sliced into levels
//! and cleared around, finished along its walls and over its surfaces, with
//! every move between cuts kept over the material that is left.

pub mod cutter;
pub mod link;
pub mod mesh;
pub mod ops;
pub mod plan;
pub mod region;
pub mod slice;
pub mod stock;
