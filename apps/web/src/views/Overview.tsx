import { ARBITRUM_SEPOLIA, CatalogView, StatusView } from "@lemma/core";
import type { ReactNode } from "react";

import { type Polled, usePolledView } from "../api.js";
import { WORKED_EXAMPLE, evaluatePricing } from "../calculator.js";
import { AddressLink } from "../components/chain.js";
import { CodeBlock, Hash } from "../components/copy.js";
import { CostComparison } from "../components/CostChart.js";
import { FlowDiagram, type FlowStep } from "../components/FlowDiagram.js";
import { Icon, type IconName } from "../components/Icon.js";
import { LiveMeter } from "../components/LiveMeter.js";
import { MarkMono } from "../components/Logo.js";
import { Badge, FeatureCard, FeatureGrid, Panel, PricingCard } from "../components/ui.js";

/**
 * The home page, in the order a buyer asks their questions: what Lemma is
 * (hero, building blocks), how it works, why the record can be trusted (live
 * evidence), what it costs (the saving, pricing), why Arbitrum, how to check
 * it, and how to start. It states only what the repository implements: what
 * runs on the testnet says so, and every live figure comes from this
 * server's catalog and status, refreshed every minute while the page is open.
 */
export function Overview() {
  const catalog = usePolledView<CatalogView>("/api/v1/catalog", CatalogView);
  const status = usePolledView<StatusView>("/api/v1/status", StatusView);
  return (
    <div className="home">
      <Hero status={status} />
      <BuildingBlocks status={status} />
      <Steps />
      <Evidence catalog={catalog} status={status} />
      <Saving />
      <WhyArbitrum />
      <Pricing catalog={catalog} status={status} />
      <VerifyIt catalog={catalog} status={status} />
      <RunYourOwn />
      <div className="cta-band">
        <div>
          <h2>Try it in your agent</h2>
          <p>About three minutes: build the bridge, add it to your agent, and install the rule.</p>
        </div>
        <a className="btn btn-primary" href="#/setup">
          Get started <Icon name="arrow" />
        </a>
      </div>
    </div>
  );
}

const ready = <T,>(polled: Polled<T>): T | null => (polled.loaded.state === "ready" ? polled.loaded.data : null);

/** Whether this server records outcomes on chain: a warranty registry with an engine. */
const onChain = (status: StatusView | null): boolean => status !== null && status.chain.registry !== null && status.chain.engine !== null;

function Hero({ status }: { status: Polled<StatusView> }) {
  const chainLive = onChain(ready(status));
  return (
    <section className="hero">
      <MarkMono size={340} className="hero-watermark" />
      <div className="hero-grid">
        <div>
          <a className="announce" href={chainLive ? "#/verify" : "#/status"}>
            <Badge tone="warn">Testnet</Badge>
            <span>{chainLive ? "Warranty registry and Stylus engine live on Arbitrum Sepolia" : "Every amount is test USDC on Arbitrum Sepolia"}</span>
            <Icon name="arrow" size={14} />
          </a>
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
    <Panel title="Example session" label="Example agent session" className="session" badge={<Badge>Illustrative</Badge>}>
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
    </Panel>
  );
}

type BlockState = "live" | "testnet" | "off";

/**
 * The building blocks, each with its state on this server. Previews and
 * receipts need no chain, so they are live wherever the server answers; the
 * rest depend on what this server runs (`StatusView`).
 */
const BLOCKS: ReadonlyArray<{ readonly icon: IconName; readonly title: string; readonly text: string; readonly state: "live" | ((status: StatusView) => BlockState) }> = [
  {
    icon: "eye",
    title: "Preview",
    text: "A free compatibility check from package metadata: reuse, adapt, build or decline. Unsupported profiles are always free.",
    state: "live",
  },
  {
    icon: "resolution",
    title: "Resolution",
    text: "A signed patch with its acceptance tests, bought for cents in USDC through x402 when a release fits.",
    state: (s) => (s.paidTools ? (s.network === ARBITRUM_SEPOLIA ? "testnet" : "live") : "off"),
  },
  {
    icon: "receipt",
    title: "Adoption receipt",
    text: "The release's own tests run on your machine, and your agent signs the outcome, pass or fail.",
    state: "live",
  },
  {
    icon: "shield",
    title: "Warranty",
    text: "A provider bond backs each sale. A failure the evaluator confirms refunds the price.",
    state: (s) => (s.chain.registry !== null ? "testnet" : "off"),
  },
  {
    icon: "gauge",
    title: "Confidence engine",
    text: "A Stylus contract folds every finalized outcome into a 90% lower bound on how often a release passes.",
    state: (s) => (s.chain.engine !== null ? "testnet" : "off"),
  },
  {
    icon: "star",
    title: "Reputation",
    text: "Each finalized outcome becomes ERC-8004 feedback for the provider's agent, which anyone can read.",
    state: (s) => (s.chain.reputationRegistry !== null ? "testnet" : "off"),
  },
];

