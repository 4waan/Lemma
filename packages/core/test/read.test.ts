import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityRelease,
  CatalogReputation,
  CatalogView,
  ChainView,
  CompatibilitySource,
  DemandView,
  MIN_PUBLISHED_BUYERS,
  ProfileCompatibility,
  ReleaseSummary,
  ResolutionView,
  StatusView,
  type UnmetDemand,
  WarrantyState,
  WarrantyView,
  publishedBuyers,
  rankUnmetDemand,
  releaseDigest,
  summarizeRelease,
} from "../src/index.js";
import { evidence, hex32, release } from "./examples.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const entry = (r: CapabilityRelease, provisional = false) => ({ release: r, releaseDigest: releaseDigest(r), baseReleaseDigest: hex32("77"), provisional });

describe("summarizeRelease", () => {
  const priced = { ...release, version: "0.1.0+bench-1", price: "250000", supportedProfiles: [{ ...release.supportedProfiles[0]!, evidence: { ...evidence, benchmarkVersion: "bench-1", controlMedianCostUsdc: "2500000", expectedRawSavingUsdc: "1000000", staleAfter: "2026-12-01T00:00:00.000Z" } }] } as CapabilityRelease;

  it("shows what the evidence promises at the list price after chain cost", () => {
    const summary = summarizeRelease(entry(priced), { chainCostAtomic: 10_000n }, NOW);
    expect(ReleaseSummary.parse(summary)).toEqual(summary);
    // (1.00 - 0.25 - 0.01) / 2.50 = 29.6 %; maxPriceFor = min(0.30, 1.00 - 0.01 - 0.625) = 0.30
    expect(summary.profiles[0]).toMatchObject({ label: "benchmarked", blocker: null, allInReductionBps: "2960", maxPriceUsdc: "300000" });
    expect(summary.provisional).toBe(false);
  });

  it("names why a profile is not sold, and labels provisional evidence", () => {
    const bare = { ...release, supportedProfiles: release.supportedProfiles.map((p) => ({ ...p, evidence: null })) };
    const unbenchmarked = summarizeRelease(entry(bare), { chainCostAtomic: 0n }, NOW).profiles[0];
    expect(unbenchmarked).toMatchObject({ label: "none", blocker: "PROFILE_NOT_BENCHMARKED", allInReductionBps: null, maxPriceUsdc: null });
    expect(summarizeRelease(entry(priced), { chainCostAtomic: 0n }, new Date("2026-12-02T00:00:00.000Z")).profiles[0]?.blocker).toBe("EVIDENCE_STALE");
    expect(summarizeRelease(entry(priced), { chainCostAtomic: 0n }, new Date(Date.parse(release.expiresAt) + 1)).profiles[0]?.blocker).toBe("RELEASE_EXPIRED");
    const provisional = summarizeRelease(entry({ ...priced, version: "0.1.0+provisional-1" }), { chainCostAtomic: 0n }, NOW);
    expect(provisional).toMatchObject({ provisional: true, profiles: [{ label: "provisional" }] });
    expect(summarizeRelease(entry(priced, true), { chainCostAtomic: 0n }, NOW).provisional).toBe(true);
  });

  it("carries the capability's adoption record when known, and null otherwise", () => {
    expect(summarizeRelease(entry(priced), { chainCostAtomic: 0n }, NOW).reputation).toBeNull();
    expect(summarizeRelease({ ...entry(priced), reputationBuyers: 9 }, { chainCostAtomic: 0n }, NOW).reputation).toBeNull();
    const known = summarizeRelease({ ...entry(priced), reputation: { passBps: 9700, count: 34 } }, { chainCostAtomic: 0n }, NOW);
    expect(known.reputation).toEqual({ passBps: 9700, count: 34, buyers: null });
    // Distinct buyers are published from three up.
    expect(summarizeRelease({ ...entry(priced), reputation: { passBps: 9700, count: 34 }, reputationBuyers: 2 }, { chainCostAtomic: 0n }, NOW).reputation?.buyers).toBeNull();
    expect(summarizeRelease({ ...entry(priced), reputation: { passBps: 9700, count: 34 }, reputationBuyers: 3 }, { chainCostAtomic: 0n }, NOW).reputation?.buyers).toBe(3);
    expect(ReleaseSummary.safeParse({ ...known, reputation: { passBps: 9700, count: 34, buyers: 2 } }).success).toBe(false);
    expect(ReleaseSummary.safeParse({ ...known, reputation: { passBps: 9700, count: 34 } }).success).toBe(false);
    expect(ReleaseSummary.safeParse({ ...known, reputation: { passBps: 10_001, count: 1 } }).success).toBe(false);
    expect(ReleaseSummary.safeParse({ ...known, reputation: { passBps: 5000, count: 0 } }).success).toBe(false);
    expect(ReleaseSummary.safeParse({ ...known, reputation: { passBps: 97.5, count: 2 } }).success).toBe(false);
  });

  it("builds a catalog view that parses", () => {
    const view = { schemaVersion: "1", catalogDigest: hex32("88"), generatedAt: NOW.toISOString(), economics: { status: "measured", chainCostUsdc: "0", priceFloorUsdc: "0" }, releases: [summarizeRelease(entry(release), { chainCostAtomic: 0n }, NOW)] };
    expect(CatalogView.safeParse(view).success).toBe(true);
  });

  it("carries each profile's compatibility confidence from the map, and null without one", () => {
    expect(summarizeRelease(entry(priced), { chainCostAtomic: 0n }, NOW).profiles[0]?.compatibility).toBeNull();
    const confidence = { confidenceBps: 8039, effectiveNMilli: "20000", outcomes: 0, source: "benchmark" as const, buyers: null };
    const summary = summarizeRelease(entry(priced), { chainCostAtomic: 0n }, NOW, new Map([[0, confidence]]));
    expect(summary.profiles[0]?.compatibility).toEqual(confidence);
    // An index the release does not have is ignored.
    expect(summarizeRelease(entry(priced), { chainCostAtomic: 0n }, NOW, new Map([[5, confidence]])).profiles[0]?.compatibility).toBeNull();
    // Outcomes alone need a profile without evidence.
    const bare = { ...release, supportedProfiles: release.supportedProfiles.map((p) => ({ ...p, evidence: null })) };
    const fromOutcomes = { confidenceBps: 4887, effectiveNMilli: "10601", outcomes: 12, source: "outcomes" as const, buyers: 4 };
    expect(summarizeRelease(entry(bare), { chainCostAtomic: 0n }, NOW, new Map([[0, fromOutcomes]])).profiles[0]?.compatibility).toEqual(fromOutcomes);
    expect(() => summarizeRelease(entry(bare), { chainCostAtomic: 0n }, NOW, new Map([[0, confidence]]))).toThrow();
    expect(() => summarizeRelease(entry(priced), { chainCostAtomic: 0n }, NOW, new Map([[0, fromOutcomes]]))).toThrow();
  });
});

