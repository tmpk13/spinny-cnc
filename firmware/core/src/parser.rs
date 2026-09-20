//! Line and realtime-byte parsing, following docs/PROTOCOL.md.
//!
//! Parsing is pure: no state, no ranges beyond what a single line can
//! check (`R` under 0, `S` negative). State-dependent checks are the
//! machine's job.

use crate::AXES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerMode {
    Dynamic,
    Constant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Realtime {
    Status,
    Hold,
    Resume,
    Reset,
    JogCancel,
}

/// Byte to realtime action. `None` for an ordinary byte.
pub fn realtime(byte: u8) -> Option<Realtime> {
    match byte {
        b'?' => Some(Realtime::Status),
        b'!' => Some(Realtime::Hold),
        b'~' => Some(Realtime::Resume),
        0x18 => Some(Realtime::Reset),
        0x85 => Some(Realtime::JogCancel),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Command<'a> {
    Go { target: [Option<f32>; AXES] },
    Cut { target: [Option<f32>; AXES], feed: Option<f32>, power: Option<f32> },
    /// `absolute` for `jogto`.
    Jog { target: [Option<f32>; AXES], feed: Option<f32>, absolute: bool },
    Dwell { ms: u32, power: Option<f32> },
    Mode(PowerMode),
    LaserOn { power: f32, ms: Option<u32> },
    LaserOff,
    SetPosition { value: [Option<f32>; AXES] },
    Enable(bool),
    Unlock,
    Version,
    Status,
    Help,
    SettingsList,
    SettingGet(&'a str),
    SettingSet(&'a str, &'a str),
    SettingsSave,
    SettingsLoad,
    SettingsDefaults,
    DriverReport,
}

/// Protocol error codes; `code()` is the number after `error:`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    UnknownCommand,
    BadWord,
    MissingWord,
    OutOfRange,
    State,
    UnknownSetting,
    BadSettingValue,
    TooLong,
    Flash,
}

impl Error {
    pub fn code(self) -> u8 {
        match self {
            Error::UnknownCommand => 1,
            Error::BadWord => 2,
            Error::MissingWord => 3,
            Error::OutOfRange => 4,
            Error::State => 5,
            Error::UnknownSetting => 6,
            Error::BadSettingValue => 7,
            Error::TooLong => 8,
            Error::Flash => 9,
        }
    }

    pub fn text(self) -> &'static str {
        match self {
            Error::UnknownCommand => "unknown command",
            Error::BadWord => "bad word",
            Error::MissingWord => "missing word",
            Error::OutOfRange => "out of range",
            Error::State => "not now",
            Error::UnknownSetting => "unknown setting",
            Error::BadSettingValue => "bad setting value",
            Error::TooLong => "line too long",
            Error::Flash => "flash failed",
        }
    }
}

/// Parses one line without its newline. Comments after `;` are dropped,
/// keywords and letters are case-insensitive, and words are `<letter><number>`.
pub fn parse(line: &str) -> Result<Command<'_>, Error> {
    let _ = line;
    unimplemented!("parser::parse")
}
