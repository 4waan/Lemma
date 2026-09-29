import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Hex32, canonicalize, fileDigest } from "@lemma/core";
import { z } from "zod";

import { BENCHMARK_ROOT } from "./fixture.js";

const Integer = z.string().regex(/^(0|[1-9]\d{0,15})$/);

/**
 * Anthropic's list prices, as published on a stated date. Token prices are
 * micro-USD per million tokens, so every published price is a whole number.
 * The digest of this file is bound to every benchmark version that meters
 * Claude Code, so a price change needs a new version.
 */
export const AnthropicPrices = z.strictObject({
  schemaVersion: z.literal("1"),
  source: z.url(),
  retrievedAt: z.iso.date(),
  models: z.record(
    z.string().regex(/^claude-[a-z0-9-]+$/),
    z.strictObject({ input: Integer, cacheWrite5m: Integer, cacheWrite1h: Integer, cacheRead: Integer, output: Integer }),
  ),
  /** Micro-USD per web search. */
  webSearchMicroUsd: Integer,
  /** The multiplier for each `usage.inference_geo`, in tenths: 10 is list price. */
  inferenceGeoTenths: z.record(z.string().regex(/^[a-z_]+$/), z.int().min(1).max(100)),
});

export type AnthropicPrices = z.infer<typeof AnthropicPrices>;

export const ANTHROPIC_PRICES_PATH = join(BENCHMARK_ROOT, "prices", "anthropic.json");

export function loadAnthropicPrices(path: string = ANTHROPIC_PRICES_PATH): AnthropicPrices {
  return AnthropicPrices.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function pricesDigest(prices: AnthropicPrices): Hex32 {
  return fileDigest(canonicalize(prices));
}

/** The price entry for a model id, with a dated snapshot id (`claude-haiku-4-5-20251001`) priced as its model. */
export function modelPrice(prices: AnthropicPrices, model: string): AnthropicPrices["models"][string] | undefined {
  return prices.models[model] ?? prices.models[model.replace(/-\d{8}$/, "")];
}

const Count = z.int().min(0);

/**
 * The `usage` of one Messages API response: what Anthropic bills. Unknown
 * fields are dropped; the ones pricing depends on are checked in `responseCost`.
 */
export const ResponseUsage = z.object({
  input_tokens: Count.nullish(),
  output_tokens: Count.nullish(),
  cache_creation_input_tokens: Count.nullish(),
  cache_read_input_tokens: Count.nullish(),
  cache_creation: z.object({ ephemeral_5m_input_tokens: Count.nullish(), ephemeral_1h_input_tokens: Count.nullish() }).nullish(),
  server_tool_use: z.object({ web_search_requests: Count.nullish() }).nullish(),
  output_tokens_details: z.object({ thinking_tokens: Count.nullish() }).nullish(),
  service_tier: z.string().nullish(),
  inference_geo: z.string().nullish(),
  speed: z.string().nullish(),
  iterations: z.array(z.unknown()).nullish(),
});

export type ResponseUsage = z.infer<typeof ResponseUsage>;

/** Cost is summed in units of 1e-7 micro-USD, exact for every price in the table, and rounded up once per run. */
export const COST_UNITS_PER_MICRO_USD = 10_000_000n;

export interface ResponseTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** A subset of `output`, when the response reports it. */
  readonly reasoning: number;
}

export type ResponseCost =
  | { readonly ok: true; readonly tokens: ResponseTokens; readonly webSearches: number; readonly costUnits: bigint }
  | { readonly ok: false; readonly tokens: ResponseTokens; readonly webSearches: number; readonly reason: string };

/**
 * What one response cost at list price. Anything the table cannot price
 * exactly is refused with a reason rather than approximated: an unknown model,
 * a service tier or speed other than standard, an unknown inference
 * geography, sampling iterations (fallbacks or compaction, whose parts may be
 * priced differently), or cache writes without their 5-minute and 1-hour
 * split. Token counts come back either way, so a refused response still shows
 * what it used.
 */
