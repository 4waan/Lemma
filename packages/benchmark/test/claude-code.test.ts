import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentSetup,
  ClaudeCodeAdapter,
  MeterRecord,
  MeteringProxy,
  RULE_FILES,
  type ResponseUsage,
  UsageStreamReader,
  centsToMicroUsd,
  childEnv,
  loadAnthropicPrices,
  prepareWorkspace,
  pricesDigest,
  readJsonResponse,
  readMeteredUsage,
  responseCost,
  unitsToMicroUsd,
} from "../src/index.js";

const prices = loadAnthropicPrices();
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

// The usage of one small Claude Code reply, as headless Claude Code 2.1.283 reported it against a stand-in API (2026-09-28).
const SMALL: ResponseUsage = { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 }, output_tokens: 7, service_tier: "standard" };
const micro = (usage: ResponseUsage, model = "claude-sonnet-5") => {
  const cost = responseCost(prices, model, usage);
  if (!cost.ok) throw new Error(cost.reason);
  return unitsToMicroUsd(cost.costUnits);
};

describe("the Anthropic price table", () => {
  it("is dated, sourced, and keeps each model's published cache multipliers", () => {
    expect(prices.retrievedAt).toBe("2026-09-28");
    expect(prices.source).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
    // 5-minute writes 1.25x, 1-hour writes 2x, reads 0.1x of input, except Fable 5.1 (0.025x) and Opus 5.5 (0.05x).
    const readTenThousandths: Record<string, bigint> = { "claude-fable-5-1": 250n, "claude-opus-5-5": 500n };
    for (const [model, p] of Object.entries(prices.models)) {
      const input = BigInt(p.input);
      expect(BigInt(p.cacheWrite5m) * 100n, model).toBe(input * 125n);
      expect(BigInt(p.cacheWrite1h), model).toBe(input * 2n);
      expect(BigInt(p.cacheRead) * 10_000n, model).toBe(input * (readTenThousandths[model] ?? 1000n));
    }
  });
});

