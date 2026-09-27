import {
  AdoptionReceipt,
  type Address,
  AgentId,
  type BuyerPass,
  BuyInput,
  CapabilityRelease,
  ClaimBuyerPassResult,
  Hex32,
  LEMMA_TOOLS,
  PatchPath,
  type Preview,
  type PreviewInput,
  PreviewResult,
  REPUTATION_META_KEY,
  ReleaseReputation,
  ResolutionDelivery,
  type SpendRequest,
  UsdcAtomic,
  type WarrantyClaim,
  WarrantyState,
  WarrantyWithdrawalAnswer,
  WarrantyWithdrawalRefusal,
  WarrantyWithdrawalRequest,
  releaseDigest,
} from "@lemma/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { z } from "zod";

const Hex = z.string().regex(/^0x[0-9a-f]{64}$/);

/** A capability the server does not list (an older server) has an empty interest set; it does not fail every preview. */
export const InterestResponse = z.object({
  catalogDigest: Hex,
  capabilities: z.record(z.string().max(100), z.array(z.string().max(214)).max(500)),
});

export type InterestResponse = z.infer<typeof InterestResponse>;

export const BaseProbeResponse = z.object({
  releaseDigest: Hex,
  // The drift check reads these paths under the package: the same safe relative paths a patch may use.
  files: z.array(z.object({ path: PatchPath, baseDigest: Hex.nullable() })).max(200),
});

export type BaseProbeEntry = z.infer<typeof BaseProbeResponse>["files"][number];

/** The server's answers to a posted receipt (ResolutionService.acceptReceipt). */
export const ReceiptAnswer = z.enum(["ACCEPTED", "DUPLICATE", "NOT_SETTLED", "TOO_EARLY", "UNKNOWN_RESOLUTION", "MISMATCH"]);

/** Answers after which a receipt is never sent again: recorded, or refused for good. NOT_SETTLED and TOO_EARLY are retried. */
export const FINAL_RECEIPT_ANSWERS: ReadonlySet<ReceiptAnswer> = new Set(["ACCEPTED", "DUPLICATE", "UNKNOWN_RESOLUTION", "MISMATCH"]);

export type ReceiptAnswer = z.infer<typeof ReceiptAnswer>;

/** The x402 meta key a payment payload travels under (`MCP_PAYMENT_META_KEY` in @x402/mcp). */
export const PAYMENT_META_KEY = "x402/payment";

/** How long the paid call may take: verification, the handler and settlement on chain. */
export const PAID_CALL_TIMEOUT_MS = 30_000;

/** The server's credit relay route (server `WITHDRAWALS_PATH`): the only place a claim secret is ever sent. */
export const WITHDRAWALS_PATH = "/api/v1/warranty/withdrawals";

/**
 * The part of a resolution's public view (`GET /api/v1/resolutions/:id`,
 * core `ResolutionView`) the refund tool reads: its warranty's state and
 * amount. Other fields, and any a later server adds, are ignored; a server
 * that runs no warranty pipeline (null) or predates it (absent) shows none.
 */
export const ResolutionWarranty = z.object({
  resolutionId: Hex32,
  warranty: z.object({ state: WarrantyState, amount: UsdcAtomic.nullable() }).nullable().optional(),
});

export type ResolutionWarranty = z.infer<typeof ResolutionWarranty>;

/** What the credit relay route answered: the relay's state for the resolution (core `WarrantyWithdrawalAnswer`), or its refusal code (core `WarrantyWithdrawalRefusal`). */
export type WithdrawalReply =
  | { readonly kind: "accepted"; readonly state: WarrantyWithdrawalAnswer["state"] }
  | { readonly kind: "refused"; readonly code: WarrantyWithdrawalRefusal["error"] };

/**
 * What the paid call answered. A challenge is an x402 v2 `PaymentRequired`,
 * kept to its reason and the requirement fields core `checkPurchase` reads.
 */
export type BuyAnswer =
  | { readonly kind: "delivery"; readonly delivery: unknown }
  | { readonly kind: "challenge"; readonly required: { readonly error: string | undefined; readonly accepts: readonly SpendRequest[] } }
  | { readonly kind: "refused"; readonly code: string };

export class RemoteError extends Error {
  override name = "RemoteError";

