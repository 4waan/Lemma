//! Invariants over the whole input domain (proptest), not hand-picked cases.

use lemma_confidence::{HALF_LIFE_SECONDS, MAX_WEIGHT_BPS, Stats, WAD, Weight, Z_WAD, Z2_WAD, confidence, decay, isqrt, record};
use proptest::prelude::*;
use ruint::aliases::U256;

/// `confidence` again with every operation checked: it panics if any intermediate
/// would leave 256 bits, which `confidence` itself (wrapping ruint operators) would hide.
fn confidence_checked(prior_passes: u32, prior_failures: u32, stats: Stats, now: u64) -> (u16, u64) {
    let dt = now.saturating_sub(stats.last);
    let wad = U256::from(WAD);
    let mul = |a: U256, b: U256| a.checked_mul(b).expect("product fits 256 bits");
    let add = |a: U256, b: U256| a.checked_add(b).expect("sum fits 256 bits");
    let passes = add(mul(U256::from(prior_passes), wad), U256::from(decay(stats.pass_wad, dt)));
    let failures = add(mul(U256::from(prior_failures), wad), U256::from(decay(stats.fail_wad, dt)));
    let n = add(passes, failures);
    if n.is_zero() {
        return (0, 0);
    }
    let p = mul(passes, wad) / n;
    let z2n = mul(U256::from(Z2_WAD), wad) / n;
    let denom = add(wad, z2n);
    let center = add(p, z2n / U256::from(2u8));
    let inner = add(mul(p, wad - p) / n, mul(z2n, wad) / n / U256::from(4u8));
    let rad = mul(U256::from(Z_WAD), isqrt(mul(inner, wad))) / wad;
    let lower = mul(center.saturating_sub(rad), wad) / denom;
    let bps = mul(lower, U256::from(10_000u16)) / wad;
    let n_milli = mul(n, U256::from(1000u16)) / wad;
    (bps.to::<u16>().min(10_000), if n_milli > U256::from(u64::MAX) { u64::MAX } else { n_milli.to::<u64>() })
}

fn any_stats() -> impl Strategy<Value = Stats> {
    let sum = prop_oneof![Just(0u128), 1u128..1_000u128, 0u128..1_000 * WAD, any::<u128>(), Just(u128::MAX)];
    (sum.clone(), sum, any::<u64>()).prop_map(|(pass_wad, fail_wad, last)| Stats { pass_wad, fail_wad, last })
}

fn any_u256() -> impl Strategy<Value = U256> {
    prop_oneof![any::<[u64; 4]>().prop_map(U256::from_limbs), any::<u128>().prop_map(U256::from), Just(U256::MAX)]
}

fn any_time() -> impl Strategy<Value = u64> {
    prop_oneof![0u64..10 * HALF_LIFE_SECONDS, any::<u64>(), Just(u64::MAX)]
}

fn any_prior() -> impl Strategy<Value = u32> {
    prop_oneof![0u32..1_000, any::<u32>(), Just(u32::MAX)]
}

/// A decayed sum: one wei (far below one outcome), fractional outcomes, or anything up to u128.
fn any_sum() -> impl Strategy<Value = u128> {
    prop_oneof![Just(0u128), 1u128..1_000_000, 0u128..1_000_000 * WAD, any::<u128>()]
}

