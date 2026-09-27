//! Lemma compatibility confidence.
//!
//! For one (release digest, profile index), how sure can a buyer be that the
//! release's acceptance recipe passes on that profile? The answer is the 90%
//! Wilson lower bound on the pass rate, over:
//!
//! - a prior from the frozen benchmark: the treatment arm's passes and failures,
//!   counted as whole outcomes;
//! - adoption outcomes, each weighted in basis points of a full outcome, whose
//!   weight halves every 30 days, so old evidence ages out.
//!
//! The same crate runs in the Lemma server (compiled to wasm for Node) and in the
//! Stylus contract: the same prior, outcomes (at their block times) and clock give
//! the same number to the wei. Integer fixed point with `WAD = 1e18`, a floor at
//! every step, no floats, allocation or `unsafe`; `vectors.json` pins each rounding.
#![no_std]
#![forbid(unsafe_code)]
#![deny(missing_docs)]

use ruint::aliases::U256;

/// Fixed-point one: every `_wad` value is scaled by 1e18.
pub const WAD: u128 = 1_000_000_000_000_000_000;

/// An outcome's weight halves every 30 days.
pub const HALF_LIFE_SECONDS: u64 = 2_592_000;

/// A full outcome, in basis points.
pub const MAX_WEIGHT_BPS: u16 = 10_000;

/// z for a 90% two-sided interval (the 95th percentile of the standard normal), in WAD.
pub const Z_WAD: u128 = 1_644_853_626_951_472_714;

/// z² in WAD: `floor(Z_WAD * Z_WAD / WAD)`.
pub const Z2_WAD: u128 = 2_705_543_454_095_414_564;

/// Fraction bits of a half-life that `decay` resolves.
pub const FRACTION_BITS: u32 = 32;

/// `DECAY_TABLE[i - 1] = floor(WAD * 2^(-1 / 2^i))` for `i` in `1..=32`, so bit `32 - i`
/// of a 32-bit fraction of a half-life selects entry `i - 1`. Computed at 80 digits
/// two ways (repeated square roots of 1/2 and `exp(-ln 2 / 2^i)`); the tests check that
/// each entry squared lands on the one before it.
pub const DECAY_TABLE: [u128; 32] = [
    707_106_781_186_547_524,
    840_896_415_253_714_543,
    917_004_043_204_671_231,
    957_603_280_698_573_646,
    978_572_062_087_700_134,
    989_228_013_193_975_484,
    994_599_423_483_633_175,
    997_296_056_085_470_126,
    998_647_112_890_970_173,
    999_323_327_502_650_752,
    999_661_606_496_243_683,
    999_830_788_931_929_063,
    999_915_390_886_613_497,
    999_957_694_548_431_132,
    999_978_847_050_491_929,
    999_989_423_469_314_464,
    999_994_711_720_674_283,
    999_997_355_856_841_394,
    999_998_677_927_546_759,
    999_999_338_963_554_895,
    999_999_669_481_722_826,
    999_999_834_740_847_757,
    999_999_917_370_420_465,
    999_999_958_685_209_379,
    999_999_979_342_604_476,
    999_999_989_671_302_184,
    999_999_994_835_651_079,
    999_999_997_417_825_536,
    999_999_998_708_912_767,
    999_999_999_354_456_383,
    999_999_999_677_228_191,
    999_999_999_838_614_095,
];

/// Decayed outcome sums for one (release, profile), valid at time `last`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Stats {
    /// Weighted passes, in WAD, decayed to `last`.
    pub pass_wad: u128,
    /// Weighted failures, in WAD, decayed to `last`.
    pub fail_wad: u128,
    /// Unix seconds the sums are valid at.
    pub last: u64,
}

/// An outcome's weight in basis points of a full outcome: `0..=10_000`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Weight(u16);

impl Weight {
    /// A full outcome.
    pub const FULL: Weight = Weight(MAX_WEIGHT_BPS);

    /// The weight for `bps`, or `None` above a full outcome.
    pub const fn from_bps(bps: u16) -> Option<Weight> {
        if bps <= MAX_WEIGHT_BPS { Some(Weight(bps)) } else { None }
    }

    /// The weight in basis points.
    pub const fn bps(self) -> u16 {
        self.0
    }

    /// The weight in WAD: `bps * WAD / 10_000`, exact because 10_000 divides WAD.
    pub const fn wad(self) -> u128 {
        self.0 as u128 * (WAD / MAX_WEIGHT_BPS as u128)
    }
}

