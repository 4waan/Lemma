import { type Hex, getAddress } from "viem";
import { z } from "zod";

import { UsdcAtomic } from "./amounts.js";
import { Address, Hex32, SchemaVersion } from "./primitives.js";

/**
 * The resolution warranty registry's EIP-712 layouts, and the strict,
 * versioned objects the server's outcome pipeline signs with them and keeps
 * in its outbox: the provider's Voucher, which activates a paid resolution's
 * warranty, and the evaluator's Outcome, which finalizes it. Typed data only:
 * core holds no keys and signs nothing.
 *
 * The layouts belong to the protocol owner and are copied exactly from
 * `contracts/src/ResolutionWarrantyRegistry.sol`: the same type names, field
 * names, field order and Solidity types, under the domain
 * `EIP712("Lemma Warranty Registry", "1")` with the chain id and the
 * registry's address as `verifyingContract`. A test reproduces the registry's
 * own vectors (`contracts/test/Vectors.t.sol`), so a change on either side
 * fails a test.
 */
export const WARRANTY_DOMAIN_NAME = "Lemma Warranty Registry";
export const WARRANTY_DOMAIN_VERSION = "1";

/** `Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)`. */
export const WARRANTY_VOUCHER_TYPES = {
  Voucher: [
    { name: "resolutionId", type: "bytes32" },
    { name: "releaseDigest", type: "bytes32" },
    { name: "profileIndex", type: "uint8" },
    { name: "amount", type: "uint256" },
    { name: "paymentRef", type: "bytes32" },
    { name: "claimHash", type: "bytes32" },
    { name: "activateBy", type: "uint64" },
  ],
} as const;

