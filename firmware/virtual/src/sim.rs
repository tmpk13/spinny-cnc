//! The control core driven against virtual hardware.
//!
//! One `Sim` per process, like one board: it keeps its position, settings
//! and alarm state across client connections. `session` runs the main loop
//! and the step interrupt for one connected client, in the same order the
//! firmware does: realtime actions, then one line if the machine will take
//! it, then `poll`, then whatever ticks are due before the next poll.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use spinny_core::hal::StepPort;
use spinny_core::machine::Machine;
use spinny_core::parser::{Error, Realtime};
use spinny_core::report;
use spinny_core::settings::Settings;
use spinny_core::stepper::{self, Isr, Shared};
use spinny_core::AXES;

use crate::clock::Clock;
use crate::inbox::{Inbound, Inbox};
use crate::ports::{FileStore, Laser, OutBuf, Slide, Steppers};
use crate::surface::Surface;
use crate::trace::{Command, Trace};

/// Main loop period, as on the board.
const POLL_US: u64 = 500;
/// How long an idle loop waits for input before looking around again.
const IDLE_WAIT: Duration = Duration::from_millis(50);
/// Ticks allowed to settle the machine after the client has gone.
const SETTLE_POLLS: u32 = 200_000;
/// Wall-clock gap between reports on stderr.
const REPORT_EVERY: Duration = Duration::from_secs(1);

pub struct Sim {
    machine: Machine<'static>,
    isr: Isr<'static>,
    port: Steppers,
    slide: Slide,
    laser: Laser,
    store: FileStore,
    out: OutBuf,
    clock: Clock,
    next_tick: Option<u64>,
    trace: Trace,
    /// Lines submitted and not yet answered, oldest first.
    awaiting: Vec<Command>,
    /// When the next stderr report is due; `None` keeps it silent.
    report_at: Option<Instant>,
    /// The board under the probe.
    surface: Option<Surface>,
}

/// Start values for a simulated board.
pub struct Setup {
    pub settings: Settings,
    pub store: FileStore,
    pub clock: Clock,
    pub trace: Trace,
    pub quiet: bool,
    pub surface: Option<Surface>,
}

impl Sim {
    pub fn new(setup: Setup) -> Sim {
        let shared: &'static mut Shared = Box::leak(Box::new(Shared::new()));
        let (front, isr) = stepper::split(shared);
        let mut sim = Sim {
            machine: Machine::new(front, setup.settings),
            isr,
            port: Steppers::default(),
            slide: Slide::default(),
            laser: Laser::default(),
            store: setup.store,
            out: OutBuf::default(),
            clock: setup.clock,
            next_tick: None,
            trace: setup.trace,
            awaiting: Vec::new(),
            report_at: (!setup.quiet).then(|| Instant::now() + REPORT_EVERY),
            surface: setup.surface,
        };
        // Stored settings win over the ones given on the command line, as
        // they do on the board, where flash is read at boot.
        sim.machine.load_settings(&mut sim.store);
        sim.out.take();
        sim
    }

    pub fn joint(&self) -> [f32; AXES] {
        self.machine.joint()
    }

    pub fn state(&self) -> report::State {
        self.machine.state()
    }

    pub fn laser_duty(&self) -> u16 {
        self.laser.duty
    }

    pub fn trace_mut(&mut self) -> &mut Trace {
        &mut self.trace
    }

    /// Runs one client to its end. Returns when the client has gone and
    /// the machine has come to rest.
    pub fn session(&mut self, inbox: &Inbox, socket: &mut impl Write) -> io::Result<()> {
        // A write that fails is the client going away mid-sentence, so the
        // machine has to be stopped on that path as much as on a clean
        // hang up: an early return here would leave it cutting.
        let result = self.serve(inbox, socket);
        self.disconnect();
        result
    }

