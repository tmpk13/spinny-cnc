//! TMC2209 drivers over the shared single-wire UART on UART1: the
//! configuration writes when a `tmc_*` setting changes, a poll that
//! notices a driver losing that configuration with its motor supply, and
//! the status report behind `$tmc`. Runs in its own task so the UART round
//! trips never hold up the main loop, and so the three never interleave on
//! the wire.

use embassy_executor::Spawner;
use embassy_rp::peripherals::{PIN_8, PIN_9, UART1};
use embassy_rp::uart::{BufferedUart, Config as UartConfig};
use embassy_rp::Peri;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_futures::select::{select3, Either3};
use embassy_time::{with_timeout, Duration, Instant, Timer};
use embedded_io_async::{Read, ReadReady, Write};
use spinny_core::report;
use spinny_core::settings::Settings;
use spinny_core::{A, H, R, Z};
use spinny_fw_logic::tmc::{
    config_datagrams, holds_config, lost_text, micro_of, parse_reply, read_request, refused_text, report_text,
    Datagram, DriverConfig, Link, Links, Reply, ADDR, DRIVERS,
};
use static_cell::StaticCell;
use tmc2209::reg::Address;

use crate::usb::UsbSink;
use crate::Irqs;

/// The newest configuration asked for. A burst of `tmc_*` changes, as the
/// settings page sends, keeps only the last snapshot, which is the one the
/// settings hold; a queue would drop the newest once it filled.
static CONFIG: Signal<CriticalSectionRawMutex, DriverConfig> = Signal::new();
/// `$tmc` was asked for.
static REPORT: Signal<CriticalSectionRawMutex, ()> = Signal::new();
/// A driver that held its configuration lost it: its motor supply went,
/// or went and came back.
static POWER_LOST: Signal<CriticalSectionRawMutex, ()> = Signal::new();

/// The echo of a datagram is back within a byte time; the drivers answer a
/// read within a few. Both wait far longer to ride out interrupt latency.
const ECHO_TIMEOUT: Duration = Duration::from_millis(20);
const REPLY_TIMEOUT: Duration = Duration::from_millis(20);
/// Echoed request plus the reply.
const READ_EXCHANGE_LEN: usize = 12;
/// A driver picks its baud rate from the first datagram it sees, which can
/// cost that datagram, so a refused configuration is tried again.
const CONFIG_TRIES: usize = 2;
/// Gap between polls of the configured drivers, which is also the gap
/// between writes of one still waiting for its supply. A driver that comes
/// back from a supply cycle steps at its strap resolution until the next
/// one, so it is short.
const POLL_EVERY: Duration = Duration::from_millis(250);
/// Reads of a silent driver before it counts as unpowered: what a lost
/// reply costs is a stopped job, so one takes more than a glitch.
const POLL_TRIES: usize = 3;

pub fn start(spawner: &Spawner, uart: Peri<'static, UART1>, tx: Peri<'static, PIN_8>, rx: Peri<'static, PIN_9>) {
    static TX_BUF: StaticCell<[u8; 64]> = StaticCell::new();
    static RX_BUF: StaticCell<[u8; 128]> = StaticCell::new();
    let mut config = UartConfig::default();
    config.baudrate = 115_200;
    let uart = BufferedUart::new(uart, tx, rx, Irqs, TX_BUF.init([0; 64]), RX_BUF.init([0; 128]), config);
    spawner.spawn(tmc_task(uart).expect("tmc task"));
}

/// Queues a reconfiguration from the current settings. The axis order is
/// the one `ADDR` and `AXIS_LETTER` use: radius, table, cross slide, focus.
/// The focus driver is left alone without `h_axis`: a board with nothing
/// in the E socket would otherwise report it refused, and retry, forever.
pub fn configure_from(settings: &Settings) {
    let focus_ma = if settings.h_axis { settings.tmc_ma[H] } else { 0 };
    let cfg = DriverConfig {
        ma: [settings.tmc_ma[R], settings.tmc_ma[A], settings.tmc_ma[Z], focus_ma],
        hold_pct: settings.tmc_hold_pct,
        micro: [settings.tmc_micro[R], settings.tmc_micro[A], settings.tmc_micro[Z], settings.tmc_micro[H]],
        stealth: settings.tmc_stealth,
    };
    CONFIG.signal(cfg);
}

pub fn request_report() {
    REPORT.signal(());
}

/// True once after a configured driver lost its configuration with its
/// motor supply. Its motor let go of its position while it was off, and
/// it came back on its MS1 and MS2 straps, which the task is already
/// writing over.
pub fn take_power_lost() -> bool {
    POWER_LOST.try_take().is_some()
}

