import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Outcome, fold, unixSeconds } from "@lemma/confidence";
import { CatalogView, DemandView, StatusView } from "@lemma/core";
import { afterEach, describe, expect, it } from "vitest";

import { ASSET, CompatibilityReader, DASHBOARD_CSP, type Logger, MemoryStore, NO_OUTCOMES, type OutcomeSource, ResolutionService, silentLogger } from "../src/index.js";
import { NOW, PROVIDER, app, committedIndex, config, sellableIndex } from "./helpers.js";

const DAY = 86_400n;
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function webRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lemma-web-"));
  temps.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), '<!doctype html><script type="module" src="/assets/index-abc.js"></script><div id="root"></div>');
  writeFileSync(join(root, "assets", "index-abc.js"), "console.log(1);\n");
  writeFileSync(join(root, "assets", "index-abc.css"), "body{}\n");
  writeFileSync(join(root, "secret.txt"), "not for the web\n");
  symlinkSync("/etc/hostname", join(root, "assets", "linked.js"));
  return root;
}

describe("read models", () => {
  const economics = { status: "measured" as const, chainCostAtomic: "10000", priceFloorAtomic: "100000" };

  it("serves the catalog view with what each profile promises at the list price", async () => {
    const res = await app({ index: sellableIndex(), economics, config: config({ PROVIDER_ADDRESS: PROVIDER }) }).request("/api/v1/catalog");
    expect(res.status).toBe(200);
    const view = CatalogView.parse(await res.json());
    expect(view.economics).toEqual({ status: "measured", chainCostUsdc: "10000", priceFloorUsdc: "100000" });
    // (1.00 - 0.25 - 0.01) / 2.50 = 29.6 %
    expect(view.releases[0]?.profiles[0]).toMatchObject({ label: "benchmarked", blocker: null, allInReductionBps: "2960", maxPriceUsdc: "300000" });
    expect(JSON.stringify(view)).not.toContain("payTo");
  });

  it("reads an unmeasured economics as a placeholder", async () => {
    const view = CatalogView.parse(await (await app().request("/api/v1/catalog")).json());
    expect(view.economics.status).toBe("placeholder");
    expect(view.releases.every((r) => r.profiles.every((p) => p.label === "none"))).toBe(true);
    // No evidence and no outcomes: nothing to be confident about.
    expect(view.releases.every((r) => r.profiles.every((p) => p.compatibility === null))).toBe(true);
  });

  it("scores compatibility from the benchmark prior, and adds finalized outcomes from the outcome source", async () => {
    const index = sellableIndex();
    const digest = index.releases[0]!.releaseDigest;
    const catalog = async (outcomes?: OutcomeSource, clock = () => NOW) =>
      CatalogView.parse(await (await app({ index, economics, clock, outcomes, config: config({ PROVIDER_ADDRESS: PROVIDER }) }).request("/api/v1/catalog")).json()).releases[0]?.profiles[0]?.compatibility;

    // The evidence's treatment arm passed 3 of 3: the prior alone.
    expect(await catalog()).toEqual({ confidenceBps: 5258, effectiveNMilli: "3000", outcomes: 0, source: "benchmark" });

    const now = unixSeconds(NOW);
    const outcomes: Outcome[] = [
      { passed: true, weightBps: 10_000, at: now - 3n * DAY },
      { passed: false, weightBps: 10_000, at: now - 40n * DAY },
      { passed: true, weightBps: 5_000, at: now - DAY },
    ];
    const source: OutcomeSource = { outcomesFor: (d, i) => (d === digest && i === 0 ? outcomes : NO_OUTCOMES.outcomesFor(d, i)) };
    const expected = fold({ passes: 3, failures: 0 }, outcomes, now);
    expect(await catalog(source)).toEqual({ confidenceBps: expected.confidenceBps, effectiveNMilli: expected.effectiveNMilli.toString(), outcomes: 3, source: "benchmark+outcomes" });
    // Read later, the same outcomes weigh less: the score moves with the request's clock.
    const later = new Date(NOW.getTime() + 90 * 86_400_000);
    const aged = fold({ passes: 3, failures: 0 }, outcomes, unixSeconds(later));
    expect((await catalog(source, () => later))?.effectiveNMilli).toBe(aged.effectiveNMilli.toString());
    expect(aged.effectiveNMilli).toBeLessThan(expected.effectiveNMilli);
  });

  it("scores a profile without evidence from its outcomes alone", async () => {
    const outcomes: Outcome[] = [{ passed: true, weightBps: 10_000, at: unixSeconds(NOW) }];
    const view = CatalogView.parse(await (await app({ outcomes: { outcomesFor: (_, i) => (i === 0 ? outcomes : []) } }).request("/api/v1/catalog")).json());
    for (const release of view.releases) {
      expect(release.profiles[0]?.compatibility).toEqual({ confidenceBps: 2698, effectiveNMilli: "1000", outcomes: 1, source: "outcomes" });
    }
  });

  it("keeps serving the catalog when one profile's outcomes cannot be read, and logs that profile", async () => {
    const index = committedIndex();
    const [broken, healthy] = index.releases.map((r) => r.releaseDigest);
    const at = unixSeconds(NOW);
    const good: Outcome[] = [{ passed: true, weightBps: 10_000, at }];
    const cases: Array<[OutcomeSource, string]> = [
      // An outcome the engine cannot represent (above a full outcome)...
      [{ outcomesFor: (d) => (d === broken ? [{ passed: true, weightBps: 20_000, at }] : good) }, "RangeError"],
      // ...and a source that fails outright.
      [
        {
          outcomesFor: (d) => {
            if (d === broken) throw new Error("snapshot unavailable");
            return good;
          },
        },
        "Error",
      ],
    ];
    for (const [outcomes, error] of cases) {
      const logged: unknown[] = [];
      const logger: Logger = { log: (level, event, fields) => logged.push([level, event, fields]) };
      const res = await app({ index, outcomes, logger }).request("/api/v1/catalog");
      expect(res.status).toBe(200);
      const view = CatalogView.parse(await res.json());
      const confidenceOf = (digest: string | undefined) => view.releases.find((r) => r.releaseDigest === digest)?.profiles[0]?.compatibility;
      // Only the broken profile loses its confidence; the other release keeps its own.
      expect(confidenceOf(broken)).toBeNull();
      expect(confidenceOf(healthy)).toEqual({ confidenceBps: 2698, effectiveNMilli: "1000", outcomes: 1, source: "outcomes" });
      expect(logged).toEqual([["error", "catalog.compatibility_failed", { releaseDigest: broken, profileIndex: 0, error }]]);
    }
  });

  it("folds a frozen array of frozen outcomes once and scores it at every read", () => {
    const reader = new CompatibilityReader(NO_OUTCOMES);
    const outcomes = Object.freeze([Object.freeze({ passed: true, weightBps: 10_000, at: unixSeconds(NOW) })]);
    // Folding reads the outcome; scoring remembered sums does not.
    let reads = 0;
    const counted = new Proxy(outcomes, {
      get: (target, key, receiver) => {
        if (key === "0") reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(reader.forProfile(null, counted, NOW)?.effectiveNMilli).toBe("1000");
    const folded = reads;
    expect(folded).toBeGreaterThan(0);
    // One half-life later the same sums weigh half an outcome, and nothing was folded again.
    expect(reader.forProfile(null, counted, new Date(NOW.getTime() + 30 * 86_400_000))?.effectiveNMilli).toBe("500");
    expect(reads).toBe(folded);
  });

  it("folds any other array again at every read, so a source that appends in place is never stale", () => {
    const reader = new CompatibilityReader(NO_OUTCOMES);
    const at = unixSeconds(NOW);
    const growing: Outcome[] = [{ passed: true, weightBps: 10_000, at }];
    expect(reader.forProfile(null, growing, NOW)).toMatchObject({ effectiveNMilli: "1000", outcomes: 1 });
    growing.push({ passed: false, weightBps: 10_000, at });
    expect(reader.forProfile(null, growing, NOW)).toMatchObject({ effectiveNMilli: "2000", outcomes: 2 });
    // A frozen array of outcomes that can still change is not remembered either.
    const shallow = Object.freeze([{ passed: true, weightBps: 10_000, at }]);
    expect(reader.forProfile(null, shallow, NOW)?.effectiveNMilli).toBe("1000");
    shallow[0]!.weightBps = 5_000;
    expect(reader.forProfile(null, shallow, NOW)?.effectiveNMilli).toBe("500");
  });

  it("serves the status view", async () => {
    const view = StatusView.parse(await (await app({ economics, storeKind: "postgres" }).request("/api/v1/status")).json());
    expect(view).toMatchObject({ status: "ok", network: "eip155:421614", paidTools: false, provisionalEvidence: false, store: "postgres", economics: "measured" });
  });

  it("reports purchases as enabled only when paid tools are actually registered", async () => {
    const registrar = () => undefined;
    expect(StatusView.parse(await (await app({ registerPaidTools: registrar }).request("/api/v1/status")).json()).paidTools).toBe(false);
    const on = app({ registerPaidTools: registrar, config: config({ PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER }) });
    expect(StatusView.parse(await (await on.request("/api/v1/status")).json()).paidTools).toBe(true);
  });

  it("reports a store that does not answer as degraded, and never caches that", async () => {
    for (const store of [
      new (class extends MemoryStore {
        override async ping(): Promise<void> {
          throw new Error("down");
        }
      })(),
      new (class extends MemoryStore {
        override ping(): Promise<void> {
          return new Promise(() => undefined);
        }
      })(),
    ]) {
      const res = await app({ store, service: new ResolutionService(store, () => NOW, silentLogger) }).request("/api/v1/status");
      expect(StatusView.parse(await res.json()).status).toBe("degraded");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("never caches an error, even from a route that sets a cache header", async () => {
    const store = new (class extends MemoryStore {
      override async demandBuckets(): Promise<never> {
        throw new Error("database down");
      }
    })();
    const res = await app({ store, service: new ResolutionService(store, () => NOW, silentLogger) }).request("/api/v1/demand");
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await app().request("/nowhere")).headers.get("cache-control")).toBe("no-store");
  });

  it("publishes demand buckets as parsed keys, only past the k-anonymity floor", async () => {
    const store = new MemoryStore({ newSalt: () => "salt" });
    const key = JSON.stringify({ capability: "mcp-server.add-payment-gating", class: { frameworks: [], moduleSystem: "esm", nodeMajor: 22, packageManager: "npm" }, decision: "build", offer: false, profileIndex: null, reasons: ["MISSING_DEPENDENCY"], release: null });
    for (let i = 0; i < 5; i++) await store.recordDemand("2026-09-30", key, `0x${String(i).repeat(64)}`, `10.0.0.${i}`);
    await store.recordDemand("2026-09-30", "not json", `0x${"9".repeat(64)}`, "10.0.0.9");
    for (let i = 0; i < 5; i++) await store.recordDemand("2026-09-30", "not json", `0x${String(i).repeat(64)}`, `10.0.0.${i}`);
    await store.recordDemand("2026-09-30", key.replace("22", "20"), `0x${"1".repeat(64)}`, "10.0.0.1");
    await store.closeDemandDaysBefore("2026-10-01");
    const service = new ResolutionService(store, () => NOW, silentLogger);
    const view = DemandView.parse(await (await app({ store, service }).request("/api/v1/demand")).json());
    expect(view.buckets).toEqual([{ day: "2026-09-30", profiles: 5, sources: 5, key: expect.objectContaining({ decision: "build", reasons: ["MISSING_DEPENDENCY"] }) }]);
  });
});

describe("the dashboard", () => {
  it("serves the page and its hashed assets under the dashboard policy", async () => {
    const a = app({ webRoot: webRoot() });
    const page = await a.request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const script = await a.request("/assets/index-abc.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");
    expect(DASHBOARD_CSP).not.toContain("unsafe");
    expect(DASHBOARD_CSP).toContain("font-src 'self'");
    // apps/web/scripts/check-dist.mjs pins the same rule.
    expect(ASSET.source).toBe("^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(js|css|svg|png|ico|woff2)$");
  });

  it("serves nothing but allowlisted asset names, and never through a link", async () => {
    const a = app({ webRoot: webRoot() });
    for (const path of ["/assets/linked.js", "/assets/..%2Fsecret.txt", "/assets/%2e%2e/secret.txt", "/secret.txt", "/assets/missing.js", "/assets/index-abc.js.map"]) {
      expect((await a.request(path)).status, path).toBe(404);
    }
  });

  it("keeps a no-content policy on the API", async () => {
    const res = await app({ webRoot: webRoot() }).request("/api/v1/interest");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("serves no page when the dashboard is not built", async () => {
    expect((await app().request("/")).status).toBe(404);
  });
});