/** `Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)`. */
export const WARRANTY_OUTCOME_TYPES = {
  Outcome: [
    { name: "resolutionId", type: "bytes32" },
    { name: "verdict", type: "uint8" },
    { name: "weightBps", type: "uint16" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

/** The acceptance recipe passed: the reserved bond returns to the provider's release. */
export const VERDICT_PASSED = 1;
/** An eligible failure: the reserved amount becomes the resolution's withdrawal credit. */
export const VERDICT_FAILED = 2;
/** Ineligible or abandoned: the bond is released and nothing is recorded. */
export const VERDICT_VOID = 3;

/** An evaluator's verdict, as the outcome carries it; `verdictCode` gives the registry's number. */
export const WarrantyVerdict = z.enum(["passed", "failed", "void"]);

export type WarrantyVerdict = z.infer<typeof WarrantyVerdict>;

const VERDICT_CODES = { passed: VERDICT_PASSED, failed: VERDICT_FAILED, void: VERDICT_VOID } as const satisfies Record<WarrantyVerdict, number>;

/** The registry's verdict number for a verdict: 1 passed, 2 failed, 3 void. */
export function verdictCode(verdict: WarrantyVerdict): 1 | 2 | 3 {
  return VERDICT_CODES[WarrantyVerdict.parse(verdict)];
}

/** The verdict a registry verdict number stands for, or undefined for any other number. */
export function verdictOf(code: number): WarrantyVerdict | undefined {
  return code === VERDICT_PASSED ? "passed" : code === VERDICT_FAILED ? "failed" : code === VERDICT_VOID ? "void" : undefined;
}

/** The largest outcome weight (100%), in basis points. */
export const MAX_OUTCOME_WEIGHT_BPS = 10_000;

const ZERO_WORD = `0x${"00".repeat(32)}`;

/**
 * A Unix time in whole seconds, as the registry's `uint64` deadlines take it,
 * held as a JSON number: every realistic deadline is far below 2^53.
 */
const UnixSeconds = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * A provider's promise to back one paid resolution: signed by the release's
 * provider (EIP-712 `Voucher`) and submitted to `activateResolution`, which
 * reserves `amount` from the release's bond and opens the claim window.
 *
 * - `amount` is the warranty in atomic USDC, above zero (the registry refuses
 *   zero); the server sets it to the resolution's price (docs/economics.md).
 * - `paymentRef` is an opaque, random 32-byte reference the server makes once
 *   per resolution. It is never derived from the payer, the payment nonce or
 *   the settlement, so the voucher on chain cannot be joined to a payment.
 * - `claimHash` is the buyer's `warrantyClaimHash`, stored with the resolution.
 * - `activateBy` is the last Unix second at which the voucher may be submitted.
 *
 * The server's outbox persists it, so it is strict and versioned; the
 * signed message is the same fields without `schemaVersion`.
 */
export const WarrantyVoucher = z
  .strictObject({
    schemaVersion: SchemaVersion,
    resolutionId: Hex32,
    releaseDigest: Hex32,
    profileIndex: z.int().min(0).max(255),
    amount: UsdcAtomic.refine((v) => v !== "0", "the warranty amount must be above zero"),
    paymentRef: Hex32,
    claimHash: Hex32,
    activateBy: UnixSeconds,
  })
  .refine((v) => v.resolutionId !== ZERO_WORD && v.paymentRef !== ZERO_WORD && v.claimHash !== ZERO_WORD, {
    message: "the registry refuses a zero resolution id, payment reference or claim hash",
  });

export type WarrantyVoucher = z.infer<typeof WarrantyVoucher>;

/**
 * An evaluator's verdict on one active warranty: signed by the release's
 * evaluator (EIP-712 `Outcome`) and submitted to `finalizeOutcome`.
 *
 * - `weightBps` is the outcome's weight for the compatibility engine, 0 to
 *   10000. The registry records only PASSED and FAILED outcomes with a weight
 *   above zero, so a VOID outcome's weight does not matter (the server sends 0).
 * - `evidenceHash` is core `adoptionReceiptDigest` of the buyer's receipt.
 * - `validUntil` is the last Unix second at which it may be submitted.
 *
 * Persisted in the server's outbox, so strict and versioned; the signed
 * message is the same fields without `schemaVersion`, with the verdict as its
 * registry number (`verdictCode`).
 */
export const WarrantyOutcome = z.strictObject({
  schemaVersion: SchemaVersion,
  resolutionId: Hex32,
  verdict: WarrantyVerdict,
  weightBps: z.int().min(0).max(MAX_OUTCOME_WEIGHT_BPS),
  evidenceHash: Hex32,
  validUntil: UnixSeconds,
});

export type WarrantyOutcome = z.infer<typeof WarrantyOutcome>;

/** Where a registry lives: the chain id and the registry's address (the EIP-712 `verifyingContract`). */
export interface WarrantyRegistryRef {
  readonly chainId: number;
  readonly registry: Address;
}

/** The registry's EIP-712 domain: `{ name: "Lemma Warranty Registry", version: "1", chainId, verifyingContract }`. */
export function warrantyDomain(ref: WarrantyRegistryRef) {
  if (!Number.isSafeInteger(ref.chainId) || ref.chainId < 1) throw new RangeError(`invalid chain id: ${String(ref.chainId)}`);
  return { name: WARRANTY_DOMAIN_NAME, version: WARRANTY_DOMAIN_VERSION, chainId: ref.chainId, verifyingContract: getAddress(Address.parse(ref.registry)) };
}

/** viem-ready typed data for a voucher: what the provider signs and the registry's `hashVoucher` hashes. */
export function warrantyVoucherTypedData(voucher: WarrantyVoucher, ref: WarrantyRegistryRef) {
  const v = WarrantyVoucher.parse(voucher);
  return {
    domain: warrantyDomain(ref),
    types: WARRANTY_VOUCHER_TYPES,
    primaryType: "Voucher" as const,
    message: {
      resolutionId: v.resolutionId as Hex,
      releaseDigest: v.releaseDigest as Hex,
      profileIndex: v.profileIndex,
      amount: BigInt(v.amount),
      paymentRef: v.paymentRef as Hex,
      claimHash: v.claimHash as Hex,
      activateBy: BigInt(v.activateBy),
    },
  };
}

export type WarrantyVoucherTypedData = ReturnType<typeof warrantyVoucherTypedData>;

/** viem-ready typed data for an outcome: what the evaluator signs and the registry's `hashOutcome` hashes. */
export function warrantyOutcomeTypedData(outcome: WarrantyOutcome, ref: WarrantyRegistryRef) {
  const o = WarrantyOutcome.parse(outcome);
  return {
    domain: warrantyDomain(ref),
    types: WARRANTY_OUTCOME_TYPES,
    primaryType: "Outcome" as const,
    message: {
      resolutionId: o.resolutionId as Hex,
      verdict: verdictCode(o.verdict),
      weightBps: o.weightBps,
      evidenceHash: o.evidenceHash as Hex,
      validUntil: BigInt(o.validUntil),
    },
  };
}

export type WarrantyOutcomeTypedData = ReturnType<typeof warrantyOutcomeTypedData>;

/**
 * What the server's warranty outbox does for a resolution: activate its
 * warranty (provider), finalize its outcome (evaluator), expire it after its
 * claim window (provider), or relay the buyer's credit withdrawal (evaluator).
 */
export const WarrantyActionKind = z.enum(["activate", "finalize", "expire", "withdraw"]);

export type WarrantyActionKind = z.infer<typeof WarrantyActionKind>;

/**
 * Where an outbox action stands: `review` (a failed outcome waiting for an
 * operator's decision), `queued` (to send when due), `sent` (an attempt was
 * begun, so a transaction may be out), and the final `done`, `skipped` (not
 * applicable, nothing sent) and `abandoned` (given up).
 */
export const WarrantyActionState = z.enum(["review", "queued", "sent", "done", "skipped", "abandoned"]);

export type WarrantyActionState = z.infer<typeof WarrantyActionState>;

/** A state after which an action never changes again. */
export function isFinalActionState(state: WarrantyActionState): boolean {
  return state === "done" || state === "skipped" || state === "abandoned";
}

/**
 * An outbox payload that names only its resolution: an expiry needs nothing
 * else, and a withdrawal keeps only this once it is over, so the claim secret
 * and the refund address are not kept longer than the relay needs them.
 */
export const WarrantyActionRef = z.strictObject({ schemaVersion: SchemaVersion, resolutionId: Hex32 });

export type WarrantyActionRef = z.infer<typeof WarrantyActionRef>;

/**
 * A buyer's credit withdrawal the server relays (`withdrawCredit`), as its
 * outbox keeps it until the relay is over. The claim secret only lets anyone
 * pay the refund address it was committed with (`warrantyClaimHash`), so
 * relaying it is safe; it is still never logged.
 */
export const WarrantyWithdrawal = z.strictObject({ schemaVersion: SchemaVersion, resolutionId: Hex32, claimSecret: Hex32, to: Address });

export type WarrantyWithdrawal = z.infer<typeof WarrantyWithdrawal>;

/**
 * The body of `POST /api/v1/warranty/withdrawals`: the buyer's claim for one
 * resolution (the bridge's `WarrantyClaim` secret and refund address, as `to`).
 */
export const WarrantyWithdrawalRequest = z.strictObject({ resolutionId: Hex32, claimSecret: Hex32, to: Address });

export type WarrantyWithdrawalRequest = z.infer<typeof WarrantyWithdrawalRequest>;

/**
 * The route's 202 answer: the relay's action state for the resolution. The
 * same request answers the same state until the relay moves on: `queued`
 * (waiting to be sent), `sent` (a transaction may be out), `done` (the credit
 * reached the refund address) or `abandoned` (the registry holds no credit to
 * pay: it was withdrawn otherwise, or never became one).
 */
export const WarrantyWithdrawalAnswer = z.strictObject({
  resolutionId: Hex32,
  state: z.enum(["queued", "sent", "done", "abandoned"]),
});

export type WarrantyWithdrawalAnswer = z.infer<typeof WarrantyWithdrawalAnswer>;

/**
 * Why the route queued nothing, as `{ error: <code> }` with a 4xx status:
 * `BAD_REQUEST` (400: not a strict `WarrantyWithdrawalRequest`),
 * `BROWSER_REQUEST` (403: the request carried an Origin header),
 * `CLAIM_MISMATCH` (403: the secret and address do not make the resolution's
 * claim hash), `UNKNOWN_RESOLUTION` (404: no such resolution, or one bought
 * without a claim), `WARRANTY_OFF` (404: the server runs no warranty
 * pipeline), `NO_CREDIT` (409: the indexed registry shows no outstanding
 * credit for it). A rate-limited request answers 429 like every other route.
 */
export const WARRANTY_WITHDRAWAL_REFUSALS = ["BAD_REQUEST", "BROWSER_REQUEST", "CLAIM_MISMATCH", "UNKNOWN_RESOLUTION", "WARRANTY_OFF", "NO_CREDIT"] as const;

export const WarrantyWithdrawalRefusal = z.strictObject({ error: z.enum(WARRANTY_WITHDRAWAL_REFUSALS) });

export type WarrantyWithdrawalRefusal = z.infer<typeof WarrantyWithdrawalRefusal>;
