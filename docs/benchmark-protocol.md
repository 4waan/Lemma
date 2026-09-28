# Benchmark Protocol

## Question

Does Lemma reduce all-in cost-to-green for supported integration tasks without lowering correctness?

## Design

A version runs one agent, chosen when it is frozen or its probe starts (`LEMMA_BENCHMARK_AGENT`): Cursor through `@cursor/sdk` with explicit local runtime, Claude Code, the installed `claude` CLI run headless (`claude -p`), or Codex, the installed OpenAI `codex` CLI run headless (`codex exec`). The version records the agent, its release, and for Claude Code and Codex the digest of its price table, and later commands refuse a different one, so a version never mixes agents, releases, or prices. Its evidence measures that agent and model only.

Check the chosen model once, select one model and parameter set (Claude Code and Codex take a model id only), and freeze them before measured runs. Load no ambient settings: each run gets a fresh home directory and a fixture copy outside any repository, with nothing above it that carries agent settings. Project settings come from the fixture copy only (Claude Code runs with `--setting-sources project`; Codex gets a fresh `CODEX_HOME` and refuses to run below system-wide settings in `/etc/codex`), so the Lemma rule reaches the treatment as the one file that differs between arms: `.cursor/rules/lemma.mdc` for Cursor, `.claude/rules/lemma.md` for Claude Code, `AGENTS.md` for Codex. A fixture that has its own file there is refused.

The matrix contains three matched tasks with control and Lemma treatment arms, three repetitions per arm, plus one no-match task in both arms. Total: twenty runs.

## Controls