    fn serve(&mut self, inbox: &Inbox, socket: &mut impl Write) -> io::Result<()> {
        report::banner(&mut self.out);
        self.flush(socket)?;
        loop {
            while let Some(action) = inbox.take_realtime() {
                let pending = !self.machine.ready_for_line();
                self.machine.realtime(action, &mut self.laser, &mut self.out);
                if pending && action == Realtime::Reset {
                    self.drop_awaiting();
                }
            }
            if self.machine.ready_for_line() {
                match inbox.take_line() {
                    Some(Inbound::Line(line)) => self.submit(line.as_str()),
                    Some(Inbound::TooLong) => report::error(Error::TooLong, &mut self.out),
                    None => {}
                }
            }
            self.machine.note_lines_waiting(inbox.lines_waiting());
            self.poll();
            self.flush(socket)?;
            // On disk as soon as the machine comes to rest, not only when
            // the client goes: a trace from the run before is worse than
            // no trace at all, because it reads exactly like this one.
            if self.trace.has_fresh() && self.machine.is_quiet() {
                self.write_trace();
            }
            // Whatever the client had queued went with it (the inbox drops
            // it on close), so there is nothing to wait for.
            if inbox.is_closed() {
                break;
            }
            self.advance(Some(inbox));
        }
        Ok(())
    }

    /// The client has gone: stop, drop the beam, and let the abort drain.
    /// Settled, not quiet: a constant beam or the idle disable timer would
    /// hold the next client off for as long as they take to run out.
    fn disconnect(&mut self) {
        let pending = !self.machine.ready_for_line();
        self.machine.disconnected(&mut self.laser, &mut self.port);
        if pending {
            self.drop_awaiting();
        }
        self.out.take();
        for _ in 0..SETTLE_POLLS {
            self.poll();
            self.out.take();
            if self.machine.is_settled() && self.next_tick.is_none() {
                break;
            }
            self.advance(None);
        }
        self.write_trace();
    }

    /// A pending line was thrown away unanswered: its entry goes to the
    /// trace now, or every later answer would land on the wrong line.
    fn drop_awaiting(&mut self) {
        let now = self.clock.now();
        let joint = self.machine.joint();
        for mut command in self.awaiting.drain(..) {
            command.done_us = now;
            command.to = joint;
            self.trace.command(command);
        }
    }

    fn write_trace(&mut self) {
        if let Err(error) = self.trace.flush() {
            if self.report_at.is_some() {
                eprintln!("trace: {error}");
            }
        }
    }

    /// The beam as commanded: the port carries the pin level, which is
    /// the other way round under `laser_invert`.
    fn beam_duty(&self) -> u16 {
        if self.machine.settings().laser_invert {
            1000 - self.laser.duty
        } else {
            self.laser.duty
        }
    }

    fn submit(&mut self, line: &str) {
        let now = self.clock.now();
        let joint = self.machine.joint();
        self.machine.submit(line, &mut self.out);
        if self.trace.enabled() {
            self.awaiting.push(Command {
                text: line.to_string(),
                sent_us: now,
                done_us: now,
                from: joint,
                to: joint,
            });
        }
    }

    /// The probe input as the board under the tip sets it, wired the way
    /// the `probe_invert` setting says: pulled low at contact by default.
    fn update_probe(&mut self) {
        let touching = self.surface.is_some_and(|surface| surface.touching(self.machine.joint()));
        self.port.probe_level = touching == self.machine.settings().probe_invert;
    }

    fn poll(&mut self) {
        self.update_probe();
        let now = self.clock.now();
        // The cross slide is stepped from the main loop, as on the board,
        // and before the poll that ends its jog.
        self.machine.poll_slide(now, &mut self.slide);
        let kick = self.machine.poll(
            now,
            &mut self.port,
            &mut self.laser,
            &mut self.store,
            &mut self.out,
        );
        if kick {
            self.next_tick = Some(now);
        }
        self.trace.sample(now, self.machine.joint(), self.beam_duty());
        if let Some(due) = self.report_at {
            if Instant::now() >= due {
                eprintln!("{}", self.status_line());
                self.report_at = Some(Instant::now() + REPORT_EVERY);
            }
        }
    }

    fn tick(&mut self) {
        self.update_probe();
        let next = self.isr.tick(&mut self.port, &mut self.laser);
        let now = self.clock.now();
        self.trace.sample(now, self.machine.joint(), self.beam_duty());
        self.next_tick = next.map(|us| now + u64::from(us));
    }

