import { readFileSync } from "node:fs";

import { ARBITRUM_SEPOLIA_USDC, CatalogView, type ProfileCompatibility, StatusView, summarizeRelease } from "@lemma/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Loaded, MAX_POLL_MS, POLL_MS, POLL_START, type Polled, nextPolled, startPoll } from "../src/api.js";
import { App } from "../src/App.js";
import { FlowDiagram } from "../src/components/FlowDiagram.js";
import { GasChart } from "../src/components/GasChart.js";
import { LiveMeter, meterPick } from "../src/components/LiveMeter.js";
import { DEPLOYMENT, PASSING_PURCHASE_GAS } from "../src/deployment.js";
import { BUILT_ON, FOOTER_COLUMNS, NAV, NETWORK_LABEL, isCurrent, parseRoute } from "../src/routes.js";
import { THEME_COLOR, applyTheme, storedTheme } from "../src/theme.js";
import { Overview, Pricing, claimWindowText, recordFlow } from "../src/views/Overview.js";
import { VerifyIt } from "../src/views/Status.js";

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
    expect(html).toContain("pass rate, a cautious estimate (90% lower bound)");
    for (const figure of ["<dt>Sample size</dt><dd>6.998</dd>", "<dt>Test results</dt><dd>5</dd>", "<dt>Buyers</dt><dd>3</dd>"]) expect(html).toContain(figure);
    expect(html).toContain("most-outcomes@0.1.0-skeleton");
    expect(html).toContain("profile 0");
    expect(html).toContain("Updated 2026-10-01 00:00 UTC");
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

  it("shows the releases being scored before any profile has a score, while loading, and when the catalog fails", () => {
    const empty = renderToStaticMarkup(<LiveMeter catalog={polled(catalog([{ id: "a" }, { id: "b" }]))} status={polled(status())} />);
    expect(empty).toContain('<span class="meter-value">2</span>');
    expect(empty).toContain("releases in the catalog, scored from each test result");
    expect(empty).not.toContain(" %");
    expect(renderToStaticMarkup(<LiveMeter catalog={polled(catalog([{ id: "a" }]))} status={polled(status())} />)).toContain("release in the catalog, scored");
    expect(renderToStaticMarkup(<LiveMeter catalog={POLL_START} status={POLL_START} />)).toContain("Loading…");
    expect(renderToStaticMarkup(<LiveMeter catalog={failed("The server answered 500.")} status={POLL_START} />)).toContain("Live figures are unavailable right now (The server answered 500.)");
  });

  it("keeps the figures that loaded when a later refresh fails, and says so", () => {
    const view = catalog([{ id: "a", compatibility: fromOutcomes(2, 1586, "2000") }]);
    const kept = nextPolled(polled(view), { state: "error", message: "Too many requests; try again shortly.", status: 429 });
    expect(kept.loaded).toEqual({ state: "ready", data: view });
    const html = renderToStaticMarkup(<LiveMeter catalog={kept} status={polled(status())} />);
    expect(html).toContain("15.86 %");
    expect(html).toContain("The last refresh failed (Too many requests; try again shortly.)");
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
  it("draws what happens to a test result as an ordered list of text, adding reputation only where the server posts it", () => {
    const html = renderToStaticMarkup(<FlowDiagram label="What happens to one test result" steps={recordFlow(status())} />);
    expect(html).toContain('<ol class="flow" aria-label="What happens to one test result">');
    expect(html.match(/<li class="flow-step">/g)).toHaveLength(3);
    for (const title of ["Signed result", "Warranty contract", "Score engine"]) expect(html).toContain(title);
    expect(html).not.toContain("ERC-8004");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("style=");
    const withReputation = renderToStaticMarkup(<FlowDiagram label="flow" steps={recordFlow(status({ reputationRegistry: "0x00000000000000000000000000000000000000f1" }))} />);
    expect(withReputation.match(/<li class="flow-step">/g)).toHaveLength(4);
    expect(withReputation).toContain("Public reputation");
    // Before the status loads, the flow shows the steps every deployment has.
    expect(renderToStaticMarkup(<FlowDiagram label="flow" steps={recordFlow(null)} />).match(/<li class="flow-step">/g)).toHaveLength(3);
  });

  it("prices from this server's catalog, with the claim window and one example tagged as such", () => {
    const view = catalog([{ id: "a" }, { id: "b", hours: 48 }]);
    expect(claimWindowText(view)).toBe("48 to 72 hours");
    expect(claimWindowText(catalog([{ id: "a" }]))).toBe("72 hours");
    expect(claimWindowText(catalog([]))).toBeNull();
    const html = renderToStaticMarkup(<Pricing catalog={polled(view)} />);
    for (const text of ["Free", "≤ 30%", "of what it saves you", "Included", "Claim within 48 to 72 hours"]) expect(html).toContain(text);
    expect(html).toContain('class="price-card featured"');
    // The worked example: 2.50 to build, 1.30 saved, a 0.39 price and 0.01 gas.
    expect(html.match(/<span class="badge">Example<\/span>/g)).toHaveLength(1);
    for (const text of ["36%", "cheaper than building it", "0.39 USDC", "price: 30% of the 1.30 saved", "0.90 USDC", "Show the numbers"]) expect(html).toContain(text);
    expect(renderToStaticMarkup(<Pricing catalog={POLL_START} />)).toContain("Each patch sets its claim window");
  });

  it("charts each on-chain step's measured gas, linking every step to its transaction", () => {
    const html = renderToStaticMarkup(<GasChart steps={DEPLOYMENT.steps} explorer={DEPLOYMENT.explorer} label="gas" />);
    expect(html.match(/<li class="gas-row">/g)).toHaveLength(4);
    for (const text of ["91,275 gas", "216,065 gas", "146,896 gas", "84,009 gas"]) expect(html).toContain(text);
    for (const step of DEPLOYMENT.steps) expect(html).toContain(`href="https://sepolia.arbiscan.io/tx/${step.tx}"`);
    // The bars are drawn, not read: the values are text beside them.
    expect(html.match(/<svg class="gas-bar"[^>]*aria-hidden="true"/g)).toHaveLength(4);
    expect(html).not.toContain("style=");
    expect(PASSING_PURCHASE_GAS).toBe(91_275 + 216_065 + 146_896);
  });

  it("lists this server's contracts with explorer links, only the ones it uses, and the read-only check", () => {
    const html = renderToStaticMarkup(<VerifyIt view={status()} />);
    expect(html).toContain('id="verify"');
    for (const address of [REGISTRY, ENGINE, ARBITRUM_SEPOLIA_USDC.toLowerCase()]) expect(html).toContain(`href="https://sepolia.arbiscan.io/address/${address}"`);
    expect(html).not.toContain("ERC-8004");
    expect(html).toContain("npm run sepolia:check");
    const bare = renderToStaticMarkup(<VerifyIt view={status({ registry: null, engine: null, explorer: null })} />);
    expect(bare).not.toContain("Warranty contract");
    expect(bare).not.toContain("arbiscan");
  });

  it("renders the whole home page without inline styles, in its six parts", () => {
    const html = renderToStaticMarkup(<Overview />);
    expect(html).not.toContain("style=");
    for (const text of ["Tested integrations your agent can reuse", 'id="how-it-works"', 'id="arbitrum"', `On ${NETWORK_LABEL}`, "Every test result counts", 'id="pricing"', "Try it in your agent"]) {
      expect(html).toContain(text);
    }
    for (const gone of ["Building blocks", 'id="verify"', "Run your own Lemma", "Why Arbitrum"]) expect(html).not.toContain(gone);
    // The on-chain section shows the recorded run: its contracts, chain and gas.
    for (const contract of DEPLOYMENT.contracts) expect(html).toContain(`href="https://sepolia.arbiscan.io/address/${contract.address.toLowerCase()}"`);
    expect(html).toContain("421614");
    expect(html).toContain("454,236 gas");
  });
});

