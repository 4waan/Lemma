import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type Outcome, type Stats, WAD, confidence, decay, fold, record } from "../src/index.js";
import { vectors } from "./vectors.js";

/*
 * A second implementation of the engine in plain bigint, written from the formula
 * in the Rust crate's documentation (contracts/stylus/lemma-confidence), with the
 * decay table from vectors.json. Random inputs across the whole domain must give
 * the wasm's numbers exactly, and no intermediate may pass 256 bits (the Rust
 * crate's operators wrap there, so an overflow would show up as a mismatch).
 */
const H = 2_592_000n;
const TABLE = vectors.constants.decayTable.map(BigInt);
const Z = BigInt(vectors.constants.zWad);
const Z2 = BigInt(vectors.constants.z2Wad);
const U32_MAX = 2 ** 32 - 1;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const U256 = 2n ** 256n;

const fits = (v: bigint) => {
  if (v < 0n || v >= U256) throw new Error(`intermediate outside 0..2^256: ${v}`);
  return v;
};

function refDecay(value: bigint, dt: bigint): bigint {
  const halvings = dt / H;
  if (halvings >= 128n) return 0n;
  let v = value >> halvings;
  const bits = ((dt % H) << 32n) / H;
  for (let i = 0; i < 32 && v !== 0n; i++) {
    if ((bits >> BigInt(31 - i)) & 1n) v = fits(v * (TABLE[i] as bigint)) / WAD;
  }
  return v;
}

function isqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let r = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  for (;;) {
    const next = (r + x / r) >> 1n;
    if (next >= r) return r;
    r = next;
  }
}

function refRecord(s: Stats, o: Outcome): Stats {
  const dt = o.at > s.last ? o.at - s.last : 0n;
  const add = (BigInt(o.weightBps) * WAD) / 10_000n;
  const sat = (v: bigint) => (v > U128_MAX ? U128_MAX : v);
  const pass = refDecay(s.passWad, dt);
  const fail = refDecay(s.failWad, dt);
  return { passWad: o.passed ? sat(pass + add) : pass, failWad: o.passed ? fail : sat(fail + add), last: o.at > s.last ? o.at : s.last };
}

function refConfidence(pp: number, pf: number, s: Stats, now: bigint): { confidenceBps: number; effectiveNMilli: bigint } {
  const dt = now > s.last ? now - s.last : 0n;
  const P = fits(BigInt(pp) * WAD + refDecay(s.passWad, dt));
  const F = fits(BigInt(pf) * WAD + refDecay(s.failWad, dt));
  const n = fits(P + F);
  if (n === 0n) return { confidenceBps: 0, effectiveNMilli: 0n };
  const p = fits(P * WAD) / n;
  const z2n = fits(Z2 * WAD) / n;
  const denom = fits(WAD + z2n);
  const center = fits(p + z2n / 2n);
  const inner = fits(fits(p * (WAD - p)) / n + fits(z2n * WAD) / n / 4n);
  const rad = fits(Z * isqrt(fits(inner * WAD))) / WAD;
  const lower = fits((center > rad ? center - rad : 0n) * WAD) / denom;
  const bps = fits(lower * 10_000n) / WAD;
  const milli = fits(n * 1000n) / WAD;
  return { confidenceBps: Number(bps > 10_000n ? 10_000n : bps), effectiveNMilli: milli > U64_MAX ? U64_MAX : milli };
}

const u128 = fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 1000n * WAD }), fc.bigInt({ min: 0n, max: U128_MAX }), fc.constant(U128_MAX));
const u64 = fc.oneof(fc.bigInt({ min: 0n, max: 20n * H }), fc.bigInt({ min: 0n, max: U64_MAX }), fc.constant(U64_MAX));
const u32 = fc.oneof(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: U32_MAX }), fc.constant(U32_MAX));
const statsArb = fc.record({ passWad: u128, failWad: u128, last: u64 });
const outcomeArb = fc.record({ passed: fc.boolean(), weightBps: fc.integer({ min: 0, max: 10_000 }), at: fc.bigInt({ min: 1_700_000_000n, max: 1_700_000_000n + 400n * 86_400n }) });