    /// Runs the clock to the next poll, executing the ticks that fall
    /// before it. With nothing to do and nothing waiting, blocks instead:
    /// free-running time then stands still until the client speaks.
    fn advance(&mut self, inbox: Option<&Inbox>) {
        if let Some(inbox) = inbox {
            if self.next_tick.is_none()
                && self.machine.is_quiet()
                && inbox.is_empty()
                && !inbox.is_closed()
            {
                inbox.wait(IDLE_WAIT);
                return;
            }
        }
        let target = self.clock.now() + POLL_US;
        while let Some(at) = self.next_tick {
            if at > target {
                break;
            }
            self.clock.wait_until(at);
            self.tick();
        }
        self.clock.wait_until(target);
    }

    /// Sends what the machine has written and closes out the commands its
    /// answers belong to.
    fn flush(&mut self, socket: &mut impl Write) -> io::Result<()> {
        let bytes = self.out.take();
        if bytes.is_empty() {
            return Ok(());
        }
        if self.trace.enabled() {
            let answers = count_answers(&bytes);
            if answers > 0 {
                let now = self.clock.now();
                let joint = self.machine.joint();
                for mut command in self.awaiting.drain(..answers.min(self.awaiting.len())) {
                    command.done_us = now;
                    command.to = joint;
                    self.trace.command(command);
                }
            }
        }
        socket.write_all(&bytes)?;
        socket.flush()
    }

    /// One line for a periodic report on stderr.
    pub fn status_line(&self) -> String {
        let joint = self.machine.joint();
        let state = match self.machine.state() {
            report::State::Idle => "Idle".to_string(),
            report::State::Run => "Run".to_string(),
            report::State::Jog => "Jog".to_string(),
            report::State::Hold => "Hold".to_string(),
            report::State::Alarm(code) => format!("Alarm:{code}"),
        };
        format!(
            "{state} R{:.3} A{:.4} H{:.3} Z{:.3} laser {} pulses {}/{}/{}/{}",
            joint[0],
            joint[1],
            joint[2],
            self.machine.slide_position(),
            self.laser.duty,
            self.port.pulses[0],
            self.port.pulses[1],
            self.port.pulses[2],
            self.slide.pulses,
        )
    }
}

/// Answers in a chunk of output: lines that start with `ok` or `error:`.
fn count_answers(bytes: &[u8]) -> usize {
    bytes
        .split(|&b| b == b'\n')
        .filter(|line| line.starts_with(b"ok") || line.starts_with(b"error:"))
        .count()
}

/// Stops the motors on the way out, so a simulated board does not end a
/// run with its drivers still energized.
impl Drop for Sim {
    fn drop(&mut self) {
        self.port.set_enable(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::clock::Clock;
    use crate::ports::FileStore;
    use crate::trace::Trace;
    use spinny_fw_logic::line::{Event, Line};

    fn sim() -> Sim {
        Sim::new(Setup {
            settings: Settings::default(),
            store: FileStore::default(),
            clock: Clock::fast(),
            trace: Trace::new(None),
            quiet: true,
            surface: None,
        })
    }

    fn line(text: &str) -> Event {
        Event::Line(text.parse::<Line>().expect("line fits"))
    }

    /// A socket that dies after a few writes, like a client that is killed.
    struct Dying {
        left: usize,
    }

    impl Write for Dying {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.left == 0 {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "gone"));
            }
            self.left -= 1;
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_client_that_dies_mid_write_still_stops_the_machine() {
        let mut sim = sim();
        let inbox = Inbox::new();
        inbox.push(line("set R0 A0"));
        inbox.push(line("cut R20 F400 S800"));
        // The banner and the first answer get through; the answer to the
        // cut, by which time the machine is moving with the beam on, does
        // not.
        let mut socket = Dying { left: 2 };
        let result = sim.session(&inbox, &mut socket);
        assert!(result.is_err(), "the write error should reach the caller");
        // Stopping a moving machine is a reset while moving, so the next
        // client finds the alarm and has to unlock before it can move.
        assert_eq!(sim.state(), report::State::Alarm(1), "the machine kept running");
        assert_eq!(sim.laser_duty(), 0, "the beam was left on");
    }

    #[test]
    fn a_client_that_hangs_up_takes_its_queued_lines_with_it() {
        let mut sim = sim();
        let inbox = Inbox::new();
        inbox.push(line("set R0 A0"));
        inbox.push(line("cut R20 F400 S800"));
        // Gone before the loop took anything: nothing of it may run, and
        // the session must end rather than wait for the queue to drain.
        inbox.close();
        let mut out = Vec::new();
        sim.session(&inbox, &mut out).unwrap();
        assert_eq!(sim.state(), report::State::Idle);
        assert_eq!(sim.joint(), [0.0, 0.0, 0.0], "a dead client's line ran");
        assert_eq!(sim.laser_duty(), 0);
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains("ok"), "{text:?}");
    }

