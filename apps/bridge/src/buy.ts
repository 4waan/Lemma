import { randomBytes } from "node:crypto";

import {
  type Address,
  CapabilityId,
  type Hex32,
  type Preview,
  type PurchaseRefusal,
  ResolutionDelivery,
  type SpendingPolicy,
  canonicalize,
  checkPurchase,
  derivePaymentNonce,
  deriveResolutionId,
  formatUsdc,
  paymentRequirementsFor,
  toolResourceUrl,
  warrantyClaimHash,
} from "@lemma/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Hex, getAddress } from "viem";
import { z } from "zod";

import { PackagePath, type PaidToolContext } from "./bridge.js";
import { packageRef, samePackage } from "./inbox.js";
import type { SpendLedger } from "./ledger.js";
import type { BuyAnswer } from "./remote.js";
import { packageDirAt } from "./scan/files.js";
import { type Signer, SignerRefusal } from "./signer/signer.js";
import { MAX_TOOL_TEXT } from "./text.js";

export interface BuyDeps {
  readonly signer: Signer;
  /** The bridge's copy of the spending policy; the signer enforces its own as well. */
  readonly policy: SpendingPolicy;
  readonly ledger: SpendLedger;
  /** The workspace root, for the `package` argument. */
  readonly root: string;
  readonly clock: () => Date;
  /** 32 random bytes for a warranty claim secret (default: the platform's secure random source). */
  readonly randomSecret?: () => Hex32;
  /**
   * Where warranty credits are paid (LEMMA_REFUND_TO); default: the buyer's
   * own address. Withdrawing a credit shows this address next to the public
   * resolution id on chain, so another address the user controls keeps the
   * buyer's wallet out of that record.
   */
  readonly refundTo?: Address | undefined;
  /** Overrides the paid call's timeout (tests). */
  readonly paidCallTimeoutMs?: number;
}

/**
 * How much shorter than the quoted window the bridge signs its authorization.
 * The server refuses a `validBefore` past its own clock plus the quoted window
 * plus a minute, so signing the whole window left a buyer clock running fast
 * only a minute of room, after which every purchase was refused. A minute
 * less doubles that room, and a clock running slow keeps most of the window.
 */
export const CLOCK_SKEW_MARGIN_SECONDS = 60;

/** The authorization lifetime signed for a quoted window: a minute less, never under half of it. */
export function signedWindowSeconds(maxTimeoutSeconds: number): number {
  return Math.max(maxTimeoutSeconds - CLOCK_SKEW_MARGIN_SECONDS, Math.ceil(maxTimeoutSeconds / 2));
}

export const BUY_DESCRIPTION = "Buy the resolution the last lemma_preview offered, within this machine's spending limits. Pays USDC through the local signer and never pays twice.";

/**
 * `lemma_buy_resolution({ capability, package? })`, registered only when a
 * signer is configured (main.ts). One purchase is one MCP call:
 *
 * 1. `latestOffer`: the open offer from the last preview (no drift, not
 *    expired, not already bought or pending);
 * 2. core `checkPurchase` against the local spend ledger, and a reservation
 *    in it, under the ledger's lock;
 * 3. `inbox.markPending`, so a lost answer is recovered and never paid again;
 * 4. the payment nonce and requirements from the preview's own terms (core
 *    `derivePaymentNonce`, `paymentRequirementsFor`): no challenge round trip;
 * 5. a warranty claim (a random secret, and a refund address: the buyer's
 *    unless LEMMA_REFUND_TO names another) kept in the inbox; only its hash
 *    is sent;
 * 6. the signer signs `TransferWithAuthorization` (and enforces its own policy);
 * 7. the paid call; a delivery must match the offer before it is stored.
 *
 * Nothing on this path reads the chain: settlement is the server's.
 */
export function buyTool(deps: BuyDeps): (server: McpServer, ctx: PaidToolContext) => void {
  return (server, ctx) => {
    server.registerTool(
      "lemma_buy_resolution",
      { description: BUY_DESCRIPTION, inputSchema: z.strictObject({ capability: CapabilityId, package: PackagePath.optional() }) },
      async ({ capability, package: pkg }) => {
        try {
          return answer(await buy(deps, ctx, capability, pkg));
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: `Lemma: the purchase step failed (${error instanceof Error ? error.name : "error"}). Nothing more is paid; call lemma_apply_resolution in a minute to see if it went through.` }] };
        }
      },
    );
  };
}

type Offered = Preview & { readonly decision: "reuse" | "adapt"; readonly offer: NonNullable<Extract<Preview, { decision: "reuse" }>["offer"]> };

