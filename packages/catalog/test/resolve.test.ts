import {
  type CapabilityRelease,
  type PatchBundle,
  type ProfileEvidence,
  type RepositoryProfile,
  bundleDigest,
  releaseDigest,
} from "@lemma/core";
import fc from "fast-check";
import { Range } from "semver";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LoadedCatalog, type LoadedRelease, buildIndex, checkProfile, resolve } from "../src/index.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const PROVIDER = "0x00000000000000000000000000000000000000a1";
const CTX = {
  now: NOW,
  previewId: `0x${"22".repeat(32)}`,
  payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
  offerTtlSeconds: 900,
} as const;

const bundle: PatchBundle = {
  schemaVersion: "1",
  files: [{ path: "src/lemma.ts", op: "add", baseDigest: null, content: "export {};\n" }],
  dependencies: {},
  devDependencies: {},
};

const evidence = (over: Partial<ProfileEvidence> = {}): ProfileEvidence => ({
  benchmarkVersion: "bench-1",
  runSetDigest: `0x${"12".repeat(32)}`,
  fixtureProfileDigest: `0x${"13".repeat(32)}`,
  model: "example-model-1",
  measuredAt: "2026-09-20T00:00:00.000Z",
  staleAfter: "2026-12-20T00:00:00.000Z",
  runs: { control: 3, treatment: 3 },
  passed: { control: 3, treatment: 3 },
  controlMedianCostUsdc: "2500000",
  expectedRawSavingUsdc: "1000000",
  expectedTokenSaving: 420000,
  ...over,
});

type ReleaseOptions = { id?: string; version?: string; price?: string; evidence?: ProfileEvidence | null; expiresAt?: string; range?: string; frameworks?: Array<"hono" | "express">; capability?: CapabilityRelease["capability"] };

function release(o: ReleaseOptions = {}): LoadedRelease {
  const r: CapabilityRelease = {
    schemaVersion: "1",
    releaseId: o.id ?? "gating",
    version: o.version ?? "1.0.0",
    capability: o.capability ?? "mcp-server.add-payment-gating",
    title: "Test release",
    supportedProfiles: [
      {
        languages: ["typescript"],
        nodeMajor: { min: 22, max: 24 },
        packageManagers: ["npm", "pnpm"],
        moduleSystems: ["esm"],
        dependencies: { "@modelcontextprotocol/sdk": o.range ?? ">=1.30.0 <2" },
        frameworks: o.frameworks ?? [],
        evidence: o.evidence === undefined ? evidence() : o.evidence,
      },
    ],
    provenance: { repository: "https://github.com/coinbase/x402", commit: "dd927a26cfefc98c24b3ec38b3a8f204dad0c60d", spdxLicense: "Apache-2.0" },
    payloadDigest: bundleDigest(bundle),
    acceptanceRecipe: { script: "test", args: [], timeoutSec: 300, env: ["CI"] },
    price: o.price ?? "250000",
    provider: { payTo: PROVIDER },
    warranty: { claimWindowHours: 72 },
    publishedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: o.expiresAt ?? "2027-03-31T00:00:00.000Z",
  };
  return { release: r, releaseDigest: releaseDigest(r), bundle, source: "public", dir: `releases/${r.releaseId}/${r.version}` };
}

const catalog = (...releases: LoadedRelease[]): LoadedCatalog => ({
  root: "/nonexistent",
  economics: { schemaVersion: "1", status: "measured", chainCostAtomic: "0", priceFloorAtomic: "0", ethUsdMicro: "0", measuredAt: "2026-09-01T00:00:00.000Z", source: "test" },
  releases,
});

const profile = (over: Partial<RepositoryProfile> = {}): RepositoryProfile => ({
  schemaVersion: "1",
  language: "typescript",
  runtime: { name: "node", major: 22 },
  packageManager: { name: "npm", lockfile: "package-lock.json" },
  moduleSystem: "esm",
  dependencies: { "@modelcontextprotocol/sdk": "1.30.1" },
  frameworks: [],
  ...over,
});

const task = { schemaVersion: "1" as const, capability: "mcp-server.add-payment-gating" as const };
const run = (c: LoadedCatalog, p: RepositoryProfile = profile(), ctx = CTX) => resolve({ task, profile: p }, buildIndex(c), ctx);

afterEach(() => vi.restoreAllMocks());

