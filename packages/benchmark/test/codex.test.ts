import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentSetup,
  CodexAdapter,
  MeterRecord,
  MeteringProxy,
  type OpenAiReply,
  RULE_FILES,
  ResponsesStreamReader,
  WorkspaceError,
  centsToMicroUsd,
  childEnv,
  codexConfig,
  loadOpenAiPrices,
  openAiApi,
  openAiPricesDigest,
  openAiResponseCost,
  prepareWorkspace,
  readCodexMeteredUsage,
  readOpenAiJsonResponse,
  unitsToMicroUsd,
} from "../src/index.js";

const prices = loadOpenAiPrices();
const temps: string[] = [];
const servers: Server[] = [];
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

const reply = (usage: OpenAiReply["usage"], extra: Partial<OpenAiReply> = {}): OpenAiReply => ({ usage, serviceTier: "default", hostedToolCalls: [], ...extra });
// 800 uncached input, 200 cached input and 50 output tokens, 10 of them reasoning.
const SMALL = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 } };
const micro = (r: OpenAiReply, model = "gpt-5.5") => {
  const cost = openAiResponseCost(prices, model, r);
  if (!cost.ok) throw new Error(cost.reason);
  return unitsToMicroUsd(cost.costUnits);
};

describe("the OpenAI price table", () => {
  it("is dated and sourced, reads cached input at a tenth of input, and prices gpt-5.5 cache writes as input", () => {
    expect(prices.retrievedAt).toBe("2026-09-28");
    expect(prices.source).toBe("https://developers.openai.com/api/docs/pricing");
    expect(prices.standardContextTokens).toBe(272_000);
    for (const [model, p] of Object.entries(prices.models)) expect(BigInt(p.cacheRead) * 10n, model).toBe(BigInt(p.input));
    expect(prices.models["gpt-5.5"]).toEqual({ input: "5000000", cacheWrite: "5000000", cacheRead: "500000", output: "30000000" });
  });
});

describe("openAiResponseCost", () => {
  it("prices uncached input, cached input, cache writes and output at the model's list price", () => {
    // 800 x $5 + 200 x $0.50 + 50 x $30 per million tokens.
    expect(micro(reply(SMALL))).toBe(5600n);
    expect(micro(reply({ input_tokens: 200_000, input_tokens_details: { cached_tokens: 200_000 }, output_tokens: 0 }))).toBe(100_000n);
    expect(micro(reply({ input_tokens: 200_000, input_tokens_details: { cache_write_tokens: 200_000 }, output_tokens: 0 }))).toBe(1_000_000n);
    expect(micro(reply({ input_tokens: 0, output_tokens: 1_000_000 }))).toBe(30_000_000n);
    const cost = openAiResponseCost(prices, "gpt-5.5", reply(SMALL));
    expect(cost.tokens).toEqual({ input: 800, output: 50, cacheRead: 200, cacheWrite: 0, reasoning: 10 });
  });

  it("prices a dated snapshot id as its model, and a missing service tier as the default", () => {
    expect(micro(reply(SMALL), "gpt-5.5-2026-04-23")).toBe(5600n);
    expect(micro(reply(SMALL, { serviceTier: null }))).toBe(5600n);
  });

  it("refuses what the table cannot price exactly, and still counts the tokens", () => {
    const refused = (r: OpenAiReply, model = "gpt-5.5") => {
      const cost = openAiResponseCost(prices, model, r);
      expect(cost.ok).toBe(false);
      return cost.ok ? "" : cost.reason;
    };
    expect(refused(reply(SMALL), "gpt-9")).toMatch(/gpt-9 has no price/);
    expect(refused(reply(SMALL, { serviceTier: "priority" }))).toMatch(/service tier priority/);
    expect(refused(reply(SMALL, { serviceTier: "flex" }))).toMatch(/service tier flex/);
    expect(refused(reply({ ...SMALL, input_tokens: 272_001 }))).toMatch(/long-context pricing/);
    expect(refused(reply(SMALL, { hostedToolCalls: ["web_search_call", "web_search_call"] }))).toMatch(/billed per call are not priced: web_search_call$/);
    expect(refused(reply({ input_tokens: 10, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 5 }, output_tokens: 1 }))).toMatch(/exceed input tokens/);
    expect(refused(reply({ input_tokens: 10, output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } }))).toMatch(/reasoning tokens/);
  });

  it("sums exactly: two replies cost what their tokens cost as one", () => {
    // Two replies together stay under the standard context, where one price applies.
    const usage = fc.record({ uncached: fc.nat(40_000), cached: fc.nat(40_000), written: fc.nat(40_000), output: fc.nat(100_000) });
    const toReply = (u: { uncached: number; cached: number; written: number; output: number }) =>
      reply({ input_tokens: u.uncached + u.cached + u.written, input_tokens_details: { cached_tokens: u.cached, cache_write_tokens: u.written }, output_tokens: u.output });
    fc.assert(
      fc.property(usage, usage, (a, b) => {
        const one = openAiResponseCost(prices, "gpt-5.5", toReply(a));
        const two = openAiResponseCost(prices, "gpt-5.5", toReply(b));
        const both = openAiResponseCost(prices, "gpt-5.5", toReply({ uncached: a.uncached + b.uncached, cached: a.cached + b.cached, written: a.written + b.written, output: a.output + b.output }));
        return one.ok && two.ok && both.ok && one.costUnits + two.costUnits === both.costUnits;
      }),
    );
  });
});

