import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Hex32, canonicalize, fileDigest } from "@lemma/core";
import { z } from "zod";

import type { ResponseCost, ResponseRead, ResponseTokens } from "./anthropic-usage.js";
import { BENCHMARK_ROOT } from "./fixture.js";

const Integer = z.string().regex(/^(0|[1-9]\d{0,15})$/);

/**
 * OpenAI's list prices for the Responses API at the standard processing tier,
 * as published on a stated date. Token prices are micro-USD per million
 * tokens. `cacheWrite` is what a token written to the prompt cache costs: the
 * input price for models that do not charge cache writes, more for those that
 * do. `standardContextTokens` is where long-context pricing starts: a response
 * above it is left unpriced rather than priced at the short-context rate. The
 * digest of this file is bound to every benchmark version that meters Codex,
 * so a price change needs a new version.
 */
export const OpenAiPrices = z.strictObject({
  schemaVersion: z.literal("1"),
  source: z.url(),
  retrievedAt: z.iso.date(),
  models: z.record(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/), z.strictObject({ input: Integer, cacheWrite: Integer, cacheRead: Integer, output: Integer })),
  standardContextTokens: z.int().min(1),
});

export type OpenAiPrices = z.infer<typeof OpenAiPrices>;

export const OPENAI_PRICES_PATH = join(BENCHMARK_ROOT, "prices", "openai.json");

