//! TMC2209 drivers over the shared single-wire UART on UART1: the
//! configuration writes when a `tmc_*` setting changes and the status
//! report behind `$tmc`. Runs in its own task so the UART round trips
//! never hold up the main loop.

use embassy_executor::Spawner;
use embassy_rp::peripherals::{PIN_8, PIN_9, UART1};
use embassy_rp::uart::{BufferedUart, Config as UartConfig};
use embassy_rp::Peri;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{with_timeout, Duration, Instant};
use embedded_io_async::{Read, ReadReady, Write};
use spinny_core::report;
use spinny_core::settings::Settings;
use spinny_fw_logic::tmc::{
    config_datagrams, parse_reply, read_request, refused_text, report_text, Datagram, DriverConfig, ADDR,
};
use static_cell::StaticCell;
use tmc2209::reg::Address;

use crate::usb::UsbSink;
use crate::Irqs;

pub enum Request {
    Configure(DriverConfig),
    Report,
}

static REQUESTS: Channel<CriticalSectionRawMutex, Request, 4> = Channel::new();

/// The echo of a datagram is back within a byte time; the drivers answer a
/// read within a few. Both wait far longer to ride out interrupt latency.
const ECHO_TIMEOUT: Duration = Duration::from_millis(20);
const REPLY_TIMEOUT: Duration = Duration::from_millis(20);
/// Echoed request plus the reply.
const READ_EXCHANGE_LEN: usize = 12;
/// A driver picks its baud rate from the first datagram it sees, which can
/// cost that datagram, so a refused configuration is tried again.
const CONFIG_TRIES: usize = 2;

pub fn start(spawner: &Spawner, uart: Peri<'static, UART1>, tx: Peri<'static, PIN_8>, rx: Peri<'static, PIN_9>) {
    static TX_BUF: StaticCell<[u8; 64]> = StaticCell::new();
    static RX_BUF: StaticCell<[u8; 128]> = StaticCell::new();
    let mut config = UartConfig::default();
    config.baudrate = 115_200;
    let uart = BufferedUart::new(uart, tx, rx, Irqs, TX_BUF.init([0; 64]), RX_BUF.init([0; 128]), config);
    spawner.spawn(tmc_task(uart).expect("tmc task"));
}

/// Queues a reconfiguration from the current settings.
pub fn configure_from(settings: &Settings) {
    let cfg = DriverConfig {
        ma: settings.tmc_ma,
        hold_pct: settings.tmc_hold_pct,
        micro: settings.tmc_micro,
        stealth: settings.tmc_stealth,
    };
    let _ = REQUESTS.try_send(Request::Configure(cfg));
}

pub fn request_report() {
    let _ = REQUESTS.try_send(Request::Report);
}

#[embassy_executor::task]
async fn tmc_task(mut uart: BufferedUart) {
    loop {
        match REQUESTS.receive().await {
            Request::Configure(cfg) => configure(&mut uart, &cfg).await,
            Request::Report => report(&mut uart).await,
        }
    }
}

/// Writes one axis and checks the driver took it, by the count of write
/// datagrams it has accepted. A driver that answers nothing, or whose
/// count does not move, keeps whatever MS1 and MS2 strap it to, which on
/// this board is 8 microsteps on the radius and 64 on the table: the
/// machine would then move a fraction or a multiple of every distance
/// asked for, so the failure is said out loud rather than left to show up
/// as a wrong-sized board.
async fn apply(uart: &mut BufferedUart, axis: usize, datagrams: &[Datagram]) -> bool {
    let addr = ADDR[axis];
    for _ in 0..CONFIG_TRIES {
        let before = read_register(uart, addr, Address::IFCNT).await;
        for datagram in datagrams {
            write(uart, datagram).await;
        }
        let after = read_register(uart, addr, Address::IFCNT).await;
        if let (Some(before), Some(after)) = (before, after) {
            // The count is eight bits and wraps.
            let written = (after as u8).wrapping_sub(before as u8);
            if written as usize >= datagrams.len() {
                return true;
            }
        }
    }
    false
}

async fn configure(uart: &mut BufferedUart, cfg: &DriverConfig) {
    for axis in 0..ADDR.len() {
        if let Some(datagrams) = config_datagrams(axis, cfg) {
            if !apply(uart, axis, &datagrams).await {
                report::message(refused_text(axis).as_str(), &mut UsbSink);
            }
        }
    }
}

/// Drops bytes left over from an exchange that timed out.
async fn drain(uart: &mut BufferedUart) {
    let mut scratch = [0u8; 16];
    while uart.read_ready().unwrap_or(false) {
        if uart.read(&mut scratch).await.is_err() {
            break;
        }
    }
}

/// Sends a datagram and takes its echo back off the wire.
async fn write(uart: &mut BufferedUart, datagram: &[u8]) {
    drain(uart).await;
    let _ = uart.write_all(datagram).await;
    let _ = uart.flush().await;
    let mut echo = [0u8; 8];
    let _ = with_timeout(ECHO_TIMEOUT, uart.read_exact(&mut echo[..datagram.len()])).await;
}

/// Reads until `buf` is full or `timeout` has passed; returns the count.
async fn read_within(uart: &mut BufferedUart, buf: &mut [u8], timeout: Duration) -> usize {
    let deadline = Instant::now() + timeout;
    let mut n = 0;
    while n < buf.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.as_ticks() == 0 {
            break;
        }
        match with_timeout(left, uart.read(&mut buf[n..])).await {
            Ok(Ok(k)) if k > 0 => n += k,
            _ => break,
        }
    }
    n
}

async fn read_register(uart: &mut BufferedUart, addr: u8, register: Address) -> Option<u32> {
    drain(uart).await;
    let request = read_request(addr, register);
    let _ = uart.write_all(&request).await;
    let _ = uart.flush().await;
    let mut buf = [0u8; READ_EXCHANGE_LEN];
    let n = read_within(uart, &mut buf, REPLY_TIMEOUT).await;
    parse_reply(&buf[..n], register)
}

async fn report(uart: &mut BufferedUart) {
    for (axis, &addr) in ADDR.iter().enumerate() {
        let ifcnt = read_register(uart, addr, Address::IFCNT).await;
        let status = read_register(uart, addr, Address::DRV_STATUS).await;
        let reply = match (ifcnt, status) {
            (Some(ifcnt), Some(status)) => Some((ifcnt as u8, status)),
            _ => None,
        };
        let text = report_text(axis, reply);
        report::message(text.as_str(), &mut UsbSink);
    }
}