describe("ProfileCompatibility", () => {
  const ok = { confidenceBps: 7337, effectiveNMilli: "21727", outcomes: 4, source: "benchmark+outcomes", buyers: null };

  it("accepts the engine's range and refuses anything outside it", () => {
    expect(ProfileCompatibility.parse(ok)).toEqual(ok);
    expect(ProfileCompatibility.safeParse({ ...ok, effectiveNMilli: "18446744073709551615" }).success).toBe(true);
    for (const bad of [
      { ...ok, confidenceBps: 10_001 },
      { ...ok, confidenceBps: -1 },
      { ...ok, confidenceBps: 1.5 },
      { ...ok, effectiveNMilli: "18446744073709551616" },
      { ...ok, effectiveNMilli: "01" },
      { ...ok, effectiveNMilli: 21727 },
      { ...ok, outcomes: -1 },
      { ...ok, source: "chain" },
      { ...ok, extra: true },
      { ...ok, buyers: undefined },
      { ...ok, buyers: 2 },
      { ...ok, buyers: 5 },
      { ...ok, buyers: 3.5 },
    ]) {
      expect(ProfileCompatibility.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("publishes distinct buyers from three up, never more than the outcomes counted", () => {
    expect(ProfileCompatibility.parse({ ...ok, buyers: 3 }).buyers).toBe(3);
    expect(ProfileCompatibility.parse({ ...ok, buyers: 4 }).buyers).toBe(4);
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), (count) => {
        expect(publishedBuyers(count)).toBe(count >= MIN_PUBLISHED_BUYERS ? count : null);
      }),
    );
    expect(() => publishedBuyers(-1)).toThrow();
    expect(() => publishedBuyers(1.5)).toThrow();
    expect(CatalogReputation.safeParse({ passBps: 5000, count: 2, buyers: null }).success).toBe(true);
  });

  it("ties the source to the outcome count", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CompatibilitySource.options), fc.nat({ max: 50 }), (source, outcomes) => {
        const parsed = ProfileCompatibility.safeParse({ ...ok, source, outcomes }).success;
        expect(parsed).toBe(source === "benchmark" ? outcomes === 0 : outcomes > 0);
      }),
    );
  });
});

