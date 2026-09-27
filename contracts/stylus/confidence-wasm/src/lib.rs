//! `lemma-confidence` as a wasm module for Node (`packages/confidence`).
//!
//! Exports take and return plain integers only: a `u128` travels as two `u64`
//! halves (low, high), results that do not fit one return value are read back with
//! `lc_out(i)`, and every call returns a status (`OK` or `INVALID`). No WASI, no
//! allocator, no imports; a panic traps. Built by `npm run confidence:wasm`.
#![cfg_attr(target_arch = "wasm32", no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

use core::sync::atomic::{AtomicU64, Ordering};

use lemma_confidence::{Stats, Weight};

/// The call succeeded; its results are in `lc_out`.
pub const OK: u32 = 0;
/// An argument was out of range (a weight above 10 000 bps, or `passed` not 0 or 1); `lc_out` is unchanged.
pub const INVALID: u32 = 1;

/// Bumped whenever an export's signature or meaning changes.
pub const ABI_VERSION: u32 = 1;

const OUT_LEN: usize = 5;

// Single-threaded wasm: relaxed atomics compile to plain loads and stores and need no `unsafe`.
static OUT: [AtomicU64; OUT_LEN] = [const { AtomicU64::new(0) }; OUT_LEN];

fn put(values: &[u64]) {
    for (slot, value) in OUT.iter().zip(values) {
        slot.store(*value, Ordering::Relaxed);
    }
}

fn join(lo: u64, hi: u64) -> u128 {
    (u128::from(hi) << 64) | u128::from(lo)
}

fn split(value: u128) -> (u64, u64) {
    (value as u64, (value >> 64) as u64)
}

/// The export ABI version (`ABI_VERSION`).
#[unsafe(no_mangle)]
pub extern "C" fn lc_abi_version() -> u32 {
    ABI_VERSION
}

/// Result slot `index` of the last successful call, or 0 past the end.
#[unsafe(no_mangle)]
pub extern "C" fn lc_out(index: u32) -> u64 {
    OUT.get(index as usize).map_or(0, |slot| slot.load(Ordering::Relaxed))
}

/// `decay(value, dt)`. Out: 0 value low, 1 value high.
#[unsafe(no_mangle)]
pub extern "C" fn lc_decay(value_lo: u64, value_hi: u64, dt: u64) -> u32 {
    let (lo, hi) = split(lemma_confidence::decay(join(value_lo, value_hi), dt));
    put(&[lo, hi]);
    OK
}

/// `record(stats, passed, weight, now)`. Out: 0 pass low, 1 pass high, 2 fail low, 3 fail high, 4 last.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn lc_record(
    pass_lo: u64,
    pass_hi: u64,
    fail_lo: u64,
    fail_hi: u64,
    last: u64,
    passed: u32,
    weight_bps: u32,
    now: u64,
) -> u32 {
    let passed = match passed {
        0 => false,
        1 => true,
        _ => return INVALID,
    };
    let Some(weight) = u16::try_from(weight_bps).ok().and_then(Weight::from_bps) else {
        return INVALID;
    };
    let stats = Stats { pass_wad: join(pass_lo, pass_hi), fail_wad: join(fail_lo, fail_hi), last };
    let next = lemma_confidence::record(stats, passed, weight, now);
    let (pass_lo, pass_hi) = split(next.pass_wad);
    let (fail_lo, fail_hi) = split(next.fail_wad);
    put(&[pass_lo, pass_hi, fail_lo, fail_hi, next.last]);
    OK
}

/// `confidence(prior_passes, prior_failures, stats, now)`. Out: 0 confidence bps, 1 effective n in thousandths.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn lc_confidence(
    prior_passes: u32,
    prior_failures: u32,
    pass_lo: u64,
    pass_hi: u64,
    fail_lo: u64,
    fail_hi: u64,
    last: u64,
    now: u64,
) -> u32 {
    let stats = Stats { pass_wad: join(pass_lo, pass_hi), fail_wad: join(fail_lo, fail_hi), last };
    let (bps, n_milli) = lemma_confidence::confidence(prior_passes, prior_failures, stats, now);
    put(&[u64::from(bps), n_milli]);
    OK
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lemma_confidence::WAD;

    fn out(n: u32) -> Vec<u64> {
        (0..n).map(|i| lc_out(i)).collect()
    }

    #[test]
    fn halves_round_trip() {
        for value in [0, 1, u64::MAX as u128, u64::MAX as u128 + 1, u128::MAX, WAD * 12_345] {
            let (lo, hi) = split(value);
            assert_eq!(join(lo, hi), value);
        }
    }

    // One test touches the shared result slots, so parallel tests cannot interleave.
    #[test]
    fn exports_match_the_library_and_refuse_bad_arguments() {
        assert_eq!(lc_abi_version(), ABI_VERSION);

        let big = u128::MAX - 7;
        assert_eq!(lc_decay(big as u64, (big >> 64) as u64, 1_000_000), OK);
        assert_eq!(join(lc_out(0), lc_out(1)), lemma_confidence::decay(big, 1_000_000));

        assert_eq!(lc_record(0, 0, 0, 0, 0, 1, 10_000, 100), OK);
        assert_eq!(out(5), vec![WAD as u64, 0, 0, 0, 100]);
        let (lo, hi) = split(WAD * 3);
        assert_eq!(lc_record(lo, hi, 0, 0, 100, 0, 2_500, 100 + 2_592_000), OK);
        assert_eq!(out(5), vec![(WAD * 3 / 2) as u64, 0, (WAD / 4) as u64, 0, 100 + 2_592_000]);

        assert_eq!(lc_record(0, 0, 0, 0, 0, 2, 10_000, 1), INVALID);
        assert_eq!(lc_record(0, 0, 0, 0, 0, 1, 10_001, 1), INVALID);
        assert_eq!(lc_record(0, 0, 0, 0, 0, 1, 65_536 + 1, 1), INVALID);
        assert_eq!(out(5), vec![(WAD * 3 / 2) as u64, 0, (WAD / 4) as u64, 0, 100 + 2_592_000], "a refused call leaves the slots");

        assert_eq!(lc_confidence(19, 1, 0, 0, 0, 0, 0, 0), OK);
        assert_eq!(out(2), vec![8_039, 20_000]);
        assert_eq!(lc_out(OUT_LEN as u32), 0);
    }
}
