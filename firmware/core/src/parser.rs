//! Line and realtime-byte parsing, following docs/PROTOCOL.md.
//!
//! Parsing is pure: no state, no ranges beyond what a single line can
//! check (`F` not above zero, `S` negative). State-dependent checks are
//! the machine's job.

use crate::{A, AXES, LINE_MAX, R};

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
    /// `min_power` is the floor of a dynamic cut's power; unlike `F` and
    /// `S` it is not modal.
    Cut { target: [Option<f32>; AXES], feed: Option<f32>, power: Option<f32>, min_power: Option<f32> },
    /// `absolute` for `jogto`.
    Jog { target: [Option<f32>; AXES], feed: Option<f32>, absolute: bool },
    /// The cross slide on its own; it is never interpolated with `R` or `A`.
    JogZ { target: f32, feed: Option<f32>, absolute: bool },
    Dwell { ms: u32, power: Option<f32> },
    Mode(PowerMode),
    LaserOn { power: f32, ms: Option<u32> },
    LaserOff,
    SetPosition { value: [Option<f32>; AXES] },
    SetSlide { value: f32 },
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

/// Longest `T` a `dwell` takes, ms.
pub const DWELL_MAX_MS: u32 = 600_000;
/// Longest `T` the `laser` command takes, ms.
pub const LASER_MAX_MS: u32 = 60_000;

/// Slowest `F` accepted, units per minute. Below it a move's planned speed
/// would round to nothing and the stepper would wait for a speed that never
/// comes.
pub const MIN_FEED: f32 = 0.001;

/// Longest keyword, bytes.
const KEYWORD_MAX: usize = 8;

/// Parses a plain decimal number: optional sign, digits, optional
/// fraction, no exponent. `None` for anything else, or a value that
/// does not fit an f32.
pub fn number(text: &str) -> Option<f32> {
    let bytes = text.as_bytes();
    let mut at = 0;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        at = 1;
    }
    let int_start = at;
    while at < bytes.len() && bytes[at].is_ascii_digit() {
        at += 1;
    }
    let mut digits = at - int_start;
    if at < bytes.len() && bytes[at] == b'.' {
        at += 1;
        let frac_start = at;
        while at < bytes.len() && bytes[at].is_ascii_digit() {
            at += 1;
        }
        digits += at - frac_start;
    }
    if at != bytes.len() || digits == 0 {
        return None;
    }
    text.parse::<f32>().ok().filter(|v| v.is_finite())
}

/// The letter words one command line may carry.
#[derive(Default)]
struct Words {
    r: Option<f32>,
    a: Option<f32>,
    z: Option<f32>,
    f: Option<f32>,
    s: Option<f32>,
    m: Option<f32>,
    t: Option<f32>,
}

impl Words {
    /// Reads `<letter><number>` tokens; only letters in `allowed` (upper
    /// case) are taken, each at most once.
    fn read<'a>(tokens: impl Iterator<Item = &'a str>, allowed: &[u8]) -> Result<Words, Error> {
        let mut words = Words::default();
        for token in tokens {
            let letter = token.as_bytes()[0];
            if !letter.is_ascii_alphabetic() {
                return Err(Error::BadWord);
            }
            let letter = letter.to_ascii_uppercase();
            if !allowed.contains(&letter) {
                return Err(Error::BadWord);
            }
            let value = number(&token[1..]).ok_or(Error::BadWord)?;
            let slot = match letter {
                b'R' => &mut words.r,
                b'A' => &mut words.a,
                b'Z' => &mut words.z,
                b'F' => &mut words.f,
                b'S' => &mut words.s,
                b'M' => &mut words.m,
                b'T' => &mut words.t,
                _ => return Err(Error::BadWord),
            };
            if slot.is_some() {
                return Err(Error::BadWord);
            }
            *slot = Some(value);
        }
        Ok(words)
    }

    fn target(&self) -> [Option<f32>; AXES] {
        let mut target = [None; AXES];
        target[R] = self.r;
        target[A] = self.a;
        target
    }

    /// At least one axis word.
    fn need_axis(&self) -> Result<(), Error> {
        if self.r.is_none() && self.a.is_none() && self.z.is_none() {
            return Err(Error::MissingWord);
        }
        Ok(())
    }

    /// The cross slide takes a line to itself: it is a separate mechanism
    /// and is never interpolated with the joints.
    fn check_slide_alone(&self) -> Result<(), Error> {
        if self.z.is_some() && (self.r.is_some() || self.a.is_some()) {
            return Err(Error::BadWord);
        }
        Ok(())
    }

    fn check_feed(&self) -> Result<(), Error> {
        if self.f.is_some_and(|f| !(f >= MIN_FEED)) {
            return Err(Error::OutOfRange);
        }
        Ok(())
    }

    fn check_power(&self) -> Result<(), Error> {
        if self.s.is_some_and(|s| s < 0.0) || self.m.is_some_and(|m| m < 0.0) {
            return Err(Error::OutOfRange);
        }
        Ok(())
    }
}

