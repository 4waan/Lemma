# Lemma Compatibility Confidence

`@lemma/confidence` scores how likely a release's acceptance recipe is to pass on one supported profile. The score is the 90% Wilson lower bound on the pass rate, in basis points. The server uses it to fill `ProfileSummary.compatibility` in the catalog read model.

The math is not written in TypeScript. It is the `lemma-confidence` Rust crate from [contracts/stylus](../../contracts/README.md#stylus-compatibility-confidence-engine), compiled to wasm and committed as `wasm/lemma_confidence.wasm`. The Stylus contract runs the same crate. The package is server-only: the dashboard never imports it.

## The model

For one release digest and profile index:

- The prior is the frozen benchmark's treatment arm: `passes = passed.treatment` and `failures = runs.treatment - passed.treatment`, counted as whole outcomes.
- Each finalized adoption outcome adds its weight, in basis points of a full outcome. Weights halve every 30 days, so old results fade as dependencies move.
- The score is the 90% Wilson lower bound over both. `effectiveNMilli` is the effective sample size in thousandths of an outcome. No data scores zero.

Every step is integer arithmetic that rounds down. WAD values (fixed point, `10^18`) are `bigint`.

## Public interface

| Export | Purpose |
| --- | --- |
| `record(stats, outcome)` | Adds one `Outcome { passed, weightBps, at }`. Both sums first decay to `at`. An outcome dated before `stats.last` decays nothing. |
| `confidence(prior, stats, nowSeconds)` | Returns `{ confidenceBps, effectiveNMilli }` at `nowSeconds`. |
| `fold(prior, outcomes, nowSeconds)` | Records the outcomes in time order from `EMPTY_STATS`, then scores them. |
| `decay(valueWad, dtSeconds)` | `valueWad * 2^(-dt / 30 days)`, rounded down exactly as on chain. |
| `priorFromEvidence(evidence)` | The prior for a `ProfileEvidence`. |
| `unixSeconds(date)` | Whole Unix seconds of a `Date`, as a `bigint`. |
| `Stats`, `Prior`, `Outcome`, `EMPTY_STATS`, `NO_PRIOR` | The types and their zero values. |
| `WAD`, `HALF_LIFE_SECONDS`, `MAX_WEIGHT_BPS`, `WASM_URL` | Constants and the module's location. |

Inputs the engine cannot represent throw `RangeError` instead of wrapping: a negative or fractional count, a weight above 10,000, a sum outside u128, or a time outside u64.

## When the catalog and the chain agree

The server and the contract run the same code, but they compute the same number only from the same inputs:

- **The same prior.** The contract uses what the owner passed to `setPrior`. The catalog uses the manifest's evidence, including the testnet-only provisional overlay when the server loads it. Set on-chain priors from frozen evidence only.
- **The same outcomes at the same times.** A key's list must hold exactly the outcomes the contract recorded: one per `OutcomeRecorded` event, weight 0 included, and none it did not record (VOID verdicts, or outcomes whose engine call failed). Each `at` must be the timestamp of the block that recorded it.
- **The same time.** The catalog scores at the request's clock, the contract at `block.timestamp`.

Decay rounds down after every record, so the sums depend on the exact record times. An `at` a few seconds off, or a missing zero-weight record, can change the score. `test/engine.test.ts` pins examples of both.

## The wasm module

`src/engine.ts` reads the module synchronously at import time from `WASM_URL`, which resolves from both `src/` and `dist/`. The module imports nothing: no WASI, no host functions and no allocator. It is about 30 KB, compiles in under a millisecond, and a call takes a few microseconds (measured on the development container, 2026-09-27).

Rebuild the module after any change to `contracts/stylus/lemma-confidence` or `contracts/stylus/confidence-wasm`, and commit it with that change:

```bash
npm run confidence:wasm
npm run confidence:wasm:check
```

The build uses the toolchain pinned in `contracts/stylus/rust-toolchain.toml`, `cargo build --locked --release` and remapped paths, so the bytes do not depend on the machine or the checkout location. The check rebuilds into a temporary directory and fails on any byte difference. CI runs it.

## Development

```bash
npm run build -w @lemma/confidence
npm run test -w @lemma/confidence
```

The tests replay `contracts/stylus/lemma-confidence/vectors.json` through the wasm. Over the whole input range (fast-check), they compare it with an independent bigint implementation and with the floating-point Wilson bound: the result is always less than one basis point below that bound, and at most about 3e-5 bp above it in extreme cases (beyond about 1e17 outcomes, or a pass rate within 1e-10 of 0 or 1), where the square-root term rounds toward zero. They also cover loading, argument checks and record-time sensitivity.

Outcomes come from outside this package: the server reads them from an injected `OutcomeSource` (see [Server Runtime](../../docs/server-runtime.md#catalog-compatibility-confidence)). Confidence is shown next to evidence; it does not block a sale.
