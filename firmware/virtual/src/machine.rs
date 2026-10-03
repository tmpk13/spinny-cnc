//! Machine files: the TOML description of a machine that the host keeps in
//! `machines/`, applied to the settings at start so the virtual firmware
//! comes up as that machine without a `--settings` flag per value. The
//! sections and keys are the host's (`spinny_laser.machines`); every value
//! goes through `Settings::set`, so the firmware's own bounds hold.

use spinny_core::settings::Settings;
use toml::{Table, Value};

/// Section, the axis letter in the setting names, the key its scale goes
/// by, and its bit in `dir_invert`.
const AXES: [(&str, &str, &str, u8); 4] = [
    ("rail", "r", "steps_per_mm", 0),
    ("table", "a", "steps_per_deg", 1),
    ("slide", "z", "steps_per_mm", 2),
    ("focus", "h", "steps_per_mm", 3),
];

/// Applies a machine file's text to `settings`; what the file leaves out
/// stays as it was. The error names the key.
pub fn apply(settings: &mut Settings, text: &str) -> Result<(), String> {
    let top: Table = text.parse().map_err(|e| format!("{e}"))?;
    let mut writes: Vec<(String, String)> = Vec::new();
    let mut known_top = vec!["name", "description", "kinematics", "tool", "probe", "output", "drivers", "host"];

    if let Some(value) = top.get("name") {
        value.as_str().ok_or("name must be a string")?;
    }
    if let Some(value) = top.get("description") {
        value.as_str().ok_or("description must be a string")?;
    }
    match top.get("kinematics").map(|v| v.as_str()) {
        None => {}
        Some(Some("polar")) => writes.push(("cartesian".into(), "0".into())),
        Some(Some("cartesian")) => writes.push(("cartesian".into(), "1".into())),
        Some(_) => return Err("kinematics must be one of polar, cartesian".into()),
    }
    match top.get("tool").map(|v| v.as_str()) {
        None => {}
        Some(Some("laser")) => writes.push(("spindle".into(), "0".into())),
        Some(Some("spindle")) => writes.push(("spindle".into(), "1".into())),
        Some(_) => return Err("tool must be one of laser, spindle".into()),
    }

    let mut dir_invert = 0u8;
    for (section, axis, scale_key, bit) in AXES {
        known_top.push(section);
        let table = table_of(&top, section)?;
        let mut known = vec![scale_key, "max_rate", "accel", "jerk", "jog_rate", "invert", "current_ma", "microsteps"];
        if axis == "h" {
            known.push("fitted");
            if let Some(fitted) = flag(&table, "fitted", section)? {
                writes.push(("h_axis".into(), flag_text(fitted)));
            }
        }
        if axis == "r" || axis == "z" {
            known.push("limit");
            if let Some(limit) = number(&table, "limit", section)? {
                writes.push((format!("{axis}_max"), limit));
            }
        }
        if let Some(steps) = number(&table, scale_key, section)? {
            writes.push((format!("{axis}_steps"), steps));
        }
        for (key, setting) in [
            ("max_rate", format!("{axis}_rate")),
            ("accel", format!("{axis}_accel")),
            ("jerk", format!("{axis}_jerk")),
            ("jog_rate", format!("jog_{axis}")),
        ] {
            if let Some(value) = number(&table, key, section)? {
                writes.push((setting, value));
            }
        }
        if flag(&table, "invert", section)? == Some(true) {
            dir_invert |= 1 << bit;
        }
        if let Some(value) = integer(&table, "current_ma", section)? {
            writes.push((format!("tmc_{axis}_ma"), value));
        }
        if let Some(value) = integer(&table, "microsteps", section)? {
            writes.push((format!("tmc_{axis}_micro"), value));
        }
        only(&table, section, &known)?;
    }
    writes.push(("dir_invert".into(), dir_invert.to_string()));

    let probe = table_of(&top, "probe")?;
    if let Some(invert) = flag(&probe, "invert", "probe")? {
        writes.push(("probe_invert".into(), flag_text(invert)));
    }
    if let Some(value) = integer(&probe, "brake_ms", "probe")? {
        writes.push(("probe_ms".into(), value));
    }
    only(&probe, "probe", &["invert", "brake_ms"])?;

    let output = table_of(&top, "output")?;
    if let Some(value) = integer(&output, "pwm_hz", "output")? {
        writes.push(("laser_hz".into(), value));
    }
    // s_max first, so a file that raises both is not refused for a
    // moment's s_min above the old s_max.
    if let Some(value) = number(&output, "s_max", "output")? {
        writes.push(("s_max".into(), value));
    }
    if let Some(value) = number(&output, "s_min", "output")? {
        writes.push(("s_min".into(), value));
    }
    if let Some(invert) = flag(&output, "invert", "output")? {
        writes.push(("laser_invert".into(), flag_text(invert)));
    }
    if let Some(value) = integer(&output, "test_ms", "output")? {
        writes.push(("laser_ms".into(), value));
    }
    only(&output, "output", &["pwm_hz", "s_max", "s_min", "invert", "test_ms"])?;

    let drivers = table_of(&top, "drivers")?;
    if let Some(invert) = flag(&drivers, "enable_invert", "drivers")? {
        writes.push(("en_invert".into(), flag_text(invert)));
    }
    if let Some(value) = integer(&drivers, "idle_ms", "drivers")? {
        writes.push(("idle_ms".into(), value));
    }
    if let Some(value) = integer(&drivers, "step_us", "drivers")? {
        writes.push(("step_us".into(), value));
    }
    if let Some(value) = integer(&drivers, "hold_pct", "drivers")? {
        writes.push(("tmc_hold_pct".into(), value));
    }
    if let Some(stealth) = flag(&drivers, "stealth", "drivers")? {
        writes.push(("tmc_stealth".into(), flag_text(stealth)));
    }
    only(&drivers, "drivers", &["enable_invert", "idle_ms", "step_us", "hold_pct", "stealth"])?;

    // The host's own values are not the firmware's: checked for shape only.
    let host = table_of(&top, "host")?;
    for key in ["tolerance", "clearance", "spinup"] {
        number(&host, key, "host")?;
    }
    only(&host, "host", &["tolerance", "clearance", "spinup"])?;
    only(&top, "", &known_top)?;

    // Applied in one go on a copy: a value the firmware refuses leaves
    // the settings as they were.
    let mut next = *settings;
    for (name, text) in &writes {
        next.set(name, text).map_err(|_| format!("{name} cannot be set to {text}"))?;
    }
    *settings = next;
    Ok(())
}

