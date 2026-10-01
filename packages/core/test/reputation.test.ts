import fc from "fast-check";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";

import {
  AdoptionEvidence,
  AdoptionFeedbackFile,
  AgentId,
  AgentIdJson,
  Caip10,
  acceptanceRecipeDigest,
  adoptionFeedbackFile,
  adoptionFeedbackFileBytes,
  agentIdJson,
  caip10,
  digest,
  feedbackHashOf,
} from "../src/index.js";
import { ATTESTER, BUYER, PROVIDER, adoptionEvidence, adoptionFeedbackFile as providerFile, hex32, release, resolution } from "./examples.js";

const parties = { agentRegistry: "eip155:421614:0x8004a818bfb912233c491871b3d84c89a494bd9e", agentId: "7", clientAddress: caip10("eip155:421614", ATTESTER) };

describe("AgentId", () => {
  it("accepts decimal uint256 values with one spelling each", () => {
    for (const ok of ["0", "7", "340282366920938463463374607431768211455", (2n ** 256n - 1n).toString()]) expect(AgentId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["", "01", "-1", "1.0", "0x10", " 1", "1e3", (2n ** 256n).toString(), "9".repeat(79)]) expect(AgentId.safeParse(bad).success, bad).toBe(false);
  });

  it("round-trips every uint256 through bigint", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), (n) => {
        const text = n.toString();
        expect(AgentId.parse(text)).toBe(text);
        expect(BigInt(AgentId.parse(text))).toBe(n);
      }),
    );
  });
});