/// `value_wad * 2^(-dt / HALF_LIFE_SECONDS)`, rounded down.
///
/// Whole half-lives shift right (to 0 from 128 on). The remaining fraction is taken
/// to 32 bits, `bits = ((dt % H) << 32) / H`, and each set bit multiplies by its
/// `DECAY_TABLE` entry, most significant bit first, flooring after every multiply.
pub fn decay(value_wad: u128, dt: u64) -> u128 {
    let halvings = dt / HALF_LIFE_SECONDS;
    if halvings >= 128 {
        return 0;
    }
    let mut value = value_wad >> halvings;
    // (dt % H) < 2^22, so the shift stays far below 2^64, and bits < 2^32.
    let bits = ((dt % HALF_LIFE_SECONDS) << FRACTION_BITS) / HALF_LIFE_SECONDS;
    let mut i = 0;
    while i < FRACTION_BITS as usize && value != 0 {
        if bits & (1u64 << (FRACTION_BITS as usize - 1 - i)) != 0 {
            value = mul_div_u128(value, DECAY_TABLE[i], WAD);
        }
        i += 1;
    }
    value
}

/// Adds one outcome at `now`: both sums decay to `now`, then the outcome's weight is
/// added to the pass or the fail sum. A `now` before `last` decays nothing and keeps
/// `last`, so a late record never moves time backwards. Sums saturate at `u128::MAX`
/// (over 10^20 full outcomes).
pub fn record(stats: Stats, passed: bool, weight: Weight, now: u64) -> Stats {
    let dt = now.saturating_sub(stats.last);
    let mut pass_wad = decay(stats.pass_wad, dt);
    let mut fail_wad = decay(stats.fail_wad, dt);
    if passed {
        pass_wad = pass_wad.saturating_add(weight.wad());
    } else {
        fail_wad = fail_wad.saturating_add(weight.wad());
    }
    Stats { pass_wad, fail_wad, last: if now > stats.last { now } else { stats.last } }
}

/// The 90% Wilson lower bound on the pass rate at `now`, in basis points, and the
/// effective sample size in thousandths.
///
/// With `P = prior_passes * WAD + decay(pass)`, `F = prior_failures * WAD + decay(fail)`
/// and `n = P + F` (all WAD), every step floors:
///
/// ```text
/// p      = P * WAD / n
/// z2n    = Z2 * WAD / n                        z² / n
/// denom  = WAD + z2n
/// center = p + z2n / 2
/// inner  = p * (WAD - p) / n + z2n * WAD / n / 4
/// rad    = Z * isqrt(inner * WAD) / WAD
/// lower  = max(center - rad, 0) * WAD / denom
/// ```
///
/// `confidence_bps = lower * 10_000 / WAD` (at most 10_000) and
/// `effective_n_milli = n * 1000 / WAD` (saturating at `u64::MAX`). No data gives `(0, 0)`.
/// Every intermediate fits in 256 bits for any input.
pub fn confidence(prior_passes: u32, prior_failures: u32, stats: Stats, now: u64) -> (u16, u64) {
    let dt = now.saturating_sub(stats.last);
    let wad = U256::from(WAD);
    let passes = U256::from(prior_passes) * wad + U256::from(decay(stats.pass_wad, dt));
    let failures = U256::from(prior_failures) * wad + U256::from(decay(stats.fail_wad, dt));
    let n = passes + failures;
    if n.is_zero() {
        return (0, 0);
    }
    let p = passes * wad / n;
    let z2n = U256::from(Z2_WAD) * wad / n;
    let denom = wad + z2n;
    let center = p + z2n / U256::from(2u8);
    let inner = p * (wad - p) / n + z2n * wad / n / U256::from(4u8);
    let rad = U256::from(Z_WAD) * isqrt(inner * wad) / wad;
    let lower = center.saturating_sub(rad) * wad / denom;
    let bps = lower * U256::from(MAX_WEIGHT_BPS) / wad;
    let confidence_bps = if bps > U256::from(MAX_WEIGHT_BPS) { MAX_WEIGHT_BPS } else { bps.to::<u16>() };
    let n_milli = n * U256::from(1000u16) / wad;
    let effective_n_milli = if n_milli > U256::from(u64::MAX) { u64::MAX } else { n_milli.to::<u64>() };
    (confidence_bps, effective_n_milli)
}

