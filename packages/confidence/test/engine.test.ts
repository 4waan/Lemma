import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EMPTY_STATS, HALF_LIFE_SECONDS, NO_PRIOR, WAD, WASM_URL, confidence, decay, fold, priorFromEvidence, record, unixSeconds } from "../src/index.js";

const T0 = 1_760_000_000n;
const DAY = 86_400n;

describe("the wasm module", () => {
  it("is found from src and from dist, and imports nothing", () => {
    expect(existsSync(WASM_URL)).toBe(true);
    // dist/engine.js resolves the same relative URL to the same file.
    const fromDist = new URL("../wasm/lemma_confidence.wasm", new URL("../dist/engine.js", import.meta.url));
    expect(fileURLToPath(fromDist)).toBe(fileURLToPath(WASM_URL));
    const { Module } = (globalThis as unknown as { WebAssembly: { Module: { new (b: Uint8Array): object; imports(m: object): unknown[] } } }).WebAssembly;
    expect(Module.imports(new Module(readFileSync(WASM_URL)))).toEqual([]);
  });
});

describe("record, confidence and fold", () => {
  it("adds weight at the outcome's time and halves it every 30 days", () => {
    const one = record(EMPTY_STATS, { passed: true, weightBps: 10_000, at: T0 });
    expect(one).toEqual({ passWad: WAD, failWad: 0n, last: T0 });
    expect(decay(one.passWad, HALF_LIFE_SECONDS)).toBe(WAD / 2n);
    const two = record(one, { passed: false, weightBps: 5_000, at: T0 + BigInt(HALF_LIFE_SECONDS) });
    expect(two).toEqual({ passWad: WAD / 2n, failWad: WAD / 2n, last: T0 + BigInt(HALF_LIFE_SECONDS) });
  });

  it("scores no data as zero and a benchmark prior on its own", () => {
    expect(confidence(NO_PRIOR, EMPTY_STATS, T0)).toEqual({ confidenceBps: 0, effectiveNMilli: 0n });
    expect(confidence({ passes: 19, failures: 1 }, EMPTY_STATS, T0)).toEqual({ confidenceBps: 8039, effectiveNMilli: 20_000n });
    expect(confidence({ passes: 19, failures: 1 }, EMPTY_STATS, Number(T0))).toEqual(confidence({ passes: 19, failures: 1 }, EMPTY_STATS, T0));
  });

  it("lets failures pull confidence down and old failures age out", () => {
    const prior = { passes: 9, failures: 1 };
    const failures = [0n, 1n, 2n].map((i) => ({ passed: false, weightBps: 10_000, at: T0 - i * DAY }));
    const fresh = fold(prior, failures, T0);
    const aged = fold(prior, failures, T0 + 365n * DAY);
    const alone = confidence(prior, EMPTY_STATS, T0);
    expect(fresh.confidenceBps).toBeLessThan(alone.confidenceBps);
    expect(aged.confidenceBps).toBeGreaterThan(fresh.confidenceBps);
    expect(aged.confidenceBps).toBeLessThanOrEqual(alone.confidenceBps);
    expect(fresh.outcomes).toBe(3);
  });

  it("depends on the exact record times, so a source must carry every record the contract made at its block time", () => {
    // Decay floors after every record and resolves a half-life to 32 bits, so the sums
    // follow the sequence of record times, not just the outcomes.
    const pass = { passed: true, weightBps: 10_000, at: T0 };
    const fail = (at: bigint) => ({ passed: false, weightBps: 10_000, at });
    expect(fold(NO_PRIOR, [pass, fail(T0 + DAY)], T0 + DAY).stats).toEqual({ passWad: 977_159_968_518_352_533n, failWad: WAD, last: T0 + DAY });
    // The same failure dated 12 seconds later: an off-chain time, or a later block.
    expect(fold(NO_PRIOR, [pass, fail(T0 + DAY + 12n)], T0 + DAY).stats.passWad).toBe(977_156_832_819_664_501n);
    // A zero-weight record adds nothing but moves `last`: leaving it out changes the sums.
    const zero = { passed: true, weightBps: 0, at: T0 + 5_222n };
    expect(fold(NO_PRIOR, [pass, zero, fail(T0 + DAY)], T0 + DAY).stats.passWad).toBe(977_159_968_518_352_533n + 157_699_842n);
  });

  it("refuses values the engine cannot represent instead of wrapping them", () => {
    const bad: Array<() => unknown> = [
      () => record(EMPTY_STATS, { passed: true, weightBps: 10_001, at: T0 }),
      () => record(EMPTY_STATS, { passed: true, weightBps: 1.5, at: T0 }),
      () => record(EMPTY_STATS, { passed: true, weightBps: 1, at: -1n }),
      () => record(EMPTY_STATS, { passed: true, weightBps: 1, at: 2n ** 64n }),
      () => record({ ...EMPTY_STATS, passWad: 2n ** 128n }, { passed: true, weightBps: 1, at: T0 }),
      () => record({ ...EMPTY_STATS, failWad: -1n }, { passed: true, weightBps: 1, at: T0 }),
      () => record(EMPTY_STATS, { passed: 1 as unknown as boolean, weightBps: 1, at: T0 }),
      () => confidence({ passes: -1, failures: 0 }, EMPTY_STATS, T0),
      () => confidence({ passes: 2 ** 32, failures: 0 }, EMPTY_STATS, T0),
      () => confidence({ passes: 0.5, failures: 0 }, EMPTY_STATS, T0),
      () => confidence(NO_PRIOR, EMPTY_STATS, 1.5),
      () => confidence(NO_PRIOR, EMPTY_STATS, Number.MAX_SAFE_INTEGER + 2),
      () => decay(-1n, 0n),
    ];
    for (const call of bad) expect(call).toThrow(RangeError);
  });

  it("takes the prior from the evidence's treatment arm", () => {
    expect(priorFromEvidence({ runs: { treatment: 20 }, passed: { treatment: 18 } })).toEqual({ passes: 18, failures: 2 });
  });

  it("converts dates to whole Unix seconds", () => {
    expect(unixSeconds(new Date("2026-10-01T00:00:00.999Z"))).toBe(1_790_812_800n);
    expect(() => unixSeconds(new Date("nope"))).toThrow(RangeError);
  });
});
