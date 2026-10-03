import { ARBITRUM_SEPOLIA_USDC, CatalogView, type DemandView, type ResolutionView, StatusView, WarrantyView, summarizeRelease } from "@lemma/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WORKED_EXAMPLE, evaluatePricing } from "../src/calculator.js";
import { CostComparison } from "../src/components/CostChart.js";
import { Hash } from "../src/components/copy.js";
import { Logo, LogoMark, MarkMono } from "../src/components/Logo.js";
import { usdcAmount } from "../src/format.js";
import { explorerAddressUrl, explorerName, explorerTxUrl } from "../src/links.js";
import { parseRoute, titleFor } from "../src/routes.js";
import { Catalog } from "../src/views/Catalog.js";
import { Demand } from "../src/views/Demand.js";
import { Evidence } from "../src/views/Evidence.js";
import { Overview } from "../src/views/Overview.js";
import { PricingCalculator } from "../src/views/PricingCalculator.js";
import { Resolution, ResolutionLookup } from "../src/views/Resolution.js";
import { Setup, serverOrigin } from "../src/views/Setup.js";
import { Status } from "../src/views/Status.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const hex = (b: string) => `0x${b.repeat(32)}`;
const ARBISCAN = "https://sepolia.arbiscan.io";

/** A release shaped like the committed skeletons: previewable, never sold (no evidence, price 0). */
const skeleton = {
  schemaVersion: "1" as const,
  releaseId: "mcp-server-payment-gating",
  version: "0.1.0-skeleton",
  capability: "mcp-server.add-payment-gating" as const,
  title: "Skeleton: x402 payment gating for a TypeScript MCP server",
  supportedProfiles: [
    {
      languages: ["typescript" as const],
      nodeMajor: { min: 22, max: 24 },
      packageManagers: ["npm" as const, "pnpm" as const],
      moduleSystems: ["esm" as const],
      dependencies: { "@modelcontextprotocol/sdk": ">=1.30.0 <2" },
      frameworks: [],
      evidence: null,
    },
  ],
  provenance: { repository: "https://github.com/coinbase/x402", commit: "dd927a26cfefc98c24b3ec38b3a8f204dad0c60d", spdxLicense: "Apache-2.0" },
  payloadDigest: hex("11"),
  acceptanceRecipe: { script: "test", args: [], timeoutSec: 300, env: ["CI" as const] },
  price: "0",
  provider: { payTo: "0x0000000000000000000000000000000000000000" },
  warranty: { claimWindowHours: 72 },
  publishedAt: "2026-09-25T00:00:00.000Z",
  expiresAt: "2027-03-31T00:00:00.000Z",
};

const previewOnly = CatalogView.parse({
  schemaVersion: "1",
  catalogDigest: hex("88"),
  generatedAt: NOW.toISOString(),
  economics: { status: "placeholder", chainCostUsdc: "0", priceFloorUsdc: "0" },
  releases: [summarizeRelease({ release: skeleton, releaseDigest: hex("55"), baseReleaseDigest: hex("56"), provisional: false }, { chainCostAtomic: 0n }, NOW)],
});