export function loadOpenAiPrices(path: string = OPENAI_PRICES_PATH): OpenAiPrices {
  return OpenAiPrices.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function openAiPricesDigest(prices: OpenAiPrices): Hex32 {
  return fileDigest(canonicalize(prices));
}

/** The price entry for a model id, with a dated snapshot id (`gpt-5.5-2026-04-23`) priced as its model. */
export function openAiModelPrice(prices: OpenAiPrices, model: string): OpenAiPrices["models"][string] | undefined {
  return prices.models[model] ?? prices.models[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
}

const Count = z.int().min(0);

/**
 * What one Responses API reply used, with what it billed beyond tokens: its
 * service tier and the hosted tools it called. `cached_tokens` and
 * `cache_write_tokens` are parts of `input_tokens`, and `reasoning_tokens` is
 * part of `output_tokens`.
 */
export const OpenAiUsage = z.object({
  input_tokens: Count,
  input_tokens_details: z.object({ cached_tokens: Count.nullish(), cache_write_tokens: Count.nullish() }).nullish(),
  output_tokens: Count,
  output_tokens_details: z.object({ reasoning_tokens: Count.nullish() }).nullish(),
});

export interface OpenAiReply {
  readonly usage: z.infer<typeof OpenAiUsage>;
  readonly serviceTier: string | null;
  /** Output items of hosted tools that are billed per call (web search, file search, code interpreter, image generation). */
  readonly hostedToolCalls: readonly string[];
}

/** Hosted tools OpenAI bills per call on top of tokens; the table does not price them. */
const HOSTED_TOOL_ITEMS = new Set(["web_search_call", "file_search_call", "code_interpreter_call", "image_generation_call"]);

/** Units of 1e-7 micro-USD per micro-USD per million tokens: prices are per 1e6 tokens, units are 1e-7 micro-USD. */
const UNITS_PER_PRICE_TOKEN = 10n;

/**
 * What one reply cost at list price. Anything the table cannot price exactly
 * is refused with a reason rather than approximated: an unknown model, a
 * service tier other than the default (priority and flex are priced
 * differently), input above the standard context (long-context pricing), a
 * hosted tool billed per call, or cache counts that exceed the input they are
 * part of. Token counts come back either way, so a refused reply still shows
 * what it used.
 */
export function openAiResponseCost(prices: OpenAiPrices, model: string, reply: OpenAiReply): ResponseCost {
  const { usage } = reply;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const tokens: ResponseTokens = {
    input: Math.max(usage.input_tokens - cacheRead - cacheWrite, 0),
    output: usage.output_tokens,
    cacheRead,
    cacheWrite,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
  const refuse = (reason: string): ResponseCost => ({ ok: false, tokens, webSearches: 0, reason });

  const price = openAiModelPrice(prices, model);
  if (price === undefined) return refuse(`model ${model} has no price in the table`);
  if (reply.serviceTier !== null && reply.serviceTier !== "default") return refuse(`service tier ${reply.serviceTier} is not priced`);
  if (usage.input_tokens > prices.standardContextTokens) return refuse(`input of ${usage.input_tokens} tokens is above ${prices.standardContextTokens}, where long-context pricing starts`);
  if (reply.hostedToolCalls.length > 0) return refuse(`hosted tool calls billed per call are not priced: ${[...new Set(reply.hostedToolCalls)].sort().join(", ")}`);
  if (cacheRead + cacheWrite > usage.input_tokens) return refuse(`cached (${cacheRead}) and cache-write (${cacheWrite}) tokens exceed input tokens (${usage.input_tokens})`);
  if (tokens.reasoning > tokens.output) return refuse(`reasoning tokens (${tokens.reasoning}) exceed output tokens (${tokens.output})`);

  const perMillion = BigInt(tokens.input) * BigInt(price.input) + BigInt(cacheRead) * BigInt(price.cacheRead) + BigInt(cacheWrite) * BigInt(price.cacheWrite) + BigInt(tokens.output) * BigInt(price.output);
  return { ok: true, tokens, webSearches: 0, costUnits: perMillion * UNITS_PER_PRICE_TOKEN };
}

/** The reply's billing facts from a Responses API `response` object, or null with `malformed` when its usage does not parse. */
function readReply(response: unknown): { model: string | null; reply: OpenAiReply | null; malformed: boolean } {
  if (typeof response !== "object" || response === null) return { model: null, reply: null, malformed: true };
  const r = response as { model?: unknown; usage?: unknown; service_tier?: unknown; output?: unknown };
  const model = typeof r.model === "string" ? r.model : null;
  if (r.usage === undefined || r.usage === null) return { model, reply: null, malformed: false };
  const usage = OpenAiUsage.safeParse(r.usage);
  if (!usage.success) return { model, reply: null, malformed: true };
  const hostedToolCalls = Array.isArray(r.output)
    ? r.output.flatMap((item: unknown) => {
        const type = typeof item === "object" && item !== null ? (item as { type?: unknown }).type : undefined;
        return typeof type === "string" && HOSTED_TOOL_ITEMS.has(type) ? [type] : [];
      })
    : [];
  const serviceTier = typeof r.service_tier === "string" ? r.service_tier : null;
  return { model, reply: { usage: usage.data, serviceTier, hostedToolCalls }, malformed: false };
}

/**
 * Reads the usage out of a streamed Responses API reply (server-sent events),
 * fed as it passes through. The reply ends with `response.completed` or
 * `response.incomplete` (both billed, with final usage), or with
 * `response.failed` or `error`; one that stops before any of them is cut.
 * Only the event being received is buffered.
 */
export class ResponsesStreamReader {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private model: string | null = null;
  private reply: OpenAiReply | null = null;
  private done = false;
  private errored = false;
  private malformed = false;

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  end(): ResponseRead<OpenAiReply> {
    this.buffer += this.decoder.decode();
    this.drain(true);
    const state = this.errored ? "errored" : this.done ? "complete" : "cut";
    return { state, model: this.model, usage: this.reply, malformed: this.malformed };
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
    if (data === "" || data === "[DONE]") return;
    let parsed: { type?: unknown; response?: unknown };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      this.malformed = true;
      return;
    }
    const type = parsed.type;
    if (type === "response.created" || type === "response.in_progress") {
      const model = (parsed.response as { model?: unknown } | undefined)?.model;
      if (typeof model === "string") this.model = model;
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const read = readReply(parsed.response);
      if (read.model !== null) this.model = read.model;
      if (read.reply !== null) this.reply = read.reply;
      if (read.malformed) this.malformed = true;
      if (type === "response.failed") this.errored = true;
      else this.done = true;
    } else if (type === "error") {
      this.errored = true;
    }
  }
}

/** The usage of a successful, non-streamed Responses API reply, from its whole body. */
export function readOpenAiJsonResponse(body: string): ResponseRead<OpenAiReply> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { state: "complete", model: null, usage: null, malformed: true };
  }
  const read = readReply(parsed);
  return { state: "complete", model: read.model, usage: read.reply, malformed: read.malformed || read.model === null || read.reply === null };
}
