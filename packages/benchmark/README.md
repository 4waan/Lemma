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

## Harness (implemented)

`<key source> | npm run benchmark -- <command>` after `npm run build`. The Cursor API key is read from standard input, which must be a pipe, for example `op read op://vault/cursor/key | npm run benchmark -- run v1`. It is never read from the environment (see "How a run is isolated").

| Command | What it does |
| --- | --- |
| `freeze <version> --tasks a,b,c --no-match d` | Freezes the matched tasks plus the no-match tasks (four here). Checks the fixtures, their kinds and the Lemma rule first, then checks `LEMMA_BENCHMARK_MODEL` against `Cursor.models.list()` and does a smoke run, which must report `rawCostCents > 0` (a token-priced model). Writes `experiments/<version>.json` with the model, tasks, repetitions and digests of the fixtures and the Lemma rule. Refuses a version that is already frozen or has runs, and a freeze with no matched task. The smoke run gets the same run-directory checks as every run. |
| `run <version>` | Refuses if a fixture or the rule changed since freeze. Runs the matrix with arms interleaved, and re-runs a slot once after a startup failure. Appends every attempt to `runs/<version>/attempts.jsonl`. Each run is logged in `started.jsonl` before the agent starts, with its agent id once it has one, so a run that was interrupted, crashed, or whose post-run step threw is still recorded (a billed failure, or a startup failure if the agent never started) and is not run again. It resumes from those logs: after an interruption, running it again finishes the matrix without repeating a slot. The version is bound to the freeze it started under (`runs/<version>/experiment.json`), and one command at a time holds its lock. |
| `reconcile <version>` | Reads billed usage with `Agent.getUsage(agentId)`, logs each read to `costs.jsonl`, and turns an attempt into a core `RunRecord` (`records.jsonl`) once its billing has settled (below). Cost that is unreported or still landing stays pending; it is never estimated. A usage lookup that fails leaves only that attempt pending. |
| `probe <probe-version> --task <taskId> --bundle <bundle.json>` | The stage-4 kill test: three control runs and one treatment run with the draft bundle pre-applied through core `planApply`. Prints the verdict, `maxPriceFor(S, C, g)` and the price to pre-register. A verdict decided on placeholder economics says so and is provisional. `probe.json` binds the version to its task, fixture, bundle and model. It resumes too: running the same command again only runs what is missing, then reconciles and decides. |
| `report <version>` | Refuses while any attempt is pending. A frozen task or slot with no result fails its task, and a report passes only with at least one matched task. Writes `reports/<version>.json`: verdicts and evidence only, each evidence entry with the adopted release and its base digest. |

How a run is isolated:

