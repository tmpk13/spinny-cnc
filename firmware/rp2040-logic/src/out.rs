//! Output ring between the control core and the USB writer, plus the
//! packet framing rule.
//!
//! The core must never block on output, so a full ring drops its oldest
//! bytes and reports how many. The USB writer takes packets of up to
//! `PACKET` bytes; a transfer that ends on a full packet needs a
//! zero-length packet after it or the host keeps the data until more
//! arrives.

/// Bulk endpoint packet size.
pub const PACKET: usize = 64;

pub struct OutRing<const N: usize> {
    buf: [u8; N],
    head: usize,
    len: usize,
}

impl<const N: usize> Default for OutRing<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> OutRing<N> {
    pub const fn new() -> Self {
        OutRing {
            buf: [0; N],
            head: 0,
            len: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }

    /// Appends `bytes`, dropping the oldest bytes when there is no room.
    /// Returns how many bytes were dropped.
    pub fn push(&mut self, bytes: &[u8]) -> usize {
        let excess = bytes.len().saturating_sub(N);
        let bytes = &bytes[excess..];
        let over = (self.len + bytes.len()).saturating_sub(N);
        self.head = (self.head + over) % N;
        self.len -= over;
        for &b in bytes {
            self.buf[(self.head + self.len) % N] = b;
            self.len += 1;
        }
        excess + over
    }

    /// Moves up to `dst.len()` of the oldest bytes out. Returns the count.
    pub fn pop(&mut self, dst: &mut [u8]) -> usize {
        let n = dst.len().min(self.len);
        for (i, slot) in dst[..n].iter_mut().enumerate() {
            *slot = self.buf[(self.head + i) % N];
        }
        self.head = (self.head + n) % N;
        self.len -= n;
        n
    }
}

/// A zero-length packet must follow a packet of `sent` bytes when nothing
/// else is waiting.
pub fn zlp_after(sent: usize, remaining: usize) -> bool {
    sent == PACKET && remaining == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain<const N: usize>(ring: &mut OutRing<N>) -> Vec<u8> {
        let mut out = Vec::new();
        let mut chunk = [0u8; 5];
        loop {
            let n = ring.pop(&mut chunk);
            if n == 0 {
                return out;
            }
            out.extend_from_slice(&chunk[..n]);
        }
    }

    #[test]
    fn bytes_come_out_in_order() {
        let mut ring = OutRing::<8>::new();
        assert!(ring.is_empty());
        assert_eq!(ring.push(b"abc"), 0);
        assert_eq!(ring.push(b"de"), 0);
        assert_eq!(ring.len(), 5);
        assert_eq!(drain(&mut ring), b"abcde");
        assert!(ring.is_empty());
    }

    #[test]
    fn wraps_around_the_end() {
        let mut ring = OutRing::<8>::new();
        ring.push(b"123456");
        let mut sink = [0u8; 4];
        assert_eq!(ring.pop(&mut sink), 4);
        assert_eq!(ring.push(b"7890"), 0);
        assert_eq!(drain(&mut ring), b"567890");
    }

    #[test]
    fn full_ring_drops_the_oldest_and_counts() {
        let mut ring = OutRing::<8>::new();
        ring.push(b"abcdef");
        assert_eq!(ring.push(b"ghij"), 2);
        assert_eq!(ring.len(), 8);
        assert_eq!(drain(&mut ring), b"cdefghij");
    }

    #[test]
    fn oversized_push_keeps_its_tail() {
        let mut ring = OutRing::<4>::new();
        ring.push(b"xy");
        assert_eq!(ring.push(b"abcdefg"), 5);
        assert_eq!(drain(&mut ring), b"defg");
    }

    #[test]
    fn clear_empties() {
        let mut ring = OutRing::<4>::new();
        ring.push(b"abc");
        ring.clear();
        assert!(ring.is_empty());
        ring.push(b"z");
        assert_eq!(drain(&mut ring), b"z");
    }

    #[test]
    fn zlp_only_after_a_full_final_packet() {
        assert!(zlp_after(PACKET, 0));
        assert!(!zlp_after(PACKET, 1));
        assert!(!zlp_after(PACKET - 1, 0));
        assert!(!zlp_after(0, 0));
    }
}