describe("resolve: matches and offers", () => {
  it("offers a sellable match at the release's price and payTo with the configured network", () => {
    const preview = run(catalog(release()));
    expect(preview.decision).toBe("reuse");
    if (preview.decision !== "reuse") return;
    expect(preview.reasons).toEqual([]);
    expect(preview.offer?.terms).toEqual({ scheme: "exact", network: "eip155:421614", asset: CTX.payment.asset, amount: "250000", payTo: PROVIDER, maxTimeoutSeconds: 300 });
    expect(preview.offer?.expectedRawSavingUsdc).toBe("1000000");
    expect(preview.offer?.claimWindowHours).toBe(72);
    expect(preview.offer?.validUntil).toBe("2026-10-01T00:15:00.000Z");
    expect(preview.createdAt).toBe(NOW.toISOString());
  });

  it("closes the offer at the release expiry or the evidence's staleAfter when sooner", () => {
    const expiring = run(catalog(release({ expiresAt: "2026-10-01T00:05:00.000Z" })));
    expect(expiring.decision === "reuse" && expiring.offer?.validUntil).toBe("2026-10-01T00:05:00.000Z");
    const stale = run(catalog(release({ evidence: evidence({ staleAfter: "2026-10-01T00:01:00.000Z" }) })));
    expect(stale.decision === "reuse" && stale.offer?.validUntil).toBe("2026-10-01T00:01:00.000Z");
  });

  it("previews without an offer, and says why, when the match cannot be sold", () => {
    const cases: Array<[ReleaseOptions, string]> = [
      [{ evidence: null }, "PROFILE_NOT_BENCHMARKED"],
      [{ evidence: evidence({ staleAfter: "2026-09-30T00:00:00.000Z" }) }, "EVIDENCE_STALE"],
      [{ price: "300001" }, "PRICE_EXCEEDS_SAVING_RULE"],
      [{ price: "0" }, "PRICE_EXCEEDS_SAVING_RULE"],
    ];
    for (const [options, reason] of cases) {
      const preview = run(catalog(release(options)));
      expect(preview.decision).toBe("reuse");
      expect(preview.decision === "reuse" && preview.offer).toBeNull();
      expect(preview.reasons).toEqual([reason]);
    }
  });

  it("ranks sellable first, then net saving, then newer versions, and breaks ties by digest", () => {
    const sellable = release({ id: "a-sellable", price: "300000" });
    const unsellable = release({ id: "b-unsellable", evidence: null });
    expect(run(catalog(unsellable, sellable)).decision === "reuse" && run(catalog(unsellable, sellable))).toMatchObject({ release: { releaseId: "a-sellable" } });

    const cheaper = release({ id: "z-cheaper", price: "100000" }); // S - P = 900000
    const pricier = release({ id: "a-pricier", price: "300000" }); // S - P = 700000
    expect(run(catalog(pricier, cheaper))).toMatchObject({ release: { releaseId: "z-cheaper" } });

    const older = release({ version: "1.0.0" });
    const newer = release({ version: "1.1.0" });
    expect(run(catalog(older, newer))).toMatchObject({ release: { version: "1.1.0" } });

    const x = release({ version: "1.0.0+bench-1" });
    const y = release({ version: "1.0.0+bench-2" });
    const first = [x, y].sort((a, b) => (a.releaseDigest < b.releaseDigest ? -1 : 1))[0] as LoadedRelease;
    expect(run(catalog(x, y))).toMatchObject({ release: { releaseDigest: first.releaseDigest } });
    expect(run(catalog(y, x))).toMatchObject({ release: { releaseDigest: first.releaseDigest } });
  });
});