- Identical starting repository for each pair.
- Identical user task and acceptance tests.
- Fresh agent and fresh fixture copy per run.
- Same model, parameters, time budget, network policy, and machine. Both arms run with open network and the agent sandbox off. MCP tool calls fail closed under the sandbox, and the control may use open-source research.
- Each run is a separate process with an allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, `CI`), and the agent's shell never sees a credential. Cursor's API key is passed through stdin. Claude Code never receives Anthropic's key: its API is the harness's metering proxy, reached with a token that works for that run only (see [Claude Code cost](#claude-code-cost)). Codex never receives OpenAI's key the same way (see [Codex cost](#codex-cost)). The harness itself takes the key from a pipe and refuses to run agents while its environment holds credentials, because an unsandboxed agent can read the environment its ancestors started with.
- The run directory and everything above it hold no ambient agent settings (`.cursor`, `.cursorrules`, `.claude`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`) and no enclosing repository.
- The agent cannot stop for permission prompts, so Claude Code runs with its permission checks off and its MCP servers limited to the run's own (`--strict-mcp-config`). Claude Code refuses to run that way as root, so the harness runs as a normal user. Codex runs with approvals and its sandbox off (`--dangerously-bypass-approvals-and-sandbox`), the run's MCP servers as the only ones in its configuration, their tools approved, and hosted web search disabled.
- The harness owns each run's deadline and kills the run's whole process tree when it passes and when the run ends, so nothing one run started survives into the next.
- Treatment receives the installed Lemma rule and MCP bridge.
- Control can use its normal tools and open-source research.

## Measurements

- Input, output, cache read, cache write, and reasoning tokens, from the agent's billed usage (the same scope as cost). The SDK counts reasoning inside output; billed usage does not split it out, so reasoning stays inside output there. For Claude Code and Codex, tokens come from the meter, and reasoning is the thinking or reasoning tokens a response reports, also inside output.
- Raw and charged cost when the SDK reports them. For Claude Code and Codex, the raw cost is the metered list-price cost below.
- Wall-clock duration.
- Tool calls and retries.
- Files changed.
- Acceptance outcome.
- Human interventions.
- x402 price, gas, payment hash, and warranty activation hash.

## Claude Code cost

Anthropic's API reports tokens, not cost, and Claude Code's own cost figure is an estimate, so the harness meters Claude Code runs. Claude Code's API base URL is a loopback proxy in the harness process. The run authenticates with a random token that stops working when the run ends, and the proxy passes its requests on with the real key. It passes on only the Messages API, token counting, and the model list, so a run cannot spend through an API the meter does not read. It reads the usage of every Messages API response, subagents and helper models included, and prices it from `packages/benchmark/prices/anthropic.json`: Anthropic's published list prices with their source and retrieval date. Cost is summed exactly in integers and rounded up to a whole micro-USD once per run.

The metered cost is the list price of the tokens at the standard service tier. It is not the invoice: it leaves out taxes, credits, and negotiated discounts. The cost is never approximated. A response the table cannot price exactly (an unknown model, the priority tier, fast mode, an inference region other than global or US, or sampling iterations), a response cut off before its final usage, or fewer metered tokens than Claude Code itself reported (traffic that went around the meter) leaves the run's cost unknown and its attempt pending. A response the agent abandons at its deadline is still billed, so the meter reads it to its end, for up to ten minutes.

Before a Claude Code version is bound, `freeze` and `probe` send the model one request for one output token with the real key. A key without API credit can still list models, so only a request that costs something shows that the runs could be paid for. A key that is refused, a model the key cannot use, or no credit left then stops the command before any run, with the reason. That request is not metered and is in no run's cost.

## Codex cost

Codex is metered the same way. Each run's Codex gets a model provider that the harness defines in the run's own `config.toml`: its base URL is the loopback meter's `/v1` and its key is the run's token, which Codex reads from one variable and keeps out of the agent's shell. The meter passes on only creating a Responses API response and the model list, and adds the real key; it drops any organization or project header, so the key's own account pays. It reads the usage of every response and prices it from `packages/benchmark/prices/openai.json`: OpenAI's list prices at the standard processing tier, with their source and retrieval date. Cached input and cache writes are parts of input and are priced at their own rates.

A reply the table cannot price exactly (an unknown model, a service tier other than the default, input above the standard context where long-context pricing starts, a hosted tool billed per call, or cache counts above the input they are part of), a reply cut off before its final usage, or fewer metered tokens than Codex itself reported leaves the run's cost unknown and its attempt pending, as for Claude Code.

Codex needs an OpenAI API key with API credit. A ChatGPT sign-in cannot be used: Codex would have to hold it where the agent can read it, and it reaches a private ChatGPT backend rather than the metered API. Before a Codex version is bound, `freeze` and `probe` ask the model for one short reply (at most 16 output tokens, in no run's cost), so a refused key, a model the key cannot use, or an account without credit stops the command before any run.

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
- Cost is reconciled from billed usage after runs finish, and only once it has settled: reads at least five minutes after the run that agree for at least a minute, with billed tokens no fewer than the run reported. A Claude Code or Codex meter record is final when its run ends, so it settles at the first reads after five minutes. A run that did work is never recorded at zero cost because its billing has not landed. An attempt without a settled cost stays pending, never becomes a run record with an estimated cost, and blocks the report.
- An interrupted matrix or probe is resumed from its attempt log. Every run is logged before its agent starts, so an interrupted or crashed run is recorded too. A slot with a result is never run again, so no repetition is duplicated and no result can be re-rolled. A version is bound to one freeze, and a report fails any frozen task or slot without a result.
- A Claude Code or Codex run cut short with the harness has no meter record, so its cost can never be known. The probe counts it as a run that measured nothing, replaces it, and waits only for the cost of the runs its verdict reads. In a matrix its attempt stays pending and blocks the report; deciding how a paired benchmark treats such a run is open.

## Integrity rules

Freeze prompts, fixtures, releases, and analysis code before final runs (`benchmark freeze` records digests of the fixtures and the Lemma rule and the agent's release, and `benchmark run` refuses when they change). Keep every run, including failures. Do not combine exploratory runs with the final paired matrix: probe versions start with `probe-`, and `deriveEvidence` refuses them and `provisional-` versions. If the target is missed, report the measured result without claiming validated savings.

## Output

Raw records remain in the ignored `packages/benchmark/runs` directory. A scrubbed aggregate and machine-readable summary may be published after checking that no prompt, tool output, path, or environment field contains a credential.