const withEvidence = CatalogView.parse({
  ...previewOnly,
  economics: { status: "measured", chainCostUsdc: "10000", priceFloorUsdc: "100000" },
  releases: [
    summarizeRelease(
      {
        release: {
          ...skeleton,
          version: "0.1.0+provisional-1",
          price: "250000",
          provider: { payTo: "0x00000000000000000000000000000000000000a1" },
          supportedProfiles: [
            {
              ...skeleton.supportedProfiles[0]!,
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
        },
        releaseDigest: hex("57"),
        baseReleaseDigest: hex("56"),
        provisional: true,
      },
      { chainCostAtomic: 10_000n },
      NOW,
      // What the server computes for a one-run probe that passed, with no outcomes yet.
      new Map([[0, { confidenceBps: 2698, effectiveNMilli: "1000", outcomes: 0, source: "benchmark" as const, buyers: null }]]),
    ),
  ],
});

describe("pricing calculator", () => {
  it("reproduces the worked example in docs/economic-gates.md with core's pricing functions", () => {
    const r = evaluatePricing(WORKED_EXAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toBe("ok");
    expect(r.maxPrice).toBe(390_000n);
    expect(r.reductionBps).toBe(3600n);
    expect(r.withLemma).toBe(1_600_000n);
    expect(r.residual).toBe(1_200_000n);
  });

  it("names which rule a price breaks", () => {
    const verdict = (input: Partial<typeof WORKED_EXAMPLE>) => {
      const r = evaluatePricing({ ...WORKED_EXAMPLE, ...input });
      return r.ok ? r.verdict : "invalid";
    };
    expect(verdict({ price: "0.40" })).toBe("breaks-sale-rule");
    expect(verdict({ price: "0" })).toBe("zero-price");
    // 0.20 is within 30% of 0.80, but (0.80 - 0.20 - 0.01) / 2.50 is 23.6%, short of the 25% target.
    expect(verdict({ saving: "0.80", price: "0.20" })).toBe("misses-target");
  });

  it("refuses malformed or impossible amounts instead of guessing", () => {
    const bad = evaluatePricing({ ...WORKED_EXAMPLE, price: "1,5", saving: "3.00", control: "2.50" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.price).toMatch(/at most 6 decimals/);
    expect(bad.errors.saving).toMatch(/cannot exceed/);
    const zero = evaluatePricing({ ...WORKED_EXAMPLE, control: "0", saving: "0" });
    expect(zero.ok ? null : zero.errors.control).toMatch(/above zero/);
    expect(evaluatePricing({ ...WORKED_EXAMPLE, gas: "0.0000001" }).ok).toBe(false);
  });

  it("renders the verdict, the bounds and the chart for the worked example", () => {
    const html = renderToStaticMarkup(<PricingCalculator />);
    expect(html).toContain("Sellable.");
    expect(html).toContain("36.00 %");
    expect(html).toContain("0.39 USDC");
    expect(html).toContain("Build it yourself");
    // The inputs start at the worked example, and the page tags them as an example.
    expect(html).toContain('<span class="badge">Example</span> The numbers start at an example. Try your own.');
  });
});

describe("cost chart", () => {
  it("keeps every value readable without hovering, in a legend and a values table", () => {
    const html = renderToStaticMarkup(<CostComparison control={2_500_000n} residual={1_200_000n} price={390_000n} gas={10_000n} caption="Cost to green" />);
    for (const label of ["Model cost", "Lemma price", "Chain cost", "Build it yourself", "With Lemma"]) expect(html).toContain(label);
    for (const value of ["2.50", "1.20", "0.39", "0.01", "1.60"]) expect(html).toContain(`>${value}<`);
    expect(html).toContain('aria-label="Lemma price: 0.39 USDC"');
    // Nothing tells the reader how to use the chart; the table holds every number.
    expect(html).not.toContain("Hover over");
    expect(html).toContain('<table class="cost-table">');
    // No inline style attributes: the dashboard's CSP has no 'unsafe-inline'.
    expect(html).not.toContain("style=");
  });

  it("folds the values table away in a compact chart, keeping every number and the caption for screen readers", () => {
    const html = renderToStaticMarkup(<CostComparison compact control={2_500_000n} residual={1_200_000n} price={390_000n} gas={10_000n} caption="Cost to green" />);
    expect(html).toContain('<details class="cost-numbers"><summary>Show the numbers</summary>');
    for (const value of ["2.50", "1.20", "0.39", "0.01", "1.60"]) expect(html).toContain(`>${value}<`);
    expect(html).toContain('<figcaption class="sr-only">Cost to green</figcaption>');
  });

  it("draws a zero-cost comparison without dividing by zero", () => {
    const html = renderToStaticMarkup(<CostComparison control={0n} residual={0n} price={0n} gas={0n} caption="Empty" />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});

describe("formatting, links and routes", () => {
  it("prints exact amounts with at least two decimals", () => {
    expect(usdcAmount(2_500_000n)).toBe("2.50");
    expect(usdcAmount(5_000n)).toBe("0.005");
    expect(usdcAmount(0n)).toBe("0.00");
    expect(usdcAmount(-10_000n)).toBe("-0.01");
  });

  it("links to the explorer the server names, only for a well-formed address or transaction", () => {
    expect(explorerAddressUrl(ARBISCAN, ARBITRUM_SEPOLIA_USDC)).toBe(`https://sepolia.arbiscan.io/address/${ARBITRUM_SEPOLIA_USDC}`);
    expect(explorerTxUrl(ARBISCAN, hex("ab"))).toBe(`https://sepolia.arbiscan.io/tx/${hex("ab")}`);
    for (const bad of ["0x123", "javascript:alert(1)", `${ARBITRUM_SEPOLIA_USDC}/../x`, `${ARBITRUM_SEPOLIA_USDC} `, hex("ab")]) expect(explorerAddressUrl(ARBISCAN, bad)).toBeNull();
    for (const bad of [ARBITRUM_SEPOLIA_USDC, `${hex("ab")}/../x`, `0x${"g".repeat(64)}`, `${hex("ab")} `]) expect(explorerTxUrl(ARBISCAN, bad)).toBeNull();
    // Links off, or an explorer that is not a plain http(s) base: no link at all.
    const withCredentials = ["https://", "someone", ":", "not-a-password", "@explorer.example"].join("");
    for (const explorer of [null, "javascript:alert(1)", withCredentials, "https://someone@explorer.example", "https://explorer.example/?q=1", "https://explorer.example/#x", "ftp://explorer.example", "explorer.example"]) {
      expect(explorerAddressUrl(explorer, ARBITRUM_SEPOLIA_USDC), String(explorer)).toBeNull();
      expect(explorerTxUrl(explorer, hex("ab")), String(explorer)).toBeNull();
      expect(explorerName(explorer), String(explorer)).toBeNull();
    }
    // A base with a path keeps it, without its trailing slash; link text names Arbiscan, or else the explorer's host.
    expect(explorerTxUrl("http://localhost:5100/explorer/", hex("ab"))).toBe(`http://localhost:5100/explorer/tx/${hex("ab")}`);
    expect(explorerName(ARBISCAN)).toBe("Arbiscan");
    expect(explorerName("http://localhost:5100/explorer/")).toBe("localhost:5100");
  });

  it("routes the setup page, the in-page anchors, and titles every view", () => {
    expect(parseRoute("#/setup")).toEqual({ view: "setup" });
    expect(parseRoute("#/how-it-works")).toEqual({ view: "overview", anchor: "how-it-works" });
    expect(parseRoute("#/what-to-trust")).toEqual({ view: "evidence", anchor: "what-to-trust" });
    expect(parseRoute("#/evidence")).toEqual({ view: "evidence", anchor: null });
    expect(titleFor({ view: "overview", anchor: null })).toBe("Lemma · Tested integrations for coding agents");
    expect(titleFor({ view: "status", anchor: "verify" })).toBe("Status · Lemma");
    expect(titleFor({ view: "evidence", anchor: null })).toBe("Proof · Lemma");
    expect(titleFor({ view: "setup" })).toBe("Get started · Lemma");
    expect(titleFor({ view: "catalog" })).toBe("Catalog · Lemma");
    expect(titleFor({ view: "resolution", id: null })).toBe("Resolutions · Lemma");
    expect(titleFor({ view: "not-found" })).toBe("Not found · Lemma");
  });

  it("shortens a hash but keeps the full value to read and copy", () => {
    const html = renderToStaticMarkup(<Hash value={hex("ab")} what="digest" />);
    expect(html).toContain(`title="${hex("ab")}"`);
    expect(html).toContain("0xababab…ababab");
    expect(html).toContain('aria-label="Copy digest"');
  });
});

describe("pages", () => {
  it("explains the product in one screen, with one example tagged as such", () => {
    const html = renderToStaticMarkup(<Overview />);
    for (const text of ["Tested integrations your agent can reuse", "Agent session", "How it works", "On Arbitrum Sepolia", "Try it in your agent", 'id="how-it-works"']) expect(html).toContain(text);
    expect(html.toLowerCase()).not.toContain("coming soon");
    // The example session uses the worked example's numbers, under an Example tag.
    expect(html).toContain('<aside class="panel session" aria-label="An example agent session"><div class="panel-head"><span>Agent session</span><span class="badge">Example</span>');
    expect(html).toContain(`fits your project · ${WORKED_EXAMPLE.price} USDC`);
    expect(html).not.toContain("lemma-mcp");
    // The four steps include the warranty.
    for (const step of ["Check", "Buy", "Apply and test", "Covered"]) expect(html).toContain(`<h3>${step}</h3>`);
    // What to trust is on the proof page, with its anchor.
    const proof = renderToStaticMarkup(<Evidence view={previewOnly} />);
    expect(proof).toContain('id="what-to-trust"');
    expect(proof).toContain("A provider bond backs a purchase when the server uses the warranty contract");
    // The known receipt gap is stated plainly.
    expect(proof).toContain("A release&#x27;s tests run as your user, so they could reach your signer. Disputes go to the evaluator.");
  });

  it("draws the mark with ids that stay distinct when it appears twice, and a one-color version", () => {
    const html = renderToStaticMarkup(
      <>
        <LogoMark size={28} />
        <LogoMark size={28} />
      </>,
    );
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]+$/);
    expect(html).not.toContain("style=");
    expect(renderToStaticMarkup(<MarkMono size={20} />)).toContain('fill="currentColor"');
    expect(renderToStaticMarkup(<Logo />)).toContain('<span class="wordmark">Lemma</span>');
  });

  it("gives setup instructions from a checkout, without inventing this server's address when there is no window", () => {
    expect(serverOrigin()).toBe("https://<this server>");
    const html = renderToStaticMarkup(<Setup />);
    expect(html).toContain("install-rule --agent cursor .");
    for (const tab of ["Cursor", "Claude Code", "Other agents"]) expect(html).toContain(tab);
    expect(html).toContain("&lt;path to your Lemma checkout&gt;/apps/bridge/dist/main.js");
    expect(html).toContain("lemma_buy_resolution");
    // Purchases go through the separate signer, with limits in atomic USDC; the bridge itself needs no RPC or key.
    for (const name of ["LEMMA_SIGNER_SOCKET", "LEMMA_MAX_USDC_PER_RESOLUTION", "LEMMA_DAILY_USDC_CAP", "LEMMA_ALLOWED_PAY_TO"]) expect(html).toContain(name);
    expect(html).toContain("250000 is 0.25 USDC");
    expect(html).not.toContain("ARBITRUM_SEPOLIA_RPC_URL");
    // Every tool the bridge registers is listed, the refund tool included.
    for (const tool of ["lemma_preview", "lemma_buy_resolution", "lemma_apply_resolution", "lemma_verify_adoption", "lemma_claim_refund"]) expect(html).toContain(tool);
    // Purchases need a refund address other than the buyer's: there is no default to fall back on.
    expect(html).toContain("other than the buyer&#x27;s");
    expect(html).not.toContain("the buyer&#x27;s address</td>");
  });

  it("lists LEMMA_AGENT_ID, says what it publishes, and does not claim the bridge sends no environment value", () => {
    const html = renderToStaticMarkup(<Setup />);
    expect(html).toContain("<code>LEMMA_AGENT_ID</code>");
    expect(html).toContain("shows on chain that the paying wallet adopted that patch");
    expect(html).toContain("environment values, except LEMMA_AGENT_ID when you set it");
    expect(html).not.toContain("file paths or environment values to the server.");
  });

  it("shows each release as a compact card, and what an agent asking for a missing capability gets", () => {
    const html = renderToStaticMarkup(<Catalog view={previewOnly} />);
    // What it is, its price or a free preview, what it fits, the warranty and the source come first.
    for (const text of ["<h3>MCP server paywall</h3>", '<span class="badge">Free preview</span>', "x402 payment gating for a TypeScript MCP server", "<li>TypeScript</li>", "<li>Node 22–24</li>", "72 h to claim", "coinbase/x402"]) {
      expect(html).toContain(text);
    }
    // No banner about what is missing, no reasons on the card, and the catalog's own titles stay out.
    for (const gone of ["Nothing is for sale yet", "not for sale yet", "not sold:", "Skeleton:"]) expect(html).not.toContain(gone);
    // A capability with no release is shown by what an agent gets today.
    expect(html).toContain("<h3>Payment facilitator</h3>");
    expect(html).toContain("Agents asking for this get a free answer to build it themselves.");
    // A sellable release shows its price.
    expect(renderToStaticMarkup(<Catalog view={withEvidence} />)).toContain('<span class="badge ok">0.25 USDC</span>');
  });

  it("shows a release's public record with its distinct buyers, and nothing when there is none", () => {
    expect(renderToStaticMarkup(<Catalog view={previewOnly} />)).not.toContain("<dt>Record</dt>");
    const withRecord = (buyers: number | null) => CatalogView.parse({ ...withEvidence, releases: withEvidence.releases.map((r) => ({ ...r, reputation: { passBps: 9750, count: 34, buyers } })) });
    expect(renderToStaticMarkup(<Catalog view={withRecord(12)} />)).toContain("97.50 % passed · 34 results · 12 buyers");
    // Below three the read model publishes no count, and the page says so.
    expect(renderToStaticMarkup(<Catalog view={withRecord(null)} />)).toContain("97.50 % passed · 34 results · fewer than 3 buyers");
  });

  it("shows the distinct buyers behind a confidence's outcomes, never beside a prior alone", () => {
    const withConfidence = (outcomes: number, buyers: number | null, source: "benchmark+outcomes" | "outcomes" = "benchmark+outcomes") =>
      CatalogView.parse({
        ...withEvidence,
        releases: withEvidence.releases.map((r) => ({
          ...r,
          profiles: r.profiles.map((p) => ({
            ...p,
            ...(source === "outcomes" ? { evidence: null, label: "none", allInReductionBps: null, maxPriceUsdc: null, blocker: "PROFILE_NOT_BENCHMARKED" } : {}),
            compatibility: { confidenceBps: 7337, effectiveNMilli: "21727", outcomes, source, buyers },
          })),
        })),
      });
    for (const html of [renderToStaticMarkup(<Catalog view={withConfidence(4, 3)} />), renderToStaticMarkup(<Evidence view={withConfidence(4, 3)} />)]) {
      expect(html).toContain("early estimate and 4 results from 3 buyers");
    }
    for (const html of [renderToStaticMarkup(<Catalog view={withConfidence(5, null)} />), renderToStaticMarkup(<Evidence view={withConfidence(5, null)} />)]) {
      expect(html).toContain("early estimate and 5 results from fewer than 3 buyers");
    }
    expect(renderToStaticMarkup(<Catalog view={withConfidence(1, null, "outcomes")} />)).toContain("1 result from fewer than 3 buyers");
    // A starting score alone has no results, so no buyers either.
    const prior = renderToStaticMarkup(<Catalog view={withEvidence} />);
    expect(prior).toContain("(from the early estimate)");
    expect(prior).not.toContain("buyers)");
    expect(renderToStaticMarkup(<Evidence view={withConfidence(4, 3)} />)).toContain("Buyer counts show from 3 buyers up");
  });

  it("shows how the benchmark and the score work before any evidence exists, and the measured profiles once it does", () => {
    const empty = renderToStaticMarkup(<Evidence view={previewOnly} />);
    for (const text of ["The benchmark", "Without Lemma", "The score", "Starts from the benchmark", "Moves with each result", "Stays current"]) expect(empty).toContain(text);
    for (const gone of ["Measured profiles", "No frozen benchmark has run yet", "Nothing to be confident about yet"]) expect(empty).not.toContain(gone);
    const html = renderToStaticMarkup(<Evidence view={withEvidence} />);
    expect(html).toContain("Measured profiles");
    expect(html).toContain("Early estimates are loaded");
    expect(html).toContain("from the early estimate");
    expect(html).toContain("With Lemma");
    // C - S + P + g = 2.50 - 1.00 + 0.25 + 0.01.
    expect(html).toContain(">1.76<");
  });

  it("says when no warranty pipeline runs, and links addresses to the explorer the server names", () => {
    const resolution: ResolutionView = {
      resolutionId: hex("aa"),
      state: "prepared",
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: hex("55"), profileIndex: 0 },
      payloadDigest: hex("11"),
      terms: {
        scheme: "exact",
        network: "eip155:421614",
        asset: ARBITRUM_SEPOLIA_USDC,
        amount: "250000",
        payTo: "0x00000000000000000000000000000000000000a1",
        maxTimeoutSeconds: 300,
      },
      createdOn: "2026-10-01",
      receipt: null,
      warranty: null,
    };
    const html = renderToStaticMarkup(<Resolution view={resolution} explorer={ARBISCAN} />);
    // Only the day it was created: no time of day that could point at its payment.
    expect(html).toContain("created on 2026-10-01 (UTC)");
    expect(html).not.toMatch(/\d{2}:\d{2} UTC|T\d{2}:\d{2}/);
    expect(html).toContain("payment in flight");
    expect(html).toContain("Waiting for the test result");
    expect(html).toContain("Sold without a warranty");
    expect(html).toContain("This server sells without a warranty.");
    // The amount is not labeled with its network.
    expect(html).toContain("<p>0.25 USDC, after a free check matched the buyer&#x27;s project.</p>");
    expect(html).toContain('href="https://sepolia.arbiscan.io/address/0x00000000000000000000000000000000000000a1"');
    // Links off (or the status not loaded yet): the addresses stay, the links go.
    const off = renderToStaticMarkup(<Resolution view={resolution} explorer={null} />);
    expect(off).toContain('title="0x00000000000000000000000000000000000000a1"');
    expect(off).not.toContain("arbiscan");
    expect(off).not.toContain("<a href=");
    const failed = renderToStaticMarkup(<Resolution view={{ ...resolution, state: "settled", receipt: { outcome: "failed", verified: true } }} explorer={ARBISCAN} />);
    expect(failed).toContain("Tests failed");
    expect(failed).toContain("signature verified");
    expect(renderToStaticMarkup(<ResolutionLookup />)).toContain('aria-disabled="true"');
  });

  it("lists the contracts this server uses with explorer links and the provider agent, and only those", () => {
    const status = StatusView.parse({
      schemaVersion: "1",
      status: "ok",
      network: "eip155:421614",
      catalogDigest: hex("88"),
      releases: 2,
      paidTools: false,
      provisionalEvidence: false,
      store: "memory",
      economics: "placeholder",
      chain: { explorer: "https://sepolia.arbiscan.io", usdc: ARBITRUM_SEPOLIA_USDC, registry: null, engine: null, identityRegistry: null, reputationRegistry: null, providerAgentId: null },
    });
    const html = renderToStaticMarkup(<Status view={status} />);
    expect(html).toContain(`https://sepolia.arbiscan.io/address/${ARBITRUM_SEPOLIA_USDC}`);
    for (const absent of ["Warranty contract", "Score engine", "ERC-8004", "Provider agent", "not used:"]) expect(html).not.toContain(absent);
    // A server without the paid tools reads by what it does: free checks.
    expect(html).toContain("Previews only");
    expect(html).toContain("every check is free");
    expect(html).toContain("Free previews");
    expect(html).toContain('id="verify"');

    const contracts = {
      registry: "0x4c454d4d41000000000000000000000000000001",
      engine: "0x00000000000000000000000000000000000000e1",
      identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
      reputationRegistry: "0x8004b663056a597dffe9eccc1965a193b7388713",
    };
    const full = StatusView.parse({ ...status, paidTools: true, chain: { ...status.chain, ...contracts, providerAgentId: "42" } });
    const on = renderToStaticMarkup(<Status view={full} />);
    for (const address of [ARBITRUM_SEPOLIA_USDC, ...Object.values(contracts)]) expect(on).toContain(`href="https://sepolia.arbiscan.io/address/${address}"`);
    expect(on).toContain("ERC-8004 agent <code>42</code>");
    expect(on).toContain("paid tools ready");
    expect(on).toContain("a bond backs each sale");
    expect(on).toContain('aria-label="View the warranty contract address on Arbiscan (opens in a new tab)"');
    // A registry without an engine: the engine is simply not listed.
    const noEngine = renderToStaticMarkup(<Status view={{ ...full, chain: { ...full.chain, engine: null } }} />);
    expect(noEngine).toContain("Warranty contract");
    expect(noEngine).not.toContain("Score engine");
    // Explorer links off: every address is still shown, with no link.
    const off = renderToStaticMarkup(<Status view={{ ...full, chain: { ...full.chain, explorer: null } }} />);
    expect(off).not.toContain("<a href=");
    expect(off).toContain(`title="${contracts.registry}"`);
  });

  it("shows every warranty state with its amount in USDC, its claim deadline and a link per transaction", () => {
    const resolution: ResolutionView = {
      resolutionId: hex("aa"),
      state: "settled",
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: hex("55"), profileIndex: 0 },
      payloadDigest: hex("11"),
      terms: { scheme: "exact", network: "eip155:421614", asset: ARBITRUM_SEPOLIA_USDC, amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdOn: "2026-10-01",
      receipt: { outcome: "passed", verified: true },
      warranty: null,
    };
    const none = { amount: null, claimDeadline: null, activation: null, outcome: null, expiry: null, withdrawal: null, feedback: null };
    const activated = { ...none, amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: hex("a1") };
    // Every view is parsed with core's schema first, so each one is a warranty the server could serve.
    const page = (warranty: Record<string, unknown>, over: Partial<ResolutionView> = {}, explorer: string | null = ARBISCAN) =>
      renderToStaticMarkup(<Resolution view={{ ...resolution, ...over, warranty: WarrantyView.parse(warranty) }} explorer={explorer} />);
    const tx = (b: string) => `href="https://sepolia.arbiscan.io/tx/${hex(b)}"`;

    const active = page({ ...activated, state: "active" });
    for (const text of ["warranty active", "Warranty active", "<span>0.25 USDC</span>", "2026-10-04 00:00 UTC", "If the contract is paused, the deadline moves later", tx("a1")]) {
      expect(active).toContain(text);
    }
    expect(active).toContain('aria-label="View the activation transaction on Arbiscan (opens in a new tab)"');

    const passed = page({ ...activated, state: "passed", outcome: hex("a2"), feedback: hex("a5") });
    for (const text of ["warranty passed", "the reserved bond went back to the provider", "ERC-8004 feedback", tx("a1"), tx("a2"), tx("a5")]) expect(passed).toContain(text);
    expect(passed).not.toContain("If the contract is paused");

    const failed = page({ ...activated, state: "failed", outcome: hex("a2") });
    for (const text of ["refund due", "Refund due", "lemma_claim_refund", tx("a2")]) expect(failed).toContain(text);

    const refunded = page({ ...activated, state: "refunded", outcome: hex("a2"), withdrawal: hex("a4") });
    for (const text of [">refunded<", "went to the buyer&#x27;s refund address", ">Refund<", tx("a4")]) expect(refunded).toContain(text);

    expect(page({ ...activated, state: "void", outcome: hex("a2") })).toContain("The result could not count.");
    const expired = page({ ...activated, state: "expired", expiry: hex("a3") });
    for (const text of ["warranty expired", "The claim window closed without a result", ">Expiry<", tx("a3")]) expect(expired).toContain(text);

    const pending = page({ ...none, state: "pending" });
    expect(pending).toContain("Warranty starting");
    expect(pending).toContain("appear here once the warranty starts");

    expect(page({ ...none, state: "none" })).toContain("Bought without a warranty claim");
    expect(page({ ...none, state: "none" }, { state: "prepared", receipt: null })).toContain("Once the payment settles, the provider starts the warranty.");
    expect(page({ ...none, state: "none" }, { state: "expired", receipt: null })).toContain("nothing to warrant");

    // Explorer links off: every hash is still shown in full on hover and copyable, with no link.
    const off = page({ ...activated, state: "refunded", outcome: hex("a2"), withdrawal: hex("a4") }, {}, null);
    for (const b of ["a1", "a2", "a4"]) expect(off).toContain(`title="${hex(b)}"`);
    expect(off).not.toContain("/tx/");
    expect(off).not.toContain("<a href=");
  });

  it("says no testnet, demo, illustrative, placeholder or coming soon on any page, with or without data", () => {
    const status = StatusView.parse({
      schemaVersion: "1",
      status: "ok",
      network: "eip155:421614",
      catalogDigest: hex("88"),
      releases: 1,
      paidTools: true,
      provisionalEvidence: true,
      store: "postgres",
      economics: "placeholder",
      chain: { explorer: ARBISCAN, usdc: ARBITRUM_SEPOLIA_USDC, registry: "0x4c454d4d41000000000000000000000000000001", engine: null, identityRegistry: null, reputationRegistry: null, providerAgentId: null },
    });
    const resolution: ResolutionView = {
      resolutionId: hex("aa"),
      state: "settled",
      release: { releaseId: "gating", version: "1.0.0+provisional-1", releaseDigest: hex("55"), profileIndex: 0 },
      payloadDigest: hex("11"),
      terms: { scheme: "exact", network: "eip155:421614", asset: ARBITRUM_SEPOLIA_USDC, amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdOn: "2026-10-01",
      receipt: null,
      warranty: WarrantyView.parse({ state: "active", amount: "250000", claimDeadline: "2026-10-04T00:00:00.000Z", activation: hex("a1"), outcome: null, expiry: null, withdrawal: null, feedback: null }),
    };
    const pages = [
      <Catalog key="c1" view={previewOnly} />,
      <Catalog key="c2" view={withEvidence} />,
      <Evidence key="e1" view={previewOnly} />,
      <Evidence key="e2" view={withEvidence} />,
      <Status key="s" view={status} />,
      <Resolution key="r" view={resolution} explorer={ARBISCAN} />,
      <Demand key="d" view={{ minProfiles: 5, buckets: [] }} />,
      <PricingCalculator key="p" />,
    ];
    for (const page of pages) {
      const text = renderToStaticMarkup(page).replace(/<[^>]*>/g, " ");
      expect(text).not.toMatch(/testnet|\bdemo|illustrative|placeholder|coming soon|hackathon/i);
    }
  });

  it("says how an empty demand list fills", () => {
    const empty: DemandView = { minProfiles: 5, buckets: [] };
    const html = renderToStaticMarkup(<Demand view={empty} />);
    expect(html).toContain("Collecting requests");
    expect(html).toContain("once at least 5 repositories ask for the same thing in a day");
  });
});
