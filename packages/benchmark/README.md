# Lemma Benchmark

## Purpose and economic role

The benchmark tests the core claim: a paid Compatibility Resolution should reduce the buyer's all-in cost-to-green without reducing correctness. It is evidence for pricing and product-market fit, not a decorative performance chart.

## Responsibilities

- Run matched control and Lemma treatment tasks through the Cursor agent SDK (`@cursor/sdk`).
- Freeze model, prompts, fixtures, repository state, settings, and time limits.
- Capture model usage, cost, duration, tool calls, edits, test results, intervention, payment, and gas data.
- Preserve raw run records outside source control.
- Produce a public aggregate with honest limitations.

## Outside this boundary

- Modifying catalog releases during a final experiment.
- Hiding failed or expensive runs.
- Mixing old runner results into a paired comparison.
- Using benchmark outcomes to bypass compatibility rules.

## Planned experiment

- Three matched tasks.
- Control and Lemma treatment arms.
- Three repetitions per arm.
- One no-match fixture in both arms.
- Twenty runs total.

The success target is at least 25 percent lower median all-in raw cost and total tokens, with identical acceptance results and zero payment for the no-match treatment.

## Evidence derivation (implemented)

`src/evidence.ts` turns run records (`RunRecord` from `@lemma/core`) into the numbers the product sells on, and checks the protocol's success criteria. Both are pure and deterministic, so a report can be regenerated from the raw records without hand-editing.

- `deriveEvidence(records, { taskId, staleAfterDays })` returns the `ProfileEvidence` a release profile carries. Runs are paired by repetition, and at least three complete pairs are required. The model, benchmark version and fixture must be uniform, and a no-match task yields no evidence. The sold saving is the lower quartile of the paired raw-cost savings (the minimum for three pairs), clamped to `[0, control median]`. A failed control run counts at the cost it reached, which can only understate the saving. `runSetDigest` binds the evidence to the exact records.
- `evaluateBenchmark(records, { noMatchTaskIds })` evaluates per task: identical or better acceptance results, at least 2500 bps lower median all-in cost (model cost plus Lemma price plus gas) and total tokens on matched tasks, and zero spend on no-match tasks. A miss is reported with the measured values.
- The sale rule then prices off that evidence (`saleBlocker` in core). At the 30% price cap, a saving below about 36% of the control cost can be sellable yet still miss the 25% all-in target, which `allInReductionBps` makes visible (see docs/economic-gates.md).

## Workspace dependencies

- `@cursor/sdk` for controlled local agent runs.
- `@lemma/core` for run-record schemas and identifiers.

## Environment variables

The harness will require `CURSOR_API_KEY` and a frozen `LEMMA_BENCHMARK_MODEL`. Treatment runs will also use the local bridge configuration and funded testnet buyer wallet.

## Development and tests

- `npm run build -w @lemma/benchmark`
- `npm run test -w @lemma/benchmark`
- `npm run benchmark`

## Security constraints

- Do not put credentials in prompts, command arguments, run records, or committed fixtures.
- Use explicit local runtime and empty ambient setting sources.
- Keep each run in a fresh fixture copy.
- Dispose SDK resources and distinguish startup failures from run failures.
- Treat provider cost as eventually consistent and retain token counts as an independent measure.

## Later completion criteria

This component is complete when the frozen twenty-run matrix is reproducible, raw records validate against a schema, all interventions are disclosed, and the report can be regenerated without hand-editing results.
