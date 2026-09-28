import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { AgentAdapter, AgentRunOutcome, AgentRunRequest, ToolCallSummary, UsageReport } from "./adapter.js";
import { superviseAgent } from "./agent-process.js";
import { type AnthropicPrices, type ResponseUsage, modelPrice, pricesDigest } from "./anthropic-usage.js";
import { MeterRecord, type MeterReading, MeteringProxy, anthropicApi } from "./meter.js";
import { childEnv, secretVariables } from "./process.js";
import type { ReportedUsage } from "./tokens.js";

export { EXIT_GRACE_MS, STOP_GRACE_MS } from "./agent-process.js";

/** Limit for the short run that checks a Claude plan's token before a probe. */
export const PLAN_CHECK_MS = 3 * 60_000;

/** Session ids are UUIDs; anything else is refused before it names a file. */
const AGENT_ID = /^[A-Za-z0-9-]{1,100}$/;

export interface ClaudeCodeOptions {
  /** Absolute path of the `claude` executable. Only `run` needs it. */
  readonly command: string | null;
  /** Where each run's meter record is kept for `usage`, one file per agent id. */
  readonly meterDir: string;
  readonly prices: AnthropicPrices;
  /**
   * The credential is a Claude plan's token (`claude setup-token`), not an API
   * key. Runs are metered and priced the same way; the check before a probe
   * is then one short real run, because a plan's token is only for Claude Code.
   */
  readonly plan?: boolean;
  /** The Anthropic API origin; tests point it at a stand-in. */
  readonly upstream?: string;
  readonly graceMs?: { readonly stop: number; readonly exit: number };
  /** How long the meter keeps reading a response the agent abandoned. */
  readonly drainMs?: number;
}

