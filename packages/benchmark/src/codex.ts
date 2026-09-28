import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { AgentAdapter, AgentRunOutcome, AgentRunRequest, McpStdioServer, ToolCallSummary, UsageReport } from "./adapter.js";
import { superviseAgent } from "./agent-process.js";
import { unitsToMicroUsd } from "./anthropic-usage.js";
import { MeterRecord, type MeterReading, MeteringProxy, openAiApi } from "./meter.js";
import { type OpenAiPrices, type OpenAiReply, openAiModelPrice, openAiPricesDigest, openAiResponseCost } from "./openai-usage.js";
import { childEnv, secretVariables } from "./process.js";
import type { ReportedUsage } from "./tokens.js";

/** Thread ids are UUIDs; anything else is refused before it names a file. */
const AGENT_ID = /^[A-Za-z0-9-]{1,100}$/;
/** The model provider the harness defines for each run: the meter, not OpenAI. */
const PROVIDER = "lemma-meter";
/** The variable Codex reads the run's meter token from (`env_key`); Codex keeps names like it out of the agent's shell. */
const TOKEN_VARIABLE = "LEMMA_METER_TOKEN";
/** Codex reads system-wide settings here; the harness refuses to run Codex below them. */
const SYSTEM_CONFIG_DIR = "/etc/codex";
/** How long the ChatGPT login check's one short run may take. */
const LOGIN_CHECK_MS = 120_000;

export interface CodexOptions {
  /** Absolute path of the `codex` executable. Only `run` needs it. */
  readonly command: string | null;
  /** Where each run's meter record is kept for `usage`, one file per agent id. */
  readonly meterDir: string;
  readonly prices: OpenAiPrices;
  /** The OpenAI API origin; tests point it at a stand-in. */
  readonly upstream?: string;
  readonly graceMs?: { readonly stop: number; readonly exit: number };
  /** How long the meter keeps reading a response the agent abandoned. */
  readonly drainMs?: number;
  /** Where Codex's system-wide settings would be (tests only). */
  readonly systemConfigDir?: string;
  /**
   * Run on a ChatGPT plan login instead of an API key: the `CODEX_HOME` that
   * `codex login` wrote its `auth.json` to. Probes only (see `CodexAdapter`).
   */
  readonly chatgptLogin?: string;
}