/// Drivers run from the motor supply, so a board brought up on USB alone
/// cannot configure them. The configuration is kept and each driver that
/// has not taken it is written again at every poll until it does, which is
/// what turning the motor supply on afterwards needs. A driver that took
/// it is polled from then on: switching the supply off and on again resets
/// it to its straps, and nothing else would notice.
///
/// The poll runs after a new configuration as well, before it is written:
/// the write clears the reset flag of a supply cycle since the last poll,
/// and a settings change arriving in that gap would otherwise hide it.
#[embassy_executor::task]
async fn tmc_task(mut uart: BufferedUart) {
    let mut cfg: Option<DriverConfig> = None;
    let mut links = Links::new();
    // A refusal or a loss is on the console, so the landing is said too.
    let mut told = false;
    loop {
        match select3(CONFIG.wait(), REPORT.wait(), Timer::after(POLL_EVERY)).await {
            Either3::First(new) => {
                links.configure(&new);
                cfg = Some(new);
                told = false;
            }
            Either3::Second(()) => report(&mut uart, &links).await,
            Either3::Third(()) => {}
        }
        if poll(&mut uart, &mut links).await {
            POWER_LOST.signal(());
            // The loss was said; refusals while the supply is off would
            // only repeat it.
            told = true;
        }
        if let Some(cfg) = &cfg {
            configure(&mut uart, cfg, &mut links, &mut told).await;
        }
        if links.settled() && told {
            told = false;
            report::message("tmc configured", &mut UsbSink);
        }
    }
}

/// Writes one axis and checks the driver took it, by the count of write
/// datagrams it has accepted and by its flags reading back clear. A driver
/// that answers nothing, or whose count does not move, keeps whatever MS1
/// and MS2 strap it to, which on this board is 8 microsteps on the radius
/// and 64 on the table: the machine would then move a fraction or a
/// multiple of every distance asked for, so the failure is said out loud
/// rather than left to show up as a wrong-sized board.
async fn apply(uart: &mut BufferedUart, axis: usize, datagrams: &[Datagram]) -> bool {
    let addr = ADDR[axis];
    for _ in 0..CONFIG_TRIES {
        // Nothing to count against without a reply, and nobody to write to.
        let Some(before) = read_register(uart, addr, Address::IFCNT).await else {
            continue;
        };
        for datagram in datagrams {
            write(uart, datagram).await;
        }
        let Some(after) = read_register(uart, addr, Address::IFCNT).await else {
            continue;
        };
        // The count is eight bits and wraps.
        let written = (after as u8).wrapping_sub(before as u8);
        if written as usize >= datagrams.len() && holds_config(read_register(uart, addr, Address::GSTAT).await) {
            return true;
        }
    }
    false
}

/// Writes every axis still waiting for its configuration. The first round
/// that fails says so; later rounds retry in silence.
async fn configure(uart: &mut BufferedUart, cfg: &DriverConfig, links: &mut Links, told: &mut bool) {
    let mut refused = false;
    for axis in 0..DRIVERS {
        if links.get(axis) != Link::Pending {
            continue;
        }
        let Some(datagrams) = config_datagrams(axis, cfg) else {
            continue;
        };
        let took = apply(uart, axis, &datagrams).await;
        links.written(axis, took);
        if !took {
            refused = true;
            if !*told {
                report::message(refused_text(axis).as_str(), &mut UsbSink);
            }
        }
    }
    if refused {
        *told = true;
    }
}

/// Reads GSTAT of every driver that holds its configuration, or held the
/// one before the newest. True when one of them has just lost it: no reply
/// after a few tries, which is a driver without its supply, or the reset
/// flag its supply coming back sets.
async fn poll(uart: &mut BufferedUart, links: &mut Links) -> bool {
    let mut lost = false;
    for (axis, &addr) in ADDR.iter().enumerate() {
        if !links.watched(axis) {
            continue;
        }
        let mut gstat = None;
        for _ in 0..POLL_TRIES {
            gstat = read_register(uart, addr, Address::GSTAT).await;
            if gstat.is_some() {
                break;
            }
        }
        if links.polled(axis, gstat) {
            lost = true;
            report::message(lost_text(axis).as_str(), &mut UsbSink);
        }
    }
    lost
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

async fn report(uart: &mut BufferedUart, links: &Links) {
    for (axis, &addr) in ADDR.iter().enumerate() {
        let reply = match read_register(uart, addr, Address::IFCNT).await {
            // A silent driver would only time out on the rest as well.
            None => None,
            Some(ifcnt) => {
                let gconf = read_register(uart, addr, Address::GCONF).await;
                let chopconf = read_register(uart, addr, Address::CHOPCONF).await;
                let ioin = read_register(uart, addr, Address::IOIN).await;
                let status = read_register(uart, addr, Address::DRV_STATUS).await;
                match (gconf, chopconf, ioin, status) {
                    (Some(gconf), Some(chopconf), Some(ioin), Some(status)) => Some(Reply {
                        ifcnt: ifcnt as u8,
                        micro: micro_of(gconf, chopconf, ioin),
                        status,
                    }),
                    _ => None,
                }
            }
        };
        let text = report_text(axis, reply, links.get(axis) != Link::Unused);
        report::message(text.as_str(), &mut UsbSink);
    }
}
