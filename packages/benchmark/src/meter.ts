import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Hex32, IsoTimestamp } from "@lemma/core";
import { z } from "zod";

import { type AnthropicPrices, type ResponseRead, UsageStreamReader, readJsonResponse, responseCost, unitsToMicroUsd } from "./anthropic-usage.js";

const Count = z.int().min(0);

/**
 * What one Claude Code run used, as the meter saw it: every Messages API
 * response, priced from the dated table. Written when the run ends and read by
 * `ClaudeCodeAdapter.usage` at reconcile time.
 */
export const MeterRecord = z.strictObject({
  schemaVersion: z.literal("1"),
  agentId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  pricesDigest: Hex32,
  meteredAt: IsoTimestamp,
  /** Successful Messages API responses the meter read for usage; error responses are not billed and not counted. */
  responses: Count,
  /** Responses that stopped before their final usage: the run's cost is unknown while this is above zero. */
  incomplete: Count,
  /** Why responses could not be priced; the run's cost is unknown while this is not empty. */
  unpriced: z.array(z.string().max(300)).max(20),
  models: z.array(z.string().max(100)).max(20),
  usage: z.strictObject({
    inputTokens: Count,
    outputTokens: Count,
    cacheReadTokens: Count,
    cacheWriteTokens: Count,
    totalTokens: Count,
    reasoningTokens: Count,
  }),
  webSearches: Count,
  costMicroUsd: z.string().regex(/^(0|[1-9]\d*)$/),
  /** The tokens Claude Code itself reported for the run, when it reported them: never more than the meter saw, unless traffic went around it. */
  reportedTokens: Count.nullable(),
});

export type MeterRecord = z.infer<typeof MeterRecord>;

export type MeterReading = Omit<MeterRecord, "schemaVersion" | "agentId" | "pricesDigest" | "meteredAt" | "reportedTokens">;

/** One run's running totals. */
class RunMeter {
  closed = false;
  inFlight = 0;
  private readonly idle: Array<() => void> = [];
  private responses = 0;
  private incomplete = 0;
  private readonly unpriced = new Set<string>();
  private readonly models = new Set<string>();
  private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  private webSearches = 0;
  private costUnits = 0n;

  constructor(private readonly prices: AnthropicPrices) {}

  record(read: ResponseRead): void {
    this.responses++;
    if (read.state === "cut") {
      this.incomplete++;
      return;
    }
    if (read.malformed) this.unpriced.add("a response's usage did not parse");
    if (read.usage === null) {
      // A successful response always carries usage; an error before any usage was billed nothing.
      if (read.state === "complete") this.unpriced.add("a successful response carried no usage");
      return;
    }
    if (read.model === null) {
      this.unpriced.add("a response named no model");
      return;
    }
    this.models.add(read.model);
    const cost = responseCost(this.prices, read.model, read.usage);
    this.tokens.input += cost.tokens.input;
    this.tokens.output += cost.tokens.output;
    this.tokens.cacheRead += cost.tokens.cacheRead;
    this.tokens.cacheWrite += cost.tokens.cacheWrite;
    this.tokens.reasoning += cost.tokens.reasoning;
    this.webSearches += cost.webSearches;
    if (cost.ok) this.costUnits += cost.costUnits;
    else if (this.unpriced.size < 20) this.unpriced.add(cost.reason);
  }

  enter(): void {
    this.inFlight++;
  }

  leave(): void {
    this.inFlight--;
    if (this.inFlight === 0) for (const resolve of this.idle.splice(0)) resolve();
  }

  settled(): Promise<void> {
    return this.inFlight === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.push(resolve));
  }

  reading(): MeterReading {
    const { input, output, cacheRead, cacheWrite, reasoning } = this.tokens;
    return {
      responses: this.responses,
      incomplete: this.incomplete,
      unpriced: [...this.unpriced].sort(),
      models: [...this.models].sort().slice(0, 20),
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, reasoningTokens: reasoning },
      webSearches: this.webSearches,
      costMicroUsd: unitsToMicroUsd(this.costUnits).toString(),
    };
  }
}

/** How long the meter keeps reading a response after the agent went away, to learn its final usage. */
export const DRAIN_MS = 10 * 60_000;
/** Largest request body passed on: well above a full 1M-token context. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** Request headers that stay between the agent and the meter. */
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "x-api-key", "authorization", "cookie", "accept-encoding"]);
/** Response headers the meter does not pass back: hop-by-hop ones, and the encoding and length of a body `fetch` has already decoded. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie"]);

/**
 * A local HTTP endpoint that Claude Code uses as its Anthropic API: it holds
 * the real key, passes each run's requests on with it, and reads the usage of
 * every Messages API response as it streams back. The agent's process only
 * ever sees a per-run token, which stops working when the run ends.
 *
 * Only the Messages API (metered), token counting (free) and the model list
 * are passed on; everything else is refused, so a run cannot spend through an
 * API the meter does not read (batches, for one). When the agent goes away in
 * the middle of a response (its deadline passed and it was killed), the meter
 * keeps reading that response to its end, up to `drainMs`, because it is
 * billed either way: its final usage is then known. A response still cut off
 * is counted as incomplete, which leaves the run's cost unknown rather than
 * guessed.
 */