/**
 * OpenAI Codex CLI, run headless (`codex exec --json`), behind the
 * AgentAdapter seam.
 *
 * It is metered the way Claude Code is (`ClaudeCodeAdapter`): the OpenAI API
 * key stays in the harness, and Codex's model provider is a local metering
 * proxy that it reaches with a per-run token; the proxy adds the key. Every
 * Responses API reply of the run is read for its usage and priced from the
 * dated table in `prices/openai.json`. That is the run's cost; Codex reports
 * no cost of its own.
 *
 * Each run gets the allowlisted environment of `childEnv` plus the run token
 * and a fresh `CODEX_HOME` inside the run's home, whose `config.toml` the
 * harness writes: the metering provider, the MCP servers of the request and no
 * others (their tools approved without prompts), no hosted web search (it is
 * billed per call, which the table does not price), no history, analytics,
 * feedback or update checks. Codex runs with approvals and its sandbox off
 * (`--dangerously-bypass-approvals-and-sandbox`: the agent cannot stop for
 * prompts, and the protocol runs agents unsandboxed), without saved sessions
 * (`--ephemeral`), and without user or project exec-policy rules. The prompt
 * goes to Codex on standard input, so it never appears in the process list.
 * The treatment's Lemma rule is the fixture copy's `AGENTS.md`, which Codex
 * reads as project instructions. The harness owns the deadline
 * (`superviseAgent`).
 *
 * With `chatgptLogin`, for probes only, Codex runs on the helper's ChatGPT
 * plan and talks to OpenAI itself: no meter can sit in front of it, and the
 * login is copied into each run's `CODEX_HOME`, where the agent can read it
 * (a refreshed login is copied back). The run's cost is Codex's own token
 * counts for the thread at list price: from `turn.completed`, or, for a run
 * stopped at its deadline, from the last token count in the session log that
 * Codex keeps in the run's home (a reply cut off at the deadline is then not
 * counted). Subagents are turned off, because their tokens are not in the
 * thread's counts. Counts of zero, a run Codex moved to another model, and a
 * run that used subagents or web search anyway leave the cost unknown
 * (`uncounted`).
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  private readonly proxy: MeteringProxy<OpenAiReply> | null;
  private readonly pricesDigest: string;

  /** `apiKey` is null exactly when the options name a ChatGPT login. */
  constructor(
    private readonly apiKey: string | null,
    private readonly options: CodexOptions,
  ) {
    if ((apiKey === null) !== (options.chatgptLogin !== undefined)) throw new Error("Codex runs on an OpenAI API key or on a ChatGPT login, exactly one");
    if (apiKey === "") throw new Error("an OpenAI API key is required");
    this.proxy = apiKey === null ? null : new MeteringProxy({ apiKey, api: openAiApi(options.prices, options.upstream), ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }) });
    this.pricesDigest = openAiPricesDigest(options.prices);
  }

  /**
   * For a ChatGPT login, the check before a probe: the table prices `model`,
   * `codex login status` says Codex is signed in with ChatGPT, and one short
   * run on `model` ends normally. That run is a real one, made the way every
   * run is, in `scratchDir` (an empty directory outside the repository, which
   * the caller removes), so a model the plan cannot use, a usage limit already
   * reached, or a Codex that cannot start stops the probe before it binds its
   * version or spends a run. It uses a sliver of the plan's usage, no money,
   * and is in no run's cost.
   */
  async checkLogin(model: string, scratchDir: string): Promise<void> {
    const login = this.options.chatgptLogin;
    if (login === undefined) throw new Error("this Codex adapter runs on an API key");
    if (openAiModelPrice(this.options.prices, model) === undefined) throw new Error(`model ${model} is not in prices/openai.json; use an exact model id the table prices`);
    const command = this.options.command;
    if (command === null) throw new Error("no codex executable was given to run agents with");
    if (!existsSync(join(login, "auth.json"))) throw new Error(`no Codex login in ${login}: run \`codex login --device-auth\` as this user first`);
    const status = spawnSync(command, ["login", "status"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/", CODEX_HOME: login }, stdio: ["ignore", "pipe", "pipe"] });
    const said = `${status.stdout ?? ""}${status.stderr ?? ""}`.trim();
    if (status.status !== 0) throw new Error(`Codex is not signed in (codex login status: ${said.slice(0, 200) || `exit ${status.status}`}); run \`codex login --device-auth\` as this user first`);
    // Not quoted: for a key login, the status line shows part of the key.
    if (!/chatgpt/i.test(said)) throw new Error("Codex is signed in here, but not with ChatGPT; run `codex logout`, then `codex login --device-auth`, as this user");
    const cwd = join(scratchDir, "work");
    const home = join(scratchDir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, "tmp"), { recursive: true });
    const outcome = await this.execute({ cwd, home, prompt: "Reply with the single word OK and do nothing else.", model: { id: model }, mcpServers: {}, timeoutMs: LOGIN_CHECK_MS }, false);
    if (outcome.status !== "finished") throw new Error(`a short Codex run on ${model} with this login ended with ${outcome.status}: ${outcome.error ?? "no reason given"}`);
  }

  /**
   * Checks that the table prices `model` (a run on an unpriced model could
   * never be costed), then asks `model` for one short reply, so a key that is
   * refused, lacks the model, or has no credit left fails here with the reason
   * instead of in every run. The request costs a small fraction of a cent and
   * is not part of any run's cost.
   */
  async checkModel(model: string): Promise<void> {
    if (this.apiKey === null) throw new Error("a ChatGPT login is checked with checkLogin");
    if (openAiModelPrice(this.options.prices, model) === undefined) throw new Error(`model ${model} is not in prices/openai.json; use an exact model id the table prices`);
    const url = `${(this.options.upstream ?? "https://api.openai.com").replace(/\/+$/, "")}/v1/responses`;
    // 16 is the smallest output limit the API accepts; a reply cut off there still proves the key can use the model.
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Reply with OK.", max_output_tokens: 16, store: false }),
    });
    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    const error = await apiError(response);
    if (response.status === 401) throw new Error("the OpenAI API refused the key (HTTP 401)");
    if (error.code === "insufficient_quota") throw new Error("the key's OpenAI account has no API credit left (a ChatGPT plan does not include API credit); add credit at platform.openai.com under Billing, then run the same command again");
    if (response.status === 404 || error.code === "model_not_found") throw new Error(`model ${model} is not available to this key`);
    if (response.status === 403) throw new Error(`the key may not use ${model} (HTTP 403)${error.message === "" ? "" : `: ${error.message.slice(0, 200)}`}`);
    if (response.status === 429) throw new Error("the OpenAI API is rate limiting this key (HTTP 429); wait a minute, then run the same command again");
    if (response.status >= 500) throw new Error(`the OpenAI API failed (HTTP ${response.status}); run the same command again later`);
    throw new Error(`a short request to ${model} failed: HTTP ${response.status} ${error.type || error.code}`.trim());
  }

  run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return this.execute(request, true);
  }

  /** One Codex run; `keepRecord` false leaves no meter record (the login check's run). */
  private async execute(request: AgentRunRequest, keepRecord: boolean): Promise<AgentRunOutcome> {
    const startedAt = new Date().toISOString();
    const command = this.options.command;
    if (command === null) throw new Error("no codex executable was given to run agents with");
    if ((request.model.params ?? []).length > 0) throw new Error("Codex runs take a model id only, without parameters");
    const systemConfig = this.options.systemConfigDir ?? SYSTEM_CONFIG_DIR;
    if (existsSync(systemConfig)) throw new Error(`${systemConfig} holds system-wide Codex settings that every run would load; run where it does not exist`);
    // The MCP configuration is a file in the run's home, which the agent can read.
    for (const [name, server] of Object.entries(request.mcpServers)) {
      const secrets = secretVariables(server.env);
      if (secrets.length > 0) throw new Error(`MCP server ${name} would put ${secrets.join(", ")} in Codex's configuration`);
    }
    const codexHome = join(request.home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const login = this.options.chatgptLogin;
    let token: string | null = null;
    let env: Record<string, string>;
    const args = ["exec", "--json", "--skip-git-repo-check", "--ignore-rules", "--dangerously-bypass-approvals-and-sandbox", "--cd", request.cwd, "--model", request.model.id, "-"];
    if (this.proxy !== null) {
      const baseUrl = await this.proxy.open();
      token = `lemma-run-${randomBytes(24).toString("hex")}`;
      this.proxy.begin(token);
      writeFileSync(join(codexHome, "config.toml"), codexConfig({ baseUrl: `${baseUrl}/v1` }, request.model.id, request.mcpServers));
      // No session log: the meter has the run's usage.
      args.splice(3, 0, "--ephemeral");
      env = { ...childEnv(request.home), CODEX_HOME: codexHome, [TOKEN_VARIABLE]: token };
    } else {
      writeFileSync(join(codexHome, "config.toml"), codexConfig("chatgpt", request.model.id, request.mcpServers));
      copyLogin(join(login as string, "auth.json"), join(codexHome, "auth.json"));
      env = { ...childEnv(request.home), CODEX_HOME: codexHome };
    }

    const seen: RunSeen = { agentId: null, result: null, failure: null, lastError: null, rerouted: null, calls: new Map() };
    const ran = await superviseAgent({
      command,
      args,
      cwd: request.cwd,
      env,
      home: request.home,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      ...(this.options.graceMs === undefined ? {} : { graceMs: this.options.graceMs }),
      onLine: (line, ended) => {
        const event = parseLine(line);
        if (event === null) return;
        if (event.type === "thread.started" && seen.agentId === null && typeof event.thread_id === "string" && AGENT_ID.test(event.thread_id)) {
          seen.agentId = event.thread_id;
          request.onStarted?.(event.thread_id);
        }
        trackItem(event, seen.calls);
        if (event.type === "error" && typeof event.message === "string") seen.lastError = event.message;
        // Codex says so in an error item: "model rerouted: <from> -> <to> (<reason>)".
        const said = event.type === "item.completed" && event.item?.type === "error" ? event.item.message : undefined;
        if (seen.rerouted === null && typeof said === "string" && said.startsWith("model rerouted")) seen.rerouted = said.slice(0, 200);
        if (seen.result === null && seen.failure === null) {
          if (event.type === "turn.completed") {
            seen.result = event;
            ended();
          } else if (event.type === "turn.failed") {
            seen.failure = typeof event.error?.message === "string" && event.error.message !== "" ? event.error.message : (seen.lastError ?? "turn failed");
            ended();
          }
        }
      },
    });

    const usage = reportedUsage(counted(seen.result?.usage));
    let reading: MeterReading;
    if (this.proxy !== null && token !== null) {
      // Every response the run started is read to its end before the run counts as over.
      reading = await this.proxy.end(token);
    } else {
      // Codex may have refreshed the login during the run; the next run needs the refreshed one.
      copyLogin(join(codexHome, "auth.json"), join(login as string, "auth.json"), true);
      reading = agentReading(this.options.prices, request.model.id, counted(seen.result?.usage) ?? counted(lastSessionUsage(join(codexHome, "sessions"))), uncounted(seen));
    }
    if (seen.agentId !== null && keepRecord) {
      const record = MeterRecord.parse({
        schemaVersion: "1",
        agentId: seen.agentId,
        pricesDigest: this.pricesDigest,
        meteredAt: new Date().toISOString(),
        ...reading,
        reportedTokens: usage === null ? null : usage.totalTokens,
        ...(this.proxy === null ? { source: "agent" } : {}),
      });
      mkdirSync(this.options.meterDir, { recursive: true });
      const path = join(this.options.meterDir, `${seen.agentId}.json`);
      writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(`${path}.tmp`, path);
    }
    return outcomeOf(startedAt, seen, ran, usage);
  }

  /** The run's metered usage and list-price cost (`readCodexMeteredUsage`). */
  async usage(agentId: string): Promise<UsageReport | null> {
    return readCodexMeteredUsage(this.options.meterDir, agentId, this.pricesDigest);
  }

  /** Stops the meter; runs cannot start afterwards. */
  close(): Promise<void> {
    return this.proxy?.close() ?? Promise.resolve();
  }
}