/**
 * Claude Code, run headless (`claude -p`), behind the AgentAdapter seam.
 *
 * The API key stays in the harness: Claude Code's API is a local metering
 * proxy (`MeteringProxy`) that it reaches with a per-run token, and the proxy
 * adds the key. So neither the agent's shell nor its file tools can find the
 * key, and every Messages API response of the run, subagents and helper
 * models included, is read for its usage and priced from the dated table in
 * `prices/anthropic.json`. That is the run's cost; it is never Claude Code's
 * own estimate.
 *
 * Each run gets the allowlisted environment of `childEnv` plus the proxy's URL
 * and token, project settings from the fixture copy only (`--setting-sources
 * project`, which loads the Lemma rule the treatment copy carries), the MCP
 * servers of the request and no others (`--strict-mcp-config`), permission
 * checks off (the agent cannot stop for prompts; Claude Code refuses this as
 * root), no saved session, and no non-essential traffic. The harness owns the
 * deadline: SIGTERM at the run's limit, then SIGKILL for the group, and every
 * process still carrying the run's home when it settles.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = "claude-code" as const;
  private readonly proxy: MeteringProxy<ResponseUsage>;
  private readonly pricesDigest: string;

  constructor(
    private readonly apiKey: string,
    private readonly options: ClaudeCodeOptions,
  ) {
    if (apiKey === "") throw new Error(options.plan === true ? "a Claude plan token is required" : "an Anthropic API key is required");
    this.proxy = new MeteringProxy({ apiKey, api: anthropicApi(options.prices, options.upstream, options.plan === true), ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }) });
    this.pricesDigest = pricesDigest(options.prices);
  }

  /**
   * Checks that the table prices `model` (a run on an unpriced model could
   * never be costed), then sends `model` one request for one output token, so
   * a key that is refused, lacks the model, or has no credit left fails here
   * with the reason instead of in every run. A key without credit can still
   * list models, so a free check would pass it. The request costs a small
   * fraction of a cent and is not part of any run's cost.
   */
  async checkModel(model: string): Promise<void> {
    if (modelPrice(this.options.prices, model) === undefined) throw new Error(`model ${model} is not in prices/anthropic.json; use an exact model id the table prices`);
    const url = `${(this.options.upstream ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "OK" }] }),
    });
    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    const error = await apiError(response);
    if (response.status === 401 || response.status === 403) throw new Error(`the Anthropic API refused the key (HTTP ${response.status})`);
    if (response.status === 404) throw new Error(`model ${model} is not available to this key`);
    if (/credit balance/i.test(error.message)) throw new Error("the key's organization has no API credit left; add credit in the Anthropic Console, then run the same command again");
    if (response.status === 429) throw new Error("the Anthropic API is rate limiting this key (HTTP 429); wait a minute, then run the same command again");
    if (response.status === 529) throw new Error("the Anthropic API is overloaded (HTTP 529); run the same command again later");
    throw new Error(`a one-token request to ${model} failed: HTTP ${response.status} ${error.type}`.trim());
  }

  /**
   * Checks a Claude plan's token with one short real run in `dir` (made the
   * way every run is, through the meter): the token, the model, a usage limit
   * already reached, and whether the meter can price the plan's replies. It
   * uses a sliver of the plan's usage and no money, and no meter record is kept.
   */
  async checkPlan(model: string, dir: string): Promise<void> {
    if (modelPrice(this.options.prices, model) === undefined) throw new Error(`model ${model} is not in prices/anthropic.json; use an exact model id the table prices`);
    const cwd = join(dir, "work");
    const home = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, "tmp"), { recursive: true });
    const { outcome, reading } = await this.runMetered({ cwd, home, prompt: "Reply with the word OK and nothing else.", model: { id: model }, mcpServers: {}, timeoutMs: PLAN_CHECK_MS }, false);
    if (outcome.status !== "finished") {
      const why = outcome.error ?? outcome.status;
      if (/HTTP 40[13]\b/.test(why)) throw new Error(`the Anthropic API refused the Claude plan token (${why}); make a new one with \`claude setup-token\``);
      if (/HTTP 429\b/.test(why) || /limit/i.test(why)) throw new Error(`the Claude plan is at a usage limit (${why}); run the same command again once it resets`);
      if (/HTTP 404\b/.test(why)) throw new Error(`model ${model} is not available on this Claude plan (${why})`);
      throw new Error(`a short check run on the Claude plan did not finish: ${why}`);
    }
    if (reading.responses === 0) throw new Error("the check run made no request through the meter, so its cost could not be measured");
    if (reading.incomplete > 0 || reading.unpriced.length > 0) throw new Error(`the meter could not price the Claude plan's replies: ${[...reading.unpriced, ...(reading.incomplete > 0 ? ["a reply stopped before its final usage"] : [])].join("; ")}`);
  }

  async run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return (await this.runMetered(request, true)).outcome;
  }

  /** One run; its meter record is written only when `keep` is set. */
  private async runMetered(request: AgentRunRequest, keep: boolean): Promise<{ outcome: AgentRunOutcome; reading: MeterReading }> {
    const startedAt = new Date().toISOString();
    const command = this.options.command;
    if (command === null) throw new Error("no claude executable was given to run agents with");
    if ((request.model.params ?? []).length > 0) throw new Error("Claude Code runs take a model id only, without parameters");
    // The MCP configuration is a command-line argument, which other users of the machine can read.
    for (const [name, server] of Object.entries(request.mcpServers)) {
      const secrets = secretVariables(server.env);
      if (secrets.length > 0) throw new Error(`MCP server ${name} would pass ${secrets.join(", ")} on Claude Code's command line`);
    }
    const baseUrl = await this.proxy.open();
    const token = `lemma-run-${randomBytes(24).toString("hex")}`;
    this.proxy.begin(token);

    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      request.model.id,
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(request.mcpServers).map(([name, s]) => [name, { type: "stdio", command: s.command, args: [...s.args], env: { ...s.env } }])) }),
      "--no-session-persistence",
    ];
    const env = {
      ...childEnv(request.home),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };

    const seen: RunSeen = { agentId: null, result: null, killedAtDeadline: false, spawnError: null, stderr: "", calls: new Map() };
    const ran = await superviseAgent({
      command,
      args,
      cwd: request.cwd,
      env,
      home: request.home,
      timeoutMs: request.timeoutMs,
      ...(this.options.graceMs === undefined ? {} : { graceMs: this.options.graceMs }),
      onLine: (line, ended) => {
        const event = parseLine(line);
        if (event === null) return;
        if (event.type === "system" && event.subtype === "init" && seen.agentId === null && typeof event.session_id === "string" && AGENT_ID.test(event.session_id)) {
          seen.agentId = event.session_id;
          request.onStarted?.(event.session_id);
        }
        trackTools(event, seen.calls);
        if (event.type === "result" && seen.result === null) {
          seen.result = event;
          ended();
        }
      },
    });
    seen.killedAtDeadline = ran.killedAtDeadline;
    seen.spawnError = ran.spawnError;
    seen.stderr = ran.stderr;

    // Every response the run started is read to its end before the run counts as over.
    const reading = await this.proxy.end(token);
    const usage = seen.result === null ? null : reportedUsage(seen.result);
    if (keep && seen.agentId !== null) {
      const record = MeterRecord.parse({
        schemaVersion: "1",
        agentId: seen.agentId,
        pricesDigest: this.pricesDigest,
        meteredAt: new Date().toISOString(),
        ...reading,
        reportedTokens: usage === null ? null : usage.totalTokens,
      });
      mkdirSync(this.options.meterDir, { recursive: true });
      const path = join(this.options.meterDir, `${seen.agentId}.json`);
      writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(`${path}.tmp`, path);
    }
    return { outcome: outcomeOf(startedAt, seen, usage), reading };
  }

  /** The run's metered usage and list-price cost (`readMeteredUsage`). */
  async usage(agentId: string): Promise<UsageReport | null> {
    return readMeteredUsage(this.options.meterDir, agentId, this.pricesDigest);
  }

  /** Stops the meter; runs cannot start afterwards. */
  close(): Promise<void> {
    return this.proxy.close();
  }
}

