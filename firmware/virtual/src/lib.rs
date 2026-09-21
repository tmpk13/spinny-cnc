//! The spinny control core on a socket, with virtual hardware and a clock
//! that can run faster than real time. It speaks the protocol the board
//! speaks, so the web backend and its tests can drive a whole machine
//! without one being plugged in.

pub mod args;
pub mod clock;
pub mod inbox;
pub mod ports;
pub mod server;
pub mod sim;
pub mod trace;

use std::io;

use crate::args::Options;
use crate::clock::Clock;
use crate::ports::FileStore;
use crate::sim::{Setup, Sim};
use crate::trace::Trace;

/// Builds the simulated board an `Options` describes.
pub fn setup(options: &Options) -> Setup {
    Setup {
        settings: options.settings,
        store: FileStore { path: options.store.clone() },
        clock: if options.fast { Clock::fast() } else { Clock::real() },
        trace: Trace::new(options.trace.clone()),
        quiet: options.quiet,
    }
}

/// Binds the address in `options` and serves until the listener fails.
pub fn run(options: &Options) -> io::Result<()> {
    let listener = server::bind(&options.listen)?;
    if !options.quiet {
        eprintln!(
            "spinny-virtual v{} on {} ({} time)",
            spinny_core::VERSION,
            listener.local_addr()?,
            if options.fast { "free-running" } else { "real" },
        );
    }
    let mut sim = Sim::new(setup(options));
    server::serve(listener, &mut sim, options.quiet)
}