describe("AgentIdJson", () => {
  it("writes an agent id as a number up to 2^53 - 1 and as its decimal string above, one form each", () => {
    expect(agentIdJson("0")).toBe(0);
    expect(agentIdJson("7")).toBe(7);
    expect(agentIdJson(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(agentIdJson("9007199254740992")).toBe("9007199254740992");
    for (const ok of [0, 7, Number.MAX_SAFE_INTEGER, "9007199254740992", (2n ** 256n - 1n).toString()]) expect(AgentIdJson.safeParse(ok).success, String(ok)).toBe(true);
    // The other form of the same agent, and what is no agent id at all.
    for (const bad of ["7", "0", String(Number.MAX_SAFE_INTEGER), 2 ** 53, -1, 1.5, "07", (2n ** 256n).toString()]) expect(AgentIdJson.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("gives every uint256 agent id back exactly to a JSON reader", () => {
    const ids = fc.oneof(fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), fc.bigInt({ min: 2n ** 53n - 4n, max: 2n ** 53n + 4n }), fc.bigInt({ min: 0n, max: 1000n }));
    fc.assert(
      fc.property(ids, (n) => {
        const written = agentIdJson(n.toString());
        const read = JSON.parse(JSON.stringify(written)) as number | string;
        expect(BigInt(read)).toBe(n);
        expect(AgentIdJson.parse(read)).toBe(written);
      }),
    );
  });
});

describe("Caip10", () => {
  it("names a lowercase address on an EVM chain", () => {
    expect(caip10("eip155:421614", ATTESTER)).toBe(`eip155:421614:${ATTESTER}`);
    expect(() => caip10("eip155:421614", "0x8004A818BFB912233c491871b3d84c89A494BD9e")).toThrow();
    expect(() => caip10("421614", ATTESTER)).toThrow();
    for (const bad of [`eip155:0:${ATTESTER}`, `eip155:421614:0x${"A".repeat(40)}`, `solana:1:${ATTESTER}`, "eip155:421614", `eip155:421614:${ATTESTER}00`]) {
      expect(Caip10.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("the ERC-8004 feedback file", () => {
  it("has the spec's required fields, equal to the giveFeedback call, and Lemma's evidence under lemma", () => {
    const file = adoptionFeedbackFile(adoptionEvidence, parties);
    expect(file).toEqual(providerFile);
    expect(Object.keys(file).sort()).toEqual(["agentId", "agentRegistry", "clientAddress", "createdAt", "endpoint", "lemma", "tag1", "tag2", "value", "valueDecimals"]);
    expect(file).toMatchObject({ agentId: 7, value: 100, valueDecimals: 0, tag1: "lemma.adoption", tag2: adoptionEvidence.capability, endpoint: "", createdAt: adoptionEvidence.finalizedAt });
    expect(file.lemma).toEqual(adoptionEvidence);
    // A failure is value 0.
    const failed = { ...adoptionEvidence, verdict: "failed" as const, acceptance: { exitCode: 1, durationMs: 9, outputDigest: null } };
    expect(adoptionFeedbackFile(failed, parties).value).toBe(0);
  });

  it("serves canonical bytes whose keccak256 is the feedback hash", () => {
    const bytes = adoptionFeedbackFileBytes(providerFile);
    expect(JSON.parse(bytes)).toEqual(providerFile);
    // Canonical: keys sorted, no whitespace, so the same file always has the same bytes and hash.
    expect(bytes.startsWith(`{"agentId":7,"agentRegistry":"eip155:421614:0x8004a818bfb912233c491871b3d84c89a494bd9e","clientAddress":"eip155:421614:${ATTESTER}",`)).toBe(true);
    expect(adoptionFeedbackFileBytes(JSON.parse(bytes) as AdoptionFeedbackFile)).toBe(bytes);
    expect(feedbackHashOf(bytes)).toBe(keccak256(stringToBytes(bytes)));
  });

  it("gives each feedback on an outcome its own file and hash, since the agent differs", () => {
    const buyerAgent = adoptionFeedbackFile(adoptionEvidence, { ...parties, agentId: "42" });
    expect(buyerAgent).toEqual({ ...providerFile, agentId: 42 });
    expect(feedbackHashOf(adoptionFeedbackFileBytes(buyerAgent))).not.toBe(feedbackHashOf(adoptionFeedbackFileBytes(providerFile)));
    // An agent id above 2^53 - 1 is written as its decimal string.
    expect(adoptionFeedbackFile(adoptionEvidence, { ...parties, agentId: "9007199254740993" }).agentId).toBe("9007199254740993");
  });

  it("is strict: no buyer, payer, preview id, nonce, settlement or proof of payment can be added, at the top or under lemma", () => {
    const proofOfPayment = { fromAddress: BUYER, toAddress: PROVIDER, chainId: "421614", txHash: hex32("7a") };
    for (const extra of [{ buyer: BUYER }, { payer: BUYER }, { previewId: resolution.previewId }, { nonce: "0x01" }, { settlementRef: "0xtx" }, { proofOfPayment }]) {
      expect(AdoptionFeedbackFile.safeParse({ ...providerFile, ...extra }).success, JSON.stringify(extra)).toBe(false);
      expect(AdoptionFeedbackFile.safeParse({ ...providerFile, lemma: { ...adoptionEvidence, ...extra } }).success, JSON.stringify(extra)).toBe(false);
    }
    const bytes = adoptionFeedbackFileBytes(providerFile);
    for (const secret of [BUYER.slice(2), resolution.previewId.slice(2), "proofOfPayment", "payer", "nonce", "settlement"]) expect(bytes).not.toContain(secret);
  });

  it("refuses a file whose spec fields contradict its evidence or the call, or lack a required field", () => {
    const changes: Array<Record<string, unknown>> = [
      { value: 0 },
      { value: 1 },
      { valueDecimals: 2 },
      { tag1: "starred" },
      { tag2: "mcp-client.add-paying-client" },
      { endpoint: "https://lemma.example/mcp" },
      { createdAt: "2026-09-24T13:00:00.001Z" },
      // ISO 8601 too, but not the one form core writes an instant in.
      { createdAt: "2026-09-24T13:00:00Z" },
      { agentId: "7" },
      { clientAddress: `eip155:1:${ATTESTER}` },
      { agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e" },
    ];
    for (const change of changes) expect(AdoptionFeedbackFile.safeParse({ ...providerFile, ...change }).success, JSON.stringify(change)).toBe(false);
    for (const key of ["agentRegistry", "agentId", "clientAddress", "createdAt", "value", "valueDecimals", "lemma"]) {
      const missing = Object.fromEntries(Object.entries(providerFile).filter(([k]) => k !== key));
      expect(AdoptionFeedbackFile.safeParse(missing).success, key).toBe(false);
    }
  });

  it("refuses evidence whose verdict its exit code contradicts, and void outcomes", () => {
    expect(AdoptionEvidence.safeParse({ ...adoptionEvidence, verdict: "failed" }).success).toBe(false);
    expect(AdoptionEvidence.safeParse({ ...adoptionEvidence, acceptance: { ...adoptionEvidence.acceptance, exitCode: 1 } }).success).toBe(false);
    expect(AdoptionEvidence.safeParse({ ...adoptionEvidence, verdict: "failed", acceptance: { exitCode: null, durationMs: 1, outputDigest: null } }).success).toBe(true);
    expect(AdoptionEvidence.safeParse({ ...adoptionEvidence, verdict: "void" }).success).toBe(false);
    expect(() => adoptionFeedbackFile({ ...adoptionEvidence, verdict: "failed" }, parties)).toThrow();
  });

  it("names the recipe by a domain-separated digest", () => {
    expect(acceptanceRecipeDigest(release.acceptanceRecipe)).toBe(digest("acceptance-recipe", release.acceptanceRecipe));
    expect(acceptanceRecipeDigest(release.acceptanceRecipe)).not.toBe(acceptanceRecipeDigest({ ...release.acceptanceRecipe, timeoutSec: 301 }));
  });
});
