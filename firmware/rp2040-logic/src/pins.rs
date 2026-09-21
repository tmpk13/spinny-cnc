//! Axis bit masks to GPIO masks for the SIO set and clear registers.

/// Splits per-axis levels (bit i = axis i) into the GPIO bits to set and
/// the GPIO bits to clear, given the pin of each axis.
pub fn level_masks(levels: u8, pins: &[u8]) -> (u32, u32) {
    let mut set = 0;
    let mut clr = 0;
    for (axis, &pin) in pins.iter().enumerate() {
        if levels & (1 << axis) != 0 {
            set |= 1 << pin;
        } else {
            clr |= 1 << pin;
        }
    }
    (set, clr)
}

/// GPIO bits of the axes selected in `mask`.
pub fn mask_of(mask: u8, pins: &[u8]) -> u32 {
    pins.iter()
        .enumerate()
        .filter(|(axis, _)| mask & (1 << axis) != 0)
        .map(|(_, &pin)| 1u32 << pin)
        .fold(0, |acc, bit| acc | bit)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PINS: [u8; 2] = [10, 5];

    #[test]
    fn levels_split_into_set_and_clear() {
        assert_eq!(level_masks(0b00, &PINS), (0, 1 << 10 | 1 << 5));
        assert_eq!(level_masks(0b01, &PINS), (1 << 10, 1 << 5));
        assert_eq!(level_masks(0b10, &PINS), (1 << 5, 1 << 10));
        assert_eq!(level_masks(0b11, &PINS), (1 << 10 | 1 << 5, 0));
    }

    #[test]
    fn extra_bits_are_ignored() {
        assert_eq!(level_masks(0xff, &PINS), (1 << 10 | 1 << 5, 0));
        assert_eq!(mask_of(0xfc, &PINS), 0);
    }

    #[test]
    fn mask_selects_pins() {
        assert_eq!(mask_of(0b00, &PINS), 0);
        assert_eq!(mask_of(0b01, &PINS), 1 << 10);
        assert_eq!(mask_of(0b10, &PINS), 1 << 5);
        assert_eq!(mask_of(0b11, &PINS), 1 << 10 | 1 << 5);
    }
}