/**
 * The metered usage and list-price cost of a Codex run, from its meter record;
 * it needs no key, so `reconcile` reads it directly. Throws, so the attempt
 * stays pending with the reason, when the cost cannot be known: no meter
 * record, a reply cut off before its final usage (for a ChatGPT-login run:
 * no token counts at all), a reply the table cannot price, a record priced
 * with another table, or fewer metered tokens than Codex itself reported
 * (traffic that went around the meter).
 */
export function readCodexMeteredUsage(meterDir: string, agentId: string, pricesDigest: string): UsageReport {
  if (!AGENT_ID.test(agentId)) throw new Error(`${agentId} is not a Codex thread id`);
  const path = join(meterDir, `${agentId}.json`);
  if (!existsSync(path)) throw new Error(`no meter record for ${agentId}: the harness stopped before the run was metered, so its cost cannot be known`);
  const record = MeterRecord.parse(JSON.parse(readFileSync(path, "utf8")));
  if (record.agentId !== agentId) throw new Error(`the meter record for ${agentId} names another run`);
  if (record.pricesDigest !== pricesDigest) throw new Error(`${agentId} was priced with another price table`);
  if (record.incomplete > 0) {
    throw new Error(record.source === "agent" ? `Codex reported no token counts for ${agentId}, so its cost cannot be known` : `${record.incomplete} responses of ${agentId} stopped before their final usage, so its cost cannot be known`);
  }
  if (record.unpriced.length > 0) throw new Error(`${agentId} used what the price table cannot price: ${record.unpriced.join("; ")}`);
  if (record.reportedTokens !== null && record.usage.totalTokens < record.reportedTokens) {
    throw new Error(`Codex reported ${record.reportedTokens} tokens for ${agentId} and the meter saw ${record.usage.totalTokens}: some of its traffic went around the meter`);
  }
  // Whole micro-USD as cents: centsToMicroUsd rounds this back to the same integer.
  return { usage: record.usage, rawCostCents: Number(record.costMicroUsd) / 10_000 };
}

