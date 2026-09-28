# Lemma Benchmark

`@lemma/benchmark` tests Lemma's central claim: a paid Compatibility Resolution should reduce all-in cost-to-green without reducing correctness.

The harness, run records, evidence derivation, economic probe, and report generator are implemented. The first task, `weather-mcp-paid-forecast`, is committed ([fixtures/README.md](fixtures/README.md)); the other tasks and the measured experiment remain pending.

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

The agent is Cursor unless `LEMMA_BENCHMARK_AGENT=claude-code` selects Claude Code or `LEMMA_BENCHMARK_AGENT=codex` selects Codex when a version is frozen or its probe starts; later commands use the agent the version recorded and refuse a different release. The agent's API key (Cursor's, Anthropic's for Claude Code, or OpenAI's for Codex) is read from a pipe on standard input. It is never accepted from an environment variable or command argument. `LEMMA_BENCHMARK_MODEL` selects the frozen model. `LEMMA_CLAUDE_COMMAND` and `LEMMA_CODEX_COMMAND` are the absolute paths of `claude` and `codex` when the first one on `PATH` is not the one to use. `LEMMA_BENCH_DIR` can move run data outside the operating-system temporary directory.

Claude Code runs have their cost metered by the harness at the dated list prices in `prices/anthropic.json`; see [Claude Code cost](../../docs/benchmark-protocol.md#claude-code-cost). They need an Anthropic API key (a Claude subscription login cannot be metered at API prices), and the harness must run as a normal user, because Claude Code refuses to skip its permission prompts as root. Reconciling them reads their meter records and needs no key.

Codex runs are metered the same way at the dated list prices in `prices/openai.json`; see [Codex cost](../../docs/benchmark-protocol.md#codex-cost). They need an OpenAI API key with API credit, from platform.openai.com. A probe alone can run on a ChatGPT plan instead, with `LEMMA_CODEX_LOGIN=chatgpt` after `codex login --device-auth`: no key is read, and its cost is Codex's own token counts at list price, not metered (see [Codex cost](../../docs/benchmark-protocol.md#codex-cost)). The table prices `gpt-5.5`; add a model only with its published prices, which makes a new table digest.

## Evidence derivation

`deriveEvidence` pairs control and treatment by repetition and requires at least three complete pairs with one model, benchmark version, and fixture. It uses the lower quartile of paired raw-cost savings, clamped between zero and the control median, as the conservative saving.

`evaluateBenchmark` applies the correctness, cost, token, and no-match criteria per task. A miss remains in the report with its measured values. The harness never turns a failed benchmark into a sellable claim.

Every evidence object cites the digest of the exact run set and the base release that was measured. Catalog validation checks that binding before a public release can carry evidence.

## Isolation and records

- Each run gets a fresh fixture copy and empty home outside the repository.
- The agent process receives a small allowlisted environment. Cursor receives the API key only through standard input; Claude Code and Codex never receive it, only a per-run token for the harness's metering proxy.
- Dependency lifecycle scripts are disabled.
- The harness owns the deadline and kills the process tree it can identify.
- Attempts are logged before agent startup, so crashes and billed failures remain visible.
- Provider cost is treated as eventually consistent and must stabilize before reconciliation.
- Raw prompts, agent output, and command output are not placed in public run records.

The harness is not a security sandbox. The agent runs as the operator's user, so final experiments must run in a disposable environment that holds no unrelated credentials or valuable files. Linux `/proc` support is required for the full process and credential checks: without it (macOS, for example), a process the agent detached into a session of its own outlives its run, and the check for credentials in an ancestor's environment has nothing to read. Measured runs therefore use Linux.

## Economic probe

Run the probe before completing the paid path for a release family. It uses three controls and one pre-applied treatment to estimate whether any price can satisfy the sale rule, chain cost, price floor, and 25 percent buyer reduction at once.

A failed probe means the team should choose a larger or more failure-prone integration task instead of completing payment infrastructure for an uneconomic release. See [Economic Gates and Iterations](../../docs/economic-gates.md).

The first probe measures `mcp-server-payment-gating@0.1.0` on `weather-mcp-paid-forecast`. On a Linux machine whose environment holds no credentials, after `npm ci && npm run build`:

```bash
<command that prints your Cursor API key> | LEMMA_BENCHMARK_MODEL=<model id> npm run benchmark -- probe probe-1 \
  --task weather-mcp-paid-forecast \
  --bundle packages/catalog/releases/mcp-server-payment-gating/0.1.0/bundle.json
```

Or with Claude Code installed, as a normal user:

```bash
<command that prints your Anthropic API key> | LEMMA_BENCHMARK_AGENT=claude-code LEMMA_BENCHMARK_MODEL=claude-sonnet-5 \
  npm run benchmark -- probe probe-1 \
  --task weather-mcp-paid-forecast \
  --bundle packages/catalog/releases/mcp-server-payment-gating/0.1.0/bundle.json
```

Or with the OpenAI Codex CLI installed:

```bash
<command that prints your OpenAI API key> | LEMMA_BENCHMARK_AGENT=codex LEMMA_BENCHMARK_MODEL=gpt-5.5 \
  npm run benchmark -- probe probe-codex-1 \
  --task weather-mcp-paid-forecast \
  --bundle packages/catalog/releases/mcp-server-payment-gating/0.1.0/bundle.json
```

It runs three controls and one treatment with the bundle pre-applied, billed to the key's account, then prints the verdict and writes it to `packages/benchmark/runs/probe-1/probe-weather-mcp-paid-forecast.json` (git-ignored). Before the version is bound or any run starts, it checks the key and the model; for Claude Code that is one request for one output token, and for Codex one reply of at most 16 tokens (a small fraction of a cent, in no run's cost), so a refused key, a model the key cannot use, or an organization with no API credit fails at once with the reason, and the same command works once that is fixed. Each run prints a line when it starts and one when it ends, and nothing in between; a run can take up to the task's 30-minute limit. A run that measured nothing (an agent error, or a run cut short by stopping the harness) is replaced, up to two extra attempts per arm, and the probe does not wait for its cost. If billing has not settled, running the same command again later only settles and decides. The verdict uses the price floor and chain cost in `packages/catalog/economics.json`: while `g` is still a placeholder of 0, a `go` is optimistic by one resolution's gas.

## Development

```bash
npm run test -w @lemma/benchmark
```

The process-isolation tests rely on Linux behavior for `/proc`, namespaces, and process-group cleanup. Elsewhere, the tests that need them skip with the reason; CI runs all of them on Linux and the rest on macOS too. Run the final harness and its full test suite on the same Linux class used for measured runs.
