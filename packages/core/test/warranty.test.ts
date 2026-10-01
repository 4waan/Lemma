import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  VERDICT_FAILED,
  VERDICT_PASSED,
  VERDICT_VOID,
  WARRANTY_DOMAIN_NAME,
  WARRANTY_DOMAIN_VERSION,
  WARRANTY_OUTCOME_TYPES,
  WARRANTY_VOUCHER_TYPES,
  WarrantyActionRef,
  WarrantyActionState,
  WarrantyOutcome,
  WarrantyVoucher,
  WarrantyWithdrawal,
  WarrantyWithdrawalAnswer,
  WarrantyWithdrawalRefusal,
  WarrantyWithdrawalRequest,
  isFinalActionState,
  verdictCode,
  verdictOf,
  warrantyClaimHash,
  warrantyDomain,
  warrantyOutcomeTypedData,
  warrantyVoucherTypedData,
} from "../src/index.js";
import { BUYER, WARRANTY_VECTOR_CLAIM_HASH, WARRANTY_VECTOR_REGISTRY as VECTOR_REGISTRY, hex32, warrantyVectorOutcome as vectorOutcome, warrantyVectorVoucher as vectorVoucher } from "./examples.js";
import { accepts, rejects, rejectsAt } from "./helpers.js";

/**
 * The registry's own cross-language vectors (contracts/test/Vectors.t.sol,
 * computed there with viem and checked against the deployed contract's
 * `hashVoucher` and `hashOutcome`, and against Foundry's own EIP-712 encoder),
 * for the inputs in examples.ts.
 */
const VOUCHER_DIGEST_VECTOR = "0x2770a4591ffeb5922cf0d77e5f159ea23e24297c9164f970a1cf74d85a1a2473";
const OUTCOME_DIGEST_VECTOR = "0xc4f2af8ca4c3b7a3a512cf4621f3ebf6de602412ed19545450663cf604c8b590";

const REGISTRY_SOURCE = readFileSync(fileURLToPath(new URL("../../../contracts/src/ResolutionWarrantyRegistry.sol", import.meta.url)), "utf8");

/** The EIP-712 `encodeType` string of a one-struct type list, as the contract writes it. */
const encodeType = (name: string, fields: ReadonlyArray<{ readonly name: string; readonly type: string }>) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;

