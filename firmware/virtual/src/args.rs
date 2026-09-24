//! Command line options.

use std::path::PathBuf;

use spinny_core::settings::Settings;

use crate::surface::Surface;

pub const USAGE: &str = "\
spinny-virtual: the spinny control core on a TCP socket

    --listen ADDR       address to serve, default 127.0.0.1:2323
    --fast              run time as fast as the machine allows
    --trace PATH        write the beam's marks and the command log as JSON
    --settings K=V      set a machine setting at start, repeatable
    --store PATH        file standing in for the settings sector
    --surface B[,SX,SY[,C]]
                        a board under the probe: its top at focus height
                        B + SX*x + SY*y + C*(x^2 + y^2), board mm; without
                        it a probe finds nothing
    --probe-offset L,C  the probe tip L mm along the rail and C mm across
                        it from the beam
    --quiet             no periodic report on stderr
    --help              this text

A client connects, gets the banner, and speaks the line protocol the board
speaks. One client at a time; disconnecting stops the machine and keeps
its position, as unplugging USB does.
";

#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub listen: String,
    pub fast: bool,
    pub trace: Option<PathBuf>,
    pub store: Option<PathBuf>,
    pub quiet: bool,
    pub settings: Settings,
    /// The board a probe touches; `None` for none.
    pub surface: Option<Surface>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            listen: "127.0.0.1:2323".to_string(),
            fast: false,
            trace: None,
            store: None,
            quiet: false,
            settings: Settings::default(),
            surface: None,
        }
    }
}

/// `Ok(None)` means the usage was asked for and nothing should run.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Option<Options>, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--help" | "-h" => return Ok(None),
            "--fast" => options.fast = true,
            "--quiet" => options.quiet = true,
            "--listen" => options.listen = value("--listen")?,
            "--trace" => options.trace = Some(PathBuf::from(value("--trace")?)),
            "--store" => options.store = Some(PathBuf::from(value("--store")?)),
            "--surface" => {
                let offset = options.surface.map_or([0.0; 2], |surface| surface.offset);
                options.surface = Some(Surface { offset, ..Surface::parse(&value("--surface")?)? });
            }
            "--probe-offset" => {
                let offset = Surface::parse_offset(&value("--probe-offset")?)?;
                options.surface = Some(Surface { offset, ..options.surface.unwrap_or_default() });
            }
            "--settings" => {
                let pair = value("--settings")?;
                let (name, text) = pair
                    .split_once('=')
                    .ok_or_else(|| format!("--settings wants name=value, got {pair:?}"))?;
                options
                    .settings
                    .set(name.trim(), text.trim())
                    .map_err(|_| format!("{name} cannot be set to {text:?}"))?;
            }
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok(Some(options))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Result<Option<Options>, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults_serve_the_documented_address_in_real_time() {
        let options = parse_args(&[]).unwrap().unwrap();
        assert_eq!(options.listen, "127.0.0.1:2323");
        assert!(!options.fast && !options.quiet);
        assert_eq!(options.trace, None);
        assert_eq!(options.settings, Settings::default());
    }

    #[test]
    fn every_option_is_read() {
        let options = parse_args(&[
            "--listen", "0.0.0.0:9000", "--fast", "--quiet",
            "--trace", "/tmp/t.json", "--store", "/tmp/s.bin",
            "--settings", "a_rate=600", "--settings", "r_steps=100",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(options.listen, "0.0.0.0:9000");
        assert!(options.fast && options.quiet);
        assert_eq!(options.trace, Some(PathBuf::from("/tmp/t.json")));
        assert_eq!(options.store, Some(PathBuf::from("/tmp/s.bin")));
        assert_eq!(options.settings.max_rate[spinny_core::A], 600.0);
        assert_eq!(options.settings.steps[spinny_core::R], 100.0);
    }

    #[test]
    fn help_asks_for_nothing_to_run() {
        assert_eq!(parse_args(&["--help"]).unwrap(), None);
    }

    #[test]
    fn bad_options_are_refused_with_a_reason() {
        assert!(parse_args(&["--nope"]).unwrap_err().contains("--nope"));
        assert!(parse_args(&["--listen"]).unwrap_err().contains("--listen"));
        assert!(parse_args(&["--settings", "a_rate"]).unwrap_err().contains("name=value"));
        assert!(parse_args(&["--settings", "a_rate=0"]).unwrap_err().contains("a_rate"));
        assert!(parse_args(&["--settings", "nope=1"]).unwrap_err().contains("nope"));
    }

    #[test]
    fn a_surface_and_a_probe_offset_in_either_order() {
        let options = parse_args(&["--probe-offset", "3,-1", "--surface", "-2,0.01,0"]).unwrap().unwrap();
        let surface = options.surface.unwrap();
        assert_eq!((surface.base, surface.slope, surface.offset), (-2.0, [0.01, 0.0], [3.0, -1.0]));
        let options = parse_args(&["--surface", "-2", "--probe-offset", "3,-1"]).unwrap().unwrap();
        assert_eq!(options.surface.unwrap().offset, [3.0, -1.0]);
        assert!(parse_args(&["--surface", "1,2"]).unwrap_err().contains("--surface"));
        assert_eq!(parse_args(&[]).unwrap().unwrap().surface, None);
    }
}
