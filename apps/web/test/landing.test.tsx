import { ARBITRUM_SEPOLIA_USDC, CatalogView, type ProfileCompatibility, StatusView, summarizeRelease } from "@lemma/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Loaded, MAX_POLL_MS, POLL_MS, POLL_START, type Polled, nextPolled, startPoll } from "../src/api.js";
import { App } from "../src/App.js";
import { FlowDiagram } from "../src/components/FlowDiagram.js";
import { LiveMeter, meterPick } from "../src/components/LiveMeter.js";
import { BUILT_ON, FOOTER_COLUMNS, NAV, isCurrent, parseRoute } from "../src/routes.js";
import { Overview, Pricing, VerifyIt, blockBadge, claimWindowText, evidenceFlow } from "../src/views/Overview.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const hex = (b: string) => `0x${b.repeat(32)}`;
const ENGINE = "0x00000000000000000000000000000000000000e1";
const REGISTRY = "0x4c454d4d41000000000000000000000000000001";

/** A release without evidence, so any confidence it carries comes from outcomes alone. */
function release(id: string, claimWindowHours = 72) {
  return {
    schemaVersion: "1" as const,
    releaseId: id,
    version: "0.1.0-skeleton",
    capability: "mcp-server.add-payment-gating" as const,
    title: `Skeleton ${id}`,
    supportedProfiles: [
      {
        languages: ["typescript" as const],
        nodeMajor: { min: 22, max: 24 },
        packageManagers: ["npm" as const],
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
    warranty: { claimWindowHours },
    publishedAt: "2026-09-25T00:00:00.000Z",
    expiresAt: "2027-03-31T00:00:00.000Z",
  };
}

const fromOutcomes = (outcomes: number, bps: number, milli: string, buyers: number | null = null): ProfileCompatibility => ({ confidenceBps: bps, effectiveNMilli: milli, outcomes, source: "outcomes", buyers });

function catalog(entries: ReadonlyArray<{ readonly id: string; readonly hours?: number; readonly compatibility?: ProfileCompatibility }>): CatalogView {
  return CatalogView.parse({
    schemaVersion: "1",
    catalogDigest: hex("88"),
    generatedAt: NOW.toISOString(),
    economics: { status: "placeholder", chainCostUsdc: "0", priceFloorUsdc: "0" },
    releases: entries.map((e, i) =>
      summarizeRelease(
        { release: release(e.id, e.hours), releaseDigest: hex(`5${i}`), baseReleaseDigest: hex(`6${i}`), provisional: false },
        { chainCostAtomic: 0n },
        NOW,
        e.compatibility === undefined ? undefined : new Map([[0, e.compatibility]]),
      ),
    ),
  });
}

function status(chain: Partial<StatusView["chain"]> = {}, paidTools = true): StatusView {
  return StatusView.parse({
    schemaVersion: "1",
    status: "ok",
    network: "eip155:421614",
    catalogDigest: hex("88"),
    releases: 1,
    paidTools,
    provisionalEvidence: false,
    store: "postgres",
    economics: "placeholder",
    chain: { explorer: "https://sepolia.arbiscan.io", usdc: ARBITRUM_SEPOLIA_USDC, registry: REGISTRY, engine: ENGINE, identityRegistry: null, reputationRegistry: null, providerAgentId: null, ...chain },
  });
}

const polled = <T,>(data: T, failure: string | null = null): Polled<T> => ({ loaded: { state: "ready", data }, failure });
const failed = (message: string): Polled<never> => ({ loaded: { state: "error", message }, failure: null });

describe("the live meter", () => {
  it("shows the confidence with the most outcomes, its effective n, outcomes and buyers, when it was computed, and the engine", () => {
    const view = catalog([
      { id: "few-outcomes", compatibility: fromOutcomes(2, 1586, "2000") },
      { id: "most-outcomes", compatibility: fromOutcomes(5, 4086, "6998", 3) },
      { id: "none" },
    ]);
    expect(meterPick(view)?.release.releaseId).toBe("most-outcomes");
    const html = renderToStaticMarkup(<LiveMeter catalog={polled(view)} status={polled(status())} />);
    expect(html).toContain("40.86 %");
    expect(html).toContain("compatibility confidence, the 90% lower bound");
    for (const figure of ["<dt>Effective n</dt><dd>6.998</dd>", "<dt>Outcomes</dt><dd>5</dd>", "<dt>Buyers</dt><dd>3</dd>"]) expect(html).toContain(figure);
    expect(html).toContain("most-outcomes@0.1.0-skeleton");
    expect(html).toContain("5 outcomes from 3 buyers, no benchmark");
    expect(html).toContain("Computed 2026-10-01 00:00 UTC");
    expect(html).toContain(`href="https://sepolia.arbiscan.io/address/${ENGINE}"`);
    expect(html).not.toContain("style=");
  });

  it("breaks a tie in outcomes by the larger effective n, and says under three buyers below three", () => {
    const view = catalog([
      { id: "smaller-n", compatibility: fromOutcomes(2, 1500, "1900") },
      { id: "larger-n", compatibility: fromOutcomes(2, 1586, "2000") },
    ]);
    expect(meterPick(view)?.release.releaseId).toBe("larger-n");
    expect(renderToStaticMarkup(<LiveMeter catalog={polled(view)} status={polled(status())} />)).toContain("<dt>Buyers</dt><dd>under 3</dd>");
  });

  it("says when no profile has a confidence, while loading, and when the catalog fails", () => {
    const empty = renderToStaticMarkup(<LiveMeter catalog={polled(catalog([{ id: "none" }]))} status={polled(status())} />);
    expect(empty).toContain("No profile has a confidence yet");
    expect(empty).not.toContain(" %");
    expect(renderToStaticMarkup(<LiveMeter catalog={POLL_START} status={POLL_START} />)).toContain("Loading…");
    expect(renderToStaticMarkup(<LiveMeter catalog={failed("The server answered 500.")} status={POLL_START} />)).toContain("Live figures are unavailable: The server answered 500.");
  });

  it("keeps the figures that loaded when a later refresh fails, and says so", () => {
    const view = catalog([{ id: "a", compatibility: fromOutcomes(2, 1586, "2000") }]);
    const kept = nextPolled(polled(view), { state: "error", message: "Too many requests; try again shortly.", status: 429 });
    expect(kept.loaded).toEqual({ state: "ready", data: view });
    const html = renderToStaticMarkup(<LiveMeter catalog={kept} status={polled(status())} />);
    expect(html).toContain("15.86 %");
    expect(html).toContain("The latest refresh failed (Too many requests; try again shortly.)");
    // New data clears the failure, and a failure before any data is shown as the error it is.
    expect(nextPolled(kept, { state: "ready", data: view }).failure).toBeNull();
    expect(nextPolled(POLL_START, { state: "error", message: "down" })).toEqual({ loaded: { state: "error", message: "down" }, failure: null });
  });

  it("links no engine when the server has none or turned explorer links off", () => {
    const view = catalog([{ id: "a", compatibility: fromOutcomes(2, 1586, "2000") }]);
    expect(renderToStaticMarkup(<LiveMeter catalog={polled(view)} status={polled(status({ engine: null }))} />)).not.toContain("arbiscan");
    expect(renderToStaticMarkup(<LiveMeter catalog={polled(view)} status={polled(status({ explorer: null }))} />)).not.toContain("arbiscan");
  });
});

describe("polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(answers: Array<Loaded<string>>) {
    vi.useFakeTimers();
    let hidden = false;
    let loads = 0;
    const results: Array<Loaded<string>> = [];
    const load = async (): Promise<Loaded<string>> => {
      const answer = answers[Math.min(loads, answers.length - 1)] as Loaded<string>;
      loads += 1;
      return answer;
    };
    const clock = {
      after: (run: () => void, ms: number) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      hidden: () => hidden,
    };
    const poll = startPoll(load, (r) => results.push(r), clock);
    return { poll, loads: () => loads, results, hide: (h: boolean) => (hidden = h) };
  }

  const ok: Loaded<string> = { state: "ready", data: "catalog" };
  const tooMany: Loaded<string> = { state: "error", message: "Too many requests; try again shortly.", status: 429 };

  it("loads at once, then once a minute, and changes nothing between answers", async () => {
    const h = harness([ok]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loads()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(h.loads()).toBe(1);
    expect(h.results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.loads()).toBe(2);
    h.poll.stop();
  });

  it("doubles the wait after each 429, up to ten minutes, and returns to a minute after an answer", async () => {
    const h = harness([tooMany, tooMany, tooMany, tooMany, tooMany, tooMany, ok, ok]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loads()).toBe(1);
    // 429 → 2 min, 429 → 4 min, 429 → 8 min, then capped at 10 min.
    for (const wait of [2 * POLL_MS, 4 * POLL_MS, 8 * POLL_MS, MAX_POLL_MS, MAX_POLL_MS]) {
      const before = h.loads();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(h.loads()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.loads()).toBe(before + 1);
    }
    // The sixth answer was a 429 too, so the next wait is still the cap; then a success resets it.
    await vi.advanceTimersByTimeAsync(MAX_POLL_MS);
    expect(h.results.at(-1)).toEqual(ok);
    const before = h.loads();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.loads()).toBe(before + 1);
    h.poll.stop();
  });

  it("fetches nothing while the page is hidden, and catches up at once when it is shown", async () => {
    const h = harness([ok]);
    await vi.advanceTimersByTimeAsync(0);
    h.hide(true);
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(h.loads()).toBe(1);
    h.hide(false);
    h.poll.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loads()).toBe(2);
    // A wake with nothing due fetches nothing extra.
    h.poll.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loads()).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.loads()).toBe(3);
    h.poll.stop();
  });

  it("does not load or report after it is stopped", async () => {
    const h = harness([ok]);
    await vi.advanceTimersByTimeAsync(0);
    h.poll.stop();
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(h.loads()).toBe(1);
    expect(h.results).toHaveLength(1);
  });
});

