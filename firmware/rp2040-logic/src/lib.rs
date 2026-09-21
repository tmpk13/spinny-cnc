//! The parts of the RP2040 firmware that do not touch hardware, kept in
//! their own crate so they build and test on the host. The firmware crate
//! pins its build target; this one is a plain workspace member.
#![cfg_attr(not(test), no_std)]

pub mod flash;
pub mod laser;
pub mod line;
pub mod out;
pub mod pins;
pub mod step;
pub mod tmc;