describe("the warranty registry's EIP-712 layouts", () => {
  it("reproduce the registry's own voucher and outcome vectors", () => {
    expect(warrantyClaimHash(hex32("11"), hex32("22"), "0x3333333333333333333333333333333333333333")).toBe(WARRANTY_VECTOR_CLAIM_HASH);
    expect(hashTypedData(warrantyVoucherTypedData(vectorVoucher, VECTOR_REGISTRY))).toBe(VOUCHER_DIGEST_VECTOR);
    expect(hashTypedData(warrantyOutcomeTypedData(vectorOutcome, VECTOR_REGISTRY))).toBe(OUTCOME_DIGEST_VECTOR);
  });

  it("are the contract's type strings and domain, field for field", () => {
    const voucher = encodeType("Voucher", WARRANTY_VOUCHER_TYPES.Voucher);
    const outcome = encodeType("Outcome", WARRANTY_OUTCOME_TYPES.Outcome);
    expect(voucher).toBe("Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)");
    expect(outcome).toBe("Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)");
    // The same strings the registry hashes into VOUCHER_TYPEHASH and OUTCOME_TYPEHASH, and its EIP712 constructor.
    expect(REGISTRY_SOURCE).toContain(`"${voucher}"`);
    expect(REGISTRY_SOURCE).toContain(`"${outcome}"`);
    expect(REGISTRY_SOURCE).toContain(`EIP712("${WARRANTY_DOMAIN_NAME}", "${WARRANTY_DOMAIN_VERSION}")`);
    expect(REGISTRY_SOURCE).toContain(`uint8 public constant VERDICT_PASSED = ${VERDICT_PASSED};`);
    expect(REGISTRY_SOURCE).toContain(`uint8 public constant VERDICT_FAILED = ${VERDICT_FAILED};`);
    expect(REGISTRY_SOURCE).toContain(`uint8 public constant VERDICT_VOID = ${VERDICT_VOID};`);
    expect(warrantyDomain(VECTOR_REGISTRY)).toEqual({ name: "Lemma Warranty Registry", version: "1", chainId: 421614, verifyingContract: "0x4c454D4D41000000000000000000000000000001" });
  });

  it("change the digest with every field, the chain and the registry", () => {
    const base = hashTypedData(warrantyVoucherTypedData(vectorVoucher, VECTOR_REGISTRY));
    const variants: WarrantyVoucher[] = [
      { ...vectorVoucher, resolutionId: hex32("12") },
      { ...vectorVoucher, releaseDigest: hex32("45") },
      { ...vectorVoucher, profileIndex: 3 },
      { ...vectorVoucher, amount: "250001" },
      { ...vectorVoucher, paymentRef: hex32("56") },
      { ...vectorVoucher, claimHash: hex32("57") },
      { ...vectorVoucher, activateBy: 1_790_000_001 },
    ];
    for (const v of variants) expect(hashTypedData(warrantyVoucherTypedData(v, VECTOR_REGISTRY))).not.toBe(base);
    expect(hashTypedData(warrantyVoucherTypedData(vectorVoucher, { ...VECTOR_REGISTRY, chainId: 42161 }))).not.toBe(base);
    expect(hashTypedData(warrantyVoucherTypedData(vectorVoucher, { ...VECTOR_REGISTRY, registry: "0x4c454d4d41000000000000000000000000000002" }))).not.toBe(base);
    const outcomeBase = hashTypedData(warrantyOutcomeTypedData(vectorOutcome, VECTOR_REGISTRY));
    for (const o of [{ ...vectorOutcome, verdict: "passed" as const }, { ...vectorOutcome, weightBps: 0 }, { ...vectorOutcome, evidenceHash: hex32("67") }, { ...vectorOutcome, validUntil: 1_790_003_601 }]) {
      expect(hashTypedData(warrantyOutcomeTypedData(o, VECTOR_REGISTRY))).not.toBe(outcomeBase);
    }
  });

  it("sign and recover with any key: typed data only, no key in core", async () => {
    const provider = privateKeyToAccount(generatePrivateKey());
    const evaluator = privateKeyToAccount(generatePrivateKey());
    const voucher = warrantyVoucherTypedData(vectorVoucher, VECTOR_REGISTRY);
    const outcome = warrantyOutcomeTypedData(vectorOutcome, VECTOR_REGISTRY);
    expect(await recoverTypedDataAddress({ ...voucher, signature: await provider.signTypedData(voucher) })).toBe(provider.address);
    expect(await recoverTypedDataAddress({ ...outcome, signature: await evaluator.signTypedData(outcome) })).toBe(evaluator.address);
  });

  it("refuse an invalid chain id or registry", () => {
    expect(() => warrantyDomain({ chainId: 0, registry: VECTOR_REGISTRY.registry })).toThrow();
    expect(() => warrantyDomain({ chainId: 421614, registry: "0x4C454D4D41000000000000000000000000000001" })).toThrow();
  });
});

describe("verdicts", () => {
  it("map to the registry's numbers and back", () => {
    expect([verdictCode("passed"), verdictCode("failed"), verdictCode("void")]).toEqual([1, 2, 3]);
    expect([verdictOf(1), verdictOf(2), verdictOf(3), verdictOf(0), verdictOf(4)]).toEqual(["passed", "failed", "void", undefined, undefined]);
    expect(() => verdictCode("abandoned" as "void")).toThrow();
  });
});

describe("WarrantyVoucher", () => {
  it("accepts the registry's range and refuses anything the registry would", () => {
    accepts(WarrantyVoucher, vectorVoucher);
    accepts(WarrantyVoucher, { ...vectorVoucher, profileIndex: 0 });
    accepts(WarrantyVoucher, { ...vectorVoucher, profileIndex: 255 });
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, profileIndex: 256 }, ["profileIndex"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, profileIndex: -1 }, ["profileIndex"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, amount: "0" }, ["amount"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, amount: "0.25" }, ["amount"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, amount: 250000 }, ["amount"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, activateBy: 1.5 }, ["activateBy"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, activateBy: "1790000000" }, ["activateBy"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, activateBy: 0 }, ["activateBy"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, schemaVersion: "2" }, ["schemaVersion"]);
    rejectsAt(WarrantyVoucher, { ...vectorVoucher, paymentRef: hex32("AB") }, ["paymentRef"]);
    rejects(WarrantyVoucher, { ...vectorVoucher, paymentRef: hex32("00") });
    rejects(WarrantyVoucher, { ...vectorVoucher, claimHash: hex32("00") });
    rejects(WarrantyVoucher, { ...vectorVoucher, resolutionId: hex32("00") });
    // Strict: nothing that could name the payer rides along.
    rejects(WarrantyVoucher, { ...vectorVoucher, payer: BUYER });
  });

  it("takes every profile index and positive amount the registry takes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.bigInt({ min: 1n, max: 2n ** 256n - 1n }), (profileIndex, amount) => {
        accepts(WarrantyVoucher, { ...vectorVoucher, profileIndex, amount: amount.toString() });
        expect(warrantyVoucherTypedData({ ...vectorVoucher, profileIndex, amount: amount.toString() }, VECTOR_REGISTRY).message.amount).toBe(amount);
      }),
    );
  });
});