describe("the home page sections", () => {
  it("draws the evidence flow as an ordered list of text, marking the on-chain steps this server has off", () => {
    const html = renderToStaticMarkup(<FlowDiagram label="From one adoption to public evidence" steps={evidenceFlow(status())} />);
    expect(html).toContain('<ol class="flow" aria-label="From one adoption to public evidence">');
    expect(html.match(/<li class="flow-step">/g)).toHaveLength(4);
    for (const title of ["Adoption receipt", "Warranty registry", "Stylus engine", "ERC-8004 reputation"]) expect(html).toContain(title);
    // Only the reputation registry is off on this server.
    expect(html.match(/Off on this server/g)).toHaveLength(1);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("style=");
    // Before the status loads, nothing is marked off.
    expect(renderToStaticMarkup(<FlowDiagram label="flow" steps={evidenceFlow(null)} />)).not.toContain("Off on this server");
  });

  it("badges each building block by what this server runs", () => {
    const html = (state: Parameters<typeof blockBadge>[0], s: Polled<StatusView>) => renderToStaticMarkup(<>{blockBadge(state, s)}</>);
    expect(html("live", POLL_START)).toContain("Live");
    expect(html((s) => (s.paidTools ? "testnet" : "off"), POLL_START)).toContain("…");
    expect(html((s) => (s.paidTools ? "testnet" : "off"), failed("down"))).toContain("Unknown");
    expect(html((s) => (s.paidTools ? "testnet" : "off"), polled(status({}, false)))).toContain("Off on this server");
    expect(html((s) => (s.chain.registry !== null ? "testnet" : "off"), polled(status()))).toContain("Testnet");
  });

  it("prices from this server's catalog: what is for sale now and the claim window", () => {
    const view = catalog([{ id: "a" }, { id: "b", hours: 48 }]);
    expect(claimWindowText(view)).toBe("48 to 72 hours");
    expect(claimWindowText(catalog([{ id: "a" }]))).toBe("72 hours");
    expect(claimWindowText(catalog([]))).toBeNull();
    const html = renderToStaticMarkup(<Pricing catalog={polled(view)} status={polled(status())} />);
    for (const text of ["Free", "≤ 30%", "of the measured saving", "Included", "For sale on this server now: 0 of 2 profiles", "Claim window on this server: 48 to 72 hours"]) expect(html).toContain(text);
    expect(html).toContain('class="price-card featured"');
    expect(renderToStaticMarkup(<Pricing catalog={polled(view)} status={polled(status({ registry: null, engine: null }))} />)).toContain("Off on this server: it runs no warranty pipeline");
  });

  it("lists this server's contracts with explorer links, and says which are off", () => {
    const html = renderToStaticMarkup(<VerifyIt catalog={polled(catalog([{ id: "a" }]))} status={polled(status())} />);
    expect(html).toContain('id="verify"');
    for (const address of [REGISTRY, ENGINE, ARBITRUM_SEPOLIA_USDC.toLowerCase()]) expect(html).toContain(`href="https://sepolia.arbiscan.io/address/${address}"`);
    expect(html).toContain("off on this server");
    expect(html).toContain("npm run sepolia:check");
    expect(renderToStaticMarkup(<VerifyIt catalog={failed("down")} status={failed("down")} />)).toContain("unavailable");
  });

  it("renders the whole home page without inline styles, with every section", () => {
    const html = renderToStaticMarkup(<Overview />);
    expect(html).not.toContain("style=");
    for (const text of ["Building blocks", "Every adoption becomes evidence", "Priced from the saving, never above 30% of it", 'id="pricing"', 'id="verify"', "Run your own Lemma", "Try it in your agent"]) {
      expect(html).toContain(text);
    }
    // While the status loads, the announcement makes no claim about the chain.
    expect(html).toContain("Every amount is test USDC on Arbitrum Sepolia");
  });
});