export class MeteringProxy {
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private readonly runs = new Map<string, RunMeter>();

  constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly prices: AnthropicPrices;
      readonly upstream?: string;
      /** How long to keep reading a response the agent abandoned (default DRAIN_MS). */
      readonly drainMs?: number;
    },
  ) {
    if (options.apiKey === "") throw new Error("an Anthropic API key is required");
  }

  private get upstream(): string {
    return (this.options.upstream ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  /** Starts listening on a free loopback port; returns the base URL runs use. */
  async open(): Promise<string> {
    if (this.baseUrl !== null) return this.baseUrl;
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 502, "api_error", "the meter could not reach the Anthropic API");
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    // The harness exits when its work is done, not when the meter's idle connections close.
    server.unref();
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  /** Starts metering a run whose agent authenticates with `token`. */
  begin(token: string): void {
    if (this.runs.has(token)) throw new Error("run token reused");
    this.runs.set(token, new RunMeter(this.options.prices));
  }

  /**
   * Ends a run: its token stops working, and once every response it started
   * has been read to its end, returns what the run used.
   */
  async end(token: string): Promise<MeterReading> {
    const run = this.runs.get(token);
    if (run === undefined) throw new Error("unknown run token");
    run.closed = true;
    await run.settled();
    this.runs.delete(token);
    return run.reading();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    // Claude Code checks that its API is reachable before the first request.
    if ((req.method === "HEAD" || req.method === "GET") && path === "/api/hello") {
      res.writeHead(200).end();
      return;
    }
    const token = req.headers["x-api-key"];
    const run = typeof token === "string" ? this.runs.get(token) : undefined;
    if (run === undefined || run.closed) {
      sendError(res, 401, "authentication_error", "this key is not a live run's");
      return;
    }
    const metered = req.method === "POST" && path === "/v1/messages";
    const passed = metered || (req.method === "POST" && path === "/v1/messages/count_tokens") || (req.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/")));
    if (!passed) {
      sendError(res, 404, "not_found_error", `the benchmark meter does not pass on ${req.method ?? "?"} ${path}`);
      return;
    }

    run.enter();
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      if (body === null) {
        sendError(res, 413, "request_too_large", "request body too large");
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || DROP_REQUEST.has(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("x-api-key", this.options.apiKey);
      headers.set("accept-encoding", "identity");
      const abort = new AbortController();
      let upstream: Response;
      try {
        upstream = await fetch(`${this.upstream}${url}`, { method: req.method ?? "GET", headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal: abort.signal });
      } catch {
        // No response came back, so none was read or billed as far as the meter can tell.
        sendError(res, 502, "api_error", "the meter could not reach the Anthropic API");
        return;
      }
      const outHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE.has(name)) outHeaders[name] = value;
      });
      res.writeHead(upstream.status, outHeaders);

      // Error responses are not billed; only a successful Messages API response is read for usage.
      const read = !metered || !upstream.ok ? "none" : (upstream.headers.get("content-type") ?? "").includes("text/event-stream") ? "stream" : "json";
      const stream = new UsageStreamReader();
      const json: Uint8Array[] = [];
      let clientGone = false;
      let drainTimer: NodeJS.Timeout | undefined;
      res.on("close", () => {
        if (res.writableFinished) return;
        clientGone = true;
        drainTimer = setTimeout(() => abort.abort(), this.options.drainMs ?? DRAIN_MS);
      });
      const writable = () =>
        new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      let failed = false;
      try {
        for await (const chunk of (upstream.body ?? []) as AsyncIterable<Uint8Array>) {
          if (read === "stream") stream.feed(chunk);
          else if (read === "json") json.push(chunk);
          if (!clientGone && !res.write(chunk)) await writable();
        }
      } catch {
        failed = true;
      } finally {
        clearTimeout(drainTimer);
      }
      if (!clientGone) {
        if (failed) res.destroy();
        else res.end();
      }
      // A stream that failed before `message_stop` or `error` reads as cut; a JSON body that failed is cut too.
      if (read === "stream") run.record(stream.end());
      else if (read === "json") run.record(failed ? { state: "cut", model: null, usage: null, malformed: false } : readJsonResponse(Buffer.concat(json).toString("utf8")));
    } finally {
      run.leave();
    }
  }
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