/**
 * The metered usage and list-price cost of a Claude Code run, from its meter
 * record; it needs no key, so `reconcile` reads it directly. Throws, so the
 * attempt stays pending with the reason, when the cost cannot be known: no
 * meter record (the harness stopped before the run ended), a response cut off
 * before its final usage, a response the table cannot price, a record priced
 * with another table, or fewer metered tokens than Claude Code itself
 * reported (traffic that went around the meter).
 */
export function readMeteredUsage(meterDir: string, agentId: string, pricesDigest: string): UsageReport {
  if (!AGENT_ID.test(agentId)) throw new Error(`${agentId} is not a Claude Code session id`);
  const path = join(meterDir, `${agentId}.json`);
  if (!existsSync(path)) throw new Error(`no meter record for ${agentId}: the harness stopped before the run was metered, so its cost cannot be known`);
  const record = MeterRecord.parse(JSON.parse(readFileSync(path, "utf8")));
  if (record.agentId !== agentId) throw new Error(`the meter record for ${agentId} names another run`);
  if (record.pricesDigest !== pricesDigest) throw new Error(`${agentId} was priced with another price table`);
  if (record.incomplete > 0) throw new Error(`${record.incomplete} responses of ${agentId} stopped before their final usage, so its cost cannot be known`);
  if (record.unpriced.length > 0) throw new Error(`${agentId} used what the price table cannot price: ${record.unpriced.join("; ")}`);
  if (record.reportedTokens !== null && record.usage.totalTokens < record.reportedTokens) {
    throw new Error(`Claude Code reported ${record.reportedTokens} tokens for ${agentId} and the meter saw ${record.usage.totalTokens}: some of its traffic went around the meter`);
  }
  // Whole micro-USD as cents: centsToMicroUsd rounds this back to the same integer.
  return { usage: record.usage, rawCostCents: Number(record.costMicroUsd) / 10_000 };
}

/** The installed Claude Code's version, from `claude --version`. */
export function claudeCodeVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/" }, stdio: ["ignore", "pipe", "ignore"] });
  const version = /^(\d+\.\d+\.\d+)\b/.exec((result.stdout ?? "").trim())?.[1];
  if (result.status !== 0 || version === undefined) throw new Error(`${command} --version did not print a version`);
  return version;
}

/** An absolute path to `claude`: `LEMMA_CLAUDE_COMMAND` when set, else the first executable on PATH. */
export function findClaudeCode(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env["LEMMA_CLAUDE_COMMAND"];
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit)) throw new Error("LEMMA_CLAUDE_COMMAND must be an absolute path");
    return explicit;
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  throw new Error("claude is not on PATH; install Claude Code or set LEMMA_CLAUDE_COMMAND to its absolute path");
}

/** The type and message of an Anthropic API error reply, or empty strings when it has none. */
async function apiError(response: Response): Promise<{ type: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { type?: unknown; message?: unknown } };
    return { type: typeof body.error?.type === "string" ? body.error.type : "", message: typeof body.error?.message === "string" ? body.error.message : "" };
  } catch {
    return { type: "", message: "" };
  }
}

/** One line of `claude -p --output-format stream-json`, as far as the harness reads it. */
interface StreamEvent {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly session_id?: unknown;
  readonly is_error?: unknown;
  readonly errors?: unknown;
  /** The run's final text; on an error result, what went wrong (for example "Credit balance is too low"). */
  readonly result?: unknown;
  readonly api_error_status?: unknown;
  readonly message?: { readonly content?: unknown };
  readonly usage?: Record<string, unknown>;
  readonly modelUsage?: Record<string, Record<string, unknown>>;
}

