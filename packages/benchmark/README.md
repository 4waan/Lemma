# Lemma Benchmark

`@lemma/benchmark` tests Lemma's central claim: a paid Compatibility Resolution should reduce all-in cost-to-green without reducing correctness.

The harness, run records, evidence derivation, economic probe, and report generator are implemented. The final x402 task fixtures and measured experiment remain pending with the payment path.

## Experiment design

The final matrix uses three matched tasks and one no-match task. Each matched task runs control and Lemma treatment arms three times. The no-match task runs in both arms, for twenty runs total.

Control and treatment start from identical fixtures and use the same model, prompt, time limit, machine, network policy, and acceptance test. The treatment adds only the Lemma rule and bridge.

Success requires:

- identical or better acceptance outcomes;
- at least 25 percent lower median all-in raw cost on matched tasks;
- at least 25 percent fewer median tokens on matched tasks;
- zero spend on the no-match treatment;
- recoverable paid delivery without a duplicate payment.

See [Benchmark Protocol](../../docs/benchmark-protocol.md) for the frozen methodology.

## Commands

Build before running the harness:

```bash
npm run build -w @lemma/benchmark
```

The CLI shape is:

```text
node packages/benchmark/dist/cli.js <freeze|run|reconcile|probe|report> <version> [options]
```

| Command | Result |
| --- | --- |
| `freeze` | Validates fixtures, rule, model, and pricing support, then writes an immutable experiment definition. |
| `run` | Executes the interleaved matrix, logs attempts before launch, and resumes without repeating completed slots. |
| `reconcile` | Reads settled provider usage and converts attempts into canonical `RunRecord` values. |
| `probe` | Runs the stage-four economic kill test against a draft bundle and reports the maximum viable price. |
| `report` | Produces scrubbed task verdicts and profile evidence once every attempt has a settled result. |

The Cursor API key is read from a pipe on standard input. It is never accepted from an environment variable or command argument. `LEMMA_BENCHMARK_MODEL` selects the frozen model. `LEMMA_BENCH_DIR` can move run data outside the operating-system temporary directory.

## Evidence derivation

`deriveEvidence` pairs control and treatment by repetition and requires at least three complete pairs with one model, benchmark version, and fixture. It uses the lower quartile of paired raw-cost savings, clamped between zero and the control median, as the conservative saving.

`evaluateBenchmark` applies the correctness, cost, token, and no-match criteria per task. A miss remains in the report with its measured values. The harness never turns a failed benchmark into a sellable claim.

Every evidence object cites the digest of the exact run set and the base release that was measured. Catalog validation checks that binding before a public release can carry evidence.

## Isolation and records

- Each run gets a fresh fixture copy and empty home outside the repository.
- The agent process receives a small allowlisted environment and the API key only through standard input.
- Dependency lifecycle scripts are disabled.
- The harness owns the deadline and kills the process tree it can identify.
- Attempts are logged before agent startup, so crashes and billed failures remain visible.
- Provider cost is treated as eventually consistent and must stabilize before reconciliation.
- Raw prompts, agent output, and command output are not placed in public run records.

The harness is not a security sandbox. The agent runs as the operator's user, so final experiments must run in a disposable environment that holds no unrelated credentials or valuable files. Linux `/proc` support is required for the full process and credential checks.

## Economic probe

Run the probe before completing the paid path for a release family. It uses three controls and one pre-applied treatment to estimate whether any price can satisfy the sale rule, chain cost, price floor, and 25 percent buyer reduction at once.

A failed probe means the team should choose a larger or more failure-prone integration task instead of completing payment infrastructure for an uneconomic release. See [Economic Gates and Iterations](../../docs/economic-gates.md).

## Development

```bash
npm run test -w @lemma/benchmark
```

The process-isolation tests rely on Linux behavior for `/proc`, namespaces, and process-group cleanup. Run the final harness and its full test suite on the same Linux class used for measured runs.