describe("rankUnmetDemand", () => {
  const key = (over: Record<string, unknown>) => ({
    capability: "mcp-server.add-payment-gating" as const,
    decision: "build" as const,
    release: null,
    profileIndex: null,
    reasons: ["MISSING_DEPENDENCY" as const],
    offer: false,
    class: { packageManager: "npm" as const, moduleSystem: "esm" as const, nodeMajor: 22, frameworks: [] },
    ...over,
  });

  it("groups by capability, answer and reasons across classes and days, and skips sold offers", () => {
    const view: DemandView = {
      minProfiles: 5,
      buckets: [
        { day: "2026-09-29", profiles: 5, sources: 5, buyers: 0, key: key({}) },
        { day: "2026-09-30", profiles: 7, sources: 7, buyers: 0, key: key({ class: { packageManager: "pnpm", moduleSystem: "cjs", nodeMajor: 20, frameworks: ["express"] } }) },
        { day: "2026-09-30", profiles: 9, sources: 9, buyers: 0, key: key({ capability: "node-service.add-payment-facilitator", reasons: ["NO_RELEASE_FOR_CAPABILITY"] }) },
        { day: "2026-09-30", profiles: 40, sources: 40, buyers: 30, key: key({ decision: "reuse", release: "gating@1.0.0", profileIndex: 0, reasons: [], offer: true }) },
        { day: "2026-09-30", profiles: 6, sources: 6, buyers: 0, key: key({ decision: "reuse", release: "gating@1.0.0", profileIndex: 0, reasons: ["PROFILE_NOT_BENCHMARKED"] }) },
      ],
    };
    // No buyer asked for any of them yet: a fixed order, with the repositories that asked published beside it.
    expect(rankUnmetDemand(view)).toEqual([
      { capability: "mcp-server.add-payment-gating", decision: "build", reasons: ["MISSING_DEPENDENCY"], buyerDays: 0, profileDays: 12, days: 2 },
      { capability: "mcp-server.add-payment-gating", decision: "reuse", reasons: ["PROFILE_NOT_BENCHMARKED"], buyerDays: 0, profileDays: 6, days: 1 },
      { capability: "node-service.add-payment-facilitator", decision: "build", reasons: ["NO_RELEASE_FOR_CAPABILITY"], buyerDays: 0, profileDays: 9, days: 1 },
    ]);
  });

  it("ranks by bridges that have bought before, however many repositories and addresses asked", () => {
    const bought = { day: "2026-09-30", profiles: 5, sources: 5, buyers: 2, key: key({ capability: "node-service.add-payment-facilitator", reasons: ["NO_RELEASE_FOR_CAPABILITY"] }) };
    const flooded = { day: "2026-09-30", profiles: 5000, sources: 5000, buyers: 1, key: key({}) };
    expect(rankUnmetDemand({ minProfiles: 5, buckets: [flooded, bought] }).map((d) => [d.capability, d.buyerDays, d.profileDays])).toEqual([
      ["node-service.add-payment-facilitator", 2, 5],
      ["mcp-server.add-payment-gating", 1, 5000],
    ]);
  });

  it("cannot be moved by previews from bridges that never bought: extra buckets without buyers leave the order of every group as it was", () => {
    const bucket = fc.record({
      day: fc.constantFrom("2026-09-29", "2026-09-30", "2026-10-01"),
      profiles: fc.integer({ min: 5, max: 10_000 }),
      sources: fc.integer({ min: 5, max: 10_000 }),
      buyers: fc.nat({ max: 20 }),
      key: fc.record({
        capability: fc.constantFrom(...CAPABILITY_IDS),
        decision: fc.constantFrom("reuse" as const, "adapt" as const, "build" as const, "decline" as const),
        reasons: fc.subarray(["MISSING_DEPENDENCY", "NO_RELEASE_FOR_CAPABILITY", "PROFILE_NOT_BENCHMARKED"] as const),
        offer: fc.boolean(),
      }),
    });
    const toView = (buckets: Array<{ day: string; profiles: number; sources: number; buyers: number; key: { capability: CapabilityId; decision: "reuse" | "adapt" | "build" | "decline"; reasons: readonly ("MISSING_DEPENDENCY" | "NO_RELEASE_FOR_CAPABILITY" | "PROFILE_NOT_BENCHMARKED")[]; offer: boolean } }>): DemandView => ({
      minProfiles: 5,
      buckets: buckets.map((b) => ({ ...b, key: key({ ...b.key, reasons: [...b.key.reasons] }) })),
    });
    const group = (d: UnmetDemand) => JSON.stringify([d.capability, d.decision, d.reasons]);
    fc.assert(
      fc.property(fc.array(bucket, { maxLength: 12 }), fc.array(bucket, { maxLength: 12 }), (real, probed) => {
        const before = rankUnmetDemand(toView(real)).map(group);
        const after = rankUnmetDemand(toView([...real, ...probed.map((b) => ({ ...b, buyers: 0 }))]));
        // Every group listed before keeps its place among the others; a group only they asked for has no buyer-days, so it ranks below every group a buyer asked for.
        expect(after.map(group).filter((g) => before.includes(g))).toEqual(before);
        for (const added of after.filter((d) => !before.includes(group(d)))) expect(added.buyerDays).toBe(0);
      }),
    );
  });

  it("refuses a published bucket without its buyer count", () => {
    expect(DemandView.safeParse({ minProfiles: 5, buckets: [{ day: "2026-09-30", profiles: 5, sources: 5, key: key({}) }] }).success).toBe(false);
  });
});