describe("the shell", () => {
  it("has a footer with Product, Explore, Trust and Built on, the testnet line, and no affiliation", () => {
    const html = renderToStaticMarkup(<App initialHash="#/" />);
    for (const title of ["Product", "Explore", "Trust", "Built on"]) expect(html).toContain(`<h2 class="footer-title">${title}</h2>`);
    for (const name of BUILT_ON) expect(html).toContain(`<li>${name}</li>`);
    for (const item of FOOTER_COLUMNS.flatMap((c) => c.items)) expect(html).toContain(`<a href="${item.href}">${item.label}</a>`);
    expect(html).toContain("Testnet only: every amount is test USDC on Arbitrum Sepolia.");
    expect(html).toContain("Lemma is not affiliated with them");
    expect(html).not.toContain("style=");
  });

  it("marks the page on screen: the logo on the home page, a section's link on that section", () => {
    expect(renderToStaticMarkup(<App initialHash="#/" />)).toContain('aria-label="Lemma home" aria-current="page"');
    const pricing = renderToStaticMarkup(<App initialHash="#/pricing" />);
    expect(pricing).toContain('<a href="#/pricing" aria-current="page">Pricing</a>');
    expect(pricing).not.toContain('aria-label="Lemma home" aria-current="page"');
    expect(pricing).not.toContain('<a href="#/how-it-works" aria-current="page">');
    expect(parseRoute("#/pricing")).toEqual({ view: "overview", anchor: "pricing" });
    expect(parseRoute("#/verify")).toEqual({ view: "overview", anchor: "verify" });
    const [how, catalogItem] = NAV;
    expect(how !== undefined && isCurrent(how, { view: "overview", anchor: "how-it-works" })).toBe(true);
    expect(how !== undefined && isCurrent(how, { view: "overview", anchor: null })).toBe(false);
    expect(catalogItem !== undefined && isCurrent(catalogItem, { view: "catalog" })).toBe(true);
  });
});