const sse = (events: ReadonlyArray<Record<string, unknown>>, eol = "\n") => events.map((e) => `event: ${String(e["type"])}${eol}data: ${JSON.stringify(e)}${eol}${eol}`).join("");
const MODEL = "gpt-5.5-2026-04-23";
const completed = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "response.completed", response: { id: "resp_1", model: MODEL, status: "completed", service_tier: "default", output: [{ type: "message", content: [] }], usage, ...extra } });
const STREAM = [
  { type: "response.created", response: { id: "resp_1", model: MODEL, status: "in_progress" } },
  { type: "response.output_text.delta", delta: "OK" },
  completed({ ...SMALL, total_tokens: 1050 }),
];

describe("ResponsesStreamReader", () => {
  const read = (text: string, cuts: number[] = []) => {
    const reader = new ResponsesStreamReader();
    const bytes = new TextEncoder().encode(text);
    let from = 0;
    for (const cut of [...cuts, bytes.length]) {
      reader.feed(bytes.slice(from, cut));
      from = cut;
    }
    return reader.end();
  };

  it("takes the model and final usage from response.completed", () => {
    expect(read(sse(STREAM))).toEqual({ state: "complete", model: MODEL, usage: { usage: { ...SMALL }, serviceTier: "default", hostedToolCalls: [] }, malformed: false });
  });

  it("reads the same however the stream is cut into chunks, with \\n or \\r\\n line ends", () => {
    const text = sse(STREAM, "\r\n");
    const whole = read(sse(STREAM));
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: text.length - 1 }), { maxLength: 8 }), (cuts) => JSON.stringify(read(text, [...cuts].sort((a, b) => a - b))) === JSON.stringify(whole)));
  });

  it("counts an incomplete reply as billed, marks a failed one as errored, and one that stopped as cut", () => {
    const incomplete = { type: "response.incomplete", response: { model: MODEL, status: "incomplete", usage: SMALL } };
    expect(read(sse([STREAM[0] as Record<string, unknown>, incomplete]))).toMatchObject({ state: "complete", usage: { usage: SMALL } });
    expect(read(sse([STREAM[0] as Record<string, unknown>, { type: "response.failed", response: { model: MODEL, usage: null, error: { code: "server_error" } } }]))).toMatchObject({ state: "errored", usage: null });
    expect(read(sse([STREAM[0] as Record<string, unknown>, { type: "error", code: "rate_limit_exceeded" }]))).toMatchObject({ state: "errored" });
    expect(read(sse(STREAM.slice(0, 2)))).toMatchObject({ state: "cut", model: MODEL, usage: null });
  });

  it("finds hosted tool calls in the reply's output, and flags usage it cannot read", () => {
    const withSearch = completed(SMALL, { output: [{ type: "web_search_call", id: "ws_1" }, { type: "function_call", id: "fc_1" }] });
    expect(read(sse([withSearch])).usage?.hostedToolCalls).toEqual(["web_search_call"]);
    expect(read(sse([completed({ input_tokens: -1, output_tokens: 1 })]))).toMatchObject({ malformed: true, usage: null });
    expect(read("data: {not json\n\n")).toMatchObject({ malformed: true });
  });

  it("reads a non-streamed reply from its body", () => {
    expect(readOpenAiJsonResponse(JSON.stringify(completed(SMALL).response))).toMatchObject({ state: "complete", model: MODEL, usage: { usage: SMALL }, malformed: false });
    expect(readOpenAiJsonResponse("{")).toMatchObject({ malformed: true });
  });
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

async function standIn(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    await handler(req, res, body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const streamed = (res: ServerResponse, events: ReadonlyArray<Record<string, unknown>>) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse(events));
};

const REAL = ["sk", "proj", "fake", "harness", "key"].join("-");