describe("resolve: no match", () => {
  it("builds when no release exists for the capability", () => {
    const preview = resolve({ task: { schemaVersion: "1", capability: "node-service.add-payment-facilitator" }, profile: profile() }, buildIndex(catalog(release())), CTX);
    expect(preview).toMatchObject({ decision: "build", reasons: ["NO_RELEASE_FOR_CAPABILITY"] });
  });

  it("declines on an unsupported platform and builds on missing or out-of-range dependencies", () => {
    const c = catalog(release({ frameworks: ["hono"] }));
    expect(run(c, profile({ runtime: { name: "node", major: 20 }, frameworks: ["hono"] }))).toMatchObject({ decision: "decline", reasons: ["UNSUPPORTED_RUNTIME"] });
    expect(run(c, profile({ language: "javascript", runtime: { name: "node", major: 25 }, frameworks: ["hono"] }))).toMatchObject({ decision: "decline", reasons: ["UNSUPPORTED_LANGUAGE", "UNSUPPORTED_RUNTIME"] });
    expect(run(c, profile({ packageManager: { name: "yarn", lockfile: "yarn.lock" }, dependencies: {} }))).toMatchObject({ decision: "decline", reasons: ["MISSING_DEPENDENCY", "MISSING_FRAMEWORK", "UNSUPPORTED_PACKAGE_MANAGER"] });
    expect(run(c, profile({ dependencies: { "@modelcontextprotocol/sdk": "1.29.9" }, frameworks: ["hono"] }))).toMatchObject({ decision: "build", reasons: ["DEPENDENCY_OUT_OF_RANGE"] });
    expect(run(c, profile())).toMatchObject({ decision: "build", reasons: ["MISSING_FRAMEWORK"] });
  });

  it("does not let a prerelease satisfy a range that does not name it", () => {
    expect(run(catalog(release()), profile({ dependencies: { "@modelcontextprotocol/sdk": "1.31.0-beta.1" } }))).toMatchObject({ decision: "build", reasons: ["DEPENDENCY_OUT_OF_RANGE"] });
  });

  it("builds on an expired release, which is in scope but not current", () => {
    expect(run(catalog(release({ expiresAt: "2026-10-01T00:00:00.000Z" })))).toMatchObject({ decision: "build", reasons: ["RELEASE_EXPIRED"] });
  });

  it("does not let manifest order flip decline and build between equally near profiles", () => {
    const twoProfiles = (order: "esm-first" | "cjs-first"): LoadedRelease => {
      const base = release();
      const esm = { ...base.release.supportedProfiles[0]!, moduleSystems: ["esm" as const], dependencies: { "@modelcontextprotocol/sdk": ">=1.30.0 <2" } };
      const cjs = { ...base.release.supportedProfiles[0]!, moduleSystems: ["cjs" as const], dependencies: { "@modelcontextprotocol/sdk": ">=1.40.0 <2" } };
      const r = { ...base.release, supportedProfiles: order === "esm-first" ? [esm, cjs] : [cjs, esm] };
      return { ...base, release: r, releaseDigest: releaseDigest(r) };
    };
    const cjsBuyer = profile({ moduleSystem: "cjs" });
    for (const order of ["esm-first", "cjs-first"] as const) {
      expect(run(catalog(twoProfiles(order)), cjsBuyer)).toMatchObject({ decision: "build", reasons: ["DEPENDENCY_OUT_OF_RANGE"] });
    }
  });

  it("counts distinct reason codes when choosing the nearest candidate", () => {
    const withProfile = (id: string, patch: Partial<CapabilityRelease["supportedProfiles"][number]>): LoadedRelease => {
      const base = release({ id });
      const r = { ...base.release, supportedProfiles: [{ ...base.release.supportedProfiles[0]!, ...patch }] };
      return { ...base, release: r, releaseDigest: releaseDigest(r) };
    };
    // Two missing dependencies are one distinct code, as near as one unsupported module system.
    const missingTwo = withProfile("missing-two", { dependencies: { "@modelcontextprotocol/sdk": ">=1.30.0 <2", hono: ">=4 <5" } });
    const cjsOnly = withProfile("cjs-only", { dependencies: {}, moduleSystems: ["cjs"] });
    const buyer = profile({ dependencies: {} });
    for (const releases of [[missingTwo, cjsOnly], [cjsOnly, missingTwo]]) {
      expect(run(catalog(...releases), buyer)).toMatchObject({ decision: "build", reasons: ["MISSING_DEPENDENCY"] });
    }
  });

  it("takes reasons from the nearest candidate", () => {
    const far = release({ id: "far", range: ">=5 <6", frameworks: ["hono"] });
    const near = release({ id: "near", range: ">=5 <6" });
    expect(run(catalog(far, near))).toMatchObject({ decision: "build", reasons: ["DEPENDENCY_OUT_OF_RANGE"] });
  });

  it("fails closed on invalid input instead of guessing", () => {
    expect(() => run(catalog(release()), { ...profile(), dependencies: { "@modelcontextprotocol/sdk": "^1.30.0" } })).toThrow();
  });
});

