# Benchmark Protocol

## Question

Does Lemma reduce all-in cost-to-green for supported integration tasks without lowering correctness?

## Design

Use `@cursor/sdk` with explicit local runtime. Query available models once, select one model and parameter set, and freeze them before measured runs. Load no ambient settings.

The matrix contains three matched tasks with control and Lemma treatment arms, three repetitions per arm, plus one no-match task in both arms. Total: twenty runs.

## Controls

- Identical starting repository for each pair.
- Identical user task and acceptance tests.
- Fresh agent and fresh fixture copy per run.
- Same model, parameters, time budget, network policy, and machine.
- Treatment receives the installed Lemma rule and MCP bridge.
- Control can use its normal tools and open-source research.

## Measurements

- Input, output, cache read, cache write, and reasoning tokens.
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

## Integrity rules

Freeze prompts, fixtures, releases, and analysis code before final runs. Keep every run, including failures. Do not combine exploratory runs with the final paired matrix. If the target is missed, report the measured result without claiming validated savings.

## Output

Raw records remain in the ignored `packages/benchmark/runs` directory. A scrubbed aggregate and machine-readable summary may be published after checking that no prompt, tool output, path, or environment field contains a credential.