describe("MeteringProxy for the OpenAI API", { timeout: 20_000 }, () => {
  const open = async (upstream: string) => {
    const proxy = new MeteringProxy({ apiKey: REAL, api: openAiApi(prices, upstream), drainMs: 5000 });
    return { proxy, url: await proxy.open() };
  };
  const post = (url: string, token: string, path = "/v1/responses", headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "gpt-5.5", stream: true }) });

  it("passes a run's request on with the real key, streams the reply back unchanged, and meters it", async () => {
    const api = await standIn((_req, res) => streamed(res, STREAM));
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-1");
    const response = await post(url, "run-token-1", "/v1/responses", { "openai-organization": "org-other", "openai-project": "proj_other" });
    expect(await response.text()).toBe(sse(STREAM));
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/v1/responses" });
    expect(api.seen[0]?.headers["authorization"]).toBe(`Bearer ${REAL}`);
    // The key's own organization and project pay: the agent cannot pick another.
    expect(api.seen[0]?.headers["openai-organization"]).toBeUndefined();
    expect(api.seen[0]?.headers["openai-project"]).toBeUndefined();
    expect(JSON.stringify(api.seen[0]?.headers)).not.toContain("run-token-1");
    const reading = await proxy.end("run-token-1");
    expect(reading).toMatchObject({ responses: 1, incomplete: 0, unpriced: [], models: [MODEL], costMicroUsd: "5600" });
    expect(reading.usage).toEqual({ inputTokens: 800, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0, totalTokens: 1050, reasoningTokens: 10 });
    await proxy.close();
  });

  it("refuses tokens that are not a live run's, and APIs it does not meter, in the OpenAI error shape", async () => {
    const api = await standIn((_req, res) => streamed(res, STREAM));
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-2");
    const stranger = await post(url, "someone-else");
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: { type: "authentication_error", message: "this key is not a live run's", code: null, param: null } });
    expect((await fetch(`${url}/v1/responses`, { method: "POST", body: "{}" })).status).toBe(401);
    for (const path of ["/v1/responses/compact", "/v1/chat/completions", "/v1/batches", "/v1/files", "/v1/memories/trace_summarize"]) expect((await post(url, "run-token-2", path)).status, path).toBe(404);
    expect(api.seen).toEqual([]);
    const models = await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer run-token-2" } });
    expect(models.status).toBe(200);
    await models.text();
    expect(await proxy.end("run-token-2")).toMatchObject({ responses: 0, costMicroUsd: "0" });
    expect((await post(url, "run-token-2")).status).toBe(401);
    await proxy.close();
  });

  it("does not meter an error reply, and leaves a reply with a hosted tool call unpriced", async () => {
    let mode = "error";
    const api = await standIn((_req, res) => {
      if (mode === "error") res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
      else streamed(res, [completed(SMALL, { output: [{ type: "web_search_call" }] })]);
    });
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-3");
    expect((await post(url, "run-token-3")).status).toBe(429);
    mode = "search";
    await (await post(url, "run-token-3")).text();
    const reading = await proxy.end("run-token-3");
    expect(reading).toMatchObject({ responses: 1, unpriced: ["hosted tool calls billed per call are not priced: web_search_call"] });
    await proxy.close();
  });
});

/**
 * A stand-in `codex` executable: it records its arguments, environment,
 * standard input and config.toml, then behaves as its prompt says, printing
 * `codex exec --json` lines and calling the model provider it was configured
 * with.
 */
