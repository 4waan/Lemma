import { CatalogView, StatusView } from "@lemma/core";

import { type Loaded, useView } from "../api.js";
import { WORKED_EXAMPLE, evaluatePricing } from "../calculator.js";
import { CostComparison } from "../components/CostChart.js";
import { Icon, type IconName } from "../components/Icon.js";
import { MarkMono } from "../components/Logo.js";
import { Badge, Stat } from "../components/ui.js";
import { networkName, shortHex } from "../format.js";

/**
 * The home page: one sentence and an example session, the three steps, why
 * it pays, why Arbitrum, live figures from this server, and the call to
 * action. It states only what the repository implements, and marks what runs
 * on the testnet only (buying, which settles in test USDC on Arbitrum Sepolia).
 */
export function Overview() {
  const catalog = useView<CatalogView>("/api/v1/catalog", CatalogView);
  const status = useView<StatusView>("/api/v1/status", StatusView);
  return (
    <>
      <Hero />
      <Steps />
      <Saving />
      <WhyArbitrum />
      <LiveFigures catalog={catalog} status={status} />
      <div className="cta-band">
        <div>
          <h2>Try it in your agent</h2>
          <p>About three minutes: build the bridge, add it to your agent, and install the rule.</p>
        </div>
        <a className="btn btn-primary" href="#/setup">
          Get started <Icon name="arrow" />
        </a>
      </div>
    </>
  );
}

function Hero() {
  return (
    <section className="hero">
      <MarkMono size={340} className="hero-watermark" />
      <div className="hero-grid">
        <div>
          <span className="eyebrow">Verified integrations for coding agents</span>
          <h1>Don't rebuild what's already proven.</h1>
          <p className="lead">
            Your agent asks Lemma first. If a verified, tested patch fits your repository, the agent buys it for cents in USDC on Arbitrum, applies it and runs the tests. A provider
            bond backs every sale.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#/setup">
              Get started <Icon name="arrow" />
            </a>
            <a className="btn btn-secondary" href="#/catalog">
              See the catalog
            </a>
          </div>
        </div>
        <ExampleSession />
      </div>
    </section>
  );
}

/** What a session looks like, with the worked example's numbers: illustrative, not a recorded session or a measurement. */
function ExampleSession() {
  return (
    <aside className="session" aria-label="Example agent session">
      <div className="session-head">
        <span>Example session</span>
        <Badge>Illustrative</Badge>
      </div>
      <ol>
        <li>
          <div className="session-call">
            lemma_preview <span className="pill">free</span>
          </div>
          <div className="session-out">
            <b>reuse</b> · fits profile #0 · price {WORKED_EXAMPLE.price} USDC · saves about {WORKED_EXAMPLE.saving} USDC of model cost
          </div>
        </li>
        <li>
          <div className="session-call">
            lemma_buy_resolution <span className="pill">testnet</span>
          </div>
          <div className="session-out">pays {WORKED_EXAMPLE.price} USDC on Arbitrum Sepolia, within your spending caps</div>
        </li>
        <li>
          <div className="session-call">lemma_apply_resolution</div>
          <div className="session-out">patch previewed, then applied all or nothing</div>
        </li>
        <li>
          <div className="session-call">lemma_verify_adoption</div>
          <div className="session-out">
            <b>tests passed</b> · adoption receipt signed
          </div>
        </li>
      </ol>
    </aside>
  );
}

const STEPS: ReadonlyArray<{ readonly title: string; readonly status: "live" | "testnet"; readonly text: string }> = [
  { title: "Check", status: "live", text: "The bridge sends a small profile of your repository, never code. Lemma answers reuse, adapt, build or decline. Always free." },
  { title: "Buy", status: "testnet", text: "For a match, the agent pays cents in USDC through x402 on Arbitrum. Its spending caps are checked in code before it signs." },
  { title: "Apply", status: "live", text: "The patch is applied all or nothing, and the release's own tests run. The outcome becomes a signed adoption receipt." },
];