/// A `T` word as whole milliseconds, 0 to `max`; a fraction rounds.
fn millis(t: f32, max: u32) -> Result<u32, Error> {
    if t < 0.0 || t > max as f32 {
        return Err(Error::OutOfRange);
    }
    Ok((t + 0.5) as u32)
}

/// A command that takes no words.
fn bare<'a>(mut tokens: impl Iterator<Item = &'a str>, command: Command<'a>) -> Result<Command<'a>, Error> {
    if tokens.next().is_some() {
        return Err(Error::BadWord);
    }
    Ok(command)
}

/// The text after `$`: a name, `name=value`, one of the actions, or
/// nothing for the full list.
fn setting(rest: &str) -> Result<Command<'_>, Error> {
    let rest = rest.trim();
    if rest.is_empty() {
        return Ok(Command::SettingsList);
    }
    if let Some((name, value)) = rest.split_once('=') {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::UnknownSetting);
        }
        return Ok(Command::SettingSet(name, value.trim()));
    }
    if rest.eq_ignore_ascii_case("save") {
        Ok(Command::SettingsSave)
    } else if rest.eq_ignore_ascii_case("load") {
        Ok(Command::SettingsLoad)
    } else if rest.eq_ignore_ascii_case("defaults") {
        Ok(Command::SettingsDefaults)
    } else if rest.eq_ignore_ascii_case("tmc") {
        Ok(Command::DriverReport)
    } else {
        Ok(Command::SettingGet(rest))
    }
}