    #[test]
    fn the_trace_records_the_beam_not_the_pin_level() {
        let mut settings = Settings::default();
        settings.laser_invert = true;
        let mut sim = Sim::new(Setup {
            settings,
            store: FileStore::default(),
            clock: Clock::fast(),
            trace: Trace::new(Some(std::path::PathBuf::from("/dev/null"))),
            quiet: true,
            surface: None,
        });
        let inbox = Inbox::new();
        inbox.push(line("set R0 A0"));
        inbox.push(line("go R10"));
        inbox.push(line("cut A90 F300 S1000"));
        inbox.push(line("go R0 A0"));
        // The loop as `serve` runs it, until the lines are taken and the
        // machine has come to rest.
        let mut out = Vec::new();
        for _ in 0..4_000_000 {
            if sim.machine.ready_for_line() {
                if let Some(Inbound::Line(text)) = inbox.take_line() {
                    sim.submit(text.as_str());
                }
            }
            sim.poll();
            sim.flush(&mut out).unwrap();
            if inbox.is_empty() && sim.machine.is_settled() && sim.next_tick.is_none() {
                break;
            }
            sim.advance(None);
        }
        assert_eq!(sim.state(), report::State::Idle);
        // The pin rests high under laser_invert, and the cut drove it low:
        // the trace counts the cut, a quarter turn at 10 mm, as the burn.
        assert_eq!(sim.laser_duty(), 1000);
        let burnt = sim.trace_mut().laser_on_mm();
        assert!((burnt - 15.7).abs() < 0.5, "burnt {burnt} mm");
    }

    #[test]
    fn a_probe_finds_the_board_under_its_tip() {
        let mut settings = Settings::default();
        settings.h_axis = true;
        let mut sim = Sim::new(Setup {
            settings,
            store: FileStore::default(),
            clock: Clock::fast(),
            trace: Trace::new(None),
            quiet: true,
            // Tilted up along X, with the tip 2 mm further out than the beam.
            surface: Some(Surface { base: -1.0, slope: [0.01, 0.0], curve: 0.0, offset: [2.0, 0.0] }),
        });
        let inbox = Inbox::new();
        inbox.push(line("go R8"));
        inbox.push(line("probe H-5 F120"));
        inbox.push(line("go H1"));
        inbox.push(line("go A180"));
        inbox.push(line("probe H-5 F120"));
        let mut out = Vec::new();
        for _ in 0..4_000_000 {
            if sim.machine.ready_for_line() {
                if let Some(Inbound::Line(text)) = inbox.take_line() {
                    sim.submit(text.as_str());
                }
            }
            sim.poll();
            sim.flush(&mut out).unwrap();
            if inbox.is_empty() && sim.machine.is_settled() && sim.next_tick.is_none() {
                break;
            }
            sim.advance(None);
        }
        // The tip at board X 10 finds the top 0.1 mm up the slope, and
        // half a turn later at X -10 as far down it.
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, "ok\n[PRB:-0.9000:1]\nok\nok\nok\n[PRB:-1.1000:1]\nok\n");
        assert_eq!(sim.state(), report::State::Idle);
    }

    #[test]
    fn answers_are_counted_per_line() {
        assert_eq!(count_answers(b"ok\n"), 1);
        assert_eq!(count_answers(b"ok\nok\nerror:4 out of range\n"), 3);
        assert_eq!(count_answers(b"[MSG:reset]\n[spinny v0.1.0 lines:16 blocks:32]\n"), 0);
        assert_eq!(count_answers(b"<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0|Z:0.000>\n"), 0);
        // A settings listing answers once, after its value lines.
        assert_eq!(count_answers(b"r_steps=256\na_steps=888.889\nok\n"), 1);
    }
}