/** A TOML basic string: JSON's escapes are all valid TOML. */
const toml = (value: string): string => JSON.stringify(value);

/**
 * The `config.toml` of one run's fresh `CODEX_HOME`: the metering provider at
 * `baseUrl`, or, on a ChatGPT login, OpenAI's own provider signed in with
 * ChatGPT from `auth.json`, with subagents off.
 */
export function codexConfig(provider: { readonly baseUrl: string } | "chatgpt", model: string, mcpServers: Readonly<Record<string, McpStdioServer>>): string {
  const lines = [
    `model = ${toml(model)}`,
    ...(provider === "chatgpt" ? [`forced_login_method = "chatgpt"`, `cli_auth_credentials_store = "file"`] : [`model_provider = ${toml(PROVIDER)}`]),
    `web_search = "disabled"`,
    "check_for_update_on_startup = false",
    "",
    "[history]",
    `persistence = "none"`,
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    ...(provider === "chatgpt"
      ? ["", "[features]", "multi_agent = false"]
      : ["", `[model_providers.${PROVIDER}]`, `name = ${toml(PROVIDER)}`, `base_url = ${toml(provider.baseUrl)}`, `env_key = ${toml(TOKEN_VARIABLE)}`, `wire_api = "responses"`]),
  ];
  for (const [name, server] of Object.entries(mcpServers)) {
    lines.push("", `[mcp_servers.${toml(name)}]`, `command = ${toml(server.command)}`, `args = [${server.args.map(toml).join(", ")}]`, `default_tools_approval_mode = "approve"`);
    const env = Object.entries(server.env);
    if (env.length > 0) lines.push(`env = { ${env.map(([k, v]) => `${toml(k)} = ${toml(v)}`).join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

/** The installed Codex's version, from `codex --version` (`codex-cli 0.158.0`). */
export function codexVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/" }, stdio: ["ignore", "pipe", "ignore"] });
  const version = /^(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec((result.stdout ?? "").trim())?.[1];
  if (result.status !== 0 || version === undefined) throw new Error(`${command} --version did not print a version`);
  return version;
}

/** An absolute path to `codex`: `LEMMA_CODEX_COMMAND` when set, else the first executable on PATH. */
export function findCodex(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env["LEMMA_CODEX_COMMAND"];
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit)) throw new Error("LEMMA_CODEX_COMMAND must be an absolute path");
    return explicit;
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  throw new Error("codex is not on PATH; install the Codex CLI or set LEMMA_CODEX_COMMAND to its absolute path");
}

/** The type, code and message of an OpenAI API error reply, or empty strings when it has none. */
async function apiError(response: Response): Promise<{ type: string; code: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { type?: unknown; code?: unknown; message?: unknown } };
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return { type: text(body.error?.type), code: text(body.error?.code), message: text(body.error?.message) };
  } catch {
    return { type: "", code: "", message: "" };
  }
}

/** One line of `codex exec --json`, as far as the harness reads it. */
interface ThreadEvent {
  readonly type?: unknown;
  readonly thread_id?: unknown;
  readonly message?: unknown;
  readonly error?: { readonly message?: unknown };
  readonly item?: { readonly id?: unknown; readonly type?: unknown; readonly status?: unknown; readonly server?: unknown; readonly tool?: unknown; readonly message?: unknown };
  readonly usage?: Record<string, unknown>;
}

function parseLine(line: string): ThreadEvent | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? (value as ThreadEvent) : null;
  } catch {
    return null;
  }
}

/** Items that are tool calls: commands, file edits, MCP tools, web searches and subagents. */
const TOOL_ITEMS: Readonly<Record<string, string>> = { command_execution: "shell", file_change: "apply_patch", mcp_tool_call: "mcp", web_search: "web_search", collab_tool_call: "subagent" };

/** Tool calls from `item.started` and `item.completed` events, by item id. */
function trackItem(event: ThreadEvent, calls: Map<string, ToolCallSummary>): void {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return;
  const item = event.item;
  if (item === undefined || typeof item.id !== "string" || typeof item.type !== "string") return;
  const kind = TOOL_ITEMS[item.type];
  if (kind === undefined) return;
  const name = item.type === "mcp_tool_call" && typeof item.server === "string" && typeof item.tool === "string" ? `${item.server}/${item.tool}` : kind;
  // A web search has no status: it is complete when its item is.
  const failed = item.status === "failed" || item.status === "declined";
  const status = failed ? "error" : event.type === "item.completed" ? "completed" : "running";
  calls.set(item.id, { callId: item.id, name, status });
}

const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * Token counts that counted at least one reply, else null. Every reply reads a
 * prompt, so counts without input tokens counted none: Codex reports zeros
 * when it never received usage, and a run is then not free but unknown.
 */
const counted = (u: Record<string, unknown> | undefined | null): Record<string, unknown> | null => (u !== undefined && u !== null && count(u["input_tokens"]) > 0 ? u : null);

/**
 * The tokens Codex reported for the run (`turn.completed`: the thread's
 * totals), split as the meter splits them: cached and cache-write tokens are
 * parts of input, so uncached input is what is left.
 */
function reportedUsage(u: Record<string, unknown> | null): ReportedUsage | null {
  if (u === null) return null;
  const input = count(u["input_tokens"]);
  const cacheReadTokens = count(u["cached_input_tokens"]);
  const cacheWriteTokens = count(u["cache_write_input_tokens"]);
  const outputTokens = count(u["output_tokens"]);
  const inputTokens = Math.max(input - cacheReadTokens - cacheWriteTokens, 0);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens };
}

interface RunSeen {
  agentId: string | null;
  result: ThreadEvent | null;
  /** Why the turn failed, when it did. */
  failure: string | null;
  /** The last error Codex printed, which explains a run that ended without a result. */
  lastError: string | null;
  /** Codex's notice that it moved the run to another model, when it did. */
  rerouted: string | null;
  readonly calls: Map<string, ToolCallSummary>;
}

/**
 * Why a ChatGPT-login run's thread counts cannot be priced as its model's
 * tokens: the run moved to another model, used subagents (their tokens are
 * not in the thread's counts), or searched the web (billed per call, which the
 * table does not price). The run's settings turn the last two off.
 */
function uncounted(seen: RunSeen): string[] {
  const used = new Set([...seen.calls.values()].map((c) => c.name));
  return [
    ...(seen.rerouted === null ? [] : [`Codex moved the run to another model (${seen.rerouted}), and its counts do not say which model used which tokens`]),
    ...(used.has("subagent") ? ["the run used subagents, whose tokens are not in Codex's counts for the run"] : []),
    ...(used.has("web_search") ? ["the run searched the web, which is billed per call and not in the price table"] : []),
  ];
}

function outcomeOf(startedAt: string, seen: RunSeen, ran: { killedAtDeadline: boolean; spawnError: string | null; stderr: string }, usage: ReportedUsage | null): AgentRunOutcome {
  const finishedAt = new Date().toISOString();
  const toolCalls = [...seen.calls.values()];
  if (seen.agentId === null) {
    const error = ran.spawnError ?? (seen.lastError ?? (ran.stderr.trim() || (ran.killedAtDeadline ? "the agent did not start before its deadline" : "the agent process ended before the run started")));
    return { agentId: null, status: "startup-error", startedAt, finishedAt, toolCalls: [], usage: null, error: error.slice(0, 500) };
  }
  // Stopped at its deadline, whatever it printed on the way out: the agent spent its whole budget.
  if (ran.killedAtDeadline) return { agentId: seen.agentId, status: "timeout", startedAt, finishedAt, toolCalls, usage, error: "the agent passed its deadline and was stopped" };
  if (seen.result !== null) return { agentId: seen.agentId, status: "finished", startedAt, finishedAt, toolCalls, usage, error: null };
  // The run began, so it is billed and it counts: it failed, it did not fail to start.
  const error = seen.failure ?? (seen.lastError === null ? "the agent process ended without a result" : `the agent process ended without a result: ${seen.lastError}`);
  return { agentId: seen.agentId, status: "error", startedAt, finishedAt, toolCalls, usage, error: error.slice(0, 500) };
}

/**
 * Copies a Codex login file, readable by this user only. `back` copies a run's
 * login back over the user's: only when the run changed it, and only when it
 * is whole JSON, because Codex writes it in place and a run stopped at its
 * deadline can leave it half written.
 */
function copyLogin(from: string, to: string, back = false): void {
  if (back && !existsSync(from)) return;
  const login = readFileSync(from);
  if (back) {
    if (existsSync(to) && login.equals(readFileSync(to))) return;
    try {
      JSON.parse(login.toString("utf8"));
    } catch {
      return;
    }
  }
  writeFileSync(`${to}.tmp`, login, { mode: 0o600 });
  chmodSync(`${to}.tmp`, 0o600);
  renameSync(`${to}.tmp`, to);
}

/**
 * The thread's last token counts in the session log Codex keeps under
 * `sessionsDir` (`token_count` events, one after each reply), or null when
 * there are none. Only the counts are read.
 */
export function lastSessionUsage(sessionsDir: string): Record<string, unknown> | null {
  if (!existsSync(sessionsDir)) return null;
  let last: Record<string, unknown> | null = null;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.includes("token_count")) continue;
          try {
            const payload = (JSON.parse(line) as { payload?: { type?: unknown; info?: { total_token_usage?: unknown } | null } }).payload;
            const total = payload?.type === "token_count" ? payload.info?.total_token_usage : undefined;
            if (typeof total === "object" && total !== null) last = total as Record<string, unknown>;
          } catch {
            // A torn last line from a killed Codex.
          }
        }
      }
    }
  };
  visit(sessionsDir);
  return last;
}

/**
 * A ChatGPT-login run's reading from Codex's own thread totals, priced at
 * list price as one reply. The long-context check is per reply and cannot
 * apply to a thread's totals; Codex keeps each reply under the model's
 * 272K-token window. No counts at all leave the cost unknown, and so does any
 * reason in `unpriced` (`uncounted`).
 */
function agentReading(prices: OpenAiPrices, model: string, u: Record<string, unknown> | null, unpriced: readonly string[]): MeterReading {
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reasoningTokens: 0 };
  if (u === null) return { responses: 0, incomplete: 1, unpriced: [...unpriced], models: [], usage: empty, webSearches: 0, costMicroUsd: "0" };
  const reply: OpenAiReply = {
    usage: {
      input_tokens: count(u["input_tokens"]),
      input_tokens_details: { cached_tokens: count(u["cached_input_tokens"]), cache_write_tokens: count(u["cache_write_input_tokens"]) },
      output_tokens: count(u["output_tokens"]),
      output_tokens_details: { reasoning_tokens: count(u["reasoning_output_tokens"]) },
    },
    serviceTier: null,
    hostedToolCalls: [],
  };
  const cost = openAiResponseCost({ ...prices, standardContextTokens: Number.MAX_SAFE_INTEGER }, model, reply);
  const t = cost.tokens;
  return {
    responses: 0,
    incomplete: 0,
    unpriced: [...(cost.ok ? [] : [cost.reason]), ...unpriced],
    models: [model],
    usage: { inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite, totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite, reasoningTokens: t.reasoning },
    webSearches: 0,
    costMicroUsd: cost.ok ? unitsToMicroUsd(cost.costUnits).toString() : "0",
  };
}