export function responseCost(prices: AnthropicPrices, model: string, usage: ResponseUsage): ResponseCost {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const tokens: ResponseTokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite,
    reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
  const webSearches = usage.server_tool_use?.web_search_requests ?? 0;
  const refuse = (reason: string): ResponseCost => ({ ok: false, tokens, webSearches, reason });

  const price = modelPrice(prices, model);
  if (price === undefined) return refuse(`model ${model} has no price in the table`);
  if ((usage.service_tier ?? "standard") !== "standard") return refuse(`service tier ${usage.service_tier} is not priced`);
  if ((usage.speed ?? "standard") !== "standard") return refuse(`speed ${usage.speed} is not priced`);
  const geo = usage.inference_geo === null || usage.inference_geo === undefined || usage.inference_geo === "" ? "global" : usage.inference_geo;
  const geoTenths = prices.inferenceGeoTenths[geo];
  if (geoTenths === undefined) return refuse(`inference geography ${geo} is not priced`);
  if ((usage.iterations ?? []).length > 0) return refuse("a response with sampling iterations (a fallback or compaction) is not priced");
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (write5m + write1h !== cacheWrite) return refuse(`cache writes (${cacheWrite}) do not match their 5-minute and 1-hour split (${write5m} + ${write1h})`);
  if (tokens.reasoning > tokens.output) return refuse(`thinking tokens (${tokens.reasoning}) exceed output tokens (${tokens.output})`);

  const perMillion =
    BigInt(tokens.input) * BigInt(price.input) +
    BigInt(write5m) * BigInt(price.cacheWrite5m) +
    BigInt(write1h) * BigInt(price.cacheWrite1h) +
    BigInt(tokens.cacheRead) * BigInt(price.cacheRead) +
    BigInt(tokens.output) * BigInt(price.output);
  // Token prices are per million tokens and the geography multiplier is in tenths: 1e6 x 10 = 1e7 units per micro-USD.
  // A web search is a flat fee, not a token price, so the geography multiplier does not apply to it.
  const costUnits = perMillion * BigInt(geoTenths) + BigInt(webSearches) * BigInt(prices.webSearchMicroUsd) * COST_UNITS_PER_MICRO_USD;
  return { ok: true, tokens, webSearches, costUnits };
}

/** Units of 1e-7 micro-USD to whole micro-USD, rounded up. */
export function unitsToMicroUsd(units: bigint): bigint {
  if (units < 0n) throw new RangeError("cost must not be negative");
  return (units + COST_UNITS_PER_MICRO_USD - 1n) / COST_UNITS_PER_MICRO_USD;
}

/**
 * How one response ended, for the meter: `complete` when the API sent its
 * final usage, `errored` when it reported an error (usage is what it reported
 * before that, if anything), `cut` when the response stopped without either,
 * so its final usage is unknown. `malformed` marks a usage or body that did
 * not parse, which the meter cannot price.
 */
export interface ResponseRead<U = ResponseUsage> {
  readonly state: "complete" | "errored" | "cut";
  readonly model: string | null;
  readonly usage: U | null;
  readonly malformed: boolean;
}

/** Later usage fields replace earlier ones: `message_delta` counts are cumulative. */
function mergeUsage(a: ResponseUsage | null, b: ResponseUsage | null): ResponseUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) if (value !== null && value !== undefined) out[key] = value;
  return out as ResponseUsage;
}

/**
 * Reads the usage out of a streamed Messages API response (server-sent
 * events), fed as it passes through: the model and first usage from
 * `message_start`, the final counts from `message_delta`, the end from
 * `message_stop` or `error`. Only the event being received is buffered.
 */
export class UsageStreamReader {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private model: string | null = null;
  private usage: ResponseUsage | null = null;
  private stopped = false;
  private errored = false;
  private malformed = false;

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  end(): ResponseRead {
    this.buffer += this.decoder.decode();
    this.drain(true);
    const state = this.errored ? "errored" : this.stopped ? "complete" : "cut";
    return { state, model: this.model, usage: this.usage, malformed: this.malformed };
  }

  private drain(final: boolean): void {
    // A lone \r at the end may be the first half of \r\n: it waits for the next chunk.
    const upTo = !final && this.buffer.endsWith("\r") ? this.buffer.length - 1 : this.buffer.length;
    const text = this.buffer.slice(0, upTo).replace(/\r\n?/g, "\n");
    const rest = this.buffer.slice(upTo);
    const events = text.split("\n\n");
    const last = events.pop() ?? "";
    for (const event of events) this.event(event);
    if (final) {
      this.event(last);
      this.buffer = "";
    } else {
      this.buffer = last + rest;
    }
  }

  private event(block: string): void {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") return;
    let parsed: { type?: unknown; message?: { model?: unknown; usage?: unknown }; usage?: unknown };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      this.malformed = true;
      return;
    }
    if (parsed.type === "message_start") {
      if (typeof parsed.message?.model === "string") this.model = parsed.message.model;
      this.usage = mergeUsage(this.usage, this.read(parsed.message?.usage));
    } else if (parsed.type === "message_delta") {
      this.usage = mergeUsage(this.usage, this.read(parsed.usage));
    } else if (parsed.type === "message_stop") {
      this.stopped = true;
    } else if (parsed.type === "error") {
      this.errored = true;
    }
  }

  private read(value: unknown): ResponseUsage | null {
    if (value === undefined || value === null) return null;
    const parsed = ResponseUsage.safeParse(value);
    if (!parsed.success) this.malformed = true;
    return parsed.success ? parsed.data : null;
  }
}

/** The usage of a successful, non-streamed Messages API response, from its whole body. */
export function readJsonResponse(body: string): ResponseRead {
  let parsed: { model?: unknown; usage?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { state: "complete", model: null, usage: null, malformed: true };
  }
  const usage = ResponseUsage.safeParse(parsed.usage);
  const model = typeof parsed.model === "string" ? parsed.model : null;
  return { state: "complete", model, usage: usage.success ? usage.data : null, malformed: !usage.success || model === null };
}