describe("the wasm against an independent bigint implementation", () => {
  it("checks the decay table: each entry squared lands on the one before it", () => {
    const first = TABLE[0] as bigint;
    expect(first * first <= (WAD * WAD) / 2n && (first + 1n) * (first + 1n) > (WAD * WAD) / 2n).toBe(true);
    for (let i = 1; i < TABLE.length; i++) {
      const squared = ((TABLE[i] as bigint) * (TABLE[i] as bigint)) / WAD;
      const diff = squared - (TABLE[i - 1] as bigint);
      expect(diff >= -2n && diff <= 2n, `entry ${i}`).toBe(true);
    }
    expect(Z2).toBe((Z * Z) / WAD);
  });

  it("decays like the reference", () => {
    fc.assert(fc.property(u128, u64, (value, dt) => decay(value, dt) === refDecay(value, dt)), { numRuns: 2000 });
  });

  it("records like the reference", () => {
    fc.assert(fc.property(statsArb, fc.boolean(), fc.integer({ min: 0, max: 10_000 }), u64, (s, passed, weightBps, at) => {
      expect(record(s, { passed, weightBps, at })).toEqual(refRecord(s, { passed, weightBps, at }));
    }), { numRuns: 2000 });
  });

  it("scores like the reference, with every intermediate inside 256 bits", () => {
    fc.assert(fc.property(u32, u32, statsArb, u64, (pp, pf, s, now) => {
      expect(confidence({ passes: pp, failures: pf }, s, now)).toEqual(refConfidence(pp, pf, s, now));
    }), { numRuns: 3000 });
  });

  it("folds like recording the outcomes in time order", () => {
    fc.assert(fc.property(fc.array(outcomeArb, { maxLength: 30 }), fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }), (outcomes, pp, pf) => {
      const now = 1_700_000_000n + 500n * 86_400n;
      const sorted = [...outcomes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const s = sorted.reduce(refRecord, { passWad: 0n, failWad: 0n, last: 0n });
      const folded = fold({ passes: pp, failures: pf }, outcomes, now);
      expect(folded.stats).toEqual(s);
      expect({ confidenceBps: folded.confidenceBps, effectiveNMilli: folded.effectiveNMilli }).toEqual(refConfidence(pp, pf, s, now));
      // The order outcomes arrive in never changes the result.
      expect(fold({ passes: pp, failures: pf }, [...outcomes].reverse(), now)).toEqual(folded);
    }), { numRuns: 500 });
  });

  it("is the Wilson lower bound: the unfloored float bound rounded down, over the whole domain", () => {
    const z = 1.644853626951472714;
    // The textbook bound for a real (decayed, fractional) number of passes and failures.
    const wilson = (s: number, f: number) => {
      const n = s + f;
      const p = s / n;
      return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
    };
    // Sums from one wei (far below one outcome) through fractional outcomes up to u128.
    const sum = fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 1_000_000n }), fc.bigInt({ min: 0n, max: 1_000_000n * WAD }), fc.bigInt({ min: 0n, max: U128_MAX }));
    const dt = fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 20n * H }));
    const T = 1_760_000_000n;
    fc.assert(
      fc.property(u32, u32, sum, sum, dt, (pp, pf, passWad, failWad, elapsed) => {
        // Decay is checked exactly against the reference above; here only the bound is compared.
        const passes = BigInt(pp) * WAD + decay(passWad, elapsed);
        const failures = BigInt(pf) * WAD + decay(failWad, elapsed);
        fc.pre(passes + failures > 0n);
        const exact = wilson(Number(passes) / 1e18, Number(failures) / 1e18) * 10_000;
        const { confidenceBps } = confidence({ passes: pp, failures: pf }, { passWad, failWad, last: T }, T + elapsed);
        // The last step floors, so the result is less than one basis point below the exact
        // bound (1e-6 bp covers float error). It can sit a little above it: every step floors
        // to a wei, and once p(1-p)/n + z²/4n² is under a few wei (beyond about 1e17 outcomes,
        // or p within 1e-10 of 0 or 1) the square root term floors toward zero. That is worth
        // at most z·sqrt(3·WAD) wei, about 3e-5 bp.
        expect(confidenceBps).toBeGreaterThan(exact - 1 - 1e-6);
        expect(confidenceBps).toBeLessThanOrEqual(exact + 1e-4);
      }),
      {
        numRuns: 3000,
        examples: [
          [19, 1, 0n, 0n, 0n], // the textbook case: 8039 bp
          [0, 0, 1n, 0n, 0n], // one wei of a pass and nothing else
          [0, 0, 0n, 1n, 0n], // one wei of a failure and nothing else
          [0, 0, WAD / 3n, WAD / 7n, H / 3n], // fractional, decayed outcomes alone
          [U32_MAX, 0, 0n, 0n, 0n], // near certainty
          [U32_MAX, U32_MAX, U128_MAX, U128_MAX, 0n], // the largest n
          // About 2.65e18 outcomes at p = 1/2: the root term floors to zero, 5000 bp against 4999.999995.
          [960, 0, U128_MAX - 39n, U128_MAX - 39n, 20_747_575n],
        ],
      },
    );
  });
});