describe("responseCost", () => {
  it("prices every token kind at the model's list price", () => {
    // 100 x $2 + 2,000 x $2.50 + 7 x $10 per million tokens: the $0.00527 Claude Code estimated for the same reply.
    expect(micro(SMALL)).toBe(5270n);
    expect(micro({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBe(200_000n);
    expect(micro({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } })).toBe(4_000_000n);
    expect(micro({ cache_read_input_tokens: 1_000_000 }, "claude-opus-5-5")).toBe(200_000n);
  });

  it("prices a dated snapshot id as its model", () => {
    expect(micro({ input_tokens: 1_000_000 }, "claude-haiku-4-5-20251001")).toBe(1_000_000n);
  });

  it("applies the US inference multiplier to tokens, and not to the flat web search fee", () => {
    expect(micro({ input_tokens: 1_000_000, inference_geo: "us" })).toBe(2_200_000n);
    expect(micro({ input_tokens: 1_000_000, inference_geo: "global", server_tool_use: { web_search_requests: 3 } })).toBe(2_030_000n);
    expect(micro({ input_tokens: 1_000_000, inference_geo: "us", server_tool_use: { web_search_requests: 3 } })).toBe(2_230_000n);
    expect(micro({ input_tokens: 1_000_000, inference_geo: "" })).toBe(2_000_000n);
  });

  it("rounds a run's cost up once, not each response", () => {
    // One input token of Haiku costs 1 micro-USD; one cache read costs a tenth of that.
    const read = responseCost(prices, "claude-haiku-4-5", { cache_read_input_tokens: 1 });
    expect(read.ok && unitsToMicroUsd(read.costUnits)).toBe(1n);
    expect(read.ok && unitsToMicroUsd(read.costUnits * 10n)).toBe(1n);
    expect(read.ok && unitsToMicroUsd(read.costUnits * 11n)).toBe(2n);
  });

  it("refuses what the table cannot price exactly, and still counts the tokens", () => {
    const refused = (model: string, usage: ResponseUsage) => {
      const cost = responseCost(prices, model, usage);
      return cost.ok ? null : { reason: cost.reason, tokens: cost.tokens };
    };
    expect(refused("claude-nonexistent-9", SMALL)?.reason).toMatch(/no price/);
    expect(refused("claude-nonexistent-9", SMALL)?.tokens).toEqual({ input: 100, output: 7, cacheRead: 0, cacheWrite: 2000, reasoning: 0 });
    expect(refused("claude-sonnet-5", { ...SMALL, service_tier: "priority" })?.reason).toMatch(/service tier priority/);
    expect(refused("claude-opus-5-5", { ...SMALL, speed: "fast" })?.reason).toMatch(/speed fast/);
    expect(refused("claude-sonnet-5", { ...SMALL, inference_geo: "eu" })?.reason).toMatch(/geography eu/);
    expect(refused("claude-sonnet-5", { ...SMALL, iterations: [{ type: "fallback_message" }] })?.reason).toMatch(/iterations/);
    expect(refused("claude-sonnet-5", { ...SMALL, cache_creation: null })?.reason).toMatch(/split/);
    expect(refused("claude-sonnet-5", { ...SMALL, output_tokens_details: { thinking_tokens: 8 } })?.reason).toMatch(/thinking tokens/);
  });

  it("sums exactly: two responses cost what their tokens cost as one", () => {
    const tokens = fc.nat({ max: 5_000_000 });
    const usage = fc.record({ input: tokens, output: tokens, read: tokens, w5: tokens, w1: tokens, searches: fc.nat({ max: 50 }) });
    type Drawn = { input: number; output: number; read: number; w5: number; w1: number; searches: number };
    const toUsage = (u: Drawn, geo: string): ResponseUsage => ({
      input_tokens: u.input,
      output_tokens: u.output,
      cache_read_input_tokens: u.read,
      cache_creation_input_tokens: u.w5 + u.w1,
      cache_creation: { ephemeral_5m_input_tokens: u.w5, ephemeral_1h_input_tokens: u.w1 },
      server_tool_use: { web_search_requests: u.searches },
      inference_geo: geo,
    });
    fc.assert(
      fc.property(usage, usage, fc.constantFrom(...Object.keys(prices.models)), fc.constantFrom("global", "us"), (a, b, model, geo) => {
        const both = { input: a.input + b.input, output: a.output + b.output, read: a.read + b.read, w5: a.w5 + b.w5, w1: a.w1 + b.w1, searches: a.searches + b.searches };
        const [ca, cb, cab] = [a, b, both].map((u) => responseCost(prices, model, toUsage(u, geo)));
        return ca?.ok === true && cb?.ok === true && cab?.ok === true && ca.costUnits + cb.costUnits === cab.costUnits;
      }),
    );
  });
});

const sse = (events: ReadonlyArray<Record<string, unknown>>, eol = "\n") => events.map((e) => `event: ${String(e["type"])}${eol}data: ${JSON.stringify(e)}${eol}${eol}`).join("");
const start = (model: string, usage: Record<string, unknown>) => ({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage } });
const delta = (usage: Record<string, unknown>) => ({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
const STREAM = [
  start("claude-sonnet-5", { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 }, output_tokens: 1, service_tier: "standard" }),
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK é" } },
  { type: "ping" },
  delta({ output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } }),
  { type: "message_stop" },
];

describe("UsageStreamReader", () => {
  const read = (text: string, cuts: readonly number[] = []) => {
    const reader = new UsageStreamReader();
    const bytes = Buffer.from(text, "utf8");
    let at = 0;
    for (const cut of [...cuts].sort((a, b) => a - b)) {
      reader.feed(bytes.subarray(at, cut));
      at = cut;
    }
    reader.feed(bytes.subarray(at));
    return reader.end();
  };

  it("takes the model and first counts from message_start and the final counts from message_delta", () => {
    const result = read(sse(STREAM));
    expect(result).toMatchObject({ state: "complete", model: "claude-sonnet-5", malformed: false });
    expect(result.usage).toMatchObject({ input_tokens: 100, cache_creation_input_tokens: 2000, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } });
  });

  it("reads the same however the stream is cut into chunks, with \\n or \\r\\n line ends", () => {
    for (const eol of ["\n", "\r\n"]) {
      const text = sse(STREAM, eol);
      const whole = read(text);
      const cuts = fc.uniqueArray(fc.integer({ min: 1, max: Buffer.byteLength(text) - 1 }), { maxLength: 12 });
      fc.assert(
        fc.property(cuts, (at) => {
          expect(read(text, at)).toEqual(whole);
        }),
      );
    }
  });

  it("marks a stream that ended without message_stop as cut, and an error event as errored with the usage so far", () => {
    expect(read(sse(STREAM.slice(0, 3))).state).toBe("cut");
    const errored = read(sse([...STREAM.slice(0, 3), { type: "error", error: { type: "overloaded_error" } }]));
    expect(errored).toMatchObject({ state: "errored", usage: { input_tokens: 100, output_tokens: 1 } });
  });

  it("flags usage it cannot read", () => {
    expect(read(`${sse(STREAM.slice(0, 1))}data: {not json\n\n${sse(STREAM.slice(4))}`).malformed).toBe(true);
    expect(read(sse([start("claude-sonnet-5", { input_tokens: -1 }), ...STREAM.slice(4)])).malformed).toBe(true);
  });

  it("reads a non-streamed response from its body", () => {
    expect(readJsonResponse(JSON.stringify({ type: "message", model: "claude-sonnet-5", usage: SMALL }))).toEqual({ state: "complete", model: "claude-sonnet-5", usage: SMALL, malformed: false });
    expect(readJsonResponse("{oops").malformed).toBe(true);
  });
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** A stand-in for the Anthropic API: `handler` answers, and every request is kept. */
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
// The harness's own Anthropic credential in these tests, built from pieces so scanners stay quiet.
const REAL = ["sk", "ant", "api03", "fake", "harness"].join("-");

describe("MeteringProxy", { timeout: 20_000 }, () => {
  const open = async (upstream: string, drainMs = 5000) => {
    const proxy = new MeteringProxy({ apiKey: REAL, prices, upstream, drainMs });
    const url = await proxy.open();
    return { proxy, url };
  };
  const post = (url: string, token: string, path = "/v1/messages?beta=true", init: RequestInit = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5", stream: true }), ...init });

  it("passes a run's request on with the real key, streams the reply back unchanged, and meters it", async () => {
    const api = await standIn((_req, res) => streamed(res, STREAM));
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-1");
    const reply = await post(url, "run-token-1");
    expect(await reply.text()).toBe(sse(STREAM));
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/v1/messages?beta=true" });
    expect(api.seen[0]?.headers["x-api-key"]).toBe(REAL);
    expect(api.seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(api.seen[0]?.headers)).not.toContain("run-token-1");
    const reading = await proxy.end("run-token-1");
    expect(reading).toMatchObject({ responses: 1, incomplete: 0, unpriced: [], models: ["claude-sonnet-5"], costMicroUsd: "5270" });
    expect(reading.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2000, totalTokens: 2107, reasoningTokens: 3 });
    await proxy.close();
  });

  it("refuses tokens that are not a live run's, and APIs it does not meter", async () => {
    const api = await standIn((_req, res) => streamed(res, STREAM));
    const { proxy, url } = await open(api.url);
    expect((await post(url, "nobody")).status).toBe(401);
    proxy.begin("run-token-2");
    expect((await post(url, "run-token-2", "/v1/messages/batches")).status).toBe(404);
    expect((await post(url, "run-token-2", "/v1/files")).status).toBe(404);
    expect((await fetch(`${url}/api/hello`, { method: "HEAD" })).status).toBe(200);
    expect(api.seen).toEqual([]);
    await proxy.end("run-token-2");
    expect((await post(url, "run-token-2")).status).toBe(401);
    expect(api.seen).toEqual([]);
    await proxy.close();
  });

  it("passes token counting and error replies on without metering them", async () => {
    const api = await standIn((req, res) => {
      if (req.url?.startsWith("/v1/messages/count_tokens")) return void res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":42}');
      res.writeHead(529, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"overloaded_error"}}');
    });
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-3");
    expect(await (await post(url, "run-token-3", "/v1/messages/count_tokens?beta=true")).json()).toEqual({ input_tokens: 42 });
    expect((await post(url, "run-token-3")).status).toBe(529);
    expect(await proxy.end("run-token-3")).toMatchObject({ responses: 0, costMicroUsd: "0" });
    await proxy.close();
  });

  it("meters a non-streamed reply", async () => {
    const api = await standIn((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", model: "claude-sonnet-5", usage: SMALL })));
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-4");
    await (await post(url, "run-token-4")).text();
    expect(await proxy.end("run-token-4")).toMatchObject({ responses: 1, costMicroUsd: "5270" });
    await proxy.close();
  });

  it("reads a reply to its end after the agent went away, so its final usage is known", async () => {
    const api = await standIn(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse(STREAM.slice(0, 3)));
      await new Promise((r) => setTimeout(r, 300));
      res.end(sse(STREAM.slice(3)));
    });
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-5");
    const abort = new AbortController();
    const reply = await post(url, "run-token-5", undefined, { signal: abort.signal });
    await reply.body?.getReader().read();
    abort.abort();
    expect(await proxy.end("run-token-5")).toMatchObject({ responses: 1, incomplete: 0, costMicroUsd: "5270" });
    await proxy.close();
  });

  it("counts a reply cut off before its final usage as incomplete", async () => {
    const api = await standIn((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse(STREAM.slice(0, 3)));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const { proxy, url } = await open(api.url);
    proxy.begin("run-token-6");
    await (await post(url, "run-token-6")).text().catch(() => undefined);
    expect(await proxy.end("run-token-6")).toMatchObject({ responses: 1, incomplete: 1 });
    await proxy.close();
  });

  it("stops reading an abandoned reply after drainMs and counts it as incomplete", async () => {
    const api = await standIn((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse(STREAM.slice(0, 1)));
    });
    const { proxy, url } = await open(api.url, 200);
    proxy.begin("run-token-7");
    const abort = new AbortController();
    const reply = await post(url, "run-token-7", undefined, { signal: abort.signal });
    await reply.body?.getReader().read();
    abort.abort();
    expect(await proxy.end("run-token-7")).toMatchObject({ responses: 1, incomplete: 1 });
    await proxy.close();
  });
});

/**
 * A stand-in `claude` executable: it records its arguments and environment,
 * then behaves as its prompt says (`-p <mode>`), printing stream-json lines
 * like headless Claude Code and calling the API it was given.
 */
function fakeClaude(dir: string): string {
  const path = join(dir, "claude.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = args[args.indexOf("-p") + 1];
writeFileSync("seen.json", JSON.stringify({ args, env: process.env }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (mode === "die") { process.stderr.write("claude: boom\\n"); process.exit(1); }
const session = "0b7c5e1a-6f0e-4c1e-9a55-2f3d4c5b6a70";
out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5" });
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "no-credit") out({ type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "Credit balance is too low", session_id: session, modelUsage: {} });
else {
  const reply = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", { method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "content-type": "application/json" }, body: "{}" });
  await reply.text();
  out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }] } });
  out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: mode === "tool-error" }] } });
  const tokens = { inputTokens: mode === "bypass" ? 5000 : 100, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 2000 };
  out({ type: "result", subtype: mode === "fail" ? "error_during_execution" : "success", is_error: mode === "fail", errors: mode === "fail" ? ["tool loop broke"] : [], session_id: session, total_cost_usd: 99, modelUsage: { "claude-sonnet-5": tokens } });
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("ClaudeCodeAdapter", { timeout: 20_000 }, () => {
  const setup = async () => {
    const api = await standIn((_req, res) => streamed(res, STREAM));
    const dir = temp("lemma-claude-");
    const cwd = join(dir, "work");
    const home = join(dir, "home");
    mkdirSync(cwd);
    mkdirSync(join(home, "tmp"), { recursive: true });
    const meterDir = join(dir, "meter");
    const adapter = new ClaudeCodeAdapter(REAL, { command: fakeClaude(dir), meterDir, prices, upstream: api.url, graceMs: { stop: 300, exit: 300 }, drainMs: 5000 });
    const request = (prompt: string, timeoutMs = 10_000) => ({ cwd, home, prompt, model: { id: "claude-sonnet-5" }, mcpServers: { lemma: { command: "/usr/bin/node", args: ["bridge.js"], env: { LEMMA_API_URL: "http://localhost:3000" } } }, timeoutMs });
    const seen = () => JSON.parse(readFileSync(join(cwd, "seen.json"), "utf8")) as { args: string[]; env: Record<string, string> };
    return { api, adapter, home, meterDir, request, seen };
  };

  it("runs headless Claude Code on the meter's URL and a run token, never the key", async () => {
    const { api, adapter, home, request, seen } = await setup();
    const started: string[] = [];
    const outcome = await adapter.run({ ...request("finish"), onStarted: (id) => started.push(id) });
    const { args, env } = seen();
    expect(Object.values(env)).not.toContain(REAL);
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process it starts.
    const given = Object.keys(env).filter((name) => name !== "__CF_USER_TEXT_ENCODING");
    expect(given.sort()).toEqual([...Object.keys(childEnv(home)), "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].sort());
    expect(env["ANTHROPIC_API_KEY"]).toMatch(/^lemma-run-[0-9a-f]{48}$/);
    expect(env["ANTHROPIC_BASE_URL"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(api.seen[0]?.headers["x-api-key"]).toBe(REAL);
    expect(args).toEqual([
      "-p",
      "finish",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-5",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { lemma: { type: "stdio", command: "/usr/bin/node", args: ["bridge.js"], env: { LEMMA_API_URL: "http://localhost:3000" } } } }),
      "--no-session-persistence",
    ]);
    expect(started).toEqual(["0b7c5e1a-6f0e-4c1e-9a55-2f3d4c5b6a70"]);
    expect(outcome).toMatchObject({
      agentId: "0b7c5e1a-6f0e-4c1e-9a55-2f3d4c5b6a70",
      status: "finished",
      error: null,
      toolCalls: [
        { callId: "toolu_1", name: "Bash", status: "completed" },
        { callId: "srvtoolu_1", name: "web_search", status: "completed" },
      ],
      usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2000, totalTokens: 2107 },
    });
    await adapter.close();
  });

  it("costs a run from its meter record, not from Claude Code's own estimate", async () => {
    const { adapter, request, meterDir } = await setup();
    const outcome = await adapter.run(request("finish"));
    const billed = await adapter.usage(outcome.agentId as string);
    expect(billed).toEqual({ usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2000, totalTokens: 2107, reasoningTokens: 3 }, rawCostCents: 0.527 });
    expect(centsToMicroUsd(billed?.rawCostCents as number)).toBe(5270n);
    const record = MeterRecord.parse(JSON.parse(readFileSync(join(meterDir, `${outcome.agentId}.json`), "utf8")));
    expect(record).toMatchObject({ responses: 1, reportedTokens: 2107, pricesDigest: pricesDigest(prices), costMicroUsd: "5270" });
    await adapter.close();
  });

  it("reports a failed tool call and a run that ended in error", async () => {
    const { adapter, request } = await setup();
    expect((await adapter.run(request("tool-error"))).toolCalls[0]).toEqual({ callId: "toolu_1", name: "Bash", status: "error" });
    expect(await adapter.run(request("fail"))).toMatchObject({ status: "error", error: "error_during_execution: tool loop broke" });
    // An API error that ends the run comes as a "success" result with is_error set; its text says why.
    expect(await adapter.run(request("no-credit"))).toMatchObject({ status: "error", error: "error: Credit balance is too low (API HTTP 400)" });
    await adapter.close();
  });

  it("stops a run at its deadline and counts it as a timeout", async () => {
    const { adapter, request } = await setup();
    const began = Date.now();
    const outcome = await adapter.run(request("hang", 300));
    expect(outcome).toMatchObject({ status: "timeout", agentId: "0b7c5e1a-6f0e-4c1e-9a55-2f3d4c5b6a70" });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(await adapter.usage(outcome.agentId as string)).toMatchObject({ rawCostCents: 0 });
    await adapter.close();
  });

  it("reports a Claude Code that never started as a startup error, with what it said", async () => {
    const { adapter, request, meterDir } = await setup();
    expect(await adapter.run(request("die"))).toMatchObject({ status: "startup-error", agentId: null, error: "claude: boom" });
    expect(existsSync(meterDir)).toBe(false);
    await adapter.close();
  });

  it("leaves a run's cost unknown when traffic went around the meter", async () => {
    const { adapter, request } = await setup();
    const outcome = await adapter.run(request("bypass"));
    await expect(adapter.usage(outcome.agentId as string)).rejects.toThrow(/went around the meter/);
    await adapter.close();
  });

  it("refuses to put a credential on Claude Code's command line", async () => {
    const { adapter, request } = await setup();
    const leaky = { lemma: { command: "/usr/bin/node", args: ["bridge.js"], env: { BUYER_PRIVATE_KEY: ["0x", "ab".repeat(32)].join("") } } };
    await expect(adapter.run({ ...request("finish"), mcpServers: leaky })).rejects.toThrow(/BUYER_PRIVATE_KEY on Claude Code's command line/);
    await adapter.close();
  });

  it("checks the key and the model with a one-token request, and says why they cannot run", async () => {
    let reply: [number, Record<string, unknown>] = [200, { type: "message", content: [] }];
    const api = await standIn((_req, res) => void res.writeHead(reply[0], { "content-type": "application/json" }).end(JSON.stringify(reply[1])));
    const adapter = new ClaudeCodeAdapter(REAL, { command: null, meterDir: temp("lemma-meter-"), prices, upstream: api.url });
    await adapter.checkModel("claude-sonnet-5");
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/v1/messages" });
    expect(api.seen[0]?.headers["x-api-key"]).toBe(REAL);
    expect(JSON.parse(api.seen[0]?.body ?? "")).toEqual({ model: "claude-sonnet-5", max_tokens: 1, messages: [{ role: "user", content: "OK" }] });
    const error = (type: string, message: string) => ({ type: "error", error: { type, message } });
    const cases: Array<[number, Record<string, unknown>, RegExp]> = [
      // A key without credit can still list models; only a request that costs something finds it out.
      [400, error("invalid_request_error", "Your credit balance is too low to access the Anthropic API."), /no API credit left/],
      [401, error("authentication_error", "invalid x-api-key"), /refused the key \(HTTP 401\)/],
      [404, error("not_found_error", "model: claude-sonnet-5"), /not available to this key/],
      [429, error("rate_limit_error", "slow down"), /rate limiting/],
      [529, error("overloaded_error", "Overloaded"), /overloaded \(HTTP 529\)/],
      [500, error("api_error", "Internal server error"), /failed: HTTP 500 api_error$/],
    ];
    for (const [status, body, message] of cases) {
      reply = [status, body];
      await expect(adapter.checkModel("claude-sonnet-5")).rejects.toThrow(message);
    }
    await adapter.close();
  });

  it("refuses a model the table does not price before asking the API", async () => {
    const { api, adapter } = await setup();
    await expect(adapter.checkModel("claude-nonexistent-9")).rejects.toThrow(/not in prices/);
    expect(api.seen).toEqual([]);
    await adapter.close();
  });
});

describe("readMeteredUsage", () => {
  const agentId = "0b7c5e1a-6f0e-4c1e-9a55-2f3d4c5b6a70";
  const record = (fields: Partial<MeterRecord>) => {
    const dir = temp("lemma-meter-");
    const base: MeterRecord = {
      schemaVersion: "1",
      agentId,
      pricesDigest: pricesDigest(prices),
      meteredAt: "2026-09-28T00:00:00.000Z",
      responses: 1,
      incomplete: 0,
      unpriced: [],
      models: ["claude-sonnet-5"],
      usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2000, totalTokens: 2107, reasoningTokens: 0 },
      webSearches: 0,
      costMicroUsd: "5270",
      reportedTokens: 2107,
    };
    writeFileSync(join(dir, `${agentId}.json`), JSON.stringify({ ...base, ...fields }));
    return dir;
  };

  it("returns the metered cost of a complete record", () => {
    expect(readMeteredUsage(record({}), agentId, pricesDigest(prices)).rawCostCents).toBe(0.527);
  });

  it("leaves the cost unknown, with the reason, whenever it cannot be known", () => {
    expect(() => readMeteredUsage(temp("lemma-meter-"), agentId, pricesDigest(prices))).toThrow(/no meter record/);
    expect(() => readMeteredUsage(record({ incomplete: 1 }), agentId, pricesDigest(prices))).toThrow(/stopped before their final usage/);
    expect(() => readMeteredUsage(record({ unpriced: ["model x has no price in the table"] }), agentId, pricesDigest(prices))).toThrow(/cannot price: model x/);
    expect(() => readMeteredUsage(record({}), agentId, `0x${"11".repeat(32)}`)).toThrow(/another price table/);
    expect(() => readMeteredUsage(record({}), "../escape", pricesDigest(prices))).toThrow(/not a Claude Code session id/);
  });
});

describe("the Claude Code treatment", () => {
  it("gets the Lemma rule where Claude Code reads project rules", () => {
    expect(RULE_FILES["claude-code"]).toBe(".claude/rules/lemma.md");
    const fixtureDir = temp("lemma-fx-");
    mkdirSync(join(fixtureDir, "repo"));
    writeFileSync(join(fixtureDir, "repo", "README.md"), "fixture\n");
    const rule = join(temp("lemma-rule-"), "lemma.mdc");
    writeFileSync(rule, "---\nalwaysApply: true\n---\ncall lemma_preview first\n");
    const ws = prepareWorkspace({ base: temp("lemma-runs-"), runId: `0x${"ab".repeat(32)}`, fixtureDir, repositoryRoot: temp("lemma-repo-"), rulePath: rule, ruleFile: RULE_FILES["claude-code"] });
    expect(readFileSync(join(ws.cwd, ".claude", "rules", "lemma.md"), "utf8")).toBe("---\nalwaysApply: true\n---\ncall lemma_preview first\n");
    expect(existsSync(join(ws.cwd, ".cursor"))).toBe(false);
    ws.dispose();
  });

  it("names its price table in the version's agent setup, and Cursor names none", () => {
    expect(AgentSetup.safeParse({ name: "claude-code", version: "2.1.283", pricesDigest: pricesDigest(prices) }).success).toBe(true);
    expect(AgentSetup.safeParse({ name: "claude-code", version: "2.1.283", pricesDigest: null }).success).toBe(false);
    expect(AgentSetup.safeParse({ name: "cursor", version: "1.0.32", pricesDigest: null }).success).toBe(true);
    expect(AgentSetup.safeParse({ name: "cursor", version: "1.0.32", pricesDigest: pricesDigest(prices) }).success).toBe(false);
  });
});
