import fc from "fast-check";
import { type Hex, concat, getAddress, hashTypedData, keccak256, pad, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  ADOPTION_RECEIPT_TYPES,
  BuyInput,
  WarrantyClaim,
  adoptionReceiptDigest,
  adoptionReceiptTypedData,
  derivePaymentNonce,
  deriveResolutionId,
  digest,
  paymentRequirementsFor,
  warrantyClaimHash,
} from "../src/index.js";
import * as ex from "./examples.js";
import { accepts, rejects, rejectsAt } from "./helpers.js";

const hexBytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n }).map((b) => `0x${Buffer.from(b).toString("hex")}` as Hex);

describe("derivePaymentNonce", () => {
  it("is the payment-nonce digest of the resolution id and the preview id", () => {
    const resolutionId = deriveResolutionId(ex.resolution.previewId, ex.BUYER);
    expect(derivePaymentNonce(resolutionId, ex.resolution.previewId)).toBe(digest("payment-nonce", { resolutionId, previewId: ex.resolution.previewId }));
  });

  it("is never the public resolution id, and changes with either input", () => {
    fc.assert(
      fc.property(hexBytes(32), hexBytes(32), (previewId, other) => {
        const resolutionId = deriveResolutionId(previewId, ex.BUYER);
        const nonce = derivePaymentNonce(resolutionId, previewId);
        expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
        expect(nonce).not.toBe(resolutionId);
        if (other !== previewId) expect(derivePaymentNonce(resolutionId, other)).not.toBe(nonce);
        if (other !== resolutionId) expect(derivePaymentNonce(other, previewId)).not.toBe(nonce);
      }),
    );
  });

  it("refuses anything that is not lowercase 32-byte hex", () => {
    expect(() => derivePaymentNonce(ex.hex32("AB"), ex.hex32("22"))).toThrow();
    expect(() => derivePaymentNonce("0x1234", ex.hex32("22"))).toThrow();
  });
});

describe("paymentRequirementsFor", () => {
  it("mirrors the terms field for field, with checksummed addresses and USDC's EIP-712 domain", () => {
    expect(paymentRequirementsFor(ex.terms)).toEqual({
      scheme: "exact",
      network: "eip155:421614",
      asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      amount: "250000",
      payTo: getAddress(ex.PROVIDER),
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    });
  });

  it("is deterministic, so the server's accepts and the bridge's accepted are deep-equal", () => {
    expect(paymentRequirementsFor({ ...ex.terms })).toStrictEqual(paymentRequirementsFor(ex.terms));
  });

  it("refuses invalid terms and assets without a known EIP-712 domain", () => {
    expect(() => paymentRequirementsFor({ ...ex.terms, amount: "0.25" })).toThrow();
    expect(() => paymentRequirementsFor({ ...ex.terms, asset: "0x0000000000000000000000000000000000000001" })).toThrow(/EIP-712 domain/);
    expect(() => paymentRequirementsFor({ ...ex.terms, network: "eip155:42161" })).toThrow(/EIP-712 domain/);
  });
});

describe("BuyInput", () => {
  it("takes a preview id and a claim hash, nothing else", () => {
    accepts(BuyInput, { previewId: ex.hex32("22"), claimHash: ex.hex32("33") });
    rejectsAt(BuyInput, { previewId: ex.hex32("22") }, ["claimHash"]);
    rejects(BuyInput, { previewId: ex.hex32("22"), claimHash: ex.hex32("33"), payer: ex.BUYER });
    rejectsAt(BuyInput, { previewId: ex.hex32("2A"), claimHash: ex.hex32("33") }, ["previewId"]);
  });
});

