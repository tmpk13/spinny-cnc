//! Machine files: the TOML description of a machine that the host keeps in
//! `machines/`, applied to the settings at start so the virtual firmware
//! comes up as that machine without a `--settings` flag per value. The
//! sections and keys are the host's (`spinny_laser.machines`); every value
//! goes through `Settings::set`, so the firmware's own bounds hold.

use spinny_core::settings::Settings;
use toml::{Table, Value};

/// Section, the axis letter in the setting names, the key its scale goes
/// by, and its bit in `dir_invert`. With `tool = "dispenser"` a
/// `[dispenser]` section stands in for `[table]`, the same keys with
/// `steps_per_mm`: the same driver turns the plunger.
const AXES: [(&str, &str, &str, u8); 4] = [
    ("rail", "r", "steps_per_mm", 0),
    ("table", "a", "steps_per_deg", 1),
    ("slide", "z", "steps_per_mm", 2),
    ("focus", "h", "steps_per_mm", 3),
];

/// Driver socket letters, numbered from 1 in the `sockets` setting.
const SOCKETS: [&str; 4] = ["X", "Y", "Z", "E"];
/// The `endstop` words, in the order of the `<axis>_stop` values.
const ENDSTOPS: [&str; 4] = ["none", "min", "max", "both"];

/// Applies a machine file's text to `settings`; what the file leaves out
/// stays as it was. The error names the key.
pub fn apply(settings: &mut Settings, text: &str) -> Result<(), String> {
    let top: Table = text.parse().map_err(|e| format!("{e}"))?;
    let mut writes: Vec<(String, String)> = Vec::new();
    let mut known_top =
        vec!["name", "description", "kinematics", "tool", "probe", "output", "enable", "drivers", "host", "controls", "camera"];

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
    let tool = match top.get("tool").map(|v| v.as_str()) {
        None => None,
        Some(Some(tool @ ("laser" | "spindle" | "dispenser"))) => Some(tool),
        Some(_) => return Err("tool must be one of laser, spindle, dispenser".into()),
    };
    if let Some(tool) = tool {
        writes.push(("spindle".into(), flag_text(tool == "spindle")));
        writes.push(("dispenser".into(), flag_text(tool == "dispenser")));
    }
    if tool == Some("dispenser") && top.get("kinematics").and_then(|v| v.as_str()) != Some("cartesian") {
        return Err("tool = dispenser needs kinematics = cartesian".into());
    }
    // The plunger is described in place of the table, on its driver.
    let dispenser = top.contains_key("dispenser");
    if dispenser && top.contains_key("table") {
        return Err("[table] and [dispenser] cannot both be given: the dispenser is the table's driver".into());
    }
    if dispenser && tool != Some("dispenser") {
        return Err("[dispenser] needs tool = dispenser".into());
    }

    let mut dir_invert = 0u8;
    let mut stop_invert = 0u8;
    let mut limits = 0u8;
    // The socket of each axis, as labeled unless the file says otherwise.
    let mut sockets = [0usize, 1, 2, 3];
    for (section, axis, scale_key, bit) in AXES {
        let (section, scale_key) =
            if section == "table" && dispenser { ("dispenser", "steps_per_mm") } else { (section, scale_key) };
        known_top.push(section);
        let table = table_of(&top, section)?;
        let mut known =
            vec![scale_key, "max_rate", "accel", "jerk", "jog_rate", "invert", "current_ma", "microsteps", "socket"];
        match table.get("socket") {
            None => {}
            Some(Value::String(letter)) => {
                sockets[bit as usize] = SOCKETS
                    .iter()
                    .position(|known| known == letter)
                    .ok_or(format!("[{section}] socket must be one of X, Y, Z, E"))?;
            }
            Some(_) => return Err(format!("[{section}] socket must be one of X, Y, Z, E")),
        }
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
        known.extend(["endstop", "endstop_pin", "endstop_invert", "endstop_halt", "home_pull", "home_pos", "home_travel"]);
        match table.get("endstop").map(|v| v.as_str()) {
            None => {}
            Some(Some(ends)) => {
                let stop = ENDSTOPS
                    .iter()
                    .position(|known| *known == ends)
                    .ok_or(format!("[{section}] endstop must be one of none, min, max, both"))?;
                writes.push((format!("{axis}_stop"), stop.to_string()));
            }
            Some(None) => return Err(format!("[{section}] endstop must be one of none, min, max, both")),
        }
        if let Some(value) = integer(&table, "endstop_pin", section)? {
            writes.push((format!("{axis}_stop_pin"), value));
        }
        if flag(&table, "endstop_invert", section)? == Some(true) {
            stop_invert |= 1 << bit;
        }
        if flag(&table, "endstop_halt", section)? == Some(true) {
            limits |= 1 << bit;
        }
        for key in ["home_pull", "home_pos", "home_travel"] {
            if let Some(value) = number(&table, key, section)? {
                writes.push((format!("{axis}_{key}"), value));
            }
        }
        only(&table, section, &known)?;
    }
    writes.push(("dir_invert".into(), dir_invert.to_string()));
    writes.push(("stop_invert".into(), stop_invert.to_string()));
    writes.push(("limits".into(), limits.to_string()));
    for (i, socket) in sockets.iter().enumerate() {
        if let Some(other) = sockets[..i].iter().position(|s| s == socket) {
            return Err(format!(
                "[{}] socket {} is the [{}] socket too",
                AXES[i].0, SOCKETS[*socket], AXES[other].0
            ));
        }
    }
    writes.push(("sockets".into(), sockets.iter().map(|s| (s + 1).to_string()).collect()));

    let probe = table_of(&top, "probe")?;
    if let Some(invert) = flag(&probe, "invert", "probe")? {
        writes.push(("probe_invert".into(), flag_text(invert)));
    }
    if let Some(value) = integer(&probe, "brake_ms", "probe")? {
        writes.push(("probe_ms".into(), value));
    }
    if let Some(value) = integer(&probe, "pin", "probe")? {
        writes.push(("probe_pin".into(), value));
    }
    only(&probe, "probe", &["invert", "brake_ms", "pin"])?;

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
    if let Some(value) = integer(&output, "pin", "output")? {
        writes.push(("laser_pin".into(), value));
    }
    only(&output, "output", &["pwm_hz", "s_max", "s_min", "invert", "test_ms", "pin"])?;

    // The tool output: the host checks that its pin is nobody else's.
    let enable = table_of(&top, "enable")?;
    if let Some(fitted) = flag(&enable, "fitted", "enable")? {
        writes.push(("tool_out".into(), flag_text(fitted)));
    }
    if let Some(value) = integer(&enable, "pin", "enable")? {
        writes.push(("tool_pin".into(), value));
    }
    if let Some(invert) = flag(&enable, "invert", "enable")? {
        writes.push(("tool_invert".into(), flag_text(invert)));
    }
    only(&enable, "enable", &["fitted", "pin", "invert"])?;

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
    for key in ["tolerance", "clearance", "spinup", "gap", "retract", "output", "extrude_rate", "dwell_ms"] {
        number(&host, key, "host")?;
    }
    flag(&host, "speed_control", "host")?;
    only(
        &host,
        "host",
        &["tolerance", "clearance", "spinup", "speed_control", "gap", "retract", "output", "extrude_rate", "dwell_ms"],
    )?;
    // The page's controls (the pad, the jog buttons, the readout) and a
    // camera on the head are the host's business: only their shape is
    // checked here.
    table_of(&top, "controls")?;
    table_of(&top, "camera")?;
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
        // The mill's limits are the measured ones, which move with the
        // machine: only that it has one is asserted.
        assert!(mill.z_max > 0.0);
        // A three axis mill wired as labeled: X, Y and Z drive the rail,
        // the slide and the depth, and the table is on E.
        assert_eq!(mill.sockets, 1423);
        assert_eq!([R, A, Z, H].map(|j| mill.socket_of(j)), [0, 3, 1, 2]);
        for name in ["polar-laser", "polar-laser-focus", "cartesian-laser"] {
            assert_eq!(applied(&shipped(name)).sockets, 1234, "{name}");
        }
        // The paste dispenser: the mill's X/Y machine with the plunger on
        // the table's settings.
        let dispenser = applied(&shipped("cartesian-dispenser"));
        assert!(dispenser.cartesian && dispenser.dispenser && !dispenser.spindle);
        assert!(dispenser.dispensing() && dispenser.h_axis);
    }

    #[test]
    fn sockets_are_named_per_axis_and_each_used_once() {
        let swapped = applied("[rail]\nsocket = \"Y\"\n[table]\nsocket = \"X\"\n");
        assert_eq!(swapped.sockets, 2134);
        let refused = |text: &str| apply(&mut Settings::default(), text).unwrap_err();
        assert_eq!(refused("[slide]\nsocket = \"Y\"\n"), "[slide] socket Y is the [table] socket too");
        assert!(refused("[focus]\nsocket = \"W\"\n").contains("[focus] socket must be one of X, Y, Z, E"));
        assert!(refused("[focus]\nsocket = 4\n").contains("[focus] socket must be one of"));
    }

    #[test]
    fn every_section_lands_on_its_setting() {
        let settings = applied(
            "kinematics = \"cartesian\"\ntool = \"spindle\"\n\
             [rail]\nsteps_per_mm = 800\nmax_rate = 1200\naccel = 75\njerk = 2.5\njog_rate = 900\nlimit = 60\ninvert = true\ncurrent_ma = 700\nmicrosteps = 16\n\
             [table]\nsteps_per_deg = 888.8889\nmax_rate = 1080\ninvert = true\n\
             [slide]\nsteps_per_mm = 640\nlimit = 8\n\
             [focus]\nfitted = true\nsteps_per_mm = 1600\nmax_rate = 300\njog_rate = 150\ninvert = true\n\
             [probe]\ninvert = true\nbrake_ms = 0\npin = 22\n\
             [output]\npwm_hz = 1000\ns_max = 255\ns_min = 10\ninvert = true\ntest_ms = 7000\npin = 23\n\
             [enable]\nfitted = true\npin = 18\ninvert = true\n\
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
        assert_eq!((settings.laser_pin, settings.probe_pin), (23, 22));
        assert!(settings.tool_out && settings.tool_invert);
        assert_eq!(settings.tool_pin, 18);
        assert!(settings.en_invert);
        assert_eq!(settings.idle_ms, 30000);
        assert_eq!(settings.step_us, 4);
        assert_eq!(settings.tmc_hold_pct, 30);
        assert!(!settings.tmc_stealth);
    }

    #[test]
    fn a_dispenser_file_puts_the_plunger_on_the_tables_settings() {
        let text = "kinematics = \"cartesian\"\ntool = \"dispenser\"\n\
             [dispenser]\nsteps_per_mm = 1600\nmax_rate = 300\njog_rate = 60\ninvert = true\nsocket = \"E\"\n\
             [focus]\nsocket = \"Y\"\n\
             [host]\ngap = 0.1\nretract = 0.2\noutput = 100\nextrude_rate = 60\ndwell_ms = 200\nspeed_control = false\n";
        let mut settings = applied(text);
        assert!(settings.cartesian && settings.dispenser && !settings.spindle);
        assert!(settings.dispensing());
        assert_eq!(settings.steps[A], 1600.0);
        assert_eq!(settings.max_rate[A], 300.0);
        assert_eq!(settings.jog_rate[A], 60.0);
        assert_eq!(settings.dir_invert, 0b0010, "the table's bit");
        assert_eq!(settings.sockets, 1432, "the table's slot");
        // A laser or a spindle file takes the flag back off.
        apply(&mut settings, "tool = \"laser\"\n").unwrap();
        assert!(!settings.dispenser && !settings.spindle);
        apply(&mut settings, "tool = \"spindle\"\n").unwrap();
        assert!(!settings.dispenser && settings.spindle);
    }

    #[test]
    fn a_table_and_a_dispenser_do_not_go_in_one_file() {
        let text = "kinematics = \"cartesian\"\ntool = \"dispenser\"\n[table]\nsteps_per_deg = 100\n[dispenser]\nsteps_per_mm = 1600\n";
        assert_eq!(
            apply(&mut Settings::default(), text).unwrap_err(),
            "[table] and [dispenser] cannot both be given: the dispenser is the table's driver"
        );
    }

    #[test]
    fn a_dispenser_section_needs_the_dispenser_tool() {
        let refused = |text: &str| apply(&mut Settings::default(), text).unwrap_err();
        let laser = "kinematics = \"cartesian\"\ntool = \"laser\"\n[dispenser]\nsteps_per_mm = 1600\n";
        assert_eq!(refused(laser), "[dispenser] needs tool = dispenser");
        assert_eq!(refused("[dispenser]\nsteps_per_mm = 1600\n"), "[dispenser] needs tool = dispenser");
        let degrees = "kinematics = \"cartesian\"\ntool = \"dispenser\"\n[dispenser]\nsteps_per_deg = 100\n";
        assert!(refused(degrees).contains("[dispenser] steps_per_deg"));
    }

    #[test]
    fn a_dispenser_needs_a_cartesian_machine() {
        for text in ["tool = \"dispenser\"\n", "kinematics = \"polar\"\ntool = \"dispenser\"\n[dispenser]\nsteps_per_mm = 1600\n"] {
            assert_eq!(apply(&mut Settings::default(), text).unwrap_err(), "tool = dispenser needs kinematics = cartesian", "{text}");
        }
        assert!(apply(&mut Settings::default(), "tool = \"glue\"\n").unwrap_err().contains("laser, spindle, dispenser"));
    }

    #[test]
    fn the_controls_are_the_hosts_and_leave_the_settings_alone() {
        let text = "[controls]\npad = false\ncenter = { r = 0 }\n[[controls.axes]]\naxis = \"r\"\nlabel = \"X\"\nsteps = [1, 5]\n";
        assert_eq!(applied(text), Settings::default());
        assert!(apply(&mut Settings::default(), "controls = 5\n").unwrap_err().contains("controls must be a table"));
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
