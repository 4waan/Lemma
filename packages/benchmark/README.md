# Lemma Benchmark

## Purpose and economic role

The benchmark tests the core claim: a paid Compatibility Resolution should reduce the buyer's all-in cost-to-green without reducing correctness. It is evidence for pricing and product-market fit, not a decorative performance chart.

## Responsibilities

- Run matched control and Lemma treatment tasks through the Codex SDK.
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
