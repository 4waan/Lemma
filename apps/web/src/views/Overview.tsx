import { CatalogView } from "@lemma/core";

import { type Polled, usePolledView } from "../api.js";
import { WORKED_EXAMPLE, evaluatePricing } from "../calculator.js";
import { CostComparison } from "../components/CostChart.js";
import { Icon, type IconName } from "../components/Icon.js";
import { AgentTerminal } from "../components/Terminal.js";
import { Badge, PricingCard } from "../components/ui.js";
import { DEPLOYMENT } from "../deployment.js";
import { usdcAmount } from "../format.js";
import { explorerAddressUrl, explorerTxUrl } from "../links.js";
import { NETWORK_LABEL } from "../routes.js";

/**
 * The home page, in the order a visitor asks: what Lemma is (with a sample
 * agent session), how it works, what the chain adds, and the price. The claim
 * window comes from this server's catalog, refreshed every minute while the
 * page is open; the chain links point at Lemma's own recorded run.
 */
export function Overview() {
  const catalog = usePolledView<CatalogView>("/api/v1/catalog", CatalogView);
  return (
    <div className="home">
      <Hero />
      <HowItWorks />
      <OnArbitrum />
      <Pricing catalog={catalog} />
      <div className="cta-band">
        <div>
          <h2>Try it in your agent</h2>
          <p>One click in most agents. Checks are free.</p>
        </div>
        <a className="btn btn-primary" href="#/connect">
          Connect your agent <Icon name="arrow" />
        </a>
      </div>
    </div>
  );
}

const ready = <T,>(polled: Polled<T>): T | null => (polled.loaded.state === "ready" ? polled.loaded.data : null);

function Hero() {
  return (
    <section className="hero">
      <div className="hero-grid">
        <div>
          <a className="announce" href="#/arbitrum">
            <Badge tone="ok">On chain</Badge>
            <span>Payments, scores and refunds</span>
            <Icon name="arrow" size={14} />
          </a>
          <h1>Tested integrations your agent can reuse</h1>
          <p className="lead">
            Before your coding agent writes an integration, it asks Lemma. If a tested patch fits your project, the agent buys it for cents, applies it and runs its tests.
          </p>
          <p className="hero-note">
            <Icon name="shield" size={16} />
            <span>A patch that fails its tests is refunded from the provider's bond.</span>
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#/connect">
              Connect your agent <Icon name="arrow" />
            </a>
            <a className="btn btn-secondary" href="#/catalog">
              See the catalog
            </a>
          </div>
        </div>
        <AgentTerminal />
      </div>
    </section>
  );
}

const STEPS: ReadonlyArray<{ readonly title: string; readonly tag: string; readonly text: string }> = [
  { title: "Check", tag: "Free", text: "Your agent sends a short profile of your project: language, Node version, packages. Never your code. Lemma answers reuse, adapt, build or decline." },
  { title: "Buy", tag: "Cents in USDC", text: "If a tested patch fits, your agent pays for it. Your spending limits are checked before it signs." },
  { title: "Apply and test", tag: "On your machine", text: "The patch goes in whole or not at all. Then its own tests run, and your agent signs the result." },
  { title: "Covered", tag: "Refund if it fails", text: "The provider's bond backs every sale. If the tests fail and the failure is confirmed, the bond refunds the price." },
];