function fakeCodex(dir: string): string {
  const path = join(dir, "codex.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const config = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");
writeFileSync("seen.json", JSON.stringify({ args, env: process.env, prompt, config }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (prompt === "die") { process.stderr.write("codex: boom\\n"); process.exit(1); }
const thread = "019a3c5e-1f0e-7c1e-9a55-2f3d4c5b6a70";
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
if (prompt === "hang") setInterval(() => {}, 1000);
else if (prompt === "no-result") { out({ type: "error", message: "stream disconnected before completion" }); process.exit(1); }
else {
  const baseUrl = /base_url = "([^"]+)"/.exec(config)[1];
  const reply = await fetch(baseUrl + "/responses", { method: "POST", headers: { authorization: "Bearer " + process.env.LEMMA_METER_TOKEN, "content-type": "application/json" }, body: "{}" });
  await reply.text();
  out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls", aggregated_output: "", exit_code: null, status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls", aggregated_output: "", exit_code: prompt === "tool-error" ? 1 : 0, status: prompt === "tool-error" ? "failed" : "completed" } });
  out({ type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "lemma", tool: "lemma_preview", arguments: {}, result: null, error: null, status: "completed" } });
  out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "done" } });
  if (prompt === "fail") out({ type: "turn.failed", error: { message: "tool loop broke" } });
  else out({ type: "turn.completed", usage: { input_tokens: prompt === "bypass" ? 5000 : 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 } });
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("CodexAdapter", { timeout: 20_000 }, () => {
  const setup = async () => {
    const api = await standIn((_req, res) => streamed(res, STREAM));
    const dir = temp("lemma-codex-");
    const cwd = join(dir, "work");
    const home = join(dir, "home");
    mkdirSync(cwd);
    mkdirSync(join(home, "tmp"), { recursive: true });
    const meterDir = join(dir, "meter");
    const adapter = new CodexAdapter(REAL, { command: fakeCodex(dir), meterDir, prices, upstream: api.url, graceMs: { stop: 300, exit: 300 }, drainMs: 5000, systemConfigDir: join(dir, "etc-codex") });
    const request = (prompt: string, timeoutMs = 10_000) => ({ cwd, home, prompt, model: { id: "gpt-5.5" }, mcpServers: { lemma: { command: "/usr/bin/node", args: ["bridge.js"], env: { LEMMA_API_URL: "http://localhost:3000" } } }, timeoutMs });
    const seen = () => JSON.parse(readFileSync(join(cwd, "seen.json"), "utf8")) as { args: string[]; env: Record<string, string>; prompt: string; config: string };
    return { api, adapter, dir, cwd, home, meterDir, request, seen };
  };
  const THREAD = "019a3c5e-1f0e-7c1e-9a55-2f3d4c5b6a70";

  it("runs headless Codex on the meter and a run token, never the key, with the prompt on standard input", async () => {
    const { api, adapter, cwd, home, request, seen } = await setup();
    const started: string[] = [];
    const outcome = await adapter.run({ ...request("finish"), onStarted: (id) => started.push(id) });
    const { args, env, prompt, config } = seen();
    expect(prompt).toBe("finish");
    expect(Object.values(env)).not.toContain(REAL);
    expect(config).not.toContain(REAL);
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process it starts.
    const given = Object.keys(env).filter((name) => name !== "__CF_USER_TEXT_ENCODING");
    expect(given.sort()).toEqual([...Object.keys(childEnv(home)), "CODEX_HOME", "LEMMA_METER_TOKEN"].sort());
    expect(env["CODEX_HOME"]).toBe(join(home, ".codex"));
    expect(env["LEMMA_METER_TOKEN"]).toMatch(/^lemma-run-[0-9a-f]{48}$/);
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/v1/responses" });
    expect(api.seen[0]?.headers["authorization"]).toBe(`Bearer ${REAL}`);
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--dangerously-bypass-approvals-and-sandbox", "--cd", cwd, "--model", "gpt-5.5", "-"]);
    expect(config).toMatch(/^model_provider = "lemma-meter"$/m);
    expect(config).toMatch(/^base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"$/m);
    expect(config).toMatch(/^env_key = "LEMMA_METER_TOKEN"$/m);
    expect(config).toMatch(/^web_search = "disabled"$/m);
    expect(config).toContain('[mcp_servers."lemma"]\ncommand = "/usr/bin/node"\nargs = ["bridge.js"]\ndefault_tools_approval_mode = "approve"\nenv = { "LEMMA_API_URL" = "http://localhost:3000" }');
    expect(started).toEqual([THREAD]);
    expect(outcome).toMatchObject({
      agentId: THREAD,
      status: "finished",
      error: null,
      toolCalls: [
        { callId: "item_1", name: "shell", status: "completed" },
        { callId: "item_2", name: "lemma/lemma_preview", status: "completed" },
      ],
      usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0, totalTokens: 1050 },
    });
    await adapter.close();
  });

  it("costs a run from its meter record", async () => {
    const { adapter, request, meterDir } = await setup();
    const outcome = await adapter.run(request("finish"));
    const billed = await adapter.usage(outcome.agentId as string);
    expect(billed).toEqual({ usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0, totalTokens: 1050, reasoningTokens: 10 }, rawCostCents: 0.56 });
    expect(centsToMicroUsd(billed?.rawCostCents as number)).toBe(5600n);
    const record = MeterRecord.parse(JSON.parse(readFileSync(join(meterDir, `${outcome.agentId}.json`), "utf8")));
    expect(record).toMatchObject({ responses: 1, reportedTokens: 1050, pricesDigest: openAiPricesDigest(prices), costMicroUsd: "5600" });
    await adapter.close();
  });

  it("reports a failed tool call, a failed turn, and a run that ended without a result", async () => {
    const { adapter, request } = await setup();
    expect((await adapter.run(request("tool-error"))).toolCalls[0]).toEqual({ callId: "item_1", name: "shell", status: "error" });
    expect(await adapter.run(request("fail"))).toMatchObject({ status: "error", error: "tool loop broke", agentId: THREAD });
    expect(await adapter.run(request("no-result"))).toMatchObject({ status: "error", error: "the agent process ended without a result: stream disconnected before completion" });
    await adapter.close();
  });

  it("stops a run at its deadline and counts it as a timeout", async () => {
    const { adapter, request } = await setup();
    const began = Date.now();
    const outcome = await adapter.run(request("hang", 300));
    expect(outcome).toMatchObject({ status: "timeout", agentId: THREAD });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(await adapter.usage(outcome.agentId as string)).toMatchObject({ rawCostCents: 0 });
    await adapter.close();
  });

  it("reports a Codex that never started as a startup error, with what it said", async () => {
    const { adapter, request, meterDir } = await setup();
    expect(await adapter.run(request("die"))).toMatchObject({ status: "startup-error", agentId: null, error: "codex: boom" });
    expect(existsSync(meterDir)).toBe(false);
    await adapter.close();
  });

  it("leaves a run's cost unknown when traffic went around the meter", async () => {
    const { adapter, request } = await setup();
    const outcome = await adapter.run(request("bypass"));
    await expect(adapter.usage(outcome.agentId as string)).rejects.toThrow(/went around the meter/);
    await adapter.close();
  });

  it("refuses to put a credential in Codex's configuration, and to run below system-wide Codex settings", async () => {
    const { adapter, dir, request } = await setup();
    const leaky = { lemma: { command: "/usr/bin/node", args: ["bridge.js"], env: { BUYER_PRIVATE_KEY: ["0x", "ab".repeat(32)].join("") } } };
    await expect(adapter.run({ ...request("finish"), mcpServers: leaky })).rejects.toThrow(/BUYER_PRIVATE_KEY in Codex's configuration/);
    mkdirSync(join(dir, "etc-codex"));
    await expect(adapter.run(request("finish"))).rejects.toThrow(/system-wide Codex settings/);
    await adapter.close();
  });

  it("checks the key and the model with one short request, and says why they cannot run", async () => {
    let answer: [number, Record<string, unknown>] = [200, { id: "resp_1", status: "incomplete" }];
    const api = await standIn((_req, res) => void res.writeHead(answer[0], { "content-type": "application/json" }).end(JSON.stringify(answer[1])));
    const adapter = new CodexAdapter(REAL, { command: null, meterDir: temp("lemma-meter-"), prices, upstream: api.url });
    await adapter.checkModel("gpt-5.5");
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/v1/responses" });
    expect(api.seen[0]?.headers["authorization"]).toBe(`Bearer ${REAL}`);
    expect(JSON.parse(api.seen[0]?.body ?? "")).toEqual({ model: "gpt-5.5", input: "Reply with OK.", max_output_tokens: 16, store: false });
    const error = (type: string, code: string | null, message = "") => ({ error: { type, code, message, param: null } });
    const cases: Array<[number, Record<string, unknown>, RegExp]> = [
      [429, error("insufficient_quota", "insufficient_quota", "You exceeded your current quota"), /no API credit left \(a ChatGPT plan does not include API credit\)/],
      [401, error("invalid_request_error", "invalid_api_key"), /refused the key \(HTTP 401\)/],
      [404, error("invalid_request_error", "model_not_found"), /not available to this key/],
      [400, error("invalid_request_error", "model_not_found"), /not available to this key/],
      [403, error("invalid_request_error", null, "Project does not have access to model gpt-5.5"), /may not use gpt-5\.5 \(HTTP 403\): Project does not have access/],
      [429, error("requests", "rate_limit_exceeded"), /rate limiting/],
      [503, error("server_error", null), /failed \(HTTP 503\)/],
      [400, error("invalid_request_error", "unsupported_parameter"), /failed: HTTP 400 invalid_request_error$/],
    ];
    for (const [status, body, message] of cases) {
      answer = [status, body];
      await expect(adapter.checkModel("gpt-5.5")).rejects.toThrow(message);
    }
    await expect(adapter.checkModel("gpt-9")).rejects.toThrow(/not in prices\/openai\.json/);
    expect(api.seen).toHaveLength(1 + cases.length);
    await adapter.close();
  });
});

