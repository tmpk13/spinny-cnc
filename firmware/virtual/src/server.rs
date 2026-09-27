//! The socket in front of the simulation: one client at a time, the same
//! byte stream the board's USB port carries.

use std::collections::VecDeque;
use std::io::{self, ErrorKind, Read};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use spinny_fw_logic::line::{Event, LineAssembler};

use crate::inbox::Inbox;
use crate::sim::Sim;

/// Bytes a client may send ahead of what the machine has taken before it
/// is dropped: past this it is flooding the socket, not streaming a job.
pub const BACKLOG_CAP: usize = 16 << 20;
/// While lines wait for room: how long a read waits for more bytes, and
/// then how long the reader waits for the loop to take a line, before it
/// looks at the socket again. Together they bound how late a hang up is
/// seen.
const PEEK_WAIT: Duration = Duration::from_millis(1);
const ROOM_WAIT: Duration = Duration::from_millis(10);

pub fn bind(address: &str) -> io::Result<TcpListener> {
    TcpListener::bind(address)
}

/// Serves clients until the listener fails. A client that goes away, by
/// closing its socket or only its sending side, stands for unplugging USB:
/// the machine stops and holds its position.
pub fn serve(listener: TcpListener, sim: &mut Sim, quiet: bool) -> io::Result<()> {
    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(stream) => stream,
            Err(error) => {
                if !quiet {
                    eprintln!("accept failed: {error}");
                }
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        if !quiet {
            match stream.peer_addr() {
                Ok(peer) => eprintln!("client {peer} connected"),
                Err(_) => eprintln!("client connected"),
            }
        }
        let inbox = Arc::new(Inbox::new());
        let reader_inbox = Arc::clone(&inbox);
        let reader_stream = stream.try_clone()?;
        let reader = thread::spawn(move || read_loop(reader_stream, &reader_inbox));
        let mut writer = stream.try_clone()?;
        let result = sim.session(&inbox, &mut writer);
        // Unblock the reader whether the client hung up or the write side
        // failed, then let it finish before the next client.
        inbox.close();
        let _ = stream.shutdown(Shutdown::Both);
        let ending = reader.join().unwrap_or(Ending::Closed);
        if !quiet {
            match (result, ending) {
                (Err(error), _) => eprintln!("client dropped: {error}"),
                (Ok(()), Ending::Flooded) => {
                    eprintln!("client dropped: more than {} MiB ahead of the machine", BACKLOG_CAP >> 20)
                }
                (Ok(()), _) => eprintln!("client gone, machine stopped"),
            }
        }
    }
    Ok(())
}

/// Why the reader stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ending {
    /// The client hung up, or its socket failed.
    HungUp,
    /// The session ended from the loop's side.
    Closed,
    /// The client got too far ahead of the machine.
    Flooded,
}

/// Reads the client until it goes. The socket is read whatever the inbox
/// holds, so a client that hangs up is seen at once, even one that sent
/// more lines than its credits while the machine takes none: its job must
/// not run on after it, and a hold with a line pending would otherwise
/// keep the session, and the machine as it was held, for good. What it
/// sent that the inbox has no room for waits here, in order.
fn read_loop(mut stream: TcpStream, inbox: &Inbox) -> Ending {
    let mut backlog = Backlog::default();
    let mut buf = [0u8; 4096];
    let mut timed = false;
    let ending = loop {
        backlog.feed(inbox);
        if inbox.is_closed() {
            break Ending::Closed;
        }
        // Blocking while nothing waits for room; the shutdown at the end
        // of a session ends such a read.
        let stalled = backlog.is_stalled();
        if stalled != timed && stream.set_read_timeout(stalled.then_some(PEEK_WAIT)).is_ok() {
            timed = stalled;
        }
        match stream.read(&mut buf) {
            Ok(0) => break Ending::HungUp,
            Ok(n) => {
                if backlog.len() + n > BACKLOG_CAP {
                    break Ending::Flooded;
                }
                backlog.extend(&buf[..n]);
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                inbox.wait_for_room(ROOM_WAIT);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => break Ending::HungUp,
        }
    };
    // What is still here goes with the client, as the lines in the inbox
    // do.
    inbox.close();
    ending
}

/// What the client has sent and the inbox has had no room for yet: the
/// line that did not fit, then the bytes behind it.
#[derive(Default)]
struct Backlog {
    assembler: LineAssembler,
    stalled: Option<Event>,
    bytes: VecDeque<u8>,
}

impl Backlog {
    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn is_stalled(&self) -> bool {
        self.stalled.is_some()
    }

    fn extend(&mut self, bytes: &[u8]) {
        self.bytes.extend(bytes);
    }

    /// Moves what fits into the inbox, in order. It stops at the first
    /// line that does not fit, and realtime bytes behind that line wait
    /// with it, as they do on the board.
    fn feed(&mut self, inbox: &Inbox) {
        loop {
            let event = match self.stalled.take() {
                Some(event) => event,
                None => match self.next_event() {
                    Some(event) => event,
                    None => return,
                },
            };
            if let Err(event) = inbox.try_push(event) {
                self.stalled = Some(event);
                return;
            }
        }
    }

    fn next_event(&mut self) -> Option<Event> {
        while let Some(byte) = self.bytes.pop_front() {
            if let Some(event) = self.assembler.push(byte) {
                return Some(event);
            }
        }
        None
    }
}
