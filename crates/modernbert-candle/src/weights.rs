//! Immutable pack references and one reusable, inference-local dense read window.
//! The caller owns the stable address space; this crate never grows or writes it.
use candle_core::Result;
use std::cell::RefCell;

pub type Reader = fn(u64, &mut [u8]) -> Result<()>;
#[derive(Clone, Copy)]
pub struct StableWeight {
    pub offset: u64,
    pub window_offset: u64,
    pub window_length: usize,
    pub reader: Reader,
}
#[derive(Default)]
struct Scratch {
    bytes: Vec<u8>,
    loaded: Option<(Reader, u64, usize)>,
}
thread_local! { static SCRATCH:RefCell<Scratch> = RefCell::new(Scratch::default()); }
impl StableWeight {
    pub fn read_bytes(self, at: u64, bytes: &mut [u8]) -> Result<()> {
        (self.reader)(at, bytes)
    }
    pub fn with_weights(self, length: usize, f: &mut dyn FnMut(&[i8])) -> Result<()> {
        let relative = self
            .offset
            .checked_sub(self.window_offset)
            .ok_or_else(|| candle_core::Error::Msg("invalid weight window".into()))?
            as usize;
        if relative
            .checked_add(length)
            .is_none_or(|end| end > self.window_length)
        {
            return Err(candle_core::Error::Msg("weight outside window".into()));
        }
        SCRATCH.with(|cell| {
            let mut scratch = cell.borrow_mut();
            let hit = scratch.loaded.is_some_and(|(reader, offset, length)| {
                std::ptr::fn_addr_eq(reader, self.reader)
                    && offset == self.window_offset
                    && length == self.window_length
            });
            if !hit {
                // An errored reader may already have overwritten part of this
                // buffer. Invalidate before touching it, including resize.
                scratch.loaded = None;
                // Keep the largest initialized window. Shrinking the length here
                // would zero-fill the same capacity again at the next larger matrix,
                // immediately before stable_read overwrites every byte.
                if scratch.bytes.len() < self.window_length {
                    scratch.bytes.resize(self.window_length, 0);
                }
                self.read_bytes(self.window_offset, &mut scratch.bytes[..self.window_length])?;
                scratch.loaded = Some((self.reader, self.window_offset, self.window_length));
            }
            f(bytemuck::cast_slice(
                &scratch.bytes[relative..relative + length],
            ));
            Ok(())
        })
    }
}
/// Cached windows are shared only within one inference, including update calls.
pub fn begin_forward() {
    SCRATCH.with(|x| x.borrow_mut().loaded = None);
    reset_metrics();
}
pub fn clear_scratch() {
    SCRATCH.with(|x| *x.borrow_mut() = Scratch::default());
}
pub fn scratch_capacity() -> u64 {
    SCRATCH.with(|x| x.borrow().bytes.capacity() as u64)
}

#[derive(Clone, Copy, Default, serde::Serialize)]
pub struct ReadMetrics {
    pub calls: u64,
    pub bytes: u64,
    pub instructions: u64,
    pub heap_peak: u64,
}
#[cfg(feature = "memory-bench")]
thread_local! {static METRICS:RefCell<ReadMetrics> = RefCell::new(ReadMetrics::default());}
pub fn record_read(bytes: u64, instructions: u64) {
    #[cfg(feature = "memory-bench")]
    METRICS.with(|x| {
        let mut m = x.borrow_mut();
        m.calls += 1;
        m.bytes += bytes;
        m.instructions += instructions;
    });
    #[cfg(not(feature = "memory-bench"))]
    let _ = (bytes, instructions);
}
pub fn observe_heap() {
    #[cfg(all(feature = "memory-bench", target_arch = "wasm32"))]
    METRICS.with(|x| {
        let mut m = x.borrow_mut();
        m.heap_peak = m
            .heap_peak
            .max(core::arch::wasm32::memory_size(0) as u64 * 65536);
    });
}
pub fn reset_metrics() {
    #[cfg(feature = "memory-bench")]
    METRICS.with(|x| *x.borrow_mut() = ReadMetrics::default());
}
pub fn metrics() -> ReadMetrics {
    observe_heap();
    #[cfg(feature = "memory-bench")]
    {
        METRICS.with(|x| *x.borrow())
    }
    #[cfg(not(feature = "memory-bench"))]
    {
        ReadMetrics::default()
    }
}

/// Initialize the reusable window during warm-up instead of paying its first
/// zero-fill in every query against a heap snapshot with no committed window.
pub fn prepare_scratch(bytes: usize) {
    SCRATCH.with(|x| {
        let mut s = x.borrow_mut();
        if s.bytes.len() < bytes {
            s.bytes.resize(bytes, 0);
        }
        s.loaded = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ones(_: u64, out: &mut [u8]) -> Result<()> {
        out.fill(1);
        Ok(())
    }
    fn twos(_: u64, out: &mut [u8]) -> Result<()> {
        out.fill(2);
        Ok(())
    }
    fn partial_error(_: u64, out: &mut [u8]) -> Result<()> {
        out[0] = 9;
        Err(candle_core::Error::Msg("read interrupted".into()))
    }
    fn source(at: u64, reader: Reader) -> StableWeight {
        StableWeight {
            offset: at,
            window_offset: at,
            window_length: 4,
            reader,
        }
    }
    #[test]
    fn cache_distinguishes_readers_at_the_same_address() {
        clear_scratch();
        source(0, ones)
            .with_weights(4, &mut |w| assert_eq!(w, &[1; 4]))
            .unwrap();
        source(0, twos)
            .with_weights(4, &mut |w| assert_eq!(w, &[2; 4]))
            .unwrap();
    }
    #[test]
    fn failed_read_cannot_leave_a_previous_window_marked_valid() {
        clear_scratch();
        source(0, ones)
            .with_weights(4, &mut |w| assert_eq!(w, &[1; 4]))
            .unwrap();
        assert!(source(8, partial_error)
            .with_weights(4, &mut |_| panic!("invalid data used"))
            .is_err());
        source(0, ones)
            .with_weights(4, &mut |w| assert_eq!(w, &[1; 4]))
            .unwrap();
    }
}
