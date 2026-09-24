import { describe, expect, it } from "vitest";

import { BENCHMARK_TARGET_BPS, allInReductionBps, checkPurchase, checkSpend, isSellable, saleBlocker } from "../src/index.js";
import * as ex from "./examples.js";

describe("isSellable (30 percent rule)", () => {
  it("allows a price of exactly 30 percent of the saving", () => {
    expect(isSellable(300_000n, 1_000_000n)).toBe(true);
  });

  it("refuses one atomic unit over the boundary, on either side", () => {
    expect(isSellable(300_001n, 1_000_000n)).toBe(false);
    expect(isSellable(300_000n, 999_999n)).toBe(false);
  });

  it("never sells without evidence, for free, or against a non-positive saving", () => {
    expect(isSellable(1n, null)).toBe(false);
    expect(isSellable(0n, 1_000_000n)).toBe(false);
    expect(isSellable(1n, 0n)).toBe(false);
    expect(isSellable(1n, -1n)).toBe(false);
  });
});

describe("saleBlocker", () => {
  const now = new Date("2026-10-01T00:00:00.000Z");

  it("requires evidence for the matched profile", () => {
    expect(saleBlocker(250_000n, null, now)).toBe("PROFILE_NOT_BENCHMARKED");
  });

  it("stops selling when evidence is stale", () => {
    expect(saleBlocker(250_000n, ex.evidence, new Date(ex.evidence.staleAfter))).toBe("EVIDENCE_STALE");
  });

  it("applies the sale rule to the evidence's conservative saving", () => {
    expect(saleBlocker(300_000n, ex.evidence, now)).toBeNull();
    expect(saleBlocker(300_001n, ex.evidence, now)).toBe("PRICE_EXCEEDS_SAVING_RULE");
  });
});

describe("allInReductionBps", () => {
  it("measures the buyer's reduction against the control cost", () => {
    // (1.00 - 0.25) / 2.50 = 30%
    expect(allInReductionBps(ex.evidence, 250_000n)).toBe(3000n);
    expect(allInReductionBps(ex.evidence, 250_000n, 10_000n)).toBe(2960n);
  });

  it("returns zero instead of dividing by a zero control cost", () => {
    expect(allInReductionBps({ ...ex.evidence, controlMedianCostUsdc: "0", expectedRawSavingUsdc: "0" }, 1n)).toBe(0n);
  });

  it("shows that the 30 percent cap does not guarantee the 25 percent target", () => {
    // Saving 30% of control, priced at the cap: 0.7 * 30% = 21% < 25%.
    const weak = { ...ex.evidence, controlMedianCostUsdc: "1000000", expectedRawSavingUsdc: "300000" };
    expect(isSellable(90_000n, 300_000n)).toBe(true);
    expect(allInReductionBps(weak, 90_000n) < BENCHMARK_TARGET_BPS).toBe(true);
  });
});