fn table_of(top: &Table, section: &str) -> Result<Table, String> {
    match top.get(section) {
        None => Ok(Table::new()),
        Some(Value::Table(table)) => Ok(table.clone()),
        Some(_) => Err(format!("{section} must be a table")),
    }
}

fn only(table: &Table, section: &str, known: &[&str]) -> Result<(), String> {
    for key in table.keys() {
        if !known.contains(&key.as_str()) {
            return Err(if section.is_empty() {
                format!("{key} is not a key here")
            } else {
                format!("[{section}] {key} is not a key here")
            });
        }
    }
    Ok(())
}

fn flag(table: &Table, key: &str, section: &str) -> Result<Option<bool>, String> {
    match table.get(key) {
        None => Ok(None),
        Some(Value::Boolean(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("[{section}] {key} must be true or false")),
    }
}

fn flag_text(value: bool) -> String {
    if value { "1" } else { "0" }.to_string()
}

/// A number as the setting parser takes it: no exponent, no stray zeros.
fn number(table: &Table, key: &str, section: &str) -> Result<Option<String>, String> {
    match table.get(key) {
        None => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(value.to_string())),
        Some(Value::Float(value)) if value.is_finite() => Ok(Some(number_text(*value))),
        Some(_) => Err(format!("[{section}] {key} must be a number")),
    }
}

fn integer(table: &Table, key: &str, section: &str) -> Result<Option<String>, String> {
    match table.get(key) {
        None => Ok(None),
        Some(Value::Integer(value)) if *value >= 0 => Ok(Some(value.to_string())),
        Some(_) => Err(format!("[{section}] {key} must be a whole number, 0 or more")),
    }
}

