import { CatalogView, type DemandView, type ResolutionView, StatusView, summarizeRelease } from "@lemma/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ASSET, checkDist } from "../scripts/check-dist.mjs";
import { fetchView } from "../src/api.js";
import { App, Shown } from "../src/App.js";
import { percent } from "../src/format.js";
import { sourceUrl } from "../src/links.js";
import { parseRoute } from "../src/routes.js";
import { Catalog } from "../src/views/Catalog.js";
import { Demand } from "../src/views/Demand.js";
import { Evidence } from "../src/views/Evidence.js";
import { Resolution } from "../src/views/Resolution.js";
import { Status } from "../src/views/Status.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const hex = (b: string) => `0x${b.repeat(32)}`;
const release = {
  schemaVersion: "1" as const,
  releaseId: "gating",
  version: "1.0.0+provisional-1",
  capability: "mcp-server.add-payment-gating" as const,
  title: '<img src=x onerror="alert(1)"> Payment gating',
  supportedProfiles: [
    {
      languages: ["typescript" as const],
      nodeMajor: { min: 22, max: 24 },
      packageManagers: ["npm" as const],
      moduleSystems: ["esm" as const],
      dependencies: { "@modelcontextprotocol/sdk": ">=1.30.0 <2" },
      frameworks: [],
      evidence: {
        benchmarkVersion: "provisional-1",
        runSetDigest: hex("12"),
        fixtureProfileDigest: hex("13"),
        model: "example-model-1",
        measuredAt: "2026-09-20T00:00:00.000Z",
        staleAfter: "2026-12-20T00:00:00.000Z",
        runs: { control: 3, treatment: 1 },
        passed: { control: 3, treatment: 1 },
        controlMedianCostUsdc: "2500000",
        expectedRawSavingUsdc: "1000000",
        expectedTokenSaving: 420000,
      },
    },
  ],
  provenance: { repository: "https://github.com/coinbase/x402", commit: "dd927a26cfefc98c24b3ec38b3a8f204dad0c60d", spdxLicense: "Apache-2.0" },
  payloadDigest: hex("11"),
  acceptanceRecipe: { script: "test", args: [], timeoutSec: 300, env: ["CI" as const] },
  price: "250000",
  provider: { payTo: "0x00000000000000000000000000000000000000a1" },
  warranty: { claimWindowHours: 72 },
  publishedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2027-03-31T00:00:00.000Z",
};
const catalog = CatalogView.parse({
  schemaVersion: "1",
  catalogDigest: hex("88"),
  generatedAt: NOW.toISOString(),
  economics: { status: "measured", chainCostUsdc: "10000", priceFloorUsdc: "100000" },
  releases: [summarizeRelease({ release, releaseDigest: hex("55"), baseReleaseDigest: hex("56"), provisional: true }, { chainCostAtomic: 10_000n }, NOW)],
});

