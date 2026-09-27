//! Shared vectors: `vectors.json` is generated here from the Rust implementation
//! and replayed by `packages/confidence` against the wasm build, so the server, the
//! Node wasm and the Stylus contract are held to the same numbers.
//!
//! Regenerate deliberately with `LEMMA_WRITE_VECTORS=1 cargo test -p lemma-confidence --test vectors`.

use lemma_confidence::{
    DECAY_TABLE, FRACTION_BITS, HALF_LIFE_SECONDS, MAX_WEIGHT_BPS, Stats, WAD, Weight, Z_WAD, Z2_WAD, confidence, decay, record,
};
use serde_json::{Value, json};

const H: u64 = HALF_LIFE_SECONDS;
const DAY: u64 = 86_400;
/// 2025-10-09T08:53:20Z: an arbitrary fixed "now".
const T0: u64 = 1_760_000_000;

fn int(value: impl ToString) -> Value {
    Value::String(value.to_string())
}

fn stats_json(s: Stats) -> Value {
    json!({ "passWad": int(s.pass_wad), "failWad": int(s.fail_wad), "last": int(s.last) })
}

fn stats(pass_wad: u128, fail_wad: u128, last: u64) -> Stats {
    Stats { pass_wad, fail_wad, last }
}

struct Outcome {
    passed: bool,
    weight_bps: u16,
    at: u64,
}

fn outcome(passed: bool, weight_bps: u16, at: u64) -> Outcome {
    Outcome { passed, weight_bps, at }
}

/// Applies outcomes in time order (a stable sort, so ties keep their order), as the
/// contract does in block order.
fn fold(outcomes: &[Outcome]) -> Stats {
    let mut ordered: Vec<&Outcome> = outcomes.iter().collect();
    ordered.sort_by_key(|o| o.at);
    ordered.iter().fold(Stats::default(), |s, o| record(s, o.passed, Weight::from_bps(o.weight_bps).unwrap(), o.at))
}

fn decay_cases() -> Vec<Value> {
    let cases: Vec<(&str, u128, u64)> = vec![
        ("no time passes", WAD, 0),
        ("one second", WAD, 1),
        ("half a half-life", WAD, H / 2),
        ("one half-life", WAD, H),
        ("one half-life and a second", WAD, H + 1),
        ("45 days", 3 * WAD / 2, 45 * DAY),
        ("just under 128 half-lives", u128::MAX, 127 * H + (H - 1)),
        ("128 half-lives reach zero", u128::MAX, 128 * H),
        ("the longest gap", u128::MAX, u64::MAX),
        ("the largest sum over a third of a half-life", u128::MAX, H / 3),
        ("one wei", 1, H - 1),
        ("nothing to decay", 0, 1_000),
        ("an odd sum and an odd gap", 123_456_789_012_345_678_901_234_567, 12_345_678),
    ];
    cases
        .into_iter()
        .map(|(name, value, dt)| json!({ "name": name, "valueWad": int(value), "dt": int(dt), "expected": int(decay(value, dt)) }))
        .collect()
}

fn record_cases() -> Vec<Value> {
    let cases: Vec<(&str, Stats, bool, u16, u64)> = vec![
        ("a first pass", Stats::default(), true, MAX_WEIGHT_BPS, T0),
        ("a half-weight pass after 10 days", stats(3 * WAD, WAD, T0), true, 5_000, T0 + 10 * DAY),
        ("a failure after one half-life", stats(4 * WAD, 0, T0), false, MAX_WEIGHT_BPS, T0 + H),
        ("weight 0 decays and adds nothing", stats(2 * WAD, WAD, T0), true, 0, T0 + 60 * DAY),
        ("now before last decays nothing and keeps last", stats(2 * WAD, WAD, T0), false, 2_500, T0 - DAY),
        ("a sum saturates", stats(u128::MAX - 1, 0, T0), true, MAX_WEIGHT_BPS, T0),
    ];
    cases
        .into_iter()
        .map(|(name, before, passed, weight_bps, now)| {
            let after = record(before, passed, Weight::from_bps(weight_bps).unwrap(), now);
            json!({ "name": name, "stats": stats_json(before), "passed": passed, "weightBps": weight_bps, "now": int(now), "expected": stats_json(after) })
        })
        .collect()
}

fn confidence_cases() -> Vec<Value> {
    let weight_zero = record(Stats::default(), true, Weight::from_bps(0).unwrap(), T0);
    let cases: Vec<(&str, u32, u32, Stats, u64)> = vec![
        ("no data", 0, 0, Stats::default(), T0),
        ("prior only: 19 of 20 treatment runs passed", 19, 1, Stats::default(), T0),
        ("prior only: a one-run probe", 1, 0, Stats::default(), T0),
        ("prior only: every run failed", 0, 5, Stats::default(), T0),
        ("outcomes only: five passes now", 0, 0, stats(5 * WAD, 0, T0), T0),
        ("benchmark and outcomes", 18, 2, stats(3 * WAD, WAD / 2, T0 - 10 * DAY), T0),
        ("large n: a million passes and a thousand failures", 1_000_000, 1_000, stats(250 * WAD, 3 * WAD, T0), T0),
        ("every input at its maximum", u32::MAX, u32::MAX, stats(u128::MAX, u128::MAX, T0), T0),
        ("one wei of evidence", 0, 0, stats(1, 0, T0), T0),
        ("long gap: outcomes 200 half-lives old leave the prior", 9, 1, stats(40 * WAD, 40 * WAD, T0 - 200 * H), T0),
        ("a 45-day gap", 9, 1, stats(6 * WAD, 2 * WAD, T0 - 45 * DAY), T0),
        ("now before last counts as no time passed", 9, 1, stats(6 * WAD, 2 * WAD, T0), T0 - 30 * DAY),
        ("weight 0 only is no data", 0, 0, weight_zero, T0),
    ];
    cases
        .into_iter()
        .map(|(name, passes, failures, s, now)| {
            let (bps, n_milli) = confidence(passes, failures, s, now);
            json!({
                "name": name,
                "prior": { "passes": passes, "failures": failures },
                "stats": stats_json(s),
                "now": int(now),
                "expected": { "confidenceBps": bps, "effectiveNMilli": int(n_milli) },
            })
        })
        .collect()
}