describe("warrantyClaimHash", () => {
  it("equals Solidity keccak256(abi.encode(bytes32, bytes32, address)) for the fixed input the registry test also asserts", () => {
    // Also computed with Foundry: cast keccak $(cast abi-encode "f(bytes32,bytes32,address)" <id> <secret> <to>).
    const resolutionId = `0x${"1".repeat(64)}`;
    const secret = `0x${"22".repeat(32)}`;
    const refundTo = "0x3333333333333333333333333333333333333333";
    expect(warrantyClaimHash(resolutionId, secret, refundTo)).toBe("0xefe737cca6b5574d334f88508fb3149002c12c771f7bdeec10267e5cf8fa21eb");
  });

  it("is the hash of three 32-byte words, the address left-padded", () => {
    fc.assert(
      fc.property(hexBytes(32), hexBytes(32), hexBytes(20), (id, secret, to) => {
        expect(warrantyClaimHash(id, secret, to)).toBe(keccak256(concat([id, secret, pad(to, { size: 32 })])));
      }),
    );
  });

  it("refuses non-canonical input instead of hashing something else", () => {
    expect(() => warrantyClaimHash(ex.hex32("11"), ex.hex32("22"), "0x3333333333333333333333333333333333333333".replace("3", "A"))).toThrow();
    expect(() => warrantyClaimHash(ex.hex32("11"), "0x22", "0x3333333333333333333333333333333333333333")).toThrow();
  });
});

describe("WarrantyClaim", () => {
  const resolutionId = `0x${"11".repeat(32)}`;
  const claimSecret = `0x${"22".repeat(32)}`;
  const refundTo = "0x3333333333333333333333333333333333333333";
  const claim = { schemaVersion: "1", resolutionId, claimSecret, refundTo, claimHash: warrantyClaimHash(resolutionId, claimSecret, refundTo) };

  it("is a strict, versioned record of a claim's secret, refund address and hash", () => {
    expect(WarrantyClaim.parse(claim)).toEqual(claim);
    const { schemaVersion: _version, ...unversioned } = claim;
    expect(WarrantyClaim.safeParse(unversioned).success).toBe(false);
    expect(WarrantyClaim.safeParse({ ...claim, schemaVersion: "2" }).success).toBe(false);
    expect(WarrantyClaim.safeParse({ ...claim, note: "x" }).success).toBe(false);
    expect(WarrantyClaim.safeParse({ ...claim, claimSecret: "0x22" }).success).toBe(false);
  });

  it("refuses a claim hash that is not the hash of its secret and refund address", () => {
    expect(WarrantyClaim.safeParse({ ...claim, claimHash: `0x${"44".repeat(32)}` }).success).toBe(false);
    expect(WarrantyClaim.safeParse({ ...claim, refundTo: "0x00000000000000000000000000000000000000c3" }).success).toBe(false);
  });
});

describe("adoptionReceiptTypedData", () => {
  it("commits to the whole receipt through its digest, under the Lemma domain", () => {
    const typed = adoptionReceiptTypedData(ex.receipt, 421614);
    expect(typed).toEqual({
      domain: { name: "Lemma", version: "1", chainId: 421614 },
      types: ADOPTION_RECEIPT_TYPES,
      primaryType: "AdoptionReceipt",
      message: { resolutionId: ex.receipt.resolutionId, outcome: "passed", receiptDigest: adoptionReceiptDigest(ex.receipt) },
    });
    // The signature field is not part of what is signed.
    expect(adoptionReceiptTypedData({ ...ex.receipt, signature: `0x${"ab".repeat(65)}` }, 421614)).toEqual(typed);
    expect(hashTypedData(adoptionReceiptTypedData({ ...ex.receipt, acceptance: { ...ex.receipt.acceptance, durationMs: 1 } }, 421614))).not.toBe(hashTypedData(typed));
  });

  it("signs and recovers with viem", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const typed = adoptionReceiptTypedData(ex.receipt, 421614);
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
  });

  it("refuses an invalid receipt or chain id", () => {
    expect(() => adoptionReceiptTypedData({ ...ex.receipt, outcome: "failed" }, 421614)).toThrow();
    expect(() => adoptionReceiptTypedData(ex.receipt, 0)).toThrow(RangeError);
    expect(() => adoptionReceiptTypedData(ex.receipt, 1.5)).toThrow(RangeError);
  });
});
