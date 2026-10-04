import { CatalogView, type DemandView, type ResolutionView, StatusView, summarizeRelease } from "@lemma/core";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ASSET, checkDist } from "../scripts/check-dist.mjs";
import { fetchView } from "../src/api.js";
import { App, Shown } from "../src/App.js";
import { COMPATIBILITY_EXPLAINED } from "../src/components/Compatibility.js";
import { percent, thousandths } from "../src/format.js";
import { sourceUrl } from "../src/links.js";
import { parseRoute } from "../src/routes.js";
import { Catalog } from "../src/views/Catalog.js";
import { Demand } from "../src/views/Demand.js";
import { Benchmark } from "../src/views/Benchmark.js";
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
  releases: [
    // The server's confidence for a one-run probe that passed (vectors.json, "prior only: a one-run probe").
    summarizeRelease({ release, releaseDigest: hex("55"), baseReleaseDigest: hex("56"), provisional: true }, { chainCostAtomic: 10_000n }, NOW, new Map([[0, { confidenceBps: 2698, effectiveNMilli: "1000", outcomes: 0, source: "benchmark" as const, buyers: null }]])),
  ],
});

describe("views render only from read models", () => {
  it("shows the catalog with labels and prices, and never renders catalog prose", () => {
    const html = renderToStaticMarkup(<Catalog view={catalog} />);
    expect(html).toContain('<span class="badge warn">Early estimate</span>');
    expect(html).toContain("0.25 USDC");
    expect(html).toContain("29.60 %");
    expect(html).toContain('<span class="badge ok">For sale</span>');
    // The release's own title is catalog prose: the card names the capability instead.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Payment gating");
    expect(html).toContain('href="https://github.com/coinbase/x402/tree/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("<dt>Score</dt>");
    expect(html).toContain("26.98 %");
    // The starting score comes from a short probe here, and the basis says so.
    expect(html).toContain("(from the early estimate)");
    expect(html).toContain("90% lower bound");
  });

  it("shows compatibility confidence on the catalog and the proof page, with what it rests on", () => {
    const withOutcomes = CatalogView.parse({
      ...catalog,
      releases: [
        summarizeRelease({ release, releaseDigest: hex("55"), baseReleaseDigest: hex("56"), provisional: true }, { chainCostAtomic: 10_000n }, NOW, new Map([[0, { confidenceBps: 7337, effectiveNMilli: "21727", outcomes: 4, source: "benchmark+outcomes" as const, buyers: null }]])),
      ],
    });
    for (const html of [renderToStaticMarkup(<Catalog view={withOutcomes} />), renderToStaticMarkup(<Benchmark view={withOutcomes} />)]) {
      expect(html).toContain("73.37 %");
      expect(html).toContain("early estimate and 4 results");
    }
    expect(renderToStaticMarkup(<Catalog view={withOutcomes} />)).toContain(COMPATIBILITY_EXPLAINED.replaceAll("'", "&#x27;"));
    expect(renderToStaticMarkup(<Benchmark view={withOutcomes} />)).toContain(">21.727<");
    // Frozen-benchmark evidence: the prior is the benchmark's, with nothing provisional about it.
    const frozen = { ...release, version: "1.0.0+bench-1", supportedProfiles: release.supportedProfiles.map((p) => ({ ...p, evidence: { ...p.evidence, benchmarkVersion: "bench-1" } })) };
    const benchmarked = CatalogView.parse({
      ...catalog,
      releases: [summarizeRelease({ release: frozen, releaseDigest: hex("58"), baseReleaseDigest: hex("56"), provisional: false }, { chainCostAtomic: 10_000n }, NOW, new Map([[0, { confidenceBps: 2698, effectiveNMilli: "1000", outcomes: 0, source: "benchmark" as const, buyers: null }]]))],
    });
    for (const html of [renderToStaticMarkup(<Catalog view={benchmarked} />), renderToStaticMarkup(<Benchmark view={benchmarked} />)]) {
      expect(html).toContain("from the benchmark");
      expect(html).not.toContain("from the early estimate");
      expect(html).not.toContain(">Early estimate</span>");
    }
    // No evidence and no result: no score in the catalog, and no score table on the proof page.
    const none = CatalogView.parse({
      ...catalog,
      releases: [summarizeRelease({ release: { ...release, supportedProfiles: release.supportedProfiles.map((p) => ({ ...p, evidence: null })) }, releaseDigest: hex("55"), baseReleaseDigest: hex("56"), provisional: true }, { chainCostAtomic: 0n }, NOW)],
    });
    expect(renderToStaticMarkup(<Benchmark view={none} />)).not.toContain("<th scope=\"col\" class=\"num\">Score</th>");
    expect(renderToStaticMarkup(<Catalog view={none} />)).not.toContain("<dt>Score</dt>");
  });

  it("shows evidence, demand, status and a resolution", () => {
    const evidence = renderToStaticMarkup(<Benchmark view={catalog} />);
    expect(evidence).toContain("provisional-1");
    expect(evidence).toContain("It is more optimistic than the full benchmark.");
    expect(evidence).toContain("score 26.98 % (from the early estimate)");
    const demand: DemandView = { minProfiles: 5, buckets: [{ day: "2026-09-30", profiles: 7, sources: 6, buyers: 3, key: { capability: "node-service.add-payment-facilitator", decision: "build", release: null, profileIndex: null, reasons: ["NO_RELEASE_FOR_CAPABILITY"], offer: false, class: { packageManager: "npm", moduleSystem: "esm", nodeMajor: 22, frameworks: [] } } }] };
    const demandHtml = renderToStaticMarkup(<Demand view={demand} />);
    expect(demandHtml).toContain("no release for this capability");
    expect(demandHtml).toContain("Buyer-days");
    expect(demandHtml).toContain('<td class="num">3</td>');
    const status = StatusView.parse({ schemaVersion: "1", status: "ok", network: "eip155:421614", catalogDigest: hex("88"), releases: 2, paidTools: false, provisionalEvidence: true, store: "memory", economics: "placeholder", chain: { explorer: "https://sepolia.arbiscan.io", usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", registry: null, engine: null, identityRegistry: null, reputationRegistry: null, providerAgentId: null } });
    const statusHtml = renderToStaticMarkup(<Status view={status} />);
    expect(statusHtml).toContain("<dd>Arbitrum Sepolia</dd>");
    expect(statusHtml).toContain("Free previews");
    expect(statusHtml).toContain('<span class="badge warn">loaded</span>');
    expect(renderToStaticMarkup(<Status view={{ ...status, status: "degraded" }} />)).toContain("<dd>Degraded<span class=\"stat-note\">the database is not answering, so purchases may fail</span></dd>");
    const resolution: ResolutionView = {
      resolutionId: hex("aa"),
      state: "settled",
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: hex("55"), profileIndex: 0 },
      payloadDigest: hex("11"),
      terms: { scheme: "exact", network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdOn: "2026-10-01",
      receipt: { outcome: "passed", verified: false },
      warranty: null,
    };
    const resolutionHtml = renderToStaticMarkup(<Resolution view={resolution} explorer={status.chain.explorer} />);
    expect(resolutionHtml).toContain("paid and delivered");
    expect(resolutionHtml).toContain("unverified");
    expect(renderToStaticMarkup(<Resolution view={{ ...resolution, release: { ...resolution.release, version: "1.0.0+provisional-1" } }} explorer={null} />)).toContain('<span class="badge warn">Early estimate</span>');
  });

  it("renders the shell with its network badge, a theme switch, a collapsed phone menu, and loading and error states", () => {
    const shell = renderToStaticMarkup(<App initialHash="#/" />);
    expect(shell).toContain('<span class="network-dot" aria-hidden="true"></span>Arbitrum Sepolia</a>');
    expect(shell).toContain('class="theme-btn"');
    expect(shell).toContain('aria-current="page"');
    expect(shell).toContain('aria-expanded="false"');
    expect(shell).toContain('class="wordmark"');
    for (const label of ["How it works", "Catalog", "Purchases", "Benchmark", "Connect your agent", "Recorded purchases", "Demand", "Status", "What to trust", "GitHub"]) expect(shell).toContain(label);
    expect(shell).not.toContain('href="#/resolutions"');
    expect(renderToStaticMarkup(<Shown loaded={{ state: "loading" }} render={() => null} />)).toContain("Loading");
    // Connecting installs the bridge this server serves; the page's earlier address still lands there.
    const connect = renderToStaticMarkup(<App initialHash="#/setup" />);
    expect(connect).toContain("/dl/lemma-mcp-0.1.0.tgz");
    expect(connect).not.toContain("apps/bridge/dist/main.js");
    expect(connect).toContain('href="#/connect" aria-current="page"');
    // A resolution waits for its read model; its explorer links wait for the status.
    expect(renderToStaticMarkup(<App initialHash={`#/resolutions/${hex("ab")}`} />)).toContain("Loading");
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
    expect(parseRoute("")).toEqual({ view: "overview", anchor: null });
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

  it("formats thousandths exactly, without trailing zeros", () => {
    expect(thousandths("0")).toBe("0");
    expect(thousandths("3000")).toBe("3");
    expect(thousandths("21727")).toBe("21.727");
    expect(thousandths("2500")).toBe("2.5");
    expect(thousandths("1001253000")).toBe("1,001,253");
    expect(thousandths("18446744073709551615")).toBe("18,446,744,073,709,551.615");
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
      ["favicon outside /assets/", good.replace("</head>", '<link rel="icon" href="/favicon.svg"></head>')],
      ["foreign font", good, { "index-a1.js": "x", "index-a1.css": "@font-face{font-family:x;src:url(https://fonts.example/x.woff2)}" }],
      ["wasm file", good, { "index-a1.js": "x", "index-a1.css": "b{}", "engine-a1.wasm": "\u0000asm" }],
      ["wasm instantiated", good, { "index-a1.js": "WebAssembly.instantiate(bytes)", "index-a1.css": "b{}" }],
      ["wasm inlined", good, { "index-a1.js": 'const engine = "AGFzbQEAAAA=";', "index-a1.css": "b{}" }],
    ];
    for (const [name, html, assets] of cases) expect(checkDist(dist(html, assets)), name).not.toEqual([]);
    for (const dir of dists.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the compatibility engine out of the browser", () => {
    // @lemma/confidence loads wasm with node:fs; the dashboard gets its numbers from the catalog read model.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("@lemma/confidence");
    const sources = readdirSync(new URL("../src", import.meta.url), { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const file of sources) expect(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), file).not.toContain("@lemma/confidence");
  });

  it("uses the server's asset-name rule", () => {
    expect(ASSET.source).toBe("^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(js|css|svg|png|ico|woff2)$");
  });
});