/** The text a reader sees: markup, attributes and entities removed. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the wording", () => {
  it("never says testnet, demo, illustrative, placeholder or coming soon, and names the network only in the header and its own section", () => {
    const pages = ["#/", "#/catalog", "#/evidence", "#/status", "#/setup", "#/demand", "#/resolutions", "#/nowhere"].map((hash) => visibleText(renderToStaticMarkup(<App initialHash={hash} />)));
    for (const text of pages) expect(text).not.toMatch(/testnet|\bdemo|illustrative|placeholder|coming soon|hackathon/i);
    const home = pages[0] as string;
    // The header badge and the section's title; amounts never carry the network.
    expect(home.match(new RegExp(NETWORK_LABEL, "g"))).toHaveLength(2);
    expect(home).not.toMatch(/USDC on Arbitrum/);
  });
});

describe("the theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a stored pick on the page, or the system's theme without one, and tints the browser's chrome to match", () => {
    const attributes = new Map<string, string>();
    const metas = [
      { media: "(prefers-color-scheme: light)", content: "" },
      { media: "(prefers-color-scheme: dark)", content: "" },
    ];
    vi.stubGlobal("document", {
      documentElement: { setAttribute: (k: string, v: string) => attributes.set(k, v), removeAttribute: (k: string) => attributes.delete(k) },
      querySelectorAll: () => metas,
    });
    applyTheme("dark");
    expect(attributes.get("data-theme")).toBe("dark");
    expect(metas.map((m) => m.content)).toEqual([THEME_COLOR.dark, THEME_COLOR.dark]);
    applyTheme(null);
    expect(attributes.has("data-theme")).toBe(false);
    expect(metas.map((m) => m.content)).toEqual([THEME_COLOR.light, THEME_COLOR.dark]);
  });

  it("reads only a valid stored pick, and none when storage is blocked", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null } });
    expect(storedTheme()).toBeNull();
    store.set("lemma-theme", "dark");
    expect(storedTheme()).toBe("dark");
    store.set("lemma-theme", "sepia");
    expect(storedTheme()).toBeNull();
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(storedTheme()).toBeNull();
  });

  it("keeps the two dark token blocks identical, and the page's own scrollbar hidden", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const block = (start: string) => {
      const from = css.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      const open = css.indexOf("{", from + start.length - 1);
      return css
        .slice(open + 1, css.indexOf("}", open))
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean);
    };
    const system = block('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
    const picked = block(':root[data-theme="dark"] {');
    expect(system.length).toBeGreaterThan(20);
    expect(picked).toEqual(system);
    expect(css).toMatch(/html \{[^}]*scrollbar-width: none;/);
    expect(css).toContain("html::-webkit-scrollbar {\n  display: none;");
  });

  it("puts a theme switch in the header that names the theme it switches to", () => {
    const html = renderToStaticMarkup(<App initialHash="#/" />);
    expect(html).toContain('class="theme-btn" aria-label="Switch to dark mode"');
  });
});

describe("the shell", () => {
  it("has a footer with Product, Explore, Trust and Built on, the read-only line, and no affiliation", () => {
    const html = renderToStaticMarkup(<App initialHash="#/" />);
    for (const title of ["Product", "Explore", "Trust", "Built on"]) expect(html).toContain(`<h2 class="footer-title">${title}</h2>`);
    for (const name of BUILT_ON) expect(html).toContain(`<li>${name}</li>`);
    for (const item of FOOTER_COLUMNS.flatMap((c) => c.items)) expect(html).toContain(`<a href="${item.href}">${item.label}</a>`);
    expect(html).toContain("This site only reads. It holds no keys and cannot sign anything.");
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
    expect(parseRoute("#/arbitrum")).toEqual({ view: "overview", anchor: "arbitrum" });
    // Verify it yourself lives on the Status page, beside this server's contracts.
    expect(parseRoute("#/verify")).toEqual({ view: "status", anchor: "verify" });
    expect(parseRoute("#/status")).toEqual({ view: "status", anchor: null });
    const [how, catalogItem] = NAV;
    expect(how !== undefined && isCurrent(how, { view: "overview", anchor: "how-it-works" })).toBe(true);
    expect(how !== undefined && isCurrent(how, { view: "overview", anchor: null })).toBe(false);
    expect(catalogItem !== undefined && isCurrent(catalogItem, { view: "catalog" })).toBe(true);
    const verify = FOOTER_COLUMNS.flatMap((c) => c.items).find((item) => item.href === "#/verify");
    expect(verify !== undefined && isCurrent(verify, { view: "status", anchor: "verify" })).toBe(true);
    expect(verify !== undefined && isCurrent(verify, { view: "status", anchor: null })).toBe(false);
    // The header's network badge links to the section about the network.
    expect(renderToStaticMarkup(<App initialHash="#/" />)).toContain(`<a class="pill network" href="#/arbitrum"`);
  });
});