describe("WarrantyOutcome", () => {
  it("accepts verdicts and weights the registry takes, and nothing else", () => {
    accepts(WarrantyOutcome, vectorOutcome);
    for (const verdict of ["passed", "failed", "void"]) accepts(WarrantyOutcome, { ...vectorOutcome, verdict });
    accepts(WarrantyOutcome, { ...vectorOutcome, weightBps: 0 });
    rejectsAt(WarrantyOutcome, { ...vectorOutcome, verdict: "abandoned" }, ["verdict"]);
    rejectsAt(WarrantyOutcome, { ...vectorOutcome, verdict: 2 }, ["verdict"]);
    rejectsAt(WarrantyOutcome, { ...vectorOutcome, weightBps: 10_001 }, ["weightBps"]);
    rejectsAt(WarrantyOutcome, { ...vectorOutcome, weightBps: -1 }, ["weightBps"]);
    rejectsAt(WarrantyOutcome, { ...vectorOutcome, evidenceHash: "0x66" }, ["evidenceHash"]);
    rejectsAt(WarrantyOutcome, { ...vectorOutcome, validUntil: 0 }, ["validUntil"]);
    rejects(WarrantyOutcome, { ...vectorOutcome, payer: BUYER });
  });

  it("signs the verdict as its registry number", () => {
    for (const verdict of ["passed", "failed", "void"] as const) {
      expect(warrantyOutcomeTypedData({ ...vectorOutcome, verdict }, VECTOR_REGISTRY).message.verdict).toBe(verdictCode(verdict));
    }
  });
});

describe("the outbox's other payloads and the withdrawal route's messages", () => {
  const withdrawal = { schemaVersion: "1", resolutionId: hex32("11"), claimSecret: hex32("22"), to: "0x3333333333333333333333333333333333333333" };

  it("keeps a withdrawal's claim until the relay is over, then only the resolution", () => {
    accepts(WarrantyWithdrawal, withdrawal);
    // Addresses are lowercase in core, so one refund address has one spelling.
    rejects(WarrantyWithdrawal, { ...withdrawal, to: "0x00000000000000000000000000000000000000aB" });
    rejects(WarrantyWithdrawal, { ...withdrawal, schemaVersion: undefined });
    accepts(WarrantyActionRef, { schemaVersion: "1", resolutionId: hex32("11") });
    rejects(WarrantyActionRef, { schemaVersion: "1", resolutionId: hex32("11"), claimSecret: hex32("22") });
  });

  it("takes a strict request and answers a state or a code", () => {
    const request = { resolutionId: hex32("11"), claimSecret: hex32("22"), to: "0x3333333333333333333333333333333333333333" };
    accepts(WarrantyWithdrawalRequest, request);
    rejects(WarrantyWithdrawalRequest, { ...request, refundTo: request.to });
    rejects(WarrantyWithdrawalRequest, { resolutionId: request.resolutionId, claimSecret: request.claimSecret });
    for (const state of ["queued", "sent", "done", "abandoned"]) accepts(WarrantyWithdrawalAnswer, { resolutionId: hex32("11"), state });
    rejects(WarrantyWithdrawalAnswer, { resolutionId: hex32("11"), state: "review" });
    accepts(WarrantyWithdrawalRefusal, { error: "NO_CREDIT" });
    rejects(WarrantyWithdrawalRefusal, { error: "no credit" });
  });

  it("names the final action states", () => {
    expect(WarrantyActionState.options.filter(isFinalActionState)).toEqual(["done", "skipped", "abandoned"]);
  });
});
