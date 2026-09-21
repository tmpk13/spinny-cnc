//! The socket in front of the simulation: one client at a time, the same
//! byte stream the board's USB port carries.

use std::io::{self, Read};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

use spinny_fw_logic::line::LineAssembler;

use crate::inbox::Inbox;
use crate::sim::Sim;

pub fn bind(address: &str) -> io::Result<TcpListener> {
    TcpListener::bind(address)
}

/// Serves clients until the listener fails. A client that goes away leaves
/// the machine stopped and holding its position, as unplugging USB does.
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
        let _ = reader.join();
        if !quiet {
            match result {
                Ok(()) => eprintln!("client gone, machine stopped"),
                Err(error) => eprintln!("client dropped: {error}"),
            }
        }
    }
    Ok(())
}

fn read_loop(mut stream: TcpStream, inbox: &Inbox) {
    let mut assembler = LineAssembler::new();
    let mut buf = [0u8; 256];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &byte in &buf[..n] {
                    if let Some(event) = assembler.push(byte) {
                        if inbox.is_closed() {
                            break;
                        }
                        inbox.push(event);
                    }
                }
            }
        }
    }
    inbox.close();
}