describe("checkSpend", () => {
  const request = { ...ex.terms, amount: "400000" };

  it("allows a payment within all limits and reports what is left", () => {
    expect(checkSpend(ex.policy, 0n, request)).toEqual({ ok: true, amount: 400_000n, remainingTodayUsdc: 600_000n });
  });

  it("counts committed spend, reaching the cap exactly but not beyond", () => {
    expect(checkSpend(ex.policy, 600_000n, request)).toMatchObject({ ok: true, remainingTodayUsdc: 0n });
    expect(checkSpend(ex.policy, 600_001n, request)).toEqual({ ok: false, reason: "EXCEEDS_DAILY_CAP" });
    expect(checkSpend(ex.policy, -1n, request)).toEqual({ ok: false, reason: "EXCEEDS_DAILY_CAP" });
  });

  it("accepts a payment exactly at the per-resolution limit and the shortest authorization", () => {
    expect(checkSpend(ex.policy, 0n, { ...request, amount: "500000" }).ok).toBe(true);
    expect(checkSpend(ex.policy, 0n, { ...request, maxTimeoutSeconds: 1 }).ok).toBe(true);
  });

  it("treats non-string fields from an untrusted challenge as mismatches, without throwing", () => {
    expect(checkSpend(ex.policy, 0n, { ...request, asset: 42 as unknown as string })).toEqual({ ok: false, reason: "WRONG_ASSET" });
    expect(checkSpend(ex.policy, 0n, { ...request, payTo: null as unknown as string })).toEqual({ ok: false, reason: "WRONG_RECIPIENT" });
  });

  it("refuses a payment over the per-resolution limit", () => {
    expect(checkSpend(ex.policy, 0n, { ...request, amount: "500001" })).toEqual({ ok: false, reason: "EXCEEDS_PER_RESOLUTION" });
  });

  it("refuses the wrong scheme, network, asset or recipient", () => {
    expect(checkSpend(ex.policy, 0n, { ...request, scheme: "upto" })).toEqual({ ok: false, reason: "WRONG_SCHEME" });
    expect(checkSpend(ex.policy, 0n, { ...request, network: "eip155:42161" })).toEqual({ ok: false, reason: "WRONG_NETWORK" });
    expect(checkSpend(ex.policy, 0n, { ...request, asset: "0x0000000000000000000000000000000000000001" })).toEqual({ ok: false, reason: "WRONG_ASSET" });
    expect(checkSpend(ex.policy, 0n, { ...request, payTo: "0x00000000000000000000000000000000000000e1" })).toEqual({ ok: false, reason: "WRONG_RECIPIENT" });
  });

  it("accepts x402's checksummed addresses", () => {
    expect(checkSpend(ex.policy, 0n, { ...request, asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" }).ok).toBe(true);
  });

  it("refuses long-lived authorizations", () => {
    for (const maxTimeoutSeconds of [0, 301, 1.5, Number.NaN]) {
      expect(checkSpend(ex.policy, 0n, { ...request, maxTimeoutSeconds })).toEqual({ ok: false, reason: "AUTHORIZATION_TOO_LONG" });
    }
  });

  it("refuses malformed and zero amounts without throwing", () => {
    expect(checkSpend(ex.policy, 0n, { ...request, amount: "0.4" })).toEqual({ ok: false, reason: "INVALID_AMOUNT" });
    expect(checkSpend(ex.policy, 0n, { ...request, amount: "0" })).toEqual({ ok: false, reason: "ZERO_AMOUNT" });
  });

  it("rejects an invalid policy instead of trusting it", () => {
    expect(() => checkSpend({ ...ex.policy, dailyCapUsdc: "-1" }, 0n, request)).toThrow();
  });
});

describe("checkPurchase", () => {
  const now = new Date("2026-09-24T12:05:00.000Z");

  it("allows paying exactly the quoted terms before the quote expires", () => {
    expect(checkPurchase(ex.policy, 0n, ex.offerPreview, ex.terms, now)).toEqual({ ok: true, amount: 250_000n, remainingTodayUsdc: 750_000n });
  });

  it("refuses a challenge that differs from the quote in any field", () => {
    for (const patch of [
      { amount: "250001" },
      { amount: "249999" },
      { payTo: "0x00000000000000000000000000000000000000e1" },
      { network: "eip155:42161" },
      { maxTimeoutSeconds: 299 },
      { scheme: "upto" },
      { asset: "0x0000000000000000000000000000000000000001" },
    ]) {
      expect(checkPurchase(ex.policy, 0n, ex.offerPreview, { ...ex.terms, ...patch }, now), JSON.stringify(patch)).toEqual({ ok: false, reason: "TERMS_MISMATCH" });
    }
  });

  it("refuses to pay for a no-match or an unsellable match", () => {
    expect(checkPurchase(ex.policy, 0n, ex.declinePreview, ex.terms, now)).toEqual({ ok: false, reason: "NO_OFFER" });
    const unsellable = { ...ex.offerPreview, offer: null, reasons: ["PROFILE_NOT_BENCHMARKED" as const] };
    expect(checkPurchase(ex.policy, 0n, unsellable, ex.terms, now)).toEqual({ ok: false, reason: "NO_OFFER" });
  });

  it("allows an adapt decision with an offer, like reuse", () => {
    expect(checkPurchase(ex.policy, 0n, { ...ex.offerPreview, decision: "adapt" } as typeof ex.offerPreview, ex.terms, now).ok).toBe(true);
  });

  it("refuses an expired quote", () => {
    expect(checkPurchase(ex.policy, 0n, ex.offerPreview, ex.terms, new Date("2026-09-24T12:15:00.000Z"))).toEqual({ ok: false, reason: "QUOTE_EXPIRED" });
  });

  it("still applies the spending policy to a matching quote", () => {
    expect(checkPurchase(ex.policy, 800_000n, ex.offerPreview, ex.terms, now)).toEqual({ ok: false, reason: "EXCEEDS_DAILY_CAP" });
  });
});
