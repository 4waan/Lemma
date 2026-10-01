import { describe, expect, it } from "vitest";

import { HALF_LIFE_SECONDS, MAX_WEIGHT_BPS, WAD, confidence, decay, fold, record } from "../src/index.js";
import { outcome, stats, vectors } from "./vectors.js";

// Every case the Rust crate generated, replayed through the committed wasm: for the
// same inputs, the server's numbers are the contract's numbers.
describe("the shared vectors", () => {
  it("are the version and constants this package speaks", () => {
    expect(vectors.schema).toBe("lemma.confidence-vectors/1");
    expect(BigInt(vectors.constants.wad)).toBe(WAD);
    expect(Number(vectors.constants.halfLifeSeconds)).toBe(HALF_LIFE_SECONDS);
    expect(vectors.constants.maxWeightBps).toBe(MAX_WEIGHT_BPS);
    expect(vectors.constants.decayTable).toHaveLength(32);
  });

  it.each(vectors.decay)("decay: $name", (c) => {
    expect(decay(BigInt(c.valueWad), BigInt(c.dt))).toBe(BigInt(c.expected));
  });

  it.each(vectors.record)("record: $name", (c) => {
    expect(record(stats(c.stats), { passed: c.passed, weightBps: c.weightBps, at: BigInt(c.now) })).toEqual(stats(c.expected));
  });

  it.each(vectors.confidence)("confidence: $name", (c) => {
    expect(confidence(c.prior, stats(c.stats), BigInt(c.now))).toEqual({ confidenceBps: c.expected.confidenceBps, effectiveNMilli: BigInt(c.expected.effectiveNMilli) });
  });

  it.each(vectors.fold)("fold: $name", (c) => {
    const folded = fold(c.prior, c.outcomes.map(outcome), BigInt(c.now));
    expect(folded).toEqual({
      stats: stats(c.expected.stats),
      outcomes: c.outcomes.length,
      confidenceBps: c.expected.confidenceBps,
      effectiveNMilli: BigInt(c.expected.effectiveNMilli),
    });
  });

  it("cover the edge cases the spec names", () => {
    const names = [...vectors.decay, ...vectors.record, ...vectors.confidence, ...vectors.fold].map((c) => c.name).join("\n");
    for (const edge of ["no data", "prior only", "large n", "long gap", "weight 0", "now before last"]) expect(names).toContain(edge);
  });
});