describe("codexConfig", () => {
  it("writes TOML strings escaped, so a path or argument cannot add settings", () => {
    const config = codexConfig({ baseUrl: "http://127.0.0.1:1/v1" }, "gpt-5.5", { "odd name": { command: '/x/"y"\nmodel = "z"', args: ["a\\b"], env: {} } });
    expect(config).toContain('[mcp_servers."odd name"]\ncommand = "/x/\\"y\\"\\nmodel = \\"z\\""\nargs = ["a\\\\b"]');
    expect(config.match(/^model = /gm)).toHaveLength(1);
    expect(config).not.toContain("env = ");
  });
});

describe("readCodexMeteredUsage", () => {
  const agentId = "019a3c5e-1f0e-7c1e-9a55-2f3d4c5b6a70";
  const record = (fields: Partial<MeterRecord>) => {
    const dir = temp("lemma-meter-");
    const base: MeterRecord = {
      schemaVersion: "1",
      agentId,
      pricesDigest: openAiPricesDigest(prices),
      meteredAt: "2026-09-28T00:00:00.000Z",
      responses: 1,
      incomplete: 0,
      unpriced: [],
      models: [MODEL],
      usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0, totalTokens: 1050, reasoningTokens: 10 },
      webSearches: 0,
      costMicroUsd: "5600",
      reportedTokens: 1050,
    };
    writeFileSync(join(dir, `${agentId}.json`), JSON.stringify({ ...base, ...fields }));
    return dir;
  };

  it("returns the metered cost of a complete record, and leaves it unknown, with the reason, whenever it cannot be known", () => {
    const digest = openAiPricesDigest(prices);
    expect(readCodexMeteredUsage(record({}), agentId, digest).rawCostCents).toBe(0.56);
    expect(() => readCodexMeteredUsage(temp("lemma-meter-"), agentId, digest)).toThrow(/no meter record/);
    expect(() => readCodexMeteredUsage(record({ incomplete: 1 }), agentId, digest)).toThrow(/stopped before their final usage/);
    expect(() => readCodexMeteredUsage(record({ unpriced: ["service tier flex is not priced"] }), agentId, digest)).toThrow(/cannot price: service tier flex/);
    expect(() => readCodexMeteredUsage(record({}), agentId, `0x${"11".repeat(32)}`)).toThrow(/another price table/);
    expect(() => readCodexMeteredUsage(record({ reportedTokens: 2000 }), agentId, digest)).toThrow(/went around the meter/);
    expect(() => readCodexMeteredUsage(record({}), "../escape", digest)).toThrow(/not a Codex thread id/);
  });
});