describe("resolve: properties", () => {
  const releasesArb = fc.array(
    fc.record({
      id: fc.constantFrom("alpha", "beta", "gamma"),
      version: fc.constantFrom("1.0.0", "1.1.0", "2.0.0", "1.0.0+bench-1"),
      price: fc.constantFrom("0", "100000", "250000", "300000", "300001"),
      evidence: fc.constantFrom<ProfileEvidence | null>(null, evidence(), evidence({ measuredAt: "2026-08-01T00:00:00.000Z", staleAfter: "2026-09-01T00:00:00.000Z" }), evidence({ expectedRawSavingUsdc: "500000" })),
      range: fc.constantFrom(">=1.30.0 <2", ">=1.0.0 <1.30.0", "^1.30.1"),
      frameworks: fc.constantFrom<Array<"hono" | "express">>([], ["hono"]),
    }),
    { minLength: 1, maxLength: 5 },
  ).map((options) => {
    const seen = new Set<string>();
    return options.map((o) => release(o)).filter((r) => (seen.has(r.dir) ? false : (seen.add(r.dir), true)));
  });

  const profileArb = fc.record({
    language: fc.constantFrom<"typescript" | "javascript">("typescript", "javascript"),
    major: fc.integer({ min: 18, max: 26 }),
    pm: fc.constantFrom<"npm" | "pnpm" | "yarn">("npm", "pnpm", "yarn"),
    module: fc.constantFrom<"esm" | "cjs">("esm", "cjs"),
    sdk: fc.option(fc.constantFrom("1.29.0", "1.30.0", "1.30.1", "1.40.0", "2.0.0"), { nil: undefined }),
    hono: fc.boolean(),
  }).map((p) =>
    profile({
      language: p.language,
      runtime: { name: "node", major: p.major },
      packageManager: { name: p.pm, lockfile: { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" }[p.pm] as never },
      moduleSystem: p.module,
      dependencies: p.sdk === undefined ? {} : { "@modelcontextprotocol/sdk": p.sdk },
      frameworks: p.hono ? ["hono"] : [],
    }),
  );

  it("is deterministic and independent of catalog order", () => {
    fc.assert(
      fc.property(releasesArb, profileArb, (releases, p) => {
        const a = run(catalog(...releases), p);
        expect(run(catalog(...releases), p)).toEqual(a);
        expect(run(catalog(...[...releases].reverse()), p)).toEqual(a);
      }),
      { numRuns: 300 },
    );
  });

  it("ignores dependencies outside the interest set", () => {
    fc.assert(
      fc.property(releasesArb, profileArb, fc.dictionary(fc.constantFrom("left-pad", "internal-thing", "zod"), fc.constantFrom("1.0.0", "3.25.0")), (releases, p, extra) => {
        const strip = (x: ReturnType<typeof run>) => ({ ...x, profileDigest: "" });
        const withExtra = profile({ ...p, dependencies: { ...extra, ...p.dependencies } });
        expect(strip(run(catalog(...releases), withExtra))).toEqual(strip(run(catalog(...releases), p)));
      }),
      { numRuns: 300 },
    );
  });

  it("reuses only a profile that passes every check, and offers exactly when it is sellable", () => {
    fc.assert(
      fc.property(releasesArb, profileArb, (releases, p) => {
        const index = buildIndex(catalog(...releases));
        const preview = resolve({ task, profile: p }, index, CTX);
        if (preview.decision !== "reuse") {
          for (const r of index.releases) for (const indexed of r.profiles) expect(checkProfile(r, indexed, p, NOW)).not.toEqual([]);
          return;
        }
        const matched = index.byDigest.get(preview.release.releaseDigest);
        const indexed = matched?.profiles[preview.release.profileIndex];
        expect(matched && indexed && checkProfile(matched, indexed, p, NOW)).toEqual([]);
        expect(preview.offer === null).toBe(preview.reasons.length > 0);
      }),
      { numRuns: 500 },
    );
  });
});

describe("resolve: cost", () => {
  it("tests each dependency range at most once per candidate profile and parses nothing", () => {
    const releases = Array.from({ length: 40 }, (_, i) => release({ id: "gating", version: `1.${i}.0` }));
    const index = buildIndex(catalog(...releases));
    const test = vi.spyOn(Range.prototype, "test");
    const parse = vi.spyOn(Range.prototype, "parseRange");
    resolve({ task, profile: profile() }, index, CTX);
    expect(test.mock.calls.length).toBe(40);
    expect(parse).not.toHaveBeenCalled();
  });
});
