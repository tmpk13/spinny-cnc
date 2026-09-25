//! A client drives the simulated board over TCP, the way the backend does.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

use spinny_virtual::args::Options;
use spinny_virtual::sim::Sim;
use spinny_virtual::{server, setup};

struct Server {
    port: u16,
    trace: std::path::PathBuf,
}

/// Starts a free-running simulated board on a free port.
fn start(name: &str) -> Server {
    let trace = std::env::temp_dir().join(format!("spinny-virtual-{name}-{:?}.json", thread::current().id()));
    let _ = std::fs::remove_file(&trace);
    let listener = server::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let options = Options {
        fast: true,
        quiet: true,
        trace: Some(trace.clone()),
        ..Options::default()
    };
    let mut sim = Sim::new(setup(&options));
    thread::spawn(move || {
        let _ = server::serve(listener, &mut sim, true);
    });
    Server { port, trace }
}

struct Client {
    stream: TcpStream,
    lines: BufReader<TcpStream>,
}

impl Client {
    fn connect(server: &Server) -> Client {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match TcpStream::connect(("127.0.0.1", server.port)) {
                Ok(stream) => break stream,
                Err(error) if Instant::now() < deadline => {
                    let _ = error;
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("connect: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .expect("read timeout");
        let lines = BufReader::new(stream.try_clone().expect("clone"));
        Client { stream, lines }
    }

    fn line(&mut self) -> String {
        let mut text = String::new();
        let n = self.lines.read_line(&mut text).expect("read");
        assert!(n > 0, "the machine closed the connection");
        text.trim_end().to_string()
    }

    /// Sends a line and returns everything up to and including its answer.
    fn send(&mut self, text: &str) -> Vec<String> {
        writeln!(self.stream, "{text}").expect("write");
        self.stream.flush().expect("flush");
        let mut out = Vec::new();
        loop {
            let line = self.line();
            let answered = line.starts_with("ok") || line.starts_with("error:");
            out.push(line);
            if answered {
                return out;
            }
        }
    }

    fn status(&mut self) -> String {
        self.stream.write_all(b"?").expect("write");
        self.stream.flush().expect("flush");
        loop {
            let line = self.line();
            if line.starts_with('<') {
                return line;
            }
        }
    }

    /// Asks for the status until the state matches, or gives up.
    fn wait_for(&mut self, state: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let status = self.status();
            if status.starts_with(&format!("<{state}")) {
                return status;
            }
            assert!(Instant::now() < deadline, "still {status} waiting for {state}");
            thread::sleep(Duration::from_millis(5));
        }
    }
}

/// Fields of `<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>`.
fn status_fields(status: &str) -> Vec<String> {
    assert!(status.starts_with('<') && status.ends_with('>'), "{status}");
    status[1..status.len() - 1].split('|').map(|s| s.to_string()).collect()
}

fn joint(status: &str) -> (f64, f64) {
    let fields = status_fields(status);
    let joint = fields[1].strip_prefix("J:").expect("J field");
    let (r, a) = joint.split_once(',').expect("two numbers");
    (r.parse().expect("radius"), a.parse().expect("angle"))
}

/// The cross slide position, from the last field.
fn slide(status: &str) -> f64 {
    let fields = status_fields(status);
    let z = fields.last().expect("a field").strip_prefix("Z:").expect("Z field");
    z.parse().expect("cross slide")
}

#[derive(Debug)]
struct Mark {
    x: f64,
    y: f64,
    r: f64,
    a: f64,
    h: f64,
    z: f64,
    duty: u32,
}

/// Reads the trace without a JSON dependency: the writer puts one mark per
/// line, so each object is picked out by its field names.
fn marks(path: &std::path::Path) -> Vec<Mark> {
    let text = std::fs::read_to_string(path).expect("trace file");
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_end_matches(',');
        if !line.starts_with("{\"us\":") {
            continue;
        }
        let field = |name: &str| -> f64 {
            let at = line.find(&format!("\"{name}\": ")).unwrap_or_else(|| panic!("{name} in {line}"));
            let rest = &line[at + name.len() + 4..];
            let end = rest.find([',', '}']).expect("end of value");
            rest[..end].trim().parse().expect("number")
        };
        out.push(Mark {
            x: field("x"),
            y: field("y"),
            r: field("r"),
            a: field("a"),
            h: field("h"),
            z: field("z"),
            duty: field("duty") as u32,
        });
    }
    out
}

#[test]
fn a_quarter_circle_cut_runs_and_lands_where_it_was_asked_to() {
    let server = start("quarter");
    let mut client = Client::connect(&server);

    let banner = client.line();
    assert!(banner.starts_with("[spinny v"), "{banner}");
    assert!(banner.contains("lines:16") && banner.contains("blocks:32"), "{banner}");

    for line in ["set R0 A0", "go R10", "cut A90 F300 S500", "cut R0 A90"] {
        let answer = client.send(line);
        assert_eq!(answer.last().map(String::as_str), Some("ok"), "{line} -> {answer:?}");
    }

    // The status line carries every documented field while the job runs.
    let running = client.status();
    let fields = status_fields(&running);
    assert_eq!(fields.len(), 8, "{running}");
    assert!(fields[2].starts_with("V:") && fields[3].starts_with("L:"), "{running}");
    assert!(fields[4].starts_with("Q:") && fields[5].starts_with("M:"), "{running}");
    assert_eq!(fields[6], "E:1", "the motors are on while it cuts");
    assert_eq!(fields[7], "Z:0.000", "the cross slide is the last field");

    let idle = client.wait_for("Idle");
    let (r, a) = joint(&idle);
    // A step is well under a micron and a thousandth of a degree at the
    // default scales; the angle at the axis keeps the value it reached.
    assert!(r.abs() <= 0.004, "ended at radius {r}, expected the axis");
    assert!((a - 90.0).abs() <= 0.002, "ended at angle {a}, expected 90");
    assert_eq!(status_fields(&idle)[3], "L:0", "the beam is off when the job ends");

    drop(client);
    // Accepting again means the session ended and the trace was written.
    let mut next = Client::connect(&server);
    assert!(next.line().starts_with("[spinny v"));

    let marks = marks(&server.trace);
    let lit: Vec<&Mark> = marks.iter().filter(|m| m.duty > 0).collect();
    assert!(lit.len() > 50, "only {} lit marks", lit.len());
    // The job is an arc at radius 10 followed by a radial cut at 90
    // degrees, so every lit mark lies on one or the other.
    for mark in &lit {
        let on_arc = (mark.r - 10.0).abs() <= 0.01;
        let on_spoke = (mark.a - 90.0).abs() <= 0.01;
        assert!(on_arc || on_spoke, "stray mark {mark:?}");
        // The file carries four decimals, so agreement to a micron is all
        // the coordinates can show.
        assert!(
            (mark.x.hypot(mark.y) - mark.r).abs() < 1e-3,
            "board position does not match the radius: {mark:?}"
        );
    }
    let arc: Vec<&&Mark> = lit.iter().filter(|m| m.a > 10.0 && m.a < 80.0).collect();
    assert!(arc.len() > 20, "the arc itself was not burnt: {} marks", arc.len());
    for mark in arc {
        assert!((mark.r - 10.0).abs() <= 0.01, "arc left radius 10: {mark:?}");
    }
}

#[test]
fn a_cartesian_spindle_machine_plunges_and_mills_a_straight_line() {
    let server = start("mill");
    let mut client = Client::connect(&server);
    assert!(client.line().starts_with("[spinny v"));

    for line in [
        "$cartesian=1",
        "$spindle=1",
        "$h_axis=1",
        "set R0 A0 Z0 H0",
        "go H2",
        "spindle S600",
        "dwell T50",
        "go R2 Z1",
        "cut H-0.1 F120",
        "cut R6 Z4 F300",
        "go H2",
        "spindle off",
    ] {
        let answer = client.send(line);
        assert_eq!(answer.last().map(String::as_str), Some("ok"), "{line} -> {answer:?}");
    }
    let idle = client.wait_for("Idle");
    let fields = status_fields(&idle);
    assert_eq!(fields[3], "L:0", "the spindle is off at the end: {idle}");
    assert_eq!(fields[7], "Z:4.000", "{idle}");
    assert_eq!(fields[8], "H:2.000", "{idle}");
    let (r, a) = joint(&idle);
    assert!((r - 6.0).abs() < 1e-3 && a == 0.0, "{idle}");

    drop(client);
    let mut next = Client::connect(&server);
    assert!(next.line().starts_with("[spinny v"));
    let marks = marks(&server.trace);
    // The tool turns from the spin-up on; it is in the work only below
    // the surface at H 0, and there it follows the line (2,1)-(6,4).
    let turning: Vec<&Mark> = marks.iter().filter(|m| m.duty > 0).collect();
    assert!(turning.iter().any(|m| m.h > 1.9), "it was turning at the travel height");
    let milled: Vec<&&Mark> = turning.iter().filter(|m| m.h < -0.09).collect();
    assert!(milled.len() > 20, "only {} marks in the work", milled.len());
    for mark in milled {
        assert!((mark.x - mark.r).abs() < 1e-3 && (mark.y - mark.z).abs() < 1e-3, "the table turned: {mark:?}");
        // Distance from the line through (2,1) and (6,4): 3x - 4y - 2 = 0.
        let off = (3.0 * mark.x - 4.0 * mark.y - 2.0).abs() / 5.0;
        assert!(off < 2e-3, "off the line by {off}: {mark:?}");
        assert!((2.0 - 1e-3..=6.0 + 1e-3).contains(&mark.x), "{mark:?}");
    }
}

#[test]
fn realtime_bytes_stop_the_machine_and_a_reset_raises_an_alarm() {
    let server = start("realtime");
    let mut client = Client::connect(&server);
    assert!(client.line().starts_with("[spinny v"));

    client.send("set R0 A0");
    client.send("go R20");
    client.send("cut A180 F200 S300");

    // Hold, check it comes to rest, then resume and stop it for good.
    client.stream.write_all(b"!").expect("hold");
    let held = client.wait_for("Hold");
    assert_eq!(status_fields(&held)[3], "L:0", "the beam is off in a hold");
    client.stream.write_all(b"~").expect("resume");
    client.wait_for("Run");

    client.stream.write_all(&[0x18]).expect("reset");
    let mut saw_alarm = false;
    for _ in 0..40 {
        let status = client.status();
        if status.starts_with("<Alarm:1") {
            saw_alarm = true;
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert!(saw_alarm, "a reset while moving should raise alarm 1");

    let refused = client.send("go R1");
    assert_eq!(refused.last().map(String::as_str), Some("error:5 not now"));
    assert_eq!(client.send("unlock").last().map(String::as_str), Some("ok"));
    client.wait_for("Idle");
    assert_eq!(client.send("go R1").last().map(String::as_str), Some("ok"));
}

#[test]
fn the_cross_slide_jogs_on_its_own_and_lands_where_it_was_asked_to() {
    let server = start("slide");
    let mut client = Client::connect(&server);
    assert!(client.line().starts_with("[spinny v"));

    // The slide is coarse, and the jog is paced so that it lasts long
    // enough to be seen in flight even when the machine is loaded: the
    // status is polled every few milliseconds, and a jog over in a tenth
    // of a second was missed now and then, leaving the wait for Jog to
    // time out on a slide that had long since arrived.
    assert_eq!(client.send("$z_steps=256").last().map(String::as_str), Some("ok"));
    assert_eq!(client.send("$jog_z=60").last().map(String::as_str), Some("ok"));
    assert_eq!(client.send("set Z0").last().map(String::as_str), Some("ok"));
    assert_eq!(slide(&client.status()), 0.0);

    assert_eq!(client.send("jog Z1.5").last().map(String::as_str), Some("ok"));
    let moving = client.wait_for("Jog");
    assert_eq!(status_fields(&moving)[3], "L:0", "the beam is off for a Z jog");
    let idle = client.wait_for("Idle");
    assert_eq!(slide(&idle), 1.5, "{idle}");
    // The joints stayed where they were.
    assert_eq!(joint(&idle), (0.0, 0.0));

    // Absolute, then back, and a line that mixes Z with a joint.
    assert_eq!(client.send("jogto Z-0.5").last().map(String::as_str), Some("ok"));
    assert_eq!(slide(&client.wait_for("Idle")), -0.5);
    assert_eq!(
        client.send("jog Z1 R1").last().map(String::as_str),
        Some("error:2 bad word"),
        "the cross slide is never interpolated with a joint"
    );
    assert_eq!(slide(&client.status()), -0.5);
}

#[test]
fn settings_round_trip_and_a_long_line_is_refused() {
    let server = start("settings");
    let mut client = Client::connect(&server);
    assert!(client.line().starts_with("[spinny v"));

    let listing = client.send("$");
    assert_eq!(listing.last().map(String::as_str), Some("ok"));
    assert!(listing.iter().any(|l| l.starts_with("r_steps=")), "{listing:?}");
    // 200 steps at 256 microsteps through 100:1, over 360 degrees.
    assert!(listing.iter().any(|l| l == "a_steps=14222.222"), "{listing:?}");
    // 200 steps at 256 microsteps over a 5 mm screw.
    assert!(listing.iter().any(|l| l == "r_steps=10240"), "{listing:?}");

    assert_eq!(client.send("$a_rate=600").last().map(String::as_str), Some("ok"));
    assert_eq!(client.send("$a_rate"), vec!["a_rate=600".to_string(), "ok".to_string()]);
    assert_eq!(
        client.send("$a_rate=0").last().map(String::as_str),
        Some("error:7 bad setting value")
    );
    assert_eq!(
        client.send("$nope=1").last().map(String::as_str),
        Some("error:6 unknown setting")
    );

    let long = "cut ".to_string() + &"R1 ".repeat(40);
    assert!(long.len() > 95);
    assert_eq!(
        client.send(&long).last().map(String::as_str),
        Some("error:8 line too long"),
        "a line past the limit gets exactly one answer"
    );
    // The link still works after it.
    assert_eq!(client.send("version").len(), 2);
}

#[test]
fn a_reset_throws_away_the_lines_the_host_had_already_sent() {
    // Stopping a run sends the reset byte, but the lines behind it are
    // already on the machine, parsed and waiting. If they survive, the
    // machine carries on cutting the job the operator just stopped, with
    // the beam on, which is the one thing a stop has to prevent.
    let server = start("flush");
    let mut client = Client::connect(&server);
    assert!(client.line().starts_with("[spinny v"));

    client.send("set R0 A0");
    client.send("go R10");
    // Send more cuts than the planner holds, slowly enough that it stays
    // full: the ones that do not fit are the ones left waiting in the
    // port's own queue, which is what a reset has to throw away. A host
    // keeping its credit has up to sixteen sitting there.
    for step in 1..=48 {
        writeln!(client.stream, "cut A{step} F60 S800").expect("write");
    }
    client.stream.flush().expect("flush");
    thread::sleep(Duration::from_millis(100));

    // Hold first and let it come to rest, then reset: that is what a stop
    // does, and it is the case the machine cannot lean on an alarm to
    // save it. A reset while still moving raises one, and an alarm
    // refuses whatever was queued; a reset from rest does not.
    client.stream.write_all(b"!").expect("hold");
    let held = client.wait_for("Hold");
    thread::sleep(Duration::from_millis(50));
    // Where it came to rest. Nothing after this may move the table: in
    // free-running time the queue would run out in microseconds, so the
    // angle either side of the stop is the only honest witness.
    let (_, stopped_at) = joint(&client.status());
    let _ = held;
    client.stream.write_all(&[0x18]).expect("reset");
    let mut settled = String::new();
    for _ in 0..200 {
        settled = client.status();
        if settled.starts_with("<Idle") || settled.starts_with("<Alarm") {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert!(settled.starts_with("<Idle"), "a stop from rest should not alarm: {settled}");

    // Nothing may move or light up after the stop.
    for _ in 0..20 {
        let status = client.status();
        assert!(status.starts_with("<Idle"), "it started again: {status}");
        assert_eq!(status_fields(&status)[3], "L:0", "the beam came back on");
        thread::sleep(Duration::from_millis(5));
    }
    let (_, after) = joint(&client.status());
    assert!(
        (after - stopped_at).abs() < 0.01,
        "the table carried on turning after the stop: {stopped_at} to {after}"
    );
}
