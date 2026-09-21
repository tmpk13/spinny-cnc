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

/// Fields of `<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:1>`.
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

#[derive(Debug)]
struct Mark {
    x: f64,
    y: f64,
    r: f64,
    a: f64,
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
    assert_eq!(fields.len(), 7, "{running}");
    assert!(fields[2].starts_with("V:") && fields[3].starts_with("L:"), "{running}");
    assert!(fields[4].starts_with("Q:") && fields[5].starts_with("M:"), "{running}");
    assert_eq!(fields[6], "E:1", "the motors are on while it cuts");

    let idle = client.wait_for("Idle");
    let (r, a) = joint(&idle);
    // One step is 1/256 mm and 1/888.889 deg; the angle at the axis keeps
    // the value it reached.
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
fn settings_round_trip_and_a_long_line_is_refused() {
    let server = start("settings");
    let mut client = Client::connect(&server);
    assert!(client.line().starts_with("[spinny v"));

    let listing = client.send("$");
    assert_eq!(listing.last().map(String::as_str), Some("ok"));
    assert!(listing.iter().any(|l| l.starts_with("r_steps=")), "{listing:?}");
    assert!(listing.iter().any(|l| l == "a_steps=888.889"), "{listing:?}");

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