async function buy(deps: BuyDeps, ctx: PaidToolContext, capability: CapabilityId, pkg: string | undefined): Promise<string> {
  const latest = ctx.latestOffer(capability);
  if (latest === undefined || !("offer" in latest) || latest.offer === null) return NO_OFFER_TEXT;
  const preview = latest as Offered;
  if (pkg !== undefined) {
    const dir = packageDirAt(deps.root, pkg);
    const noted = ctx.inbox.preview(preview.previewId);
    if (dir === undefined || noted === undefined || !samePackage(noted.where, packageRef(deps.root, dir))) return OTHER_PACKAGE_TEXT;
  }
  let buyer: Address;
  try {
    buyer = await deps.signer.address();
  } catch {
    return SIGNER_UNREACHABLE_TEXT;
  }
  const now = deps.clock();
  const { previewId, offer } = preview;
  const resolutionId = deriveResolutionId(previewId, buyer);
  const nonce = derivePaymentNonce(resolutionId, previewId);
  const requirements = paymentRequirementsFor(offer.terms);
  const known = deps.ledger.entries().some((e) => e.nonce === nonce && e.state !== "released");
  const decision = deps.ledger.reserve({ nonce, amount: BigInt(offer.terms.amount), payTo: offer.terms.payTo }, now, (committed) => checkPurchase(deps.policy, committed, preview, requirements, now));
  if (!decision.ok) return policyText(decision.reason);
  ctx.inbox.markPending(previewId, buyer, now, preview.release.releaseDigest);
  const refundTo = deps.refundTo ?? buyer;
  const claim = ctx.inbox.claimFor(resolutionId, () => {
    const claimSecret = deps.randomSecret?.() ?? (`0x${randomBytes(32).toString("hex")}` as Hex32);
    return { schemaVersion: "1" as const, resolutionId, claimSecret, refundTo, claimHash: warrantyClaimHash(resolutionId, claimSecret, refundTo) };
  });
  const validBefore = (Math.floor(now.getTime() / 1000) + signedWindowSeconds(offer.terms.maxTimeoutSeconds)).toString();
  let signature: Hex;
  try {
    signature = await deps.signer.signTransferAuthorization({ to: offer.terms.payTo, value: offer.terms.amount, validAfter: "0", validBefore, nonce });
  } catch (error) {
    // Nothing was signed (or it never left the signer): undo the reservation, unless an earlier signature holds it, and the mark.
    if (!known) deps.ledger.release(nonce, now);
    ctx.inbox.clearPending(previewId);
    return error instanceof SignerRefusal ? cap(`Lemma: the signer refused to sign (${error.code}), so nothing was paid.`) : SIGNER_UNREACHABLE_TEXT;
  }
  const payment = {
    x402Version: 2,
    resource: { url: toolResourceUrl("lemma_buy_resolution"), description: "Lemma Compatibility Resolution", mimeType: "application/json" },
    accepted: { ...requirements, extra: { ...requirements.extra } },
    payload: { authorization: { from: getAddress(buyer), to: requirements.payTo, value: requirements.amount, validAfter: "0", validBefore, nonce }, signature },
  };
  let reply: BuyAnswer;
  try {
    reply = await ctx.remote.buy({ previewId, claimHash: claim.claimHash }, payment, deps.paidCallTimeoutMs);
  } catch {
    // Lost or timed out: the payment may have settled. Recover it for free; never pay again.
    return recovered(deps, ctx, resolutionId, nonce, offer.terms.amount);
  }
  return settle(deps, ctx, preview, buyer, nonce, reply);
}