/// Parses one line without its newline. Comments after `;` are dropped,
/// keywords and letters are case-insensitive, and words are `<letter><number>`.
/// An empty line, or one that is only a comment, parses as `Command::Empty`
/// and is answered `ok` by the machine.
pub fn parse(line: &str) -> Result<Command<'_>, Error> {
    if line.len() > LINE_MAX - 1 {
        return Err(Error::TooLong);
    }
    let line = match line.find(';') {
        Some(comment) => &line[..comment],
        None => line,
    };
    let line = line.trim();
    if let Some(rest) = line.strip_prefix('$') {
        return setting(rest);
    }
    let mut tokens = line.split_ascii_whitespace();
    let keyword = tokens.next().ok_or(Error::UnknownCommand)?;
    if keyword.len() > KEYWORD_MAX {
        return Err(Error::UnknownCommand);
    }
    let mut lower = [0u8; KEYWORD_MAX];
    for (dst, src) in lower.iter_mut().zip(keyword.bytes()) {
        *dst = src.to_ascii_lowercase();
    }
    match &lower[..keyword.len()] {
        // A negative radius on any move is the far side of the axis. A
        // cutting move goes there to burn a board point from the other
        // direction, where the head's offset from the axis is mirrored;
        // the machine holds it to the soft limit, not to zero.
        b"go" => {
            let words = Words::read(tokens, b"RA")?;
            words.need_axis()?;
            Ok(Command::Go { target: words.target() })
        }
        b"cut" => {
            let words = Words::read(tokens, b"RAFSM")?;
            words.need_axis()?;
            words.check_feed()?;
            words.check_power()?;
            Ok(Command::Cut { target: words.target(), feed: words.f, power: words.s, min_power: words.m })
        }
        key @ (b"jog" | b"jogto") => {
            let absolute = key == b"jogto";
            let words = Words::read(tokens, b"RAZF")?;
            words.need_axis()?;
            words.check_slide_alone()?;
            words.check_feed()?;
            if let Some(target) = words.z {
                // The slide has no zero to stay on the far side of, so an
                // absolute Z is as free as a relative one.
                return Ok(Command::JogZ { target, feed: words.f, absolute });
            }
            // A jog may carry a negative R either way: relative it is a
            // distance, absolute it is the far side of the axis, which is
            // where the head has to go to be lined up with it.
            Ok(Command::Jog { target: words.target(), feed: words.f, absolute })
        }
        b"dwell" => {
            let words = Words::read(tokens, b"TS")?;
            let t = words.t.ok_or(Error::MissingWord)?;
            words.check_power()?;
            Ok(Command::Dwell { ms: millis(t, DWELL_MAX_MS)?, power: words.s })
        }
        b"mode" => {
            let word = tokens.next().ok_or(Error::MissingWord)?;
            if tokens.next().is_some() {
                return Err(Error::BadWord);
            }
            if word.eq_ignore_ascii_case("dyn") {
                Ok(Command::Mode(PowerMode::Dynamic))
            } else if word.eq_ignore_ascii_case("const") {
                Ok(Command::Mode(PowerMode::Constant))
            } else {
                Err(Error::BadWord)
            }
        }
        b"laser" => {
            if tokens.clone().next().is_some_and(|word| word.eq_ignore_ascii_case("off")) {
                tokens.next();
                return bare(tokens, Command::LaserOff);
            }
            let words = Words::read(tokens, b"ST")?;
            let power = words.s.ok_or(Error::MissingWord)?;
            words.check_power()?;
            let ms = match words.t {
                Some(t) => Some(millis(t, LASER_MAX_MS)?),
                None => None,
            };
            Ok(Command::LaserOn { power, ms })
        }
        b"set" => {
            let words = Words::read(tokens, b"RAZ")?;
            words.need_axis()?;
            words.check_slide_alone()?;
            if let Some(value) = words.z {
                return Ok(Command::SetSlide { value });
            }
            // A negative radius declares the head on the far side of the
            // axis, which is the only way to say so while lining up.
            Ok(Command::SetPosition { value: words.target() })
        }
        b"enable" => bare(tokens, Command::Enable(true)),
        b"disable" => bare(tokens, Command::Enable(false)),
        b"unlock" => bare(tokens, Command::Unlock),
        b"version" => bare(tokens, Command::Version),
        b"status" => bare(tokens, Command::Status),
        b"help" => bare(tokens, Command::Help),
        _ => Err(Error::UnknownCommand),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn go(r: Option<f32>, a: Option<f32>) -> Command<'static> {
        Command::Go { target: [r, a] }
    }

    #[test]
    fn realtime_bytes() {
        assert_eq!(realtime(b'?'), Some(Realtime::Status));
        assert_eq!(realtime(b'!'), Some(Realtime::Hold));
        assert_eq!(realtime(b'~'), Some(Realtime::Resume));
        assert_eq!(realtime(0x18), Some(Realtime::Reset));
        assert_eq!(realtime(0x85), Some(Realtime::JogCancel));
        assert_eq!(realtime(b'g'), None);
        assert_eq!(realtime(b'\n'), None);
    }

    #[test]
    fn error_codes_and_texts() {
        let all = [
            (Error::UnknownCommand, 1, "unknown command"),
            (Error::BadWord, 2, "bad word"),
            (Error::MissingWord, 3, "missing word"),
            (Error::OutOfRange, 4, "out of range"),
            (Error::State, 5, "not now"),
            (Error::UnknownSetting, 6, "unknown setting"),
            (Error::BadSettingValue, 7, "bad setting value"),
            (Error::TooLong, 8, "line too long"),
            (Error::Flash, 9, "flash failed"),
        ];
        for (error, code, text) in all {
            assert_eq!(error.code(), code);
            assert_eq!(error.text(), text);
        }
    }

    #[test]
    fn number_grammar() {
        assert_eq!(number("12"), Some(12.0));
        assert_eq!(number("-90"), Some(-90.0));
        assert_eq!(number("+3.5"), Some(3.5));
        assert_eq!(number("12.5"), Some(12.5));
        assert_eq!(number("5."), Some(5.0));
        assert_eq!(number(".5"), Some(0.5));
        assert_eq!(number("-.25"), Some(-0.25));
        assert_eq!(number("0"), Some(0.0));
        assert_eq!(number("888.889"), Some(888.889));
        assert_eq!(number(""), None);
        assert_eq!(number("-"), None);
        assert_eq!(number("."), None);
        assert_eq!(number("+"), None);
        assert_eq!(number("1e3"), None);
        assert_eq!(number("1E3"), None);
        assert_eq!(number("1.2.3"), None);
        assert_eq!(number("12a"), None);
        assert_eq!(number(" 12"), None);
        assert_eq!(number("12 "), None);
        assert_eq!(number("nan"), None);
        assert_eq!(number("inf"), None);
        assert_eq!(number("0x10"), None);
        assert_eq!(number("1_000"), None);
        assert_eq!(number("999999999999999999999999999999999999999999"), None);
    }

    #[test]
    fn go_forms() {
        assert_eq!(parse("go R10"), Ok(go(Some(10.0), None)));
        assert_eq!(parse("go A90"), Ok(go(None, Some(90.0))));
        assert_eq!(parse("go R0 A0"), Ok(go(Some(0.0), Some(0.0))));
        assert_eq!(parse("GO r10 a-90"), Ok(go(Some(10.0), Some(-90.0))));
        assert_eq!(parse("go A-720.5 R12.25"), Ok(go(Some(12.25), Some(-720.5))));
        assert_eq!(parse("  go   R10  "), Ok(go(Some(10.0), None)));
        assert_eq!(parse("go R10 ; to ten"), Ok(go(Some(10.0), None)));
        assert_eq!(parse("go R10\r"), Ok(go(Some(10.0), None)));
        assert_eq!(parse("go\tR10"), Ok(go(Some(10.0), None)));
        assert_eq!(parse("go R+5"), Ok(go(Some(5.0), None)));
        assert_eq!(parse("go R-0"), Ok(go(Some(-0.0), None)));
        // The far side of the axis is a place like any other.
        assert_eq!(parse("go R-1"), Ok(go(Some(-1.0), None)));
        assert_eq!(parse("go R-0.001 A5"), Ok(go(Some(-0.001), Some(5.0))));
    }

    #[test]
    fn go_errors() {
        assert_eq!(parse("go"), Err(Error::MissingWord));
        assert_eq!(parse("go ; nothing"), Err(Error::MissingWord));
        assert_eq!(parse("go F100"), Err(Error::BadWord));
        assert_eq!(parse("go R10 S5"), Err(Error::BadWord));
        assert_eq!(parse("go R10 R20"), Err(Error::BadWord));
        assert_eq!(parse("go R"), Err(Error::BadWord));
        assert_eq!(parse("go R1e3"), Err(Error::BadWord));
        assert_eq!(parse("go R1.2.3"), Err(Error::BadWord));
        assert_eq!(parse("go 10"), Err(Error::BadWord));
        assert_eq!(parse("go R10 junk"), Err(Error::BadWord));
        assert_eq!(parse("go R10 -"), Err(Error::BadWord));
        assert_eq!(parse("go X10"), Err(Error::BadWord));
        assert_eq!(parse("go R 10"), Err(Error::BadWord));
        assert_eq!(parse("go R10A5"), Err(Error::BadWord));
        assert_eq!(parse("go R\u{e9}5"), Err(Error::BadWord));
        assert_eq!(parse("go \u{e9}5"), Err(Error::BadWord));
    }

    #[test]
    fn cut_forms() {
        assert_eq!(
            parse("cut A90 F300 S400"),
            Ok(Command::Cut { target: [None, Some(90.0)], feed: Some(300.0), power: Some(400.0), min_power: None })
        );
        assert_eq!(parse("cut A180"), Ok(Command::Cut { target: [None, Some(180.0)], feed: None, power: None, min_power: None }));
        assert_eq!(
            parse("CUT s0 f0.5 r1.5 a-2"),
            Ok(Command::Cut { target: [Some(1.5), Some(-2.0)], feed: Some(0.5), power: Some(0.0), min_power: None })
        );
        // A cut on the far side of the axis: the same board point half a
        // turn away, reached with the head's offset mirrored.
        assert_eq!(
            parse("cut R-1 A90"),
            Ok(Command::Cut { target: [Some(-1.0), Some(90.0)], feed: None, power: None, min_power: None })
        );
        assert_eq!(
            parse("cut R2 F300 S400 M120"),
            Ok(Command::Cut { target: [Some(2.0), None], feed: Some(300.0), power: Some(400.0), min_power: Some(120.0) })
        );
        assert_eq!(parse("cut R2 M-1"), Err(Error::OutOfRange));
        assert_eq!(parse("cut R2 M1 M2"), Err(Error::BadWord));
        // The floor is a cut word only.
        assert_eq!(parse("go R2 M1"), Err(Error::BadWord));
        assert_eq!(parse("dwell T10 M1"), Err(Error::BadWord));
    }

    #[test]
    fn cut_errors() {
        assert_eq!(parse("cut"), Err(Error::MissingWord));
        assert_eq!(parse("cut F300 S400"), Err(Error::MissingWord));
        assert_eq!(parse("cut A90 F0"), Err(Error::OutOfRange));
        assert_eq!(parse("cut A90 F-5"), Err(Error::OutOfRange));
        assert_eq!(parse("cut A90 S-1"), Err(Error::OutOfRange));
        assert_eq!(parse("cut A90 T5"), Err(Error::BadWord));
        assert_eq!(parse("cut A90 F300 F300"), Err(Error::BadWord));
        assert_eq!(parse("cut A90 Fx"), Err(Error::BadWord));
    }

    #[test]
    fn jog_forms() {
        assert_eq!(parse("jog R-5"), Ok(Command::Jog { target: [Some(-5.0), None], feed: None, absolute: false }));
        assert_eq!(
            parse("jog A10 F100"),
            Ok(Command::Jog { target: [None, Some(10.0)], feed: Some(100.0), absolute: false })
        );
        assert_eq!(
            parse("jogto R20 A-30"),
            Ok(Command::Jog { target: [Some(20.0), Some(-30.0)], feed: None, absolute: true })
        );
        assert_eq!(
            parse("JOGTO r0 f50"),
            Ok(Command::Jog { target: [Some(0.0), None], feed: Some(50.0), absolute: true })
        );
    }

    #[test]
    fn jog_errors() {
        assert_eq!(parse("jog"), Err(Error::MissingWord));
        assert_eq!(parse("jog F100"), Err(Error::MissingWord));
        assert_eq!(parse("jogto"), Err(Error::MissingWord));
        assert_eq!(parse("jogto F100"), Err(Error::MissingWord));
        // A jog may be sent past the axis: that is how the head is lined
        // up with it. A cutting move may go there too, to burn a board
        // point from the far side.
        assert_eq!(
            parse("jogto R-1"),
            Ok(Command::Jog { target: [Some(-1.0), None], feed: None, absolute: true })
        );
        assert_eq!(parse("go R-1"), Ok(go(Some(-1.0), None)));
        assert_eq!(
            parse("cut R-1 F60"),
            Ok(Command::Cut { target: [Some(-1.0), None], feed: Some(60.0), power: None, min_power: None })
        );
        assert_eq!(parse("jog R5 F0"), Err(Error::OutOfRange));
        assert_eq!(parse("jogto A5 F-1"), Err(Error::OutOfRange));
        assert_eq!(parse("jog R5 S1"), Err(Error::BadWord));
        assert_eq!(parse("jog R5 R6"), Err(Error::BadWord));
        assert_eq!(parse("jog R5 T6"), Err(Error::BadWord));
    }

    #[test]
    fn slide_jog_forms() {
        assert_eq!(parse("jog Z1"), Ok(Command::JogZ { target: 1.0, feed: None, absolute: false }));
        assert_eq!(parse("jog Z-0.5"), Ok(Command::JogZ { target: -0.5, feed: None, absolute: false }));
        assert_eq!(
            parse("jog Z2 F60"),
            Ok(Command::JogZ { target: 2.0, feed: Some(60.0), absolute: false })
        );
        assert_eq!(parse("jogto Z0"), Ok(Command::JogZ { target: 0.0, feed: None, absolute: true }));
        // The slide crosses the rotation axis, so an absolute Z may be
        // negative where an absolute R may not.
        assert_eq!(
            parse("JOGTO z-3.25 f120"),
            Ok(Command::JogZ { target: -3.25, feed: Some(120.0), absolute: true })
        );
        assert_eq!(parse("set Z0"), Ok(Command::SetSlide { value: 0.0 }));
        assert_eq!(parse("SET z-1.5 ; found it"), Ok(Command::SetSlide { value: -1.5 }));
    }

    #[test]
    fn the_slide_is_never_on_a_line_with_r_or_a() {
        for line in [
            "jog Z1 R1",
            "jog R1 Z1",
            "jog Z1 A90",
            "jogto Z1 R2 A3",
            "set Z0 R0",
            "set R0 A0 Z0",
        ] {
            assert_eq!(parse(line), Err(Error::BadWord), "{line}");
        }
        // Everything else a Z line can get wrong answers as it did before.
        assert_eq!(parse("jog Z1 Z2"), Err(Error::BadWord));
        assert_eq!(parse("jog Z1 S100"), Err(Error::BadWord));
        assert_eq!(parse("jog Z"), Err(Error::BadWord));
        assert_eq!(parse("jog Z1 F0"), Err(Error::OutOfRange));
        assert_eq!(parse("go Z1"), Err(Error::BadWord));
        assert_eq!(parse("cut Z1 F100"), Err(Error::BadWord));
        assert_eq!(parse("dwell T10 Z1"), Err(Error::BadWord));
        assert_eq!(parse("laser S100 Z1"), Err(Error::BadWord));
    }

    #[test]
    fn dwell_forms() {
        assert_eq!(parse("dwell T250"), Ok(Command::Dwell { ms: 250, power: None }));
        assert_eq!(parse("dwell T0"), Ok(Command::Dwell { ms: 0, power: None }));
        assert_eq!(parse("dwell S300 T1000"), Ok(Command::Dwell { ms: 1000, power: Some(300.0) }));
        assert_eq!(parse("DWELL t600000"), Ok(Command::Dwell { ms: 600_000, power: None }));
        assert_eq!(parse("dwell T2.5"), Ok(Command::Dwell { ms: 3, power: None }));
        assert_eq!(parse("dwell T2.4"), Ok(Command::Dwell { ms: 2, power: None }));
    }

    #[test]
    fn dwell_errors() {
        assert_eq!(parse("dwell"), Err(Error::MissingWord));
        assert_eq!(parse("dwell S5"), Err(Error::MissingWord));
        assert_eq!(parse("dwell T600001"), Err(Error::OutOfRange));
        assert_eq!(parse("dwell T-1"), Err(Error::OutOfRange));
        assert_eq!(parse("dwell T100 S-1"), Err(Error::OutOfRange));
        assert_eq!(parse("dwell T100 R1"), Err(Error::BadWord));
        assert_eq!(parse("dwell T100 T100"), Err(Error::BadWord));
        assert_eq!(parse("dwell T"), Err(Error::BadWord));
    }

    #[test]
    fn mode_forms() {
        assert_eq!(parse("mode dyn"), Ok(Command::Mode(PowerMode::Dynamic)));
        assert_eq!(parse("mode const"), Ok(Command::Mode(PowerMode::Constant)));
        assert_eq!(parse("MODE Const"), Ok(Command::Mode(PowerMode::Constant)));
        assert_eq!(parse("mode DYN ; back"), Ok(Command::Mode(PowerMode::Dynamic)));
        assert_eq!(parse("mode"), Err(Error::MissingWord));
        assert_eq!(parse("mode fast"), Err(Error::BadWord));
        assert_eq!(parse("mode S1"), Err(Error::BadWord));
        assert_eq!(parse("mode dyn const"), Err(Error::BadWord));
    }

    #[test]
    fn laser_forms() {
        assert_eq!(parse("laser S500"), Ok(Command::LaserOn { power: 500.0, ms: None }));
        assert_eq!(parse("laser S500 T2000"), Ok(Command::LaserOn { power: 500.0, ms: Some(2000) }));
        assert_eq!(parse("laser T60000 S1"), Ok(Command::LaserOn { power: 1.0, ms: Some(60_000) }));
        assert_eq!(parse("laser S0"), Ok(Command::LaserOn { power: 0.0, ms: None }));
        assert_eq!(parse("laser S12.5 T0"), Ok(Command::LaserOn { power: 12.5, ms: Some(0) }));
        assert_eq!(parse("laser off"), Ok(Command::LaserOff));
        assert_eq!(parse("LASER OFF"), Ok(Command::LaserOff));
        assert_eq!(parse("laser off ; done"), Ok(Command::LaserOff));
    }

    #[test]
    fn laser_errors() {
        assert_eq!(parse("laser"), Err(Error::MissingWord));
        assert_eq!(parse("laser T500"), Err(Error::MissingWord));
        assert_eq!(parse("laser S-1"), Err(Error::OutOfRange));
        assert_eq!(parse("laser S100 T60001"), Err(Error::OutOfRange));
        assert_eq!(parse("laser S100 T-1"), Err(Error::OutOfRange));
        assert_eq!(parse("laser off S100"), Err(Error::BadWord));
        assert_eq!(parse("laser S100 off"), Err(Error::BadWord));
        assert_eq!(parse("laser on"), Err(Error::BadWord));
        assert_eq!(parse("laser S100 R1"), Err(Error::BadWord));
        assert_eq!(parse("laser S100 S100"), Err(Error::BadWord));
    }

    #[test]
    fn set_forms() {
        assert_eq!(parse("set R0"), Ok(Command::SetPosition { value: [Some(0.0), None] }));
        assert_eq!(parse("set R0 A0"), Ok(Command::SetPosition { value: [Some(0.0), Some(0.0)] }));
        assert_eq!(parse("SET a-90"), Ok(Command::SetPosition { value: [None, Some(-90.0)] }));
        assert_eq!(parse("set"), Err(Error::MissingWord));
        // The head can be parked past the axis, so it can be declared there.
        assert_eq!(parse("set R-1"), Ok(Command::SetPosition { value: [Some(-1.0), None] }));
        assert_eq!(parse("set F1"), Err(Error::BadWord));
        assert_eq!(parse("set R1 A2 A3"), Err(Error::BadWord));
    }

    #[test]
    fn bare_commands() {
        assert_eq!(parse("enable"), Ok(Command::Enable(true)));
        assert_eq!(parse("disable"), Ok(Command::Enable(false)));
        assert_eq!(parse("unlock"), Ok(Command::Unlock));
        assert_eq!(parse("version"), Ok(Command::Version));
        assert_eq!(parse("status"), Ok(Command::Status));
        assert_eq!(parse("help"), Ok(Command::Help));
        assert_eq!(parse("ENABLE"), Ok(Command::Enable(true)));
        assert_eq!(parse(" help ; me"), Ok(Command::Help));
        assert_eq!(parse("enable R1"), Err(Error::BadWord));
        assert_eq!(parse("disable now"), Err(Error::BadWord));
        assert_eq!(parse("unlock 1"), Err(Error::BadWord));
        assert_eq!(parse("version 2"), Err(Error::BadWord));
        assert_eq!(parse("status ?"), Err(Error::BadWord));
        assert_eq!(parse("help me"), Err(Error::BadWord));
    }

    #[test]
    fn unknown_commands() {
        assert_eq!(parse("frobnicate"), Err(Error::UnknownCommand));
        assert_eq!(parse("G0 X1"), Err(Error::UnknownCommand));
        assert_eq!(parse("goR10"), Err(Error::UnknownCommand));
        assert_eq!(parse("gos R10"), Err(Error::UnknownCommand));
        assert_eq!(parse("jogt R10"), Err(Error::UnknownCommand));
        assert_eq!(parse("abcdefghijk"), Err(Error::UnknownCommand));
        assert_eq!(parse(""), Err(Error::UnknownCommand));
        assert_eq!(parse("   "), Err(Error::UnknownCommand));
        assert_eq!(parse("; only a comment"), Err(Error::UnknownCommand));
        assert_eq!(parse("?"), Err(Error::UnknownCommand));
    }

    #[test]
    fn line_length_is_checked_first() {
        let mut long = heapless::String::<128>::new();
        long.push_str("go R10").unwrap();
        while long.len() < LINE_MAX - 1 {
            long.push(' ').unwrap();
        }
        assert_eq!(long.len(), 95);
        assert_eq!(parse(&long), Ok(go(Some(10.0), None)));
        long.push(' ').unwrap();
        assert_eq!(long.len(), 96);
        assert_eq!(parse(&long), Err(Error::TooLong));

        let mut comment = heapless::String::<128>::new();
        comment.push_str("go R10 ;").unwrap();
        while comment.len() < LINE_MAX {
            comment.push('x').unwrap();
        }
        assert_eq!(parse(&comment), Err(Error::TooLong));
    }

    #[test]
    fn settings_forms() {
        assert_eq!(parse("$"), Ok(Command::SettingsList));
        assert_eq!(parse("$ "), Ok(Command::SettingsList));
        assert_eq!(parse("$ ; list"), Ok(Command::SettingsList));
        assert_eq!(parse("$r_max"), Ok(Command::SettingGet("r_max")));
        assert_eq!(parse("$ R_MAX "), Ok(Command::SettingGet("R_MAX")));
        assert_eq!(parse("$r_max=12.5"), Ok(Command::SettingSet("r_max", "12.5")));
        assert_eq!(parse("$ r_max = 12.5 "), Ok(Command::SettingSet("r_max", "12.5")));
        assert_eq!(parse("$r_max=12.5 ; limit"), Ok(Command::SettingSet("r_max", "12.5")));
        assert_eq!(parse("$r_max="), Ok(Command::SettingSet("r_max", "")));
        assert_eq!(parse("$a=b=c"), Ok(Command::SettingSet("a", "b=c")));
        assert_eq!(parse("$save"), Ok(Command::SettingsSave));
        assert_eq!(parse("$SAVE"), Ok(Command::SettingsSave));
        assert_eq!(parse("$load"), Ok(Command::SettingsLoad));
        assert_eq!(parse("$defaults"), Ok(Command::SettingsDefaults));
        assert_eq!(parse("$tmc"), Ok(Command::DriverReport));
        assert_eq!(parse("$ tmc"), Ok(Command::DriverReport));
        assert_eq!(parse("$nope"), Ok(Command::SettingGet("nope")));
        assert_eq!(parse("$save=1"), Ok(Command::SettingSet("save", "1")));
        assert_eq!(parse("$=5"), Err(Error::UnknownSetting));
        assert_eq!(parse("$ = 5"), Err(Error::UnknownSetting));
    }

    #[test]
    fn setting_slices_borrow_the_line() {
        let line: heapless::String<32> = "$laser_hz=20000".parse().unwrap();
        let command = parse(&line).unwrap();
        match command {
            Command::SettingSet(name, value) => {
                assert!(core::ptr::eq(name.as_ptr(), line.as_ptr().wrapping_add(1)));
                assert_eq!(value, "20000");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