function Steps() {
  return (
    <section className="section" id="how-it-works" aria-labelledby="how-title">
      <div className="section-head">
        <h2 id="how-title">How it works</h2>
        <p>Three tool calls, all from your own machine.</p>
      </div>
      <ol className="steps">
        {STEPS.map((step, i) => (
          <li className="step" key={step.title}>
            <span className="step-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="step-head">
              <h3>{step.title}</h3>
              {step.status === "live" ? <Badge tone="ok">Live</Badge> : <Badge tone="warn">Testnet</Badge>}
            </div>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Saving() {
  const example = evaluatePricing(WORKED_EXAMPLE);
  return (
    <section className="section stat-block" aria-labelledby="saving-title">
      <div>
        <h2 id="saving-title" className="sr-only">
          Why it pays
        </h2>
        <p className="stat-big">
          25%
          <small>cheaper, at least, than building it yourself</small>
        </p>
        <p>
          A release is sold only when a paired benchmark shows the agent reaches passing tests at least a quarter cheaper all-in. The price is capped at 30% of the measured
          saving. <a href="#/evidence">See the proof</a>.
        </p>
      </div>
      <div className="card stat-chart">
        <span className="example">
          <Badge>Example</Badge>
        </span>
        {example.ok ? (
          <CostComparison control={example.control} residual={example.residual} price={example.price} gas={example.gas} caption="Cost to reach passing tests, worked example" />
        ) : null}
      </div>
    </section>
  );
}

const ARBITRUM: ReadonlyArray<{ readonly icon: IconName; readonly title: string; readonly text: string }> = [
  { icon: "coins", title: "Sub-cent fees", text: "The chain cost is part of Lemma's price formula. If it grew past a few tenths of a dollar, nothing could be sold." },
  { icon: "bolt", title: "Gasless for agents", text: "The agent signs a USDC transfer. The facilitator submits it and pays the gas, so the agent never holds ETH." },
  { icon: "eye", title: "Public receipts", text: "Settlements, warranties and outcomes are transactions anyone can check on Arbiscan." },
];

function WhyArbitrum() {
  return (
    <section className="section band" aria-labelledby="arbitrum-title">
      <h2 id="arbitrum-title">Why Arbitrum</h2>
      <p>A patch that costs cents only works on a chain where the payment, the warranty and the receipts together cost less than a cent.</p>
      <div className="band-grid">
        {ARBITRUM.map((item) => (
          <div className="band-item" key={item.title}>
            <h3>
              <Icon name={item.icon} size={18} />
              {item.title}
            </h3>
            <p>{item.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveFigures({ catalog, status }: { catalog: Loaded<CatalogView>; status: Loaded<StatusView> }) {
  const waiting = (l: Loaded<unknown>) => (l.state === "loading" ? "…" : "Unavailable");
  const profiles = catalog.state === "ready" ? catalog.data.releases.flatMap((r) => r.profiles) : [];
  const sellable = profiles.filter((p) => p.blocker === null).length;
  return (
    <section className="section" aria-label="Live figures from this server">
      <dl className="stats compact">
        <Stat
          label="Curated releases"
          value={catalog.state === "ready" ? catalog.data.releases.length : waiting(catalog)}
          note={catalog.state === "ready" ? `catalog ${shortHex(catalog.data.catalogDigest)}` : "from this server"}
        />
        <Stat
          label="For sale now"
          value={catalog.state === "ready" ? `${sellable} of ${profiles.length} profiles` : waiting(catalog)}
          note={catalog.state === "ready" && sellable === 0 ? "preview only until a benchmark measures them" : "backed by benchmark evidence"}
        />
        <Stat label="Settlement" value={status.state === "ready" ? networkName(status.data.network) : waiting(status)} note="USDC through x402" />
        <Stat
          label="Purchases"
          value={status.state === "ready" ? (status.data.paidTools ? "Enabled" : "Previews only") : waiting(status)}
          note={status.state === "ready" && !status.data.paidTools ? "payments are off on this server" : "x402 paid tools, test USDC"}
        />
      </dl>
      {catalog.state === "error" || status.state === "error" ? (
        <p className="small error-text">Live figures are unavailable: {catalog.state === "error" ? catalog.message : status.state === "error" ? status.message : ""}</p>
      ) : null}
    </section>
  );
}