fn fold_cases() -> Vec<Value> {
    let cases: Vec<(&str, u32, u32, Vec<Outcome>, u64)> = vec![
        ("the prior alone", 19, 1, vec![], T0),
        (
            "outcomes out of order apply in time order",
            18,
            2,
            vec![
                outcome(true, 10_000, T0 - 5 * DAY),
                outcome(false, 10_000, T0 - 40 * DAY),
                outcome(true, 5_000, T0 - 20 * DAY),
                outcome(true, 10_000, T0 - 90 * DAY),
            ],
            T0,
        ),
        ("ties at one second", 3, 0, vec![outcome(true, 10_000, T0), outcome(false, 10_000, T0), outcome(true, 2_500, T0)], T0 + DAY),
        ("a weight 0 outcome still moves time", 3, 1, vec![outcome(true, 10_000, T0 - 60 * DAY), outcome(false, 0, T0 - 10 * DAY)], T0),
        ("outcomes a year old", 9, 1, vec![outcome(false, 10_000, T0 - 365 * DAY), outcome(false, 10_000, T0 - 364 * DAY)], T0),
        ("outcomes without evidence", 0, 0, (0..12).map(|i| outcome(i % 4 != 0, 10_000, T0 - i * DAY)).collect(), T0),
    ];
    cases
        .into_iter()
        .map(|(name, passes, failures, outcomes, now)| {
            let s = fold(&outcomes);
            let (bps, n_milli) = confidence(passes, failures, s, now);
            let list: Vec<Value> =
                outcomes.iter().map(|o| json!({ "passed": o.passed, "weightBps": o.weight_bps, "at": int(o.at) })).collect();
            json!({
                "name": name,
                "prior": { "passes": passes, "failures": failures },
                "outcomes": list,
                "now": int(now),
                "expected": { "stats": stats_json(s), "confidenceBps": bps, "effectiveNMilli": int(n_milli) },
            })
        })
        .collect()
}

fn vectors() -> Value {
    json!({
        "schema": "lemma.confidence-vectors/1",
        "about": "Generated from contracts/stylus/lemma-confidence (LEMMA_WRITE_VECTORS=1 cargo test -p lemma-confidence --test vectors) and replayed by packages/confidence. Integers that can pass 2^53 are decimal strings; times are Unix seconds.",
        "constants": {
            "wad": int(WAD),
            "halfLifeSeconds": int(HALF_LIFE_SECONDS),
            "maxWeightBps": MAX_WEIGHT_BPS,
            "zWad": int(Z_WAD),
            "z2Wad": int(Z2_WAD),
            "fractionBits": FRACTION_BITS,
            "decayTable": DECAY_TABLE.iter().map(int).collect::<Vec<_>>(),
        },
        "decay": decay_cases(),
        "record": record_cases(),
        "confidence": confidence_cases(),
        "fold": fold_cases(),
    })
}

#[test]
fn vectors_match_the_committed_file() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors.json");
    let generated = vectors();
    if std::env::var("LEMMA_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(path, serde_json::to_string_pretty(&generated).unwrap() + "\n").unwrap();
    }
    let committed: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("vectors.json exists")).unwrap();
    assert!(committed == generated, "vectors.json is stale: regenerate it deliberately with LEMMA_WRITE_VECTORS=1");
}

#[test]
fn the_edge_cases_mean_what_their_names_say() {
    assert_eq!(confidence(0, 0, Stats::default(), T0), (0, 0));
    // A gap of 200 half-lives leaves exactly the prior.
    assert_eq!(confidence(9, 1, stats(40 * WAD, 40 * WAD, T0 - 200 * H), T0), confidence(9, 1, Stats::default(), T0));
    // now < last is dt = 0.
    let s = stats(6 * WAD, 2 * WAD, T0);
    assert_eq!(confidence(9, 1, s, T0 - 30 * DAY), confidence(9, 1, s, T0));
    // The largest inputs saturate the sample size instead of wrapping.
    assert_eq!(confidence(u32::MAX, u32::MAX, stats(u128::MAX, u128::MAX, T0), T0).1, u64::MAX);
    // Order does not change a fold.
    let a = fold(&[outcome(true, 10_000, T0 - 5 * DAY), outcome(false, 7_500, T0 - 40 * DAY)]);
    let b = fold(&[outcome(false, 7_500, T0 - 40 * DAY), outcome(true, 10_000, T0 - 5 * DAY)]);
    assert_eq!(a, b);
}
