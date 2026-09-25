import { ARBITRUM_SEPOLIA_USDC, CatalogView, type DemandView, type ResolutionView, StatusView, summarizeRelease } from "@lemma/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WORKED_EXAMPLE, evaluatePricing } from "../src/calculator.js";
import { CostComparison } from "../src/components/CostChart.js";
import { Hash } from "../src/components/copy.js";
import { usdcAmount } from "../src/format.js";
import { explorerAddressUrl } from "../src/links.js";
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
    expect(html).toContain("illustrative assumptions, not measurements");
  });
});

describe("cost chart", () => {
  it("keeps every value readable without hovering, in a legend and a values table", () => {
    const html = renderToStaticMarkup(<CostComparison control={2_500_000n} residual={1_200_000n} price={390_000n} gas={10_000n} caption="Cost to green" />);
    for (const label of ["Model cost", "Lemma price", "Chain cost", "Build it yourself", "With Lemma"]) expect(html).toContain(label);
    for (const value of ["2.50", "1.20", "0.39", "0.01", "1.60"]) expect(html).toContain(`>${value}<`);
    expect(html).toContain('aria-label="Lemma price: 0.39 USDC"');
    expect(html).toContain("Hover over or focus a bar segment");
    // No inline style attributes: the dashboard's CSP has no 'unsafe-inline'.
    expect(html).not.toContain("style=");
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

  it("links to the explorer only for a well-formed address", () => {
    expect(explorerAddressUrl(ARBITRUM_SEPOLIA_USDC)).toBe(`https://sepolia.arbiscan.io/address/${ARBITRUM_SEPOLIA_USDC}`);
    for (const bad of ["0x123", "javascript:alert(1)", `${ARBITRUM_SEPOLIA_USDC}/../x`, `${ARBITRUM_SEPOLIA_USDC} `]) expect(explorerAddressUrl(bad)).toBeNull();
  });

  it("routes the setup page and titles every view", () => {
    expect(parseRoute("#/setup")).toEqual({ view: "setup" });
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
  it("explains the product and marks what is still being built", () => {
    const html = renderToStaticMarkup(<Overview />);
    for (const text of ["What Lemma sells", "How it works", "What leaves your machine", "The pricing rule", "What to trust"]) expect(html).toContain(text);
    expect(html).toContain("Built");
    expect(html).toContain("In progress");
    expect(html).toContain("The warranty registry is not deployed yet");
    expect(html).not.toContain("lemma-mcp");
  });

  it("gives setup instructions from a checkout, without inventing this server's address when there is no window", () => {
    expect(serverOrigin()).toBe("https://<this server>");
    const html = renderToStaticMarkup(<Setup />);
    expect(html).toContain("install-rule .");
    expect(html).toContain("&lt;path to your Lemma checkout&gt;/apps/bridge/dist/main.js");
    expect(html).toContain("lemma_buy_resolution");
  });

  it("says why nothing is for sale, and shows capabilities that have no release", () => {
    const html = renderToStaticMarkup(<Catalog view={previewOnly} />);
    expect(html).toContain("Nothing is for sale yet");
    expect(html).toContain("0 USDC (not for sale)");
    expect(html).toContain("not sold: no frozen benchmark supports this profile");
    expect(html).toContain("An Arbitrum x402 facilitator for a Node service");
    expect(html).toContain("no release exists for this capability yet");
    expect(renderToStaticMarkup(<Catalog view={withEvidence} />)).not.toContain("Nothing is for sale yet");
  });

  it("shows an honest empty state until evidence exists, and the cost chart once it does", () => {
    expect(renderToStaticMarkup(<Evidence view={previewOnly} />)).toContain("No frozen benchmark has run yet");
    const html = renderToStaticMarkup(<Evidence view={withEvidence} />);
    expect(html).toContain("Provisional evidence is loaded");
    expect(html).toContain("With Lemma");
    // C - S + P + g = 2.50 - 1.00 + 0.25 + 0.01.
    expect(html).toContain(">1.76<");
  });

  it("states the warranty handoff and links addresses to the explorer on a resolution", () => {
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
      createdAt: NOW.toISOString(),
      receipt: null,
    };
    const html = renderToStaticMarkup(<Resolution view={resolution} />);
    expect(html).toContain("payment in flight");
    expect(html).toContain("No adoption receipt yet");
    expect(html).toContain("warranty registry");
    expect(html).toContain('href="https://sepolia.arbiscan.io/address/0x00000000000000000000000000000000000000a1"');
    const failed = renderToStaticMarkup(<Resolution view={{ ...resolution, state: "settled", receipt: { outcome: "failed", verified: true } }} />);
    expect(failed).toContain("Acceptance tests failed");
    expect(failed).toContain("signature verified");
    expect(renderToStaticMarkup(<ResolutionLookup />)).toContain('aria-disabled="true"');
  });

  it("lists the settlement contracts and says the registry is not deployed", () => {
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
    });
    const html = renderToStaticMarkup(<Status view={status} />);
    expect(html).toContain(`https://sepolia.arbiscan.io/address/${ARBITRUM_SEPOLIA_USDC}`);
    expect(html).toContain("not deployed yet");
    expect(html).toContain("Previews only");
    expect(html).toContain("placeholder: nothing can be sold");
  });

  it("explains an empty demand list", () => {
    const empty: DemandView = { minProfiles: 5, buckets: [] };
    expect(renderToStaticMarkup(<Demand view={empty} />)).toContain("Nothing to show yet");
  });
});
