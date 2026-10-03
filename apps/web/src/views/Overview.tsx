import { CatalogView, StatusView } from "@lemma/core";

import { type Polled, usePolledView } from "../api.js";
import { WORKED_EXAMPLE, evaluatePricing } from "../calculator.js";
import { AddressLink } from "../components/chain.js";
import { CostComparison } from "../components/CostChart.js";
import { FlowDiagram, type FlowStep } from "../components/FlowDiagram.js";
import { GasChart } from "../components/GasChart.js";
import { Icon, type IconName } from "../components/Icon.js";
import { LiveMeter } from "../components/LiveMeter.js";
import { Badge, Panel, PricingCard } from "../components/ui.js";
import { DEPLOYMENT, PASSING_PURCHASE_GAS } from "../deployment.js";
import { usdcAmount } from "../format.js";
import { NETWORK_LABEL } from "../routes.js";

/**
 * The home page, in the order a visitor asks: what Lemma is, how it works,
 * what runs on chain and what it costs there, what the live record shows, and
 * the price. Live figures come from this server's catalog and status,
 * refreshed every minute while the page is open; the on-chain section shows
 * Lemma's own recorded run. Example numbers carry an Example tag.
 */
export function Overview() {
  const catalog = usePolledView<CatalogView>("/api/v1/catalog", CatalogView);
  const status = usePolledView<StatusView>("/api/v1/status", StatusView);
  return (
    <div className="home">
      <Hero />
      <HowItWorks />
      <OnArbitrum />
      <LiveRecord catalog={catalog} status={status} />
      <Pricing catalog={catalog} />
      <div className="cta-band">
        <div>
          <h2>Try it in your agent</h2>
          <p>Setup takes about three minutes.</p>
        </div>
        <a className="btn btn-primary" href="#/setup">
          Get started <Icon name="arrow" />
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
            <span>See what every step costs</span>
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

/** What a session looks like, with the worked example's numbers: an example, not a recorded session. */
function ExampleSession() {
  return (
    <Panel title="Agent session" label="An example agent session" className="session" badge={<Badge>Example</Badge>}>
      <ol>
        <li>
          <div className="session-call">
            lemma_preview <span className="pill">free</span>
          </div>
          <div className="session-out">
            <b>reuse</b> · fits your project · {WORKED_EXAMPLE.price} USDC · saves about {WORKED_EXAMPLE.saving} USDC
          </div>
        </li>
        <li>
          <div className="session-call">
            lemma_buy_resolution <span className="pill">paid</span>
          </div>
          <div className="session-out">paid {WORKED_EXAMPLE.price} USDC, within your limits</div>
        </li>
        <li>
          <div className="session-call">lemma_apply_resolution</div>
          <div className="session-out">patch applied: every file or none</div>
        </li>
        <li>
          <div className="session-call">lemma_verify_adoption</div>
          <div className="session-out">
            <b>tests passed</b> · result signed
          </div>
        </li>
      </ol>
    </Panel>
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

/** What Arbitrum adds, each with a fact from the recorded run. */
const VALUE: ReadonlyArray<{ readonly icon: IconName; readonly title: string; readonly text: string }> = [
  { icon: "wallet", title: "No gas for the agent", text: "The agent signs a USDC transfer and a facilitator sends it. The buyer in our run held no ETH." },
  {
    icon: "cpu",
    title: "Scores computed on chain",
    text: `A ${DEPLOYMENT.engineKb} KB Rust program on Stylus keeps each release's score. Adding a result costs about ${DEPLOYMENT.recordGas.toLocaleString("en-US")} gas.`,
  },
  { icon: "shield", title: "Bonds held by a contract", text: "The provider's USDC bond sits in the warranty contract. A failed test is refunded from it." },
  { icon: "eye", title: "Anyone can check", text: "Every step is a transaction on Arbiscan, and a read-only script recomputes every score." },
];

function OnArbitrum() {
  return (
    <section className="section" id="arbitrum" aria-labelledby="arbitrum-title">
      <div className="section-head">
        <span className="eyebrow">Network</span>
        <h2 id="arbitrum-title">On {NETWORK_LABEL}</h2>
        <p>Payments, warranties and test results are public transactions. Here is what one purchase used in our run on {DEPLOYMENT.measuredOn}.</p>
      </div>
      <div className="chain-grid">
        <div className="card chain-card">
          <h3 className="card-title">One purchase, step by step</h3>
          <GasChart steps={DEPLOYMENT.steps} explorer={DEPLOYMENT.explorer} label="Gas used by each on-chain step of one purchase" />
          <p className="chain-total">
            <strong>{PASSING_PURCHASE_GAS.toLocaleString("en-US")} gas</strong> for a purchase that passes, under {DEPLOYMENT.purchaseEthBelow} ETH in all. The buyer paid none of it.
          </p>
        </div>
        <ul className="value-grid" aria-label={`What ${NETWORK_LABEL} adds`}>
          {VALUE.map((item) => (
            <li className="value-tile" key={item.title}>
              <span className="feature-icon" aria-hidden="true">
                <Icon name={item.icon} size={18} />
              </span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </div>
      <ul className="contract-strip" aria-label="Deployed contracts">
        {DEPLOYMENT.contracts.map((contract) => (
          <li key={contract.address}>
            <span className="contract-name">{contract.name}</span>
            <span className="contract-value">
              <AddressLink value={contract.address} explorer={DEPLOYMENT.explorer} what={`${contract.name} address`} />
            </span>
          </li>
        ))}
        <li>
          <span className="contract-name">Chain ID</span>
          <span className="contract-value">
            <code>{DEPLOYMENT.chainId}</code>
          </span>
        </li>
      </ul>
    </section>
  );
}

/**
 * What happens to one test result. The on-chain steps are the ones every
 * deployment has; reputation joins them when this server posts it.
 */
export function recordFlow(status: StatusView | null): readonly FlowStep[] {
  const steps: FlowStep[] = [
    { title: "Signed result", where: "Your machine", icon: "receipt", text: "The patch's tests run and your agent signs the result. The server checks the signature." },
    { title: "Warranty contract", where: "On chain", icon: "shield", text: "The result becomes final. A pass returns the bond to the provider. A failure refunds the buyer." },
    { title: "Score engine", where: "On chain", icon: "gauge", text: "The result updates the release's score. Older results count less." },
  ];
  if (status !== null && status.chain.reputationRegistry !== null) {
    steps.push({ title: "Public reputation", where: "On chain", icon: "star", text: "The result is posted to the provider's ERC-8004 record, which anyone can read." });
  }
  return steps;
}

function LiveRecord({ catalog, status }: { catalog: Polled<CatalogView>; status: Polled<StatusView> }) {
  return (
    <section className="section" aria-labelledby="record-title">
      <div className="section-head">
        <span className="eyebrow">Live record</span>
        <h2 id="record-title">Every test result counts</h2>
        <p>Results are signed on your machine, made final on chain and added to the release's score. No reviews and no star ratings.</p>
      </div>
      <div className="evidence-grid">
        <FlowDiagram label="What happens to one test result" steps={recordFlow(ready(status))} />
        <LiveMeter catalog={catalog} status={status} />
      </div>
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
            <Badge>Example</Badge>
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