pub fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1.0e15 {
        return format!("{}", value as i64);
    }
    let text = format!("{value:.6}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use spinny_core::{A, H, R, Z};

    fn shipped(name: &str) -> String {
        let path = format!("{}/../../machines/{name}.toml", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn applied(text: &str) -> Settings {
        let mut settings = Settings::default();
        apply(&mut settings, text).unwrap();
        settings
    }

    #[test]
    fn an_empty_file_leaves_the_defaults() {
        assert_eq!(applied(""), Settings::default());
        assert_eq!(applied("name = \"x\"\nkinematics = \"polar\"\ntool = \"laser\"\n"), Settings::default());
    }

    #[test]
    fn the_shipped_polar_laser_spells_out_the_defaults() {
        assert_eq!(applied(&shipped("polar-laser")), Settings::default());
    }

    #[test]
    fn the_shipped_files_set_the_modes_they_name() {
        let focus = applied(&shipped("polar-laser-focus"));
        assert!(focus.h_axis && !focus.cartesian && !focus.spindle);
        let laser = applied(&shipped("cartesian-laser"));
        assert!(laser.cartesian && !laser.spindle && !laser.h_axis);
        assert_eq!(laser.z_max, 30.0);
        let mill = applied(&shipped("cartesian-mill"));
        assert!(mill.cartesian && mill.spindle && mill.h_axis);
        assert_eq!(mill.z_max, 30.0);
    }

    #[test]
    fn every_section_lands_on_its_setting() {
        let settings = applied(
            "kinematics = \"cartesian\"\ntool = \"spindle\"\n\
             [rail]\nsteps_per_mm = 800\nmax_rate = 1200\naccel = 75\njerk = 2.5\njog_rate = 900\nlimit = 60\ninvert = true\ncurrent_ma = 700\nmicrosteps = 16\n\
             [table]\nsteps_per_deg = 888.8889\nmax_rate = 1080\ninvert = true\n\
             [slide]\nsteps_per_mm = 640\nlimit = 8\n\
             [focus]\nfitted = true\nsteps_per_mm = 1600\nmax_rate = 300\njog_rate = 150\ninvert = true\n\
             [probe]\ninvert = true\nbrake_ms = 0\n\
             [output]\npwm_hz = 1000\ns_max = 255\ns_min = 10\ninvert = true\ntest_ms = 7000\n\
             [drivers]\nenable_invert = true\nidle_ms = 30000\nstep_us = 4\nhold_pct = 30\nstealth = false\n\
             [host]\ntolerance = 0.01\nclearance = 3\nspinup = 1.5\n",
        );
        assert!(settings.cartesian && settings.spindle && settings.h_axis);
        assert_eq!(settings.steps, [800.0, 888.8889, 1600.0, 640.0]);
        assert_eq!(settings.max_rate[R], 1200.0);
        assert_eq!(settings.max_rate[A], 1080.0);
        assert_eq!(settings.max_rate[H], 300.0);
        assert_eq!(settings.accel[R], 75.0);
        assert_eq!(settings.jerk[R], 2.5);
        assert_eq!(settings.jog_rate[R], 900.0);
        assert_eq!(settings.jog_rate[H], 150.0);
        assert_eq!(settings.r_max, 60.0);
        assert_eq!(settings.z_max, 8.0);
        // Rail, table and focus inverted: bits 0, 1 and 3.
        assert_eq!(settings.dir_invert, 0b1011);
        assert_eq!(settings.joint_dir_invert() & (1 << Z), 0);
        assert_eq!(settings.tmc_ma[R], 700);
        assert_eq!(settings.tmc_micro[R], 16);
        assert!(settings.probe_invert);
        assert_eq!(settings.probe_ms, 0);
        assert_eq!(settings.laser_hz, 1000);
        assert_eq!(settings.s_max, 255.0);
        assert_eq!(settings.s_min, 10.0);
        assert!(settings.laser_invert);
        assert_eq!(settings.laser_ms, 7000);
        assert!(settings.en_invert);
        assert_eq!(settings.idle_ms, 30000);
        assert_eq!(settings.step_us, 4);
        assert_eq!(settings.tmc_hold_pct, 30);
        assert!(!settings.tmc_stealth);
    }

    #[test]
    fn mistakes_are_named_and_apply_nothing() {
        let mut settings = Settings::default();
        let refused = |text: &str| apply(&mut Settings::default(), text).unwrap_err();
        assert!(refused("[rail]\nstep_per_mm = 1\n").contains("[rail] step_per_mm"));
        assert!(refused("[nope]\nx = 1\n").contains("nope"));
        assert!(refused("kinematics = \"spiral\"\n").contains("kinematics"));
        assert!(refused("[rail]\ninvert = 1\n").contains("true or false"));
        assert!(refused("[rail]\nmax_rate = \"fast\"\n").contains("must be a number"));
        assert!(refused("[rail]\nmicrosteps = 3\n").contains("tmc_r_micro"));
        assert!(refused("[probe]\nbrake_ms = 200\n").contains("probe_ms"));
        assert!(refused("[output]\ns_max = 1e9\n").contains("s_max"));
        assert!(refused("[rail\n").len() > 0);
        // A refused value further down leaves the earlier ones unapplied.
        assert!(apply(&mut settings, "[rail]\nmax_rate = 900\n[probe]\nbrake_ms = 999\n").is_err());
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn numbers_are_written_as_the_parser_takes_them() {
        assert_eq!(number_text(14222.222), "14222.222");
        assert_eq!(number_text(560.0), "560");
        assert_eq!(number_text(0.5), "0.5");
        assert_eq!(number_text(0.000001), "0.000001");
        assert_eq!(number_text(-7.25), "-7.25");
    }
}
