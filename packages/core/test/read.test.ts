import { describe, expect, it } from "vitest";

import { type CapabilityRelease, CatalogView, type DemandView, ReleaseSummary, rankUnmetDemand, releaseDigest, summarizeRelease } from "../src/index.js";
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

  it("builds a catalog view that parses", () => {
    const view = { schemaVersion: "1", catalogDigest: hex32("88"), generatedAt: NOW.toISOString(), economics: { status: "measured", chainCostUsdc: "0", priceFloorUsdc: "0" }, releases: [summarizeRelease(entry(release), { chainCostAtomic: 0n }, NOW)] };
    expect(CatalogView.safeParse(view).success).toBe(true);
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

  it("groups by capability, answer and reasons across classes and days, ranks by repositories, and skips sold offers", () => {
    const view: DemandView = {
      minProfiles: 5,
      buckets: [
        { day: "2026-09-29", profiles: 5, sources: 5, key: key({}) },
        { day: "2026-09-30", profiles: 7, sources: 7, key: key({ class: { packageManager: "pnpm", moduleSystem: "cjs", nodeMajor: 20, frameworks: ["express"] } }) },
        { day: "2026-09-30", profiles: 9, sources: 9, key: key({ capability: "node-service.add-payment-facilitator", reasons: ["NO_RELEASE_FOR_CAPABILITY"] }) },
        { day: "2026-09-30", profiles: 40, sources: 40, key: key({ decision: "reuse", release: "gating@1.0.0", profileIndex: 0, reasons: [], offer: true }) },
        { day: "2026-09-30", profiles: 6, sources: 6, key: key({ decision: "reuse", release: "gating@1.0.0", profileIndex: 0, reasons: ["PROFILE_NOT_BENCHMARKED"] }) },
      ],
    };
    expect(rankUnmetDemand(view)).toEqual([
      { capability: "mcp-server.add-payment-gating", decision: "build", reasons: ["MISSING_DEPENDENCY"], profileDays: 12, days: 2 },
      { capability: "node-service.add-payment-facilitator", decision: "build", reasons: ["NO_RELEASE_FOR_CAPABILITY"], profileDays: 9, days: 1 },
      { capability: "mcp-server.add-payment-gating", decision: "reuse", reasons: ["PROFILE_NOT_BENCHMARKED"], profileDays: 6, days: 1 },
    ]);
  });
});