/// `floor(sqrt(x))` by Newton's method from a power of two at or above the root.
pub fn isqrt(x: U256) -> U256 {
    if x.is_zero() {
        return x;
    }
    let mut root = U256::from(1u8) << x.bit_len().div_ceil(2);
    loop {
        // root >= sqrt(x) throughout, so x / root <= root and the sum cannot overflow.
        let next = (root + x / root) >> 1;
        if next >= root {
            return root;
        }
        root = next;
    }
}

/// `a * b / d` rounded down, for `b <= d`, through a 256-bit product.
fn mul_div_u128(a: u128, b: u128, d: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(d)).to::<u128>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z_squared_is_the_floor_of_z_times_z() {
        let z = U256::from(Z_WAD);
        assert_eq!(U256::from(Z2_WAD), z * z / U256::from(WAD));
    }

    #[test]
    fn each_decay_entry_squares_to_the_one_before_it() {
        // floor(sqrt(1/2) * WAD): the first entry is exact against integers.
        let first = DECAY_TABLE[0];
        assert!(first * first <= WAD * WAD / 2 && (first + 1) * (first + 1) > WAD * WAD / 2);
        for i in 1..DECAY_TABLE.len() {
            let squared = mul_div_u128(DECAY_TABLE[i], DECAY_TABLE[i], WAD);
            let before = DECAY_TABLE[i - 1];
            // Floors on both sides leave at most a few wei between them.
            assert!(before.abs_diff(squared) <= 2, "entry {i}: {squared} vs {before}");
        }
    }

    #[test]
    fn decay_halves_per_half_life_and_ends_at_zero() {
        assert_eq!(decay(WAD, 0), WAD);
        assert_eq!(decay(WAD, HALF_LIFE_SECONDS), WAD / 2);
        assert_eq!(decay(WAD, 2 * HALF_LIFE_SECONDS), WAD / 4);
        assert_eq!(decay(WAD, HALF_LIFE_SECONDS / 2), DECAY_TABLE[0]);
        assert_eq!(decay(u128::MAX, 128 * HALF_LIFE_SECONDS), 0);
        assert_eq!(decay(u128::MAX, u64::MAX), 0);
        assert_eq!(decay(0, 12_345), 0);
    }

    #[test]
    fn record_adds_weight_and_never_moves_time_back() {
        let s = record(Stats::default(), true, Weight::FULL, 100);
        assert_eq!(s, Stats { pass_wad: WAD, fail_wad: 0, last: 100 });
        let s = record(s, false, Weight::from_bps(5_000).unwrap(), 50);
        assert_eq!(s, Stats { pass_wad: WAD, fail_wad: WAD / 2, last: 100 });
        assert_eq!(Weight::from_bps(10_001), None);
        assert_eq!(Weight::from_bps(0).map(Weight::wad), Some(0));
    }

    #[test]
    fn no_data_scores_zero_and_certainty_stays_below_one() {
        assert_eq!(confidence(0, 0, Stats::default(), 0), (0, 0));
        let (bps, n) = confidence(u32::MAX, 0, Stats::default(), 0);
        assert!(bps < 10_000 && bps > 9_990, "{bps}");
        assert_eq!(n, u32::MAX as u64 * 1000);
        let (bps, _) = confidence(0, u32::MAX, Stats::default(), 0);
        assert_eq!(bps, 0);
    }

    #[test]
    fn matches_the_textbook_wilson_bound() {
        // (p + z²/2n - z*sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n) in f64:
        // 19 of 20 gives 0.80399..., 3 of 3 gives 0.52580..., 1 of 1 gives 0.26986...
        let (bps, n) = confidence(19, 1, Stats::default(), 0);
        assert_eq!((bps, n), (8_039, 20_000));
        assert_eq!(confidence(3, 0, Stats::default(), 0), (5_258, 3_000));
        assert_eq!(confidence(1, 0, Stats::default(), 0), (2_698, 1_000));
    }

    #[test]
    fn isqrt_edges() {
        assert_eq!(isqrt(U256::ZERO), U256::ZERO);
        assert_eq!(isqrt(U256::from(1u8)), U256::from(1u8));
        assert_eq!(isqrt(U256::from(15u8)), U256::from(3u8));
        assert_eq!(isqrt(U256::from(16u8)), U256::from(4u8));
        let max = isqrt(U256::MAX);
        assert_eq!(max, U256::from(u128::MAX));
    }
}
