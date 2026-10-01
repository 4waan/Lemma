import { readFileSync } from "node:fs";

/**
 * Lemma compatibility confidence for Node: the `lemma-confidence` Rust crate
 * compiled to wasm (contracts/stylus/confidence-wasm), the same code the Stylus
 * contract runs, so the catalog and the chain agree to the wei for the same prior,
 * the same outcomes at the same times and the same clock (see the README).
 *
 * The module is read and instantiated synchronously when this file is imported.
 * It imports nothing (no WASI, no host functions) and holds no state between
 * calls other than its result slots.
 */

/** Fixed-point one: every `*Wad` value is scaled by 10^18. */
export const WAD = 10n ** 18n;
/** An outcome's weight halves every 30 days. */
export const HALF_LIFE_SECONDS = 2_592_000;
/** A full outcome, in basis points. */
export const MAX_WEIGHT_BPS = 10_000;

const U32_MAX = 2 ** 32 - 1;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const ABI_VERSION = 1;
const OK = 0;

/** Decayed outcome sums for one (release digest, profile index), valid at `last` (Unix seconds). */
export interface Stats {
  readonly passWad: bigint;
  readonly failWad: bigint;
  readonly last: bigint;
}

/** The benchmark prior: the frozen evidence's treatment arm, as whole outcomes. */
export interface Prior {
  readonly passes: number;
  readonly failures: number;
}

/**
 * One finalized adoption outcome, weighted in basis points of a full outcome, at Unix
 * seconds `at`. To match the contract, `at` is the timestamp of the block that recorded it.
 */
export interface Outcome {
  readonly passed: boolean;
  readonly weightBps: number;
  readonly at: bigint;
}

/** The 90% Wilson lower bound on the pass rate in basis points, and the effective sample size in thousandths. */
export interface Confidence {
  readonly confidenceBps: number;
  readonly effectiveNMilli: bigint;
}

export const EMPTY_STATS: Stats = Object.freeze({ passWad: 0n, failWad: 0n, last: 0n });
export const NO_PRIOR: Prior = Object.freeze({ passes: 0, failures: 0 });

interface Exports {
  lc_abi_version(): number;
  lc_out(index: number): bigint;
  lc_decay(valueLo: bigint, valueHi: bigint, dt: bigint): number;
  lc_record(passLo: bigint, passHi: bigint, failLo: bigint, failHi: bigint, last: bigint, passed: number, weightBps: number, now: bigint): number;
  lc_confidence(priorPasses: number, priorFailures: number, passLo: bigint, passHi: bigint, failLo: bigint, failHi: bigint, last: bigint, now: bigint): number;
}

// The WebAssembly JS API is a Node global; ES2022's lib does not declare it.
interface WasmApi {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: unknown };
}

/** The wasm file sits one level above both src/ and dist/, so this path works from either. */
export const WASM_URL = new URL("../wasm/lemma_confidence.wasm", import.meta.url);

const engine = instantiate(readFileSync(WASM_URL));

function instantiate(bytes: Uint8Array): Exports {
  const { Module, Instance } = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;
  const exports = new Instance(new Module(bytes), {}).exports as Exports;
  const version = exports.lc_abi_version();
  if (version !== ABI_VERSION) throw new Error(`lemma_confidence.wasm speaks ABI ${version}, expected ${ABI_VERSION}: rebuild it with npm run confidence:wasm`);
  return exports;
}

function u64(value: bigint | number, what: string): bigint {
  const v = typeof value === "number" ? (Number.isSafeInteger(value) ? BigInt(value) : -1n) : value;
  if (v < 0n || v > U64_MAX) throw new RangeError(`${what} must be an integer number of seconds in 0..2^64-1`);
  return v;
}

function u128(value: bigint, what: string): bigint {
  if (value < 0n || value > U128_MAX) throw new RangeError(`${what} must be in 0..2^128-1`);
  return value;
}