- **Processes.** Each run happens in a child process whose environment holds only `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ` and `CI`. The SDK's shell tool inherits that environment, so the API key reaches the child through stdin. `PATH` is the host's without relative entries, `node_modules/.bin` directories (which `npm run` prepends) or anything inside the repository, so fixture commands use the fixture's own tools.
- **Credentials.** The agent runs unsandboxed as the operator's user, so it can read the environment that the harness and its parents started with (`/proc/<pid>/environ`). The key therefore comes from a pipe, and `freeze`, `run` and `probe` refuse to start while their environment, or the one any readable ancestor started with, holds anything that looks like a credential: a name with a `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE`, `MNEMONIC`, `SEED` or `PAT` segment, names such as `PGPASSWORD`, `*_PWD`, `*_SESSION` and `*_RPC_URL`, a URL with credentials, or an authorization header value. `env -u NAME` is not enough, because the shell that ran it keeps its copy in `/proc`: start the harness from a session that never had them. Only the harness's own ancestors are checked: a shell that started it in the background and kept the key is not, so the check is a guard, not a guarantee. Everything else the user can read, the agent can read too: run the benchmark as a user, or on a machine, that holds nothing else of value.
- **Workspace.** Each run gets a fresh fixture copy and an empty home directory, outside the repository (`LEMMA_BENCH_DIR`, default the OS temp directory; symlinks are resolved first). Relative paths and the SDK's discovery of project settings therefore never reach the catalog or this repository. It is not a wall: with the sandbox off, an agent that searches the filesystem can still find this checkout, as it could find the public catalog through open-source research. The harness refuses to run if any directory above the run directory holds files the SDK loads from ancestors (`.cursor`, `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`) or a `.git`.
- **Process lifetime.** The harness owns each run's deadline: the fixture's time limit plus a grace period for the SDK to start and dispose. Past it, the child and everything it started are killed. The SDK starts its shells in separate process groups, so the harness kills the whole process tree, not one group; the child does the same before it exits, so a server the agent left running cannot leak into the next run. When a run ends, every process whose environment still carries the run's own home directory is killed too, which reaches what was detached or re-parented. A process that rewrote its own environment, or a host without `/proc`, escapes that. An interrupted harness kills its runs too. Dependency installs run with lifecycle scripts off on npm, pnpm and yarn (`--ignore-scripts` on classic, `--mode=skip-build` on berry).
- **Arms.** Both arms use an explicit local runtime, `settingSources: ["project"]` over the fixture copy, and the sandbox off. MCP tool calls fail closed under the sandbox, and the control may do open-source research. The treatment differs only in `.cursor/rules/lemma.mdc` in its copy and an explicit `mcpServers.lemma` entry for the bridge.
- **Startup failures.** An attempt is a startup failure when fixture setup failed, when the agent's run never began, or when a treatment's bridge never wrote its `initialize` line (it had no Lemma at all). A startup failure is kept in the attempt log, excluded from pairs, and re-run once. A run that began and then died, timed out or failed is not a startup failure: it was billed, and it counts. A treatment whose agent simply never called Lemma is a real result and stays in the pairs.
- **Tokens and cost.** Both come from the agent's billed usage, so every record measures the same scope whether the run finished, failed or timed out. The run's own token report is kept on the attempt as a cross-check. The SDK counts reasoning inside output, so where usage splits reasoning out, `output = outputTokens - reasoningTokens`; billed usage does not split it, so reasoning stays inside output. Cost is `round(rawCostCents * 10,000)` micro-USD.
- **Settled cost.** Provider cost is eventually consistent, so the first number reported can be partial. A cost is final only once reads taken at least five minutes after the run have agreed for at least a minute, and the billed tokens are no fewer than the run itself reported. An agent billed no tokens that still shows no cost after an hour is recorded at zero, but only when its run reported no tokens and made no tool calls; otherwise it stays pending.
- **Probe runs.** A probe counts only runs that finished or timed out. An agent error measures nothing, and with the bundle pre-applied, a treatment that failed at once would pass acceptance at almost no cost and fake a saving. Such runs are replaced, at most twice per arm. The verdict uses the earliest three controls and the earliest treatment, so running again cannot pick a better result, and it is `go` only if that treatment finished on its own.
- **What is kept.** Counts, digests and the acceptance exit code, and no command or agent output. `filesChanged` is measured before acceptance runs, so test output is not counted as the agent's work.

Payments and the adopted release come from two seams: `PaymentSource` (the payment work's spend ledger) and `AdoptionSource` (the bridge's resolution inbox). Until they exist, runs record neither, and a treatment without an adopted release produces no evidence.

The frozen fixtures for the x402 tasks are still to be written, together with the payment work, because their acceptance tests exercise payment gating.

## Workspace dependencies

- `@cursor/sdk` for controlled local agent runs. It is imported lazily, so tests never load it.
- `@lemma/core` for run-record schemas, identifiers, `planApply` and `maxPriceFor`.
- `@lemma/catalog` for reserved benchmark prefixes and the economics inputs.

## Environment variables

The harness reads the Cursor API key from a pipe on standard input, never from the environment, and needs `LEMMA_BENCHMARK_MODEL` for `freeze` and `probe`. `LEMMA_BENCH_DIR` moves the run directories, and `LEMMA_BRIDGE_COMMAND` and `LEMMA_API_URL` point the treatment's bridge. Treatment runs will also use the funded testnet buyer wallet, through the payment work's ledger rather than an environment variable.

## Development and tests

- `npm run build -w @lemma/benchmark`
- `npm run test -w @lemma/benchmark`
- `npm run benchmark -- <freeze|run|reconcile|probe|report> <version> ...` (see Harness)

## Security constraints

- Do not put credentials in prompts, command arguments, run records, or committed fixtures.
- Use explicit local runtime and empty ambient setting sources.
- Keep each run in a fresh fixture copy.
- Dispose SDK resources and distinguish startup failures from run failures.
- Treat provider cost as eventually consistent and retain token counts as an independent measure.

## Later completion criteria

This component is complete when the frozen twenty-run matrix is reproducible, raw records validate against a schema, all interventions are disclosed, and the report can be regenerated without hand-editing results.