describe("the Codex treatment", () => {
  const fixture = (files: Record<string, string>) => {
    const fixtureDir = temp("lemma-fx-");
    mkdirSync(join(fixtureDir, "repo"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(fixtureDir, "repo", name), text);
    return fixtureDir;
  };
  const rule = () => {
    const path = join(temp("lemma-rule-"), "lemma.mdc");
    writeFileSync(path, "---\nalwaysApply: true\n---\ncall lemma_preview first\n");
    return path;
  };

  it("gets the Lemma rule as the project's AGENTS.md, where Codex reads project instructions", () => {
    expect(RULE_FILES.codex).toBe("AGENTS.md");
    const ws = prepareWorkspace({ base: temp("lemma-runs-"), runId: `0x${"ab".repeat(32)}`, fixtureDir: fixture({ "README.md": "fixture\n" }), repositoryRoot: temp("lemma-repo-"), rulePath: rule(), ruleFile: RULE_FILES.codex });
    expect(readFileSync(join(ws.cwd, "AGENTS.md"), "utf8")).toBe("---\nalwaysApply: true\n---\ncall lemma_preview first\n");
    ws.dispose();
  });

  it("refuses a fixture that has its own AGENTS.md, which the rule would replace", () => {
    const make = () => prepareWorkspace({ base: temp("lemma-runs-"), runId: `0x${"cd".repeat(32)}`, fixtureDir: fixture({ "AGENTS.md": "house rules\n" }), repositoryRoot: temp("lemma-repo-"), rulePath: rule(), ruleFile: RULE_FILES.codex });
    expect(make).toThrow(WorkspaceError);
    expect(make).toThrow(/already has AGENTS\.md/);
  });

  it("names its price table in the version's agent setup", () => {
    expect(AgentSetup.safeParse({ name: "codex", version: "0.158.0", pricesDigest: openAiPricesDigest(prices) }).success).toBe(true);
    expect(AgentSetup.safeParse({ name: "codex", version: "0.158.0", pricesDigest: null }).success).toBe(false);
  });
});

/**
 * A stand-in `codex` signed in with ChatGPT: it answers `login status` from
 * its auth.json, records what a run got, never calls a model, and reports
 * token counts as its prompt says: at the end of the turn, only in its
 * session log (it hangs until its deadline), as zeros, or not at all. A login
 * whose tokens are "limited" has used up its plan: every turn fails.
 */
function fakeChatgptCodex(dir: string): string {
  const path = join(dir, "codex-chatgpt.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const auth = join(process.env.CODEX_HOME, "auth.json");
if (args[0] === "login") {
  if (existsSync(auth) && readFileSync(auth, "utf8").includes("chatgpt")) { console.log("Logged in using ChatGPT"); process.exit(0); }
  if (existsSync(auth) && readFileSync(auth, "utf8").includes("apikey")) { console.log("Logged in using an API key - sk-proj-***" + "ABCDE"); process.exit(0); }
  console.log("Not logged in"); process.exit(1);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const config = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");
writeFileSync("seen.json", JSON.stringify({ args, env: process.env, config, auth: readFileSync(auth, "utf8"), authMode: statSync(auth).mode & 0o777 }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "thread.started", thread_id: "019a3c5e-1f0e-7c1e-9a55-2f3d4c5b6a71" });
const total = { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 };
if (JSON.parse(readFileSync(auth, "utf8")).tokens === "limited") {
  const message = "You've hit your usage limit. Try again in 2 hours 13 minutes.";
  out({ type: "turn.started" });
  out({ type: "error", message });
  out({ type: "turn.failed", error: { message } });
  process.exit(1);
}
if (prompt === "refresh") writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: "refreshed" }));
if (prompt === "torn") writeFileSync(auth, '{"auth_mode": "chatgpt", "tok');
if (prompt === "reroute") out({ type: "item.completed", item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.5 -> gpt-5.4-mini (HighRiskCyberActivity)" } });
if (prompt === "subagent") {
  out({ type: "item.started", item: { id: "item_1", type: "collab_tool_call", status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_1", type: "collab_tool_call", status: "completed" } });
}
if (prompt === "zero") out({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } });
else if (prompt === "hang") {
  const day = join(process.env.CODEX_HOME, "sessions", "2026", "09", "28");
  mkdirSync(day, { recursive: true });
  const line = (n) => JSON.stringify({ timestamp: "2026-09-28T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...total, output_tokens: n }, last_token_usage: total } } });
  writeFileSync(join(day, "rollout-1.jsonl"), [JSON.stringify({ type: "session_meta", payload: {} }), line(10), line(50), '{"torn'].join("\\n"));
  setInterval(() => {}, 1000);
} else if (prompt === "silent") process.exit(1);
else out({ type: "turn.completed", usage: total });
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("CodexAdapter on a ChatGPT login (probes only)", { timeout: 20_000 }, () => {
  const THREAD = "019a3c5e-1f0e-7c1e-9a55-2f3d4c5b6a71";
  const setup = (login = { auth_mode: "chatgpt", tokens: "original" }) => {
    const dir = temp("lemma-codex-chatgpt-");
    const cwd = join(dir, "work");
    const home = join(dir, "home");
    const loginHome = join(dir, "login");
    mkdirSync(cwd);
    mkdirSync(join(home, "tmp"), { recursive: true });
    mkdirSync(loginHome);
    writeFileSync(join(loginHome, "auth.json"), JSON.stringify(login));
    const meterDir = join(dir, "meter");
    const adapter = new CodexAdapter(null, { command: fakeChatgptCodex(dir), meterDir, prices, graceMs: { stop: 300, exit: 300 }, systemConfigDir: join(dir, "etc-codex"), chatgptLogin: loginHome });
    const request = (prompt: string, timeoutMs = 10_000) => ({ cwd, home, prompt, model: { id: "gpt-5.5" }, mcpServers: {}, timeoutMs });
    const seen = () => JSON.parse(readFileSync(join(cwd, "seen.json"), "utf8")) as { args: string[]; env: Record<string, string>; config: string; auth: string; authMode: number };
    return { adapter, home, loginHome, meterDir, request, seen };
  };

  it("takes a login or a key, exactly one", () => {
    expect(() => new CodexAdapter(REAL, { command: null, meterDir: temp("lemma-meter-"), prices, chatgptLogin: temp("lemma-login-") })).toThrow(/exactly one/);
    expect(() => new CodexAdapter(null, { command: null, meterDir: temp("lemma-meter-"), prices })).toThrow(/exactly one/);
  });

  it("runs Codex on OpenAI's own provider with the login copied in, subagents off, and no meter token", async () => {
    const { adapter, home, request, seen } = await setup();
    const outcome = await adapter.run(request("finish"));
    const { args, env, config, auth, authMode } = seen();
    expect(args).not.toContain("--ephemeral");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const given = Object.keys(env).filter((name) => name !== "__CF_USER_TEXT_ENCODING");
    expect(given.sort()).toEqual([...Object.keys(childEnv(home)), "CODEX_HOME"].sort());
    expect(config).toMatch(/^forced_login_method = "chatgpt"$/m);
    expect(config).toMatch(/^\[features\]\nmulti_agent = false$/m);
    expect(config).not.toContain("model_provider");
    expect(auth).toBe(JSON.stringify({ auth_mode: "chatgpt", tokens: "original" }));
    expect(authMode).toBe(0o600);
    expect(outcome).toMatchObject({ agentId: THREAD, status: "finished", usage: { inputTokens: 800, cacheReadTokens: 200, outputTokens: 50, totalTokens: 1050 } });
    await adapter.close();
  });

  it("costs a run from Codex's own counts at list price, and says so in its record", async () => {
    const { adapter, meterDir, request } = await setup();
    const outcome = await adapter.run(request("finish"));
    expect(await adapter.usage(THREAD)).toEqual({ usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0, totalTokens: 1050, reasoningTokens: 10 }, rawCostCents: 0.56 });
    const record = MeterRecord.parse(JSON.parse(readFileSync(join(meterDir, `${outcome.agentId}.json`), "utf8")));
    expect(record).toMatchObject({ source: "agent", responses: 0, models: ["gpt-5.5"], costMicroUsd: "5600", reportedTokens: 1050 });
    await adapter.close();
  });

  it("copies a login Codex refreshed during the run back, so the next run has it", async () => {
    const { adapter, loginHome, request } = await setup();
    await adapter.run(request("refresh"));
    expect(JSON.parse(readFileSync(join(loginHome, "auth.json"), "utf8"))).toEqual({ auth_mode: "chatgpt", tokens: "refreshed" });
    expect(statSync(join(loginHome, "auth.json")).mode & 0o777).toBe(0o600);
    await adapter.close();
  });

  it("costs a run stopped at its deadline from the last token count in its session log", async () => {
    const { adapter, request } = await setup();
    const outcome = await adapter.run(request("hang", 800));
    expect(outcome).toMatchObject({ status: "timeout", agentId: THREAD, usage: null });
    expect(await adapter.usage(THREAD)).toMatchObject({ rawCostCents: 0.56, usage: { outputTokens: 50 } });
    await adapter.close();
  });

  it("leaves the cost unknown when Codex reported no token counts at all", async () => {
    const { adapter, request } = await setup();
    expect(await adapter.run(request("silent"))).toMatchObject({ status: "error", agentId: THREAD });
    await expect(adapter.usage(THREAD)).rejects.toThrow(/reported no token counts/);
    await adapter.close();
  });

  it("costs nothing, rather than guessing, when Codex's counts are zeros, a run moved model, or used subagents", async () => {
    const { adapter, request } = setup();
    await adapter.run(request("zero"));
    await expect(adapter.usage(THREAD)).rejects.toThrow(/reported no token counts/);
    expect(await adapter.run(request("reroute"))).toMatchObject({ status: "finished" });
    await expect(adapter.usage(THREAD)).rejects.toThrow(/moved the run to another model \(model rerouted: gpt-5\.5 -> gpt-5\.4-mini/);
    await adapter.run(request("subagent"));
    await expect(adapter.usage(THREAD)).rejects.toThrow(/used subagents/);
    await adapter.close();
  });

  it("keeps the user's login when a run leaves its copy half written", async () => {
    const { adapter, loginHome, request } = setup();
    await adapter.run(request("torn"));
    expect(JSON.parse(readFileSync(join(loginHome, "auth.json"), "utf8"))).toEqual({ auth_mode: "chatgpt", tokens: "original" });
    await adapter.close();
  });

  it("reports a plan's usage limit as the run's error, in Codex's words", async () => {
    const { adapter, request } = setup({ auth_mode: "chatgpt", tokens: "limited" });
    expect(await adapter.run(request("finish"))).toMatchObject({ status: "error", agentId: THREAD, error: "You've hit your usage limit. Try again in 2 hours 13 minutes." });
    await adapter.close();
  });

  it("checks the login and the model with one short run, and says why the probe cannot start", async () => {
    const scratch = () => temp("lemma-codex-check-");
    const ok = setup();
    const dir = scratch();
    await ok.adapter.checkLogin("gpt-5.5", dir);
    expect(JSON.parse(readFileSync(join(dir, "work", "seen.json"), "utf8"))).toMatchObject({ args: expect.arrayContaining(["--model", "gpt-5.5"]) });
    // The check's run leaves no meter record, so a later run cannot mistake it for one of its own.
    expect(existsSync(ok.meterDir)).toBe(false);
    await expect(setup().adapter.checkLogin("gpt-9", scratch())).rejects.toThrow(/not in prices\/openai\.json/);
    await expect(setup({ auth_mode: "chatgpt", tokens: "limited" }).adapter.checkLogin("gpt-5.5", scratch())).rejects.toThrow(/short Codex run on gpt-5\.5 with this login ended with error: You've hit your usage limit/);
    const key = setup({ auth_mode: "apikey", tokens: "" }).adapter.checkLogin("gpt-5.5", scratch());
    await expect(key).rejects.toThrow(/signed in here, but not with ChatGPT/);
    await expect(key).rejects.not.toThrow(/sk-/);
    const { adapter, loginHome } = setup();
    rmSync(join(loginHome, "auth.json"));
    await expect(adapter.checkLogin("gpt-5.5", scratch())).rejects.toThrow(/codex login --device-auth/);
    await expect(adapter.checkModel("gpt-5.5")).rejects.toThrow(/checkLogin/);
  });

  it("is a Codex-only setting of the version's agent", () => {
    expect(AgentSetup.safeParse({ name: "codex", version: "0.158.0", pricesDigest: openAiPricesDigest(prices), login: "chatgpt" }).success).toBe(true);
    expect(AgentSetup.safeParse({ name: "claude-code", version: "2.1.283", pricesDigest: openAiPricesDigest(prices), login: "chatgpt" }).success).toBe(false);
  });
});