describe("views render only from read models", () => {
  it("shows the catalog with labels and prices, escaping catalog prose", () => {
    const html = renderToStaticMarkup(<Catalog view={catalog} />);
    expect(html).toContain("probe (provisional, testnet only)");
    expect(html).toContain("0.25 USDC");
    expect(html).toContain("29.60 %");
    expect(html).toContain("sellable");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('href="https://github.com/coinbase/x402/tree/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("shows evidence, demand, status and a resolution", () => {
    const evidence = renderToStaticMarkup(<Evidence view={catalog} />);
    expect(evidence).toContain("provisional-1");
    expect(evidence).toContain("Their saving is optimistic");
    const demand: DemandView = { minProfiles: 5, buckets: [{ day: "2026-09-30", profiles: 7, sources: 6, key: { capability: "node-service.add-payment-facilitator", decision: "build", release: null, profileIndex: null, reasons: ["NO_RELEASE_FOR_CAPABILITY"], offer: false, class: { packageManager: "npm", moduleSystem: "esm", nodeMajor: 22, frameworks: [] } } }] };
    expect(renderToStaticMarkup(<Demand view={demand} />)).toContain("no release exists for this capability yet");
    const status = StatusView.parse({ schemaVersion: "1", status: "ok", network: "eip155:421614", catalogDigest: hex("88"), releases: 2, paidTools: false, provisionalEvidence: true, store: "memory", economics: "placeholder" });
    const statusHtml = renderToStaticMarkup(<Status view={status} />);
    expect(statusHtml).toContain("Arbitrum Sepolia (testnet)");
    expect(statusHtml).toContain("placeholder: nothing can be sold");
    expect(renderToStaticMarkup(<Status view={{ ...status, status: "degraded" }} />)).toContain("degraded");
    const resolution: ResolutionView = {
      resolutionId: hex("aa"),
      state: "settled",
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: hex("55"), profileIndex: 0 },
      payloadDigest: hex("11"),
      terms: { scheme: "exact", network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdAt: NOW.toISOString(),
      receipt: { outcome: "passed", verified: false },
    };
    const resolutionHtml = renderToStaticMarkup(<Resolution view={resolution} />);
    expect(resolutionHtml).toContain("paid and delivered");
    expect(resolutionHtml).toContain("unverified");
    expect(renderToStaticMarkup(<Resolution view={{ ...resolution, release: { ...resolution.release, version: "1.0.0+provisional-1" } }} />)).toContain("provisional (testnet only)");
  });

  it("renders the shell with its testnet banner, and loading and error states", () => {
    const shell = renderToStaticMarkup(<App initialHash="#/" />);
    expect(shell).toContain("Testnet");
    // The setup uses the bridge as built from a checkout; nothing installs a lemma-mcp command yet.
    expect(shell).not.toContain("lemma-mcp");
    expect(shell).toContain("apps/bridge/dist/main.js");
    expect(shell).toContain('aria-current="page"');
    expect(renderToStaticMarkup(<Shown loaded={{ state: "error", message: "<b>bad</b>" }} render={() => null} />)).toContain("&lt;b&gt;bad&lt;/b&gt;");
  });
});

describe("safety helpers", () => {
  it("links only to a GitHub repository at a full commit", () => {
    expect(sourceUrl({ repository: "https://github.com/a/b", commit: "0".repeat(40) })).toBe(`https://github.com/a/b/tree/${"0".repeat(40)}`);
    for (const bad of [
      { repository: "javascript:alert(1)", commit: "0".repeat(40) },
      { repository: "https://github.com/a/b/../../evil", commit: "0".repeat(40) },
      { repository: "https://evil.example/a/b", commit: "0".repeat(40) },
      { repository: "https://github.com/a/b", commit: "main" },
      { repository: "https://github.com/../b", commit: "0".repeat(40) },
    ]) expect(sourceUrl(bad)).toBeNull();
  });

  it("routes by fragment and refuses malformed resolution ids", () => {
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("#/catalog")).toEqual({ view: "catalog" });
    expect(parseRoute(`#/resolutions/${hex("ab")}`)).toEqual({ view: "resolution", id: hex("ab") });
    expect(parseRoute("#/resolutions/../../api")).toEqual({ view: "not-found" });
    expect(parseRoute("#/resolutions")).toEqual({ view: "resolution", id: null });
  });

  it("never renders an answer that does not match its read model", async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    expect(await fetchView("/api/v1/status", StatusView, answer(200, { status: "ok" }))).toMatchObject({ state: "error" });
    expect(await fetchView("/api/v1/status", StatusView, answer(429, {}))).toMatchObject({ state: "error", message: expect.stringContaining("Too many") });
    expect(await fetchView("/api/v1/catalog", CatalogView, answer(200, catalog))).toMatchObject({ state: "ready" });
  });

  it("formats basis points in integer math", () => {
    expect(percent("2960")).toBe("29.60 %");
    expect(percent("-1")).toBe("-0.01 %");
    expect(percent(5n)).toBe("0.05 %");
  });
});

describe("the dist check", () => {
  const dists: string[] = [];
  const dist = (html: string, assets: Record<string, string> = { "index-a1.js": "console.log(1);\n", "index-a1.css": "body{}\n" }) => {
    const dir = mkdtempSync(join(tmpdir(), "lemma-dist-"));
    dists.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), html);
    for (const [name, text] of Object.entries(assets)) writeFileSync(join(dir, "assets", name), text);
    return dir;
  };
  const good = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-a1.css"></head><body><div id="root"></div></body></html>';

  it("passes a build the server can serve under its CSP", () => {
    expect(checkDist(dist(good))).toEqual([]);
  });

  it("catches what the CSP would refuse or the server would not serve", () => {
    const cases: Array<[string, string, Record<string, string>?]> = [
      ["protocol-relative stylesheet", good.replace("</head>", '<link rel="stylesheet" href="//fonts.example/css"></head>')],
      ["single-quoted data URI", good.replace("</head>", "<link rel='icon' href='data:image/svg+xml,x'></head>")],
      ["inline handler", good.replace("<body>", '<body onload="x()">')],
      ["inline script", good.replace("</head>", "<script>alert(1)</script></head>")],
      ["missing asset", good.replace("index-a1.css", "index-zz.css")],
      ["inline source map", good, { "index-a1.js": "x;\n//# sourceMappingURL=data:application/json;base64,e30=", "index-a1.css": "body{}" }],
      ["css import", good, { "index-a1.js": "x", "index-a1.css": "@import url(https://fonts.example/a.css);" }],
      ["css url to data", good, { "index-a1.js": "x", "index-a1.css": "a{background:url(data:image/png;base64,AA==)}" }],
      ["stray file", good, { "index-a1.js": "x", "index-a1.css": "b{}", "index-a1.js.map": "{}" }],
    ];
    for (const [name, html, assets] of cases) expect(checkDist(dist(html, assets)), name).not.toEqual([]);
    for (const dir of dists.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the server's asset-name rule", () => {
    expect(ASSET.source).toBe("^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(js|css|svg|png|ico|woff2)$");
  });
});