async function settle(deps: BuyDeps, ctx: PaidToolContext, preview: Offered, buyer: Address, nonce: Hex32, reply: BuyAnswer): Promise<string> {
  const resolutionId = deriveResolutionId(preview.previewId, buyer);
  const amount = preview.offer.terms.amount;
  if (reply.kind === "delivery") {
    const delivery = matching(reply.delivery, preview, buyer);
    // Kept pending: recovery fetches it again later, and the reservation stays counted.
    if (delivery === undefined) return MISMATCH_TEXT;
    ctx.inbox.put(delivery);
    deps.ledger.settle(nonce, deps.clock());
    return boughtText(amount);
  }
  if (reply.kind === "refused") {
    if (reply.code === "IN_FLIGHT" || reply.code === "ALREADY_SETTLED") return recovered(deps, ctx, resolutionId, nonce, amount);
    // The server refused before settling (x402 cancels on a refusal), so there is nothing to recover.
    ctx.inbox.clearPending(preview.previewId);
    // The one refusal a correct bridge meets: an authorization window past the server's clock, from a clock running fast.
    const clock = reply.code === "UNSUPPORTED_PAYMENT" ? " Check that this computer's clock is right." : "";
    return cap(`Lemma: the server refused the purchase (${reply.code}); nothing was charged.${clock} Call lemma_preview again, or build it yourself.`);
  }
  // A challenge: the payment was not taken. Never answered with a new payment.
  const now = deps.clock();
  const [asked] = reply.required.accepts;
  const terms = asked === undefined ? ({ ok: false, reason: "TERMS_MISMATCH" } as const) : checkPurchase(deps.policy, deps.ledger.committed(now, nonce), preview, asked, now);
  const reason = reasonCode(reply.required.error);
  if (reason === "settlement_failed") return recovered(deps, ctx, resolutionId, nonce, amount);
  ctx.inbox.clearPending(preview.previewId);
  if (!terms.ok) return cap(`Lemma: the server asked for other payment terms (${terms.reason}), so nothing more was paid. Call lemma_preview again.`);
  return cap(`Lemma: the payment was not accepted (${reason}); nothing was charged. Check the buyer's USDC balance on Arbitrum Sepolia, then call lemma_preview again.`);
}

/** After a lost or unclear answer: recover pending purchases for free, then answer from the inbox. */
async function recovered(deps: BuyDeps, ctx: PaidToolContext, resolutionId: Hex32, nonce: Hex32, amount: string): Promise<string> {
  await ctx.recover().catch(() => undefined);
  if (ctx.inbox.get(resolutionId) === undefined) return SETTLING_TEXT;
  deps.ledger.settle(nonce, deps.clock());
  return boughtText(amount);
}

/** The delivery, only if it is the resolution this offer sells to this buyer: preview, release, profile, buyer and terms. */
function matching(value: unknown, preview: Offered, buyer: Address): ResolutionDelivery | undefined {
  const parsed = ResolutionDelivery.safeParse(value);
  if (!parsed.success) return undefined;
  const r = parsed.data.resolution;
  const same =
    r.resolutionId === deriveResolutionId(preview.previewId, buyer) &&
    r.previewId === preview.previewId &&
    r.buyer === buyer &&
    r.profileDigest === preview.profileDigest &&
    canonicalize(r.release) === canonicalize(preview.release) &&
    canonicalize(r.terms) === canonicalize(preview.offer.terms);
  return same ? parsed.data : undefined;
}

/** x402's reason for a challenge as a short code; anything else becomes a generic one. */
function reasonCode(error: string | undefined): string {
  if (error === undefined) return "payment_not_accepted";
  if (/^Payment settlement failed/i.test(error)) return "settlement_failed";
  return /^[a-z0-9_]{1,64}$/.test(error) ? error : "payment_not_accepted";
}

const cap = (text: string) => (text.length <= MAX_TOOL_TEXT ? text : `${text.slice(0, MAX_TOOL_TEXT - 1)}…`);

function answer(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function boughtText(amount: string): string {
  return `Lemma: bought for ${formatUsdc(BigInt(amount))} USDC (Arbitrum Sepolia testnet). Next, call lemma_apply_resolution, then lemma_verify_adoption.`;
}

function policyText(reason: PurchaseRefusal): string {
  if (reason === "NO_OFFER" || reason === "QUOTE_EXPIRED") return cap(`Lemma: the offer is no longer open (${reason}); nothing was paid. Call lemma_preview again.`);
  return cap(`Lemma: this machine's spending policy refused the purchase (${reason}); nothing was paid. Build it yourself, or ask the user to change the limits.`);
}

export const NO_OFFER_TEXT = "Lemma: no open offer for this capability here, so nothing was paid. Call lemma_preview first; if it offers nothing, build it yourself.";
export const OTHER_PACKAGE_TEXT = "Lemma: the open offer is for another package, so nothing was paid. Call lemma_preview for this package first.";
export const SIGNER_UNREACHABLE_TEXT = "Lemma: the local signer could not be reached, so nothing was paid. Ask the user to start lemma-signer, then try again.";
export const SETTLING_TEXT = "Lemma: the purchase answer was lost; the payment is recovered automatically and never made twice. Call lemma_apply_resolution in a minute.";
export const MISMATCH_TEXT = "Lemma: the server answered with a resolution that does not match the offer, so it was not stored. It is recovered automatically; nothing is paid again.";