function u32(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError(`${what} must be an integer in 0..2^32-1`);
  return value;
}

const lo = (v: bigint) => BigInt.asIntN(64, v & U64_MAX);
const hi = (v: bigint) => BigInt.asIntN(64, v >> 64n);
const out = (i: number) => BigInt.asUintN(64, engine.lc_out(i));
const joined = (i: number) => out(i) | (out(i + 1) << 64n);

function checkStats(stats: Stats): Stats {
  return { passWad: u128(stats.passWad, "passWad"), failWad: u128(stats.failWad, "failWad"), last: u64(stats.last, "last") };
}

/** `valueWad * 2^(-dt / 30 days)`, rounded down exactly as on chain. */
export function decay(valueWad: bigint, dtSeconds: bigint | number): bigint {
  const value = u128(valueWad, "valueWad");
  if (engine.lc_decay(lo(value), hi(value), u64(dtSeconds, "dt")) !== OK) throw new Error("lc_decay refused its arguments");
  return joined(0);
}

/**
 * Adds one outcome: both sums decay to `outcome.at`, then its weight joins the pass
 * or fail sum. An outcome dated before `stats.last` decays nothing and keeps `last`.
 */
export function record(stats: Stats, outcome: Outcome): Stats {
  const s = checkStats(stats);
  if (typeof outcome.passed !== "boolean") throw new RangeError("passed must be a boolean");
  if (!Number.isInteger(outcome.weightBps) || outcome.weightBps < 0 || outcome.weightBps > MAX_WEIGHT_BPS) {
    throw new RangeError(`weightBps must be an integer in 0..${MAX_WEIGHT_BPS}`);
  }
  const status = engine.lc_record(lo(s.passWad), hi(s.passWad), lo(s.failWad), hi(s.failWad), s.last, outcome.passed ? 1 : 0, outcome.weightBps, u64(outcome.at, "at"));
  if (status !== OK) throw new Error("lc_record refused its arguments");
  return { passWad: joined(0), failWad: joined(2), last: out(4) };
}

/** The 90% Wilson lower bound at `nowSeconds` over the prior and the decayed sums. No data gives zero. */
export function confidence(prior: Prior, stats: Stats, nowSeconds: bigint | number): Confidence {
  const s = checkStats(stats);
  const passes = u32(prior.passes, "prior passes");
  const failures = u32(prior.failures, "prior failures");
  const status = engine.lc_confidence(passes, failures, lo(s.passWad), hi(s.passWad), lo(s.failWad), hi(s.failWad), s.last, u64(nowSeconds, "now"));
  if (status !== OK) throw new Error("lc_confidence refused its arguments");
  return { confidenceBps: Number(out(0)), effectiveNMilli: out(1) };
}

export interface Folded extends Confidence {
  readonly stats: Stats;
  /** How many outcomes were folded in. */
  readonly outcomes: number;
}

/**
 * Records `outcomes` in time order (a stable sort: ties keep their order and add
 * without decay, so order never matters), as the contract does in block order, and
 * scores the result at `nowSeconds`.
 */
export function fold(prior: Prior, outcomes: readonly Outcome[], nowSeconds: bigint | number): Folded {
  const ordered = [...outcomes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const stats = ordered.reduce(record, EMPTY_STATS);
  return { stats, outcomes: ordered.length, ...confidence(prior, stats, nowSeconds) };
}

/** The prior for a profile's evidence: the treatment arm's passes and failures. */
export function priorFromEvidence(evidence: { readonly runs: { readonly treatment: number }; readonly passed: { readonly treatment: number } }): Prior {
  return { passes: evidence.passed.treatment, failures: evidence.runs.treatment - evidence.passed.treatment };
}

/** Whole Unix seconds of a date, rounded down, for `Outcome.at` and `nowSeconds`. */
export function unixSeconds(date: Date): bigint {
  const ms = date.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("expected a valid date at or after 1970");
  return BigInt(ms) / 1000n;
}