/// The textbook Wilson lower bound in f64, unfloored, for a real number of passes and failures.
fn wilson(passes: f64, failures: f64) -> f64 {
    let z = 1.644_853_626_951_472_6_f64;
    let n = passes + failures;
    let p = passes / n;
    (p + z * z / (2.0 * n) - z * (p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt()) / (1.0 + z * z / n)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2_000, ..ProptestConfig::default() })]

    #[test]
    fn isqrt_is_the_floor_root(x in any_u256()) {
        let r = isqrt(x);
        prop_assert!(r.checked_mul(r).is_some_and(|sq| sq <= x));
        let next = r + U256::from(1u8);
        prop_assert!(next.checked_mul(next).is_none_or(|sq| sq > x));
    }

    #[test]
    fn decay_never_grows_and_is_monotone_in_time(value in any::<u128>(), a in any_time(), b in any_time()) {
        let (early, late) = if a <= b { (a, b) } else { (b, a) };
        prop_assert!(decay(value, early) <= value);
        prop_assert!(decay(value, late) <= decay(value, early));
    }

    #[test]
    fn decay_is_monotone_in_value(a in any::<u128>(), b in any::<u128>(), dt in any_time()) {
        let (small, large) = if a <= b { (a, b) } else { (b, a) };
        prop_assert!(decay(small, dt) <= decay(large, dt));
    }

    #[test]
    fn whole_half_lives_are_exact_shifts(value in 0u128..u128::MAX / 2, halvings in 0u64..127) {
        prop_assert_eq!(decay(value, halvings * HALF_LIFE_SECONDS), value >> halvings);
    }

    #[test]
    fn every_intermediate_fits_256_bits(prior_passes in any::<u32>(), prior_failures in any::<u32>(), stats in any_stats(), now in any_time()) {
        prop_assert_eq!(confidence(prior_passes, prior_failures, stats, now), confidence_checked(prior_passes, prior_failures, stats, now));
    }

    #[test]
    fn the_bound_stays_below_the_observed_rate(prior_passes in 0u32..10_000, prior_failures in 0u32..10_000, stats in any_stats(), now in any_time()) {
        let (bps, n_milli) = confidence(prior_passes, prior_failures, stats, now);
        prop_assert!(bps <= MAX_WEIGHT_BPS);
        let dt = now.saturating_sub(stats.last);
        let passes = U256::from(prior_passes) * U256::from(WAD) + U256::from(decay(stats.pass_wad, dt));
        let failures = U256::from(prior_failures) * U256::from(WAD) + U256::from(decay(stats.fail_wad, dt));
        let n = passes + failures;
        if n.is_zero() {
            prop_assert_eq!((bps, n_milli), (0, 0));
        } else {
            // A lower bound never exceeds the observed pass rate.
            prop_assert!(U256::from(bps) * n <= passes * U256::from(10_000u16));
        }
    }

    #[test]
    fn the_bound_is_the_exact_wilson_bound_rounded_down(prior_passes in any_prior(), prior_failures in any_prior(), pass_wad in any_sum(), fail_wad in any_sum(), dt in 0u64..20 * HALF_LIFE_SECONDS) {
        const T: u64 = 1_760_000_000;
        let stats = Stats { pass_wad, fail_wad, last: T };
        let passes = f64::from(prior_passes) + decay(pass_wad, dt) as f64 / WAD as f64;
        let failures = f64::from(prior_failures) + decay(fail_wad, dt) as f64 / WAD as f64;
        prop_assume!(passes + failures > 0.0);
        let exact = wilson(passes, failures) * 10_000.0;
        let bps = f64::from(confidence(prior_passes, prior_failures, stats, T + dt).0);
        // At most one basis point below (the last floor), and at most about 3e-5 bp above: once
        // p(1-p)/n + z²/4n² is under a few wei, the square root term floors toward zero.
        prop_assert!(bps > exact - 1.0 - 1e-6 && bps <= exact + 1e-4, "{} bp against the exact {}", bps, exact);
    }

    #[test]
    fn a_pass_never_lowers_and_a_failure_never_raises_confidence(prior_passes in 0u32..1_000, prior_failures in 0u32..1_000, pass_wad in 0u128..1_000 * WAD, fail_wad in 0u128..1_000 * WAD, weight in 1u16..=10_000, now in 0u64..u64::MAX / 2) {
        let stats = Stats { pass_wad, fail_wad, last: now };
        let before = confidence(prior_passes, prior_failures, stats, now).0;
        let weight = Weight::from_bps(weight).unwrap();
        let after_pass = confidence(prior_passes, prior_failures, record(stats, true, weight, now), now).0;
        let after_fail = confidence(prior_passes, prior_failures, record(stats, false, weight, now), now).0;
        // Floors can cost one basis point either way.
        prop_assert!(after_pass + 1 >= before, "pass: {} -> {}", before, after_pass);
        prop_assert!(after_fail <= before + 1, "fail: {} -> {}", before, after_fail);
    }

    #[test]
    fn record_keeps_time_forward_and_adds_exactly_the_weight(stats in any_stats(), passed in any::<bool>(), weight in 0u16..=10_000, now in any_time()) {
        let weight = Weight::from_bps(weight).unwrap();
        let next = record(stats, passed, weight, now);
        prop_assert_eq!(next.last, stats.last.max(now));
        let dt = now.saturating_sub(stats.last);
        let (grown, kept, old) = if passed { (next.pass_wad, next.fail_wad, stats.pass_wad) } else { (next.fail_wad, next.pass_wad, stats.fail_wad) };
        prop_assert_eq!(grown, decay(old, dt).saturating_add(weight.wad()));
        prop_assert_eq!(kept, decay(if passed { stats.fail_wad } else { stats.pass_wad }, dt));
    }

    #[test]
    fn weights_above_a_full_outcome_are_refused(bps in 10_001u16..=u16::MAX) {
        prop_assert_eq!(Weight::from_bps(bps), None);
    }
}
