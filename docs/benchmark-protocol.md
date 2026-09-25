# Benchmark Protocol

## Question

Does Lemma reduce all-in cost-to-green for supported integration tasks without lowering correctness?

## Design

Use `@cursor/sdk` with explicit local runtime. Query available models once, select one model and parameter set, and freeze them before measured runs. Load no ambient settings: each run gets a fresh home directory and a fixture copy outside any repository, with nothing above it that carries Cursor settings. Project settings come from the fixture copy only, so the Lemma rule reaches the treatment as the one file that differs between arms.

The matrix contains three matched tasks with control and Lemma treatment arms, three repetitions per arm, plus one no-match task in both arms. Total: twenty runs.

## Controls

- Identical starting repository for each pair.
- Identical user task and acceptance tests.
- Fresh agent and fresh fixture copy per run.
- Same model, parameters, time budget, network policy, and machine. Both arms run with open network and the agent sandbox off. MCP tool calls fail closed under the sandbox, and the control may use open-source research.
- Each run is a separate process with an allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, `CI`). The API key is passed through stdin, so the agent's shell never sees a credential. The harness itself takes the key from a pipe and refuses to run agents while its environment holds credentials, because an unsandboxed agent can read the environment its ancestors started with.
- The run directory and everything above it hold no ambient agent settings (`.cursor`, `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`) and no enclosing repository.
- The harness owns each run's deadline and kills the run's whole process tree when it passes and when the run ends, so nothing one run started survives into the next.
- Treatment receives the installed Lemma rule and MCP bridge.
- Control can use its normal tools and open-source research.

## Measurements

- Input, output, cache read, cache write, and reasoning tokens, from the agent's billed usage (the same scope as cost). The SDK counts reasoning inside output; billed usage does not split it out, so reasoning stays inside output there.
- Raw and charged cost when the SDK reports them.
- Wall-clock duration.
- Tool calls and retries.
- Files changed.
- Acceptance outcome.
- Human interventions.
- x402 price, gas, payment hash, and warranty activation hash.

## Success criteria

- Both arms pass the same acceptance tests.
- Treatment median all-in raw cost is at least 25 percent lower.
- Treatment median total tokens are at least 25 percent lower.
- No correctness regression occurs.
- No-match treatment spends zero USDC.
- A paid response can be recovered without duplicate payment.

## Run validity

- A startup failure is an attempt whose fixture setup failed, whose agent run never began, or, for the treatment, whose bridge never initialized (no `initialize` line in the bridge trace). It is kept in the attempt log, excluded from pairs, and re-run once. A run that began and then failed or timed out is a result, not a startup failure.
- A treatment whose agent never called Lemma is a valid run. That outcome is part of what the product delivers.
- Cost is reconciled from billed usage after runs finish, and only once it has settled: reads at least five minutes after the run that agree for at least a minute, with billed tokens no fewer than the run reported. A run that did work is never recorded at zero cost because its billing has not landed. An attempt without a settled cost stays pending, never becomes a run record with an estimated cost, and blocks the report.
- An interrupted matrix or probe is resumed from its attempt log. Every run is logged before its agent starts, so an interrupted or crashed run is recorded too. A slot with a result is never run again, so no repetition is duplicated and no result can be re-rolled. A version is bound to one freeze, and a report fails any frozen task or slot without a result.

## Integrity rules

Freeze prompts, fixtures, releases, and analysis code before final runs (`benchmark freeze` records digests of the fixtures and the Lemma rule, and `benchmark run` refuses when they change). Keep every run, including failures. Do not combine exploratory runs with the final paired matrix: probe versions start with `probe-`, and `deriveEvidence` refuses them and `provisional-` versions. If the target is missed, report the measured result without claiming validated savings.

## Output

Raw records remain in the ignored `packages/benchmark/runs` directory. A scrubbed aggregate and machine-readable summary may be published after checking that no prompt, tool output, path, or environment field contains a credential.