const STATE_BADGE: Readonly<Record<BlockState, ReactNode>> = {
  live: <Badge tone="ok">Live</Badge>,
  testnet: <Badge tone="warn">Testnet</Badge>,
  off: <Badge>Off on this server</Badge>,
};

/** A block's badge: "Live" at once for a block that needs no chain, else its state once the status has loaded. */
export function blockBadge(state: "live" | ((status: StatusView) => BlockState), status: Polled<StatusView>): ReactNode {
  if (state === "live") return STATE_BADGE.live;
  const view = ready(status);
  if (view !== null) return STATE_BADGE[state(view)];
  return <Badge>{status.loaded.state === "error" ? "Unknown" : "…"}</Badge>;
}

function BuildingBlocks({ status }: { status: Polled<StatusView> }) {
  return (
    <section className="section" aria-labelledby="blocks-title">
      <div className="section-head">
        <span className="eyebrow">Building blocks</span>
        <h2 id="blocks-title">Everything an agent needs to reuse a proven integration</h2>
        <p>Free checks, paid patches with their tests, a warranty behind each sale, and a public record of how adoptions went.</p>
      </div>
      <FeatureGrid label="Building blocks">
        {BLOCKS.map((block) => (
          <FeatureCard key={block.title} icon={block.icon} title={block.title} state={blockBadge(block.state, status)}>
            {block.text}
          </FeatureCard>
        ))}
      </FeatureGrid>
    </section>
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
        <span className="eyebrow">On your machine</span>
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

/** What happens to one adoption's outcome after the tests, and where; the on-chain steps say when this server has them off. */
export function evidenceFlow(status: StatusView | null): readonly FlowStep[] {
  const off = (on: (s: StatusView) => boolean): ReactNode => (status === null || on(status) ? undefined : <Badge>Off on this server</Badge>);
  return [
    {
      title: "Adoption receipt",
      where: "Your machine",
      icon: "receipt",
      text: "The bridge runs the release's tests and your agent signs the outcome. The server checks the signature before the outcome counts.",
    },
    {
      title: "Warranty registry",
      where: "Arbitrum",
      icon: "shield",
      text: "The evaluator finalizes the outcome. A pass releases the provider's bond; a failure turns it into the buyer's refund.",
      state: off((s) => s.chain.registry !== null),
    },
    {
      title: "Stylus engine",
      where: "Arbitrum",
      icon: "gauge",
      text: "The registry records the outcome into the engine, which keeps the release's confidence. Each outcome's weight halves every 30 days.",
      state: off((s) => s.chain.engine !== null),
    },
    {
      title: "ERC-8004 reputation",
      where: "Arbitrum",
      icon: "star",
      text: "The outcome is posted as feedback to the provider's agent, so anyone can read its record.",
      state: off((s) => s.chain.reputationRegistry !== null),
    },
  ];
}

function Evidence({ catalog, status }: { catalog: Polled<CatalogView>; status: Polled<StatusView> }) {
  return (
    <section className="section" aria-labelledby="evidence-title">
      <div className="section-head">
        <span className="eyebrow">Live evidence</span>
        <h2 id="evidence-title">Every adoption becomes evidence</h2>
        <p>Not reviews: each outcome is a signed test result, finalized on chain and folded into a confidence anyone can recompute.</p>
      </div>
      <div className="evidence-grid">
        <FlowDiagram label="From one adoption to public evidence" steps={evidenceFlow(ready(status))} />
        <LiveMeter catalog={catalog} status={status} />
      </div>
    </section>
  );
}

function Saving() {
  const example = evaluatePricing(WORKED_EXAMPLE);
  return (
    <section className="section" aria-labelledby="saving-title">
      <div className="section-head">
        <span className="eyebrow">Unit economics</span>
        <h2 id="saving-title">Priced from the saving, never above 30% of it</h2>
      </div>
      <div className="stat-block">
        <div>
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

/** The claim windows of this server's releases, in words: "72 hours", or "48 to 72 hours". */
export function claimWindowText(view: CatalogView): string | null {
  const hours = [...new Set(view.releases.map((r) => r.warrantyHours))].sort((a, b) => a - b);
  const first = hours[0];
  const last = hours[hours.length - 1];
  if (first === undefined || last === undefined) return null;
  return first === last ? `${first} hours` : `${first} to ${last} hours`;
}

export function Pricing({ catalog, status }: { catalog: Polled<CatalogView>; status: Polled<StatusView> }) {
  const view = ready(catalog);
  const chain = ready(status)?.chain ?? null;
  const profiles = view === null ? [] : view.releases.flatMap((r) => r.profiles);
  const sellable = profiles.filter((p) => p.blocker === null).length;
  const claimWindow = view === null ? null : claimWindowText(view);
  return (
    <section className="section" id="pricing" aria-labelledby="pricing-title">
      <div className="section-head centered">
        <span className="eyebrow">Pricing</span>
        <h2 id="pricing-title">Free to check. Cents to buy, and only for a measured saving.</h2>
      </div>
      <div className="price-grid">
        <PricingCard
          name="Preview"
          price="Free"
          unit="every check"
          items={[
            ["profiles", "Any repository profile, supported or not"],
            ["answer", "reuse, adapt, build or decline, with the reasons"],
            ["private", "Package metadata only, never source code"],
          ]}
        />
        <PricingCard
          name="Resolution"
          featured
          price="≤ 30%"
          unit="of the measured saving"
          items={[
            ["usdc", "Paid in USDC through x402: test USDC on Arbitrum Sepolia for now"],
            ["evidence", "Sold only with frozen benchmark evidence"],
            ["now", view === null ? "For sale on this server: …" : `For sale on this server now: ${sellable} of ${profiles.length} profiles`],
          ]}
        />
        <PricingCard
          name="Warranty"
          price="Included"
          unit="backed by the provider's bond"
          items={[
            ["bond", "The bond reserves the price when the warranty activates"],
            ["refund", "A failure the evaluator confirms refunds the price"],
            [
              "window",
              chain !== null && chain.registry === null
                ? "Off on this server: it runs no warranty pipeline"
                : claimWindow === null
                  ? "Each release sets its claim window"
                  : `Claim window on this server: ${claimWindow}`,
            ],
          ]}
        />
      </div>
    </section>
  );
}

const CONTRACTS: ReadonlyArray<{ readonly field: "registry" | "engine" | "usdc" | "reputationRegistry"; readonly name: string; readonly what: string }> = [
  { field: "registry", name: "Warranty registry", what: "warranty registry address" },
  { field: "engine", name: "Compatibility engine (Stylus)", what: "compatibility engine address" },
  { field: "usdc", name: "USDC (testnet)", what: "USDC contract address" },
  { field: "reputationRegistry", name: "ERC-8004 reputation registry", what: "ERC-8004 reputation registry address" },
];

export function VerifyIt({ catalog, status }: { catalog: Polled<CatalogView>; status: Polled<StatusView> }) {
  const view = ready(status);
  const digest = ready(catalog)?.catalogDigest ?? null;
  const waiting = status.loaded.state === "error" ? "unavailable" : "…";
  return (
    <section className="section" id="verify" aria-labelledby="verify-title">
      <div className="section-head">
        <span className="eyebrow">Verify it yourself</span>
        <h2 id="verify-title">Don't take our word for it</h2>
        <p>Every claim on this page can be checked against the chain, without an account and without a key.</p>
      </div>
      <div className="verify-grid">
        <div className="card">
          <h3 className="card-title">This server's contracts</h3>
          <ul className="verify-list">
            {CONTRACTS.map((c) => {
              const address = view === null ? null : view.chain[c.field];
              const shown =
                view === null ? (
                  <span className="muted">{waiting}</span>
                ) : address === null ? (
                  <span className="muted">off on this server</span>
                ) : (
                  <AddressLink value={address} explorer={view.chain.explorer} what={c.what} />
                );
              return (
                <li key={c.field}>
                  <span>{c.name}</span>
                  <span>{shown}</span>
                </li>
              );
            })}
            <li>
              <span>Catalog digest</span>
              <span>{digest === null ? <span className="muted">{catalog.loaded.state === "error" ? "unavailable" : "…"}</span> : <Hash value={digest} what="catalog digest" />}</span>
            </li>
          </ul>
        </div>
        <div className="card">
          <h3 className="card-title">Recompute it</h3>
          <p>
            A read-only check from a checkout replays every outcome at its block's time and compares the confidence with the engine's, the registry's balance with its bonds,
            and each contract's code with its deployment record.
          </p>
          <CodeBlock code="ARBITRUM_SEPOLIA_RPC_URL=<rpc> npm run sepolia:check" label="read-only check" />
        </div>
      </div>
    </section>
  );
}

function RunYourOwn() {
  return (
    <section className="section" aria-labelledby="own-title">
      <div className="own">
        <span className="own-icon" aria-hidden="true">
          <Icon name="terminal" size={22} />
        </span>
        <div>
          <h2 id="own-title">Run your own Lemma</h2>
          <p>
            The runbook in <code>docs/deployment.md</code> takes one funded testnet key through the warranty registry, the Stylus engine, a release and its bond, and the server.
            The setup of our run on 2026-10-01 cost about 0.0006 testnet ETH in gas (<code>docs/deployments/arbitrum-sepolia.md</code>).
          </p>
        </div>
        <a className="btn btn-secondary" href="#/status">
          This server's status
        </a>
      </div>
    </section>
  );
}