function HowItWorks() {
  return (
    <section className="section" id="how-it-works" aria-labelledby="how-title">
      <div className="section-head">
        <span className="eyebrow">Four steps</span>
        <h2 id="how-title">How it works</h2>
        <p>Your agent runs each step from your machine.</p>
      </div>
      <ol className="steps">
        {STEPS.map((step, i) => (
          <li className="step" key={step.title}>
            <span className="step-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="step-head">
              <h3>{step.title}</h3>
              <Badge tone="accent">{step.tag}</Badge>
            </div>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What the chain adds, in three points, each with the recorded run's transaction or contract to look at. */
const CHAIN_POINTS: ReadonlyArray<{ readonly icon: IconName; readonly title: string; readonly text: string; readonly link: string | null; readonly linkLabel: string }> = [
  {
    icon: "wallet",
    title: "No gas for your agent",
    text: "Your agent signs a USDC payment. Lemma sends it and pays the gas.",
    link: explorerTxUrl(DEPLOYMENT.explorer, DEPLOYMENT.paymentTx),
    linkLabel: "See a payment",
  },
  {
    icon: "cpu",
    title: "Scores computed on chain",
    text: "A Stylus program keeps every release's score, so anyone can check it.",
    link: explorerAddressUrl(DEPLOYMENT.explorer, DEPLOYMENT.engine),
    linkLabel: "See the score engine",
  },
  {
    icon: "refund",
    title: "Failed tests are refunded",
    text: "Each sale is backed by a USDC bond. If the tests fail, the bond pays you back.",
    link: explorerTxUrl(DEPLOYMENT.explorer, DEPLOYMENT.refundTx),
    linkLabel: "See a refund",
  },
];

function OnArbitrum() {
  return (
    <section className="section" id="arbitrum" aria-labelledby="arbitrum-title">
      <div className="section-head">
        <span className="eyebrow">Network</span>
        <h2 id="arbitrum-title">On {NETWORK_LABEL}</h2>
      </div>
      <ul className="chain-points">
        {CHAIN_POINTS.map((point) => (
          <li className="chain-point" key={point.title}>
            <span className="feature-icon" aria-hidden="true">
              <Icon name={point.icon} size={18} />
            </span>
            <h3>{point.title}</h3>
            <p>{point.text}</p>
            {point.link === null ? null : (
              <a className="chain-link" href={point.link} target="_blank" rel="noopener noreferrer">
                {point.linkLabel} <Icon name="external" size={14} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The claim windows of this server's releases, in words: "72 hours", or "48 to 72 hours". */
export function claimWindowText(view: CatalogView): string | null {
  const hours = [...new Set(view.releases.map((r) => r.warrantyHours))].sort((a, b) => a - b);
  const first = hours[0];
  const last = hours[hours.length - 1];
  if (first === undefined || last === undefined) return null;
  return first === last ? `${first} hours` : `${first} to ${last} hours`;
}

export function Pricing({ catalog }: { catalog: Polled<CatalogView> }) {
  const view = ready(catalog);
  const claimWindow = view === null ? null : claimWindowText(view);
  const example = evaluatePricing(WORKED_EXAMPLE);
  return (
    <section className="section" id="pricing" aria-labelledby="pricing-title">
      <div className="section-head centered">
        <span className="eyebrow">Pricing</span>
        <h2 id="pricing-title">Free to check. Pay only when it fits.</h2>
      </div>
      <div className="price-grid">
        <PricingCard
          name="Check"
          price="Free"
          unit="every time"
          items={[
            ["any", "Any project, supported or not"],
            ["answer", "Reuse, adapt, build or decline, with the reasons"],
            ["private", "Your project's profile only, never your code"],
          ]}
        />
        <PricingCard
          name="Patch"
          featured
          price="≤ 30%"
          unit="of what it saves you"
          items={[
            ["usdc", "Paid in USDC, usually cents"],
            ["measured", "Priced from a measured saving"],
            ["limits", "Your spending limits apply"],
          ]}
        />
        <PricingCard
          name="Warranty"
          price="Included"
          unit="with every patch"
          items={[
            ["bond", "Backed by the provider's bond"],
            ["refund", "A confirmed failure is refunded"],
            ["window", claimWindow === null ? "Each patch sets its claim window" : `Claim within ${claimWindow}`],
          ]}
        />
      </div>
      {example.ok ? (
        <div className="card example-card">
          <div className="card-head">
            <h3 className="card-title">One integration, built or bought</h3>
          </div>
          <div className="example-grid">
            <CostComparison compact control={example.control} residual={example.residual} price={example.price} gas={example.gas} caption="Cost to reach passing tests" />
            <ul className="example-facts">
              <li>
                <strong>{`${example.reductionBps / 100n}%`}</strong>
                <span>cheaper than building it</span>
              </li>
              <li>
                <strong>{usdcAmount(example.price)} USDC</strong>
                <span>
                  price: {`${(example.price * 100n) / example.saving}%`} of the {usdcAmount(example.saving)} saved
                </span>
              </li>
              <li>
                <strong>{usdcAmount(example.saving - example.price - example.gas)} USDC</strong>
                <span>you keep, after price and gas</span>
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
