import { z } from "zod";

import { UsdcAtomic } from "./amounts.js";
import { MAX_AUTHORIZATION_SECONDS } from "./payment.js";
import type { Preview } from "./preview.js";
import { Address, Caip2, SchemaVersion, isSortedUnique } from "./primitives.js";

/** The buyer's local spending limits. The bridge enforces them in code before any payment is signed. */
export const SpendingPolicy = z.strictObject({
  schemaVersion: SchemaVersion,
  network: Caip2,
  asset: Address,
  /** Recipients the buyer is willing to pay (provider x402 addresses). */
  allowedPayTo: z.array(Address).min(1).max(16).refine(isSortedUnique, "must be sorted and unique"),
  maxPerResolutionUsdc: UsdcAtomic,
  dailyCapUsdc: UsdcAtomic,
  /** Longest payment authorization the buyer will sign. */
  maxAuthorizationSeconds: z.int().min(1).max(MAX_AUTHORIZATION_SECONDS),
});

export type SpendingPolicy = z.infer<typeof SpendingPolicy>;

/**
 * A payment about to be signed. The fields are the x402 v2
 * `PaymentRequirements` fields, so an `accepts[i]` entry can be passed as is.
 * They are plain strings because they come from a remote challenge, which is
 * untrusted input.
 */
export interface SpendRequest {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
}

export type SpendRefusal =
  | "INVALID_AMOUNT"
  | "ZERO_AMOUNT"
  | "WRONG_SCHEME"
  | "WRONG_NETWORK"
  | "WRONG_ASSET"
  | "WRONG_RECIPIENT"
  | "AUTHORIZATION_TOO_LONG"
  | "EXCEEDS_PER_RESOLUTION"
  | "EXCEEDS_DAILY_CAP";

export type SpendDecision =
  | { readonly ok: true; readonly amount: bigint; readonly remainingTodayUsdc: bigint }
  | { readonly ok: false; readonly reason: SpendRefusal };

const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");

/**
 * Decides whether one payment fits the policy. Pure: the caller owns the ledger.
 *
 * `committedTodayUsdc` must be everything already committed in the current cap
 * window: settled spend plus every authorization signed but not yet proven
 * unspent (proof means the USDC `authorizationState` is still unused after
 * `validBefore`, or a definitive facilitator failure). Callers reserve the amount
 * before signing, under the same lock as this check, and treat timeouts and
 * indeterminate settlements as committed until reconciled. Counting only
 * settled spend would let concurrent, retried or lost payments exceed the cap.
 */
export function checkSpend(policy: SpendingPolicy, committedTodayUsdc: bigint, request: SpendRequest): SpendDecision {
  const p = SpendingPolicy.parse(policy);
  const parsed = UsdcAtomic.safeParse(request.amount);
  if (!parsed.success) return { ok: false, reason: "INVALID_AMOUNT" };
  const amount = BigInt(parsed.data);
  if (amount === 0n) return { ok: false, reason: "ZERO_AMOUNT" };
  if (request.scheme !== "exact") return { ok: false, reason: "WRONG_SCHEME" };
  if (request.network !== p.network) return { ok: false, reason: "WRONG_NETWORK" };
  if (lower(request.asset) !== p.asset) return { ok: false, reason: "WRONG_ASSET" };
  if (!p.allowedPayTo.includes(lower(request.payTo))) return { ok: false, reason: "WRONG_RECIPIENT" };
  if (!Number.isInteger(request.maxTimeoutSeconds) || request.maxTimeoutSeconds < 1 || request.maxTimeoutSeconds > p.maxAuthorizationSeconds) {
    return { ok: false, reason: "AUTHORIZATION_TOO_LONG" };
  }
  if (amount > BigInt(p.maxPerResolutionUsdc)) return { ok: false, reason: "EXCEEDS_PER_RESOLUTION" };
  const cap = BigInt(p.dailyCapUsdc);
  if (committedTodayUsdc < 0n || committedTodayUsdc + amount > cap) return { ok: false, reason: "EXCEEDS_DAILY_CAP" };
  return { ok: true, amount, remainingTodayUsdc: cap - committedTodayUsdc - amount };
}

export type PurchaseRefusal = SpendRefusal | "NO_OFFER" | "QUOTE_EXPIRED" | "TERMS_MISMATCH";

export type PurchaseDecision =
  | { readonly ok: true; readonly amount: bigint; readonly remainingTodayUsdc: bigint }
  | { readonly ok: false; readonly reason: PurchaseRefusal };

/**
 * The bridge's check before signing a payment for a quoted preview: the
 * challenge must ask for exactly the quoted terms, the quote must still be open,
 * and the payment must fit the spending policy. A server that raises the price,
 * changes the recipient, or charges for a no-match is refused.
 */
export function checkPurchase(policy: SpendingPolicy, committedTodayUsdc: bigint, preview: Preview, request: SpendRequest, now: Date): PurchaseDecision {
  if ((preview.decision !== "reuse" && preview.decision !== "adapt") || preview.offer === null) return { ok: false, reason: "NO_OFFER" };
  const { terms, validUntil } = preview.offer;
  if (now.getTime() >= Date.parse(validUntil)) return { ok: false, reason: "QUOTE_EXPIRED" };
  const same =
    request.scheme === terms.scheme &&
    request.network === terms.network &&
    lower(request.asset) === terms.asset &&
    request.amount === terms.amount &&
    lower(request.payTo) === terms.payTo &&
    request.maxTimeoutSeconds === terms.maxTimeoutSeconds;
  if (!same) return { ok: false, reason: "TERMS_MISMATCH" };
  return checkSpend(policy, committedTodayUsdc, request);
}