  /**
   * `missing`: the server answered, and has no such object (or a different
   * one); retrying will not help. `status`: the HTTP status it answered with,
   * when there was one (429 is its rate limit).
   */
  constructor(
    message: string,
    readonly missing = false,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RemoteOptions {
  /**
   * This buyer agent's own ERC-8004 agent id (LEMMA_AGENT_ID), sent with every
   * receipt so the attester can give the agent feedback on its adoptions. Opt-in:
   * without it, no receipt names an agent. The server posts to the agent only if
   * the address that paid owns it or is its agent wallet.
   */
  readonly agentId?: AgentId | undefined;
}

/** A preview with the matched release's public adoption record, when the server knows one. */
export interface RemotePreview {
  readonly preview: Preview;
  readonly reputation: ReleaseReputation | null;
}

/**
 * The bridge's view of the Lemma server. Every response is validated with a
 * schema before use, and the cheap parts are cached so a preview costs one
 * request in steady state:
 *
 * - the interest set, revalidated with its ETag (the catalog digest)
 * - base probes per release digest, which never change
 * - one MCP connection (initialize once; the server is stateless)
 *
 * Every request gives up after `timeoutMs`, so a stalled server ends in the
 * preview's "build it yourself" answer rather than the agent's own timeout.
 */
export class LemmaRemote {
  /** HTTP requests made, for the round-trip budget. */
  requests = 0;
  private client: Client | undefined;
  private interestCache: InterestResponse | undefined;
  private readonly probes = new Map<Hex32, BaseProbeEntry[]>();
  private readonly fetchImpl: FetchLike;

  private readonly agentId: AgentId | undefined;

  constructor(
    private readonly baseUrl: URL,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 10_000,
    options: RemoteOptions = {},
  ) {
    this.fetchImpl = (input, init) => {
      this.requests++;
      return fetchImpl(input, init);
    };
    this.agentId = options.agentId === undefined ? undefined : AgentId.parse(options.agentId);
  }

  /** The interest set, fetched once and revalidated only when asked (after a catalog change). */
  async interest(revalidate = false): Promise<InterestResponse> {
    if (this.interestCache !== undefined && !revalidate) return this.interestCache;
    const headers: Record<string, string> = {};
    if (this.interestCache !== undefined) headers["if-none-match"] = `"${this.interestCache.catalogDigest}"`;
    const res = await this.fetchImpl(new URL("/api/v1/interest", this.baseUrl), { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 304 && this.interestCache !== undefined) return this.interestCache;
    if (!res.ok) throw new RemoteError(`interest request failed with ${res.status}`);
    this.interestCache = InterestResponse.parse(await res.json());
    return this.interestCache;
  }

  async preview(input: PreviewInput): Promise<Preview> {
    return (await this.previewWithRecord(input)).preview;
  }

  /**
   * A preview, and the matched release's adoption record from the result's
   * `_meta["lemma/reputation"]`. The record is optional: a missing or malformed
   * one reads as null and never fails the preview.
   */
  async previewWithRecord(input: PreviewInput): Promise<RemotePreview> {
    const result = await (await this.mcp()).callTool({ name: LEMMA_TOOLS.preview, arguments: input }, undefined, { timeout: this.timeoutMs });
    if (result.isError === true) throw new RemoteError(textOf(result.content) || "the preview failed");
    const preview = PreviewResult.parse(result.structuredContent).preview;
    const record = ReleaseReputation.safeParse(result._meta?.[REPUTATION_META_KEY]);
    return { preview, reputation: record.success && "release" in preview ? record.data : null };
  }

  async baseProbe(releaseDigest: Hex32): Promise<BaseProbeEntry[]> {
    const cached = this.probes.get(releaseDigest);
    if (cached !== undefined) return cached;
    const res = await this.fetchImpl(new URL(`/api/v1/releases/${releaseDigest}/base-probe`, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new RemoteError(`base probe request failed with ${res.status}`);
    const body = BaseProbeResponse.parse(await res.json());
    if (body.releaseDigest !== releaseDigest) throw new RemoteError("the server answered for another release");
    this.probes.set(releaseDigest, body.files);
    return body.files;
  }

  /** A release manifest by digest. The digest is checked here, so the server need not be trusted for its content. */
  async release(digest: Hex32): Promise<CapabilityRelease> {
    const res = await this.fetchImpl(new URL(`/api/v1/releases/${digest}`, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new RemoteError(`release request failed with ${res.status}`, res.status === 404);
    const body = z.object({ release: CapabilityRelease }).parse(await res.json());
    if (releaseDigest(body.release) !== digest) throw new RemoteError("the server answered with a different release", true);
    return body.release;
  }

  /**
   * Posts an adoption receipt with the preview id it was bought from, which
   * proves to the server that the buyer sends it, and this agent's ERC-8004 id
   * when it opted in; the answer says whether the server recorded it.
   */
  async postReceipt(receipt: AdoptionReceipt, previewId: Hex32): Promise<ReceiptAnswer> {
    const res = await this.fetchImpl(new URL("/api/v1/adoption-receipts", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receipt: AdoptionReceipt.parse(receipt), previewId, ...(this.agentId === undefined ? {} : { agentId: this.agentId }) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const parsed = z.object({ result: ReceiptAnswer }).safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new RemoteError(`receipt request failed with ${res.status}`);
    return parsed.data.result;
  }

  /**
   * A resolution's warranty as the server shows it (`GET
   * /api/v1/resolutions/:id`), or undefined when the server has no such
   * resolution. The request names only the resolution id. Any other answer
   * throws a `RemoteError` with its status.
   */
  async resolutionWarranty(resolutionId: Hex32): Promise<ResolutionWarranty | undefined> {
    const res = await this.fetchImpl(new URL(`/api/v1/resolutions/${Hex32.parse(resolutionId)}`, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new RemoteError(`resolution request failed with ${res.status}`, false, res.status);
    const parsed = ResolutionWarranty.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success || parsed.data.resolutionId !== resolutionId) throw new RemoteError("the server's resolution view could not be read", false, res.status);
    return parsed.data;
  }

  /**
   * Asks the server to relay a failed warranty's credit to the claim's
   * refund address (`POST /api/v1/warranty/withdrawals`, core
   * `WarrantyWithdrawalRequest`); the server's evaluator pays the gas. This
   * is the only request that carries the claim secret, and it goes only to
   * this server's withdrawal route: a redirect fails the request rather than
   * take the secret along. The answer is the relay's state (the same one for
   * the same request) or the route's refusal code; a rate limit, any other
   * answer and a transport failure throw.
   */
  async requestWithdrawal(claim: WarrantyClaim): Promise<WithdrawalReply> {
    const body = WarrantyWithdrawalRequest.parse({ resolutionId: claim.resolutionId, claimSecret: claim.claimSecret, to: claim.refundTo });
    const res = await this.fetchImpl(new URL(WITHDRAWALS_PATH, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await res.json().catch(() => undefined);
    if (res.status === 202) {
      const answer = WarrantyWithdrawalAnswer.safeParse(json);
      if (answer.success && answer.data.resolutionId === claim.resolutionId) return { kind: "accepted", state: answer.data.state };
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      const refusal = WarrantyWithdrawalRefusal.safeParse(json);
      if (refusal.success) return { kind: "refused", code: refusal.data.error };
    }
    throw new RemoteError(`withdrawal request failed with ${res.status}`, false, res.status);
  }

  /**
   * The paid call: one `tools/call` of `lemma_buy_resolution` carrying the
   * signed payment in `_meta["x402/payment"]`. It answers with the delivery
   * (unvalidated here; the buy tool checks it against the offer), an x402
   * challenge (the payment was not accepted, or the terms changed), or a
   * refusal code. A transport failure or timeout throws: the answer is lost,
   * and the caller recovers instead of paying again.
   */
  async buy(input: BuyInput, payment: unknown, timeoutMs = PAID_CALL_TIMEOUT_MS): Promise<BuyAnswer> {
    const client = await this.mcp();
    const result = await client.callTool({ name: LEMMA_TOOLS.buyResolution, arguments: BuyInput.parse(input), _meta: { [PAYMENT_META_KEY]: payment } }, undefined, { timeout: timeoutMs });
    const text = textOf(result.content);
    if (result.isError !== true) return { kind: "delivery", delivery: safeJson(text) };
    const challenge = PaymentRequiredV2Schema.safeParse(result.structuredContent ?? safeJson(text));
    if (challenge.success) {
      const accepts = challenge.data.accepts.map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds }));
      return { kind: "challenge", required: { error: challenge.data.error, accepts } };
    }
    const code = /^([A-Z][A-Z_]{1,39}): /.exec(text)?.[1];
    if (code !== undefined) return { kind: "refused", code };
    throw new RemoteError("the purchase answer carried no code");
  }

  /**
   * The buyer pass for a settled purchase (server tool `lemma_claim_buyer_pass`);
   * undefined while it is not settled, or when the server hands out none.
   */
  async claimBuyerPass(previewId: Hex32, buyer: Address): Promise<BuyerPass | undefined> {
    const result = await (await this.mcp()).callTool({ name: LEMMA_TOOLS.claimBuyerPass, arguments: { previewId, buyer } }, undefined, { timeout: this.timeoutMs });
    if (result.isError === true) return undefined;
    return ClaimBuyerPassResult.parse(result.structuredContent).buyerPass;
  }

  /** Free recovery of a settled resolution (server tool `lemma_recover_resolution`). */
  async recover(previewId: Hex32, buyer: Address): Promise<ResolutionDelivery | "IN_FLIGHT" | "NOT_FOUND"> {
    const result = await (await this.mcp()).callTool({ name: LEMMA_TOOLS.recoverResolution, arguments: { previewId, buyer } }, undefined, { timeout: this.timeoutMs });
    if (result.isError === true) {
      const text = textOf(result.content);
      if (text.startsWith("IN_FLIGHT")) return "IN_FLIGHT";
      if (text.startsWith("NOT_FOUND")) return "NOT_FOUND";
      throw new RemoteError(text || "recovery failed");
    }
    return ResolutionDelivery.parse(result.structuredContent);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private async mcp(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.baseUrl), { fetch: (input, init) => this.fetchImpl(input, init) });
    const client = new Client({ name: "lemma-bridge", version: "0.1.0" });
    // The SDK's transport class declares optional members without `| undefined`,
    // which exactOptionalPropertyTypes rejects; the runtime object is a Transport.
    await client.connect(transport as unknown as Transport, { timeout: this.timeoutMs });
    this.client = client;
    return client;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) => (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join(" ")
    .trim();
}