function parseLine(line: string): StreamEvent | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? (value as StreamEvent) : null;
  } catch {
    return null;
  }
}

/** Tool calls from assistant messages (`tool_use`, `server_tool_use`) and their results. */
function trackTools(event: StreamEvent, calls: Map<string, ToolCallSummary>): void {
  if (!Array.isArray(event.message?.content)) return;
  for (const block of event.message.content as Array<Record<string, unknown>>) {
    if (typeof block !== "object" || block === null) continue;
    if ((block["type"] === "tool_use" || block["type"] === "server_tool_use") && typeof block["id"] === "string") {
      calls.set(block["id"], { callId: block["id"], name: typeof block["name"] === "string" ? block["name"] : "unknown", status: "running" });
    } else if (typeof block["type"] === "string" && block["type"].endsWith("tool_result") && typeof block["tool_use_id"] === "string") {
      const call = calls.get(block["tool_use_id"]);
      if (call !== undefined) calls.set(call.callId, { ...call, status: block["is_error"] === true ? "error" : "completed" });
    }
  }
}

const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The tokens Claude Code reported for the run: every model it used (`modelUsage`), else its main `usage`. */
function reportedUsage(result: StreamEvent): ReportedUsage | null {
  const models = result.modelUsage !== undefined && result.modelUsage !== null ? Object.values(result.modelUsage) : [];
  const sum = (field: string) => models.reduce((total, m) => total + count(m[field]), 0);
  if (models.length > 0) {
    const inputTokens = sum("inputTokens");
    const outputTokens = sum("outputTokens");
    const cacheReadTokens = sum("cacheReadInputTokens");
    const cacheWriteTokens = sum("cacheCreationInputTokens");
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens };
  }
  const u = result.usage;
  if (u === undefined || u === null) return null;
  const inputTokens = count(u["input_tokens"]);
  const outputTokens = count(u["output_tokens"]);
  const cacheReadTokens = count(u["cache_read_input_tokens"]);
  const cacheWriteTokens = count(u["cache_creation_input_tokens"]);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens };
}

interface RunSeen {
  agentId: string | null;
  result: StreamEvent | null;
  killedAtDeadline: boolean;
  spawnError: string | null;
  stderr: string;
  readonly calls: Map<string, ToolCallSummary>;
}

/**
 * Why a result is not a success. An API error that ends the run (no credit, a
 * refused key) comes as subtype "success" with `is_error` set, the API's
 * message as its result text, and the HTTP status.
 */
function resultError(result: StreamEvent): string {
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
  const text = result.is_error === true && typeof result.result === "string" ? result.result.trim() : "";
  const status = typeof result.api_error_status === "number" ? ` (API HTTP ${result.api_error_status})` : "";
  const kind = result.subtype === "success" || typeof result.subtype !== "string" ? "error" : result.subtype;
  return `${[kind, ...(text === "" ? [] : [text]), ...errors].join(": ")}${status}`.slice(0, 500);
}

function outcomeOf(startedAt: string, seen: RunSeen, usage: ReportedUsage | null): AgentRunOutcome {
  const finishedAt = new Date().toISOString();
  const toolCalls = [...seen.calls.values()];
  if (seen.agentId === null) {
    const error = seen.spawnError ?? (seen.stderr.trim() || (seen.killedAtDeadline ? "the agent did not start before its deadline" : "the agent process ended before the run started"));
    return { agentId: null, status: "startup-error", startedAt, finishedAt, toolCalls: [], usage: null, error };
  }
  const result = seen.result;
  // Stopped at its deadline, whatever it printed on the way out: the agent spent its whole budget.
  if (result !== null && !seen.killedAtDeadline) {
    const ok = result.subtype === "success" && result.is_error !== true;
    return { agentId: seen.agentId, status: ok ? "finished" : "error", startedAt, finishedAt, toolCalls, usage, error: ok ? null : resultError(result) };
  }
  // The run began, so it is billed and it counts: it timed out or failed, it did not fail to start.
  return {
    agentId: seen.agentId,
    status: seen.killedAtDeadline ? "timeout" : "error",
    startedAt,
    finishedAt,
    toolCalls,
    usage,
    error: seen.killedAtDeadline ? "the agent passed its deadline and was stopped" : "the agent process ended without a result",
  };
}