describe("WarrantyView", () => {
  const tx = (b: string) => hex32(b);
  const views: Record<WarrantyState, Record<string, unknown>> = {
    none: { state: "none", amount: null, claimDeadline: null, activation: null, outcome: null, expiry: null, withdrawal: null, feedback: null },
    pending: { state: "pending", amount: null, claimDeadline: null, activation: null, outcome: null, expiry: null, withdrawal: null, feedback: null },
    active: { state: "active", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: tx("a1"), outcome: null, expiry: null, withdrawal: null, feedback: null },
    passed: { state: "passed", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: tx("a1"), outcome: tx("a2"), expiry: null, withdrawal: null, feedback: tx("a5") },
    failed: { state: "failed", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: tx("a1"), outcome: tx("a2"), expiry: null, withdrawal: null, feedback: null },
    refunded: { state: "refunded", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: tx("a1"), outcome: tx("a2"), expiry: null, withdrawal: tx("a4"), feedback: tx("a5") },
    void: { state: "void", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: tx("a1"), outcome: tx("a2"), expiry: null, withdrawal: null, feedback: null },
    expired: { state: "expired", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: tx("a1"), outcome: null, expiry: tx("a3"), withdrawal: null, feedback: null },
  };

  it("accepts each state with exactly the transactions it has", () => {
    for (const state of WarrantyState.options) expect(WarrantyView.parse(views[state])).toEqual(views[state]);
  });

  it("refuses transactions and amounts a state cannot have", () => {
    const bad = [
      { ...views.pending, activation: tx("a1") },
      { ...views.active, activation: null },
      { ...views.active, amount: null },
      { ...views.active, claimDeadline: null },
      { ...views.none, amount: "1" },
      { ...views.active, outcome: tx("a2") },
      { ...views.passed, outcome: null },
      { ...views.failed, withdrawal: tx("a4") },
      { ...views.refunded, withdrawal: null },
      { ...views.expired, expiry: null },
      { ...views.active, expiry: tx("a3") },
      { ...views.void, feedback: tx("a5") },
      { ...views.expired, feedback: tx("a5") },
      { ...views.active, amount: "0.25" },
      { ...views.active, claimDeadline: "2026-10-04" },
      { ...views.active, payer: "0x00000000000000000000000000000000000000b1" },
      { ...views.active, state: "reserved" },
    ];
    for (const view of bad) expect(WarrantyView.safeParse(view).success, JSON.stringify(view)).toBe(false);
  });

  it("is part of the resolution view, null while no pipeline runs", () => {
    const resolution = {
      resolutionId: hex32("11"),
      state: "settled",
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: hex32("44"), profileIndex: 0 },
      payloadDigest: hex32("45"),
      terms: { scheme: "exact", network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdOn: "2026-10-01",
      receipt: null,
    };
    expect(ResolutionView.safeParse({ ...resolution, warranty: null }).success).toBe(true);
    expect(ResolutionView.safeParse({ ...resolution, warranty: views.refunded }).success).toBe(true);
    expect(ResolutionView.safeParse(resolution).success).toBe(false);
    expect(ResolutionView.safeParse({ ...resolution, warranty: { ...views.active, claimHash: hex32("99") } }).success).toBe(false);
  });

  it("dates a resolution to the day only, so its public id cannot be timed to the payment that settled it", () => {
    const resolution = {
      resolutionId: hex32("11"),
      state: "settled",
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: hex32("44"), profileIndex: 0 },
      payloadDigest: hex32("45"),
      terms: { scheme: "exact", network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdOn: "2026-10-01",
      receipt: null,
      warranty: null,
    };
    expect(ResolutionView.parse(resolution).createdOn).toBe("2026-10-01");
    const { createdOn: _, ...undated } = resolution;
    for (const bad of [{ createdOn: "2026-10-01T12:00:03.123Z" }, { createdOn: "2026-10-01 12:00" }, { createdOn: "2026-13-01" }, { createdOn: 1790000000 }, { createdAt: "2026-10-01T12:00:03.123Z" }]) {
      expect(ResolutionView.safeParse({ ...undated, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    // The precise time stays in the signed resolution the buyer holds, and in the server's row.
    expect(ResolutionView.safeParse({ ...resolution, createdAt: NOW.toISOString() }).success).toBe(false);
  });
});

describe("ChainView", () => {
  const chain = {
    explorer: "https://sepolia.arbiscan.io",
    usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    registry: "0x4c454d4d41000000000000000000000000000001",
    engine: null,
    identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
    reputationRegistry: null,
    providerAgentId: "7",
  };

  it("names the chain's contracts and explorer, each null when unused", () => {
    expect(ChainView.parse(chain)).toEqual(chain);
    const off = { explorer: null, usdc: null, registry: null, engine: null, identityRegistry: null, reputationRegistry: null, providerAgentId: null };
    expect(ChainView.parse(off)).toEqual(off);
    for (const bad of [
      { ...chain, explorer: "ftp://example.com" },
      { ...chain, registry: "0x4C454D4D41000000000000000000000000000001" },
      { ...chain, providerAgentId: "07" },
      { ...chain, provider: "0x00000000000000000000000000000000000000a1" },
    ]) {
      expect(ChainView.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is part of the status view", () => {
    const status = { schemaVersion: "1", status: "ok", network: "eip155:421614", catalogDigest: hex32("88"), releases: 2, paidTools: true, provisionalEvidence: false, store: "postgres", economics: "measured" };
    expect(StatusView.safeParse({ ...status, chain }).success).toBe(true);
    expect(StatusView.safeParse(status).success).toBe(false);
  });
});
