import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CatalogView, DemandView, StatusView } from "@lemma/core";
import { afterEach, describe, expect, it } from "vitest";

import { ASSET, DASHBOARD_CSP, MemoryStore, ResolutionService, silentLogger } from "../src/index.js";
import { NOW, PROVIDER, app, config, sellableIndex } from "./helpers.js";

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
