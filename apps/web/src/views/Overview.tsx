import { CAPABILITY_IDS, type CapabilityId, CatalogView, StatusView } from "@lemma/core";

import { type Loaded, useView } from "../api.js";
import { Icon, type IconName } from "../components/Icon.js";
import { Badge, Built, Section, Stat, type Tone } from "../components/ui.js";
import { CAPABILITY_TEXT, networkName, shortHex } from "../format.js";
import { PricingCalculator } from "./PricingCalculator.js";

/**
 * The landing page: what Lemma is, how a purchase flows, what leaves the
 * buyer's machine, how prices are bounded, and what to trust. The live
 * figures come from the read API; everything else is static and states only
 * what the repository implements, marking the rest as in progress.
 */
export function Overview() {
  const catalog = useView<CatalogView>("/api/v1/catalog", CatalogView);
  const status = useView<StatusView>("/api/v1/status", StatusView);
  return (
    <>
      <Hero />
      <LiveStats catalog={catalog} status={status} />
      <Section
        title="What Lemma sells"
        intro="Lemma does not sell open-source code. It sells the answer to whether proven integration work fits the repository in front of your agent, and a ready path to adopt it."
      >
        <div className="grid grid-3">
          {OBJECTS.map((o) => (
            <article className="card object-card" key={o.title}>
              <div className="icon-tile">
                <Icon name={o.icon} size={20} />
              </div>
              <h3>{o.title}</h3>
              <p>{o.text}</p>
              <a href={o.href}>
                {o.link} <Icon name="arrow" size={14} />
              </a>
            </article>
          ))}
        </div>
      </Section>
      <Section
        title="How it works"
        intro="One integration task, from the agent's first question to the warranty. Each step says whether it is built in this repository or still in progress."
      >
        <ol className="steps">
          {STEPS.map((s) => (
            <li className="step" key={s.title}>
              <div className="step-top">
                <span className="step-actor">{s.actor}</span>
                <Built built={s.built} />
              </div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="What leaves your machine" intro="The bridge builds a small, typed profile from manifests and lockfiles. Source code never leaves.">
        <div className="grid grid-2">
          <div className="card">
            <h3>Sent with a preview</h3>
            <ul className="check-list">
              {SENT.map((item) => (
                <li key={item}>
                  <Icon name="check" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <InterestSets catalog={catalog} />
          </div>
          <div className="card">
            <h3>Never sent</h3>
            <ul className="check-list warn">
              {NEVER_SENT.map((item) => (
                <li key={item}>
                  <Icon name="x" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
      <Section
        title="The pricing rule"
        intro="A price has to be backed by a measurement and has to leave the buyer clearly better off. Both rules are code in @lemma/core, and the catalog check refuses any price that breaks them."
      >
        <div className="rules">
          <div className="rule">
            <strong>At most 30% of the saving</strong>
            <span>The price is capped at 30% of the conservative model-cost saving a frozen benchmark measured.</span>
          </div>
          <div className="rule">
            <strong>At least 25% cheaper all-in</strong>
            <span>After the price and chain cost, the buyer still spends a quarter less than building it alone.</span>
          </div>
          <div className="rule">
            <strong>Free when it does not fit</strong>
            <span>A build or decline answer never carries a price, and an unbenchmarked profile is never sold.</span>
          </div>
        </div>
        <PricingCalculator />
      </Section>
      <Section title="What to trust" intro="This is a hackathon MVP that demonstrates an economic mechanism. These limits are stated wherever they apply.">
        <ul className="check-list warn">
          {TRUST.map((item) => (
            <li key={item}>
              <Icon name="alert" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>
      <div className="cta-band">
        <div>
          <h2>Try it in your agent</h2>
          <p>Build the bridge, add it to your MCP configuration, and ask for an x402 integration.</p>
        </div>
        <a className="btn btn-primary" href="#/setup">
          Set up the bridge <Icon name="arrow" />
        </a>
      </div>
    </>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="hero-grid">
        <div>
          <span className="eyebrow">Compatibility resolutions for coding agents</span>
          <h1>Stop paying agents to rediscover solved integrations.</h1>
          <p className="lead">
            Coding agents keep rebuilding the same integrations. Lemma checks for free whether verified prior work fits the repository in front of your agent. When it does, the
            agent buys the exact patch in USDC through x402 on Arbitrum, priced below the model cost it saves and backed by a provider bond.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#/setup">
              Set up the bridge <Icon name="arrow" />
            </a>
            <a className="btn btn-secondary" href="#/catalog">
              Browse the catalog
            </a>
          </div>
        </div>
        <aside className="answers" aria-label="The four answers to a preview">
          <div className="answers-head">
            Before building, the agent calls <code>lemma_preview</code>. It is free and answers one of four ways.
          </div>
          <ul>
            {ANSWERS.map((a) => (
              <li key={a.decision}>
                <span>
                  <Badge tone={a.tone}>{a.decision}</Badge>
                </span>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
          <div className="answers-foot">Only a match can carry a price, and only with fresh benchmark evidence behind it.</div>
        </aside>
      </div>
    </section>
  );
}

function LiveStats({ catalog, status }: { catalog: Loaded<CatalogView>; status: Loaded<StatusView> }) {
  const waiting = (l: Loaded<unknown>) => (l.state === "loading" ? "…" : "Unavailable");
  const profiles = catalog.state === "ready" ? catalog.data.releases.flatMap((r) => r.profiles) : [];
  const sellable = profiles.filter((p) => p.blocker === null).length;
  return (
    <section className="section" aria-label="Live figures from this server">
      <dl className="stats">
        <Stat
          label="Curated releases"
          value={catalog.state === "ready" ? catalog.data.releases.length : waiting(catalog)}
          note={catalog.state === "ready" ? `catalog ${shortHex(catalog.data.catalogDigest)}` : "from /api/v1/catalog"}
        />
        <Stat
          label="Profiles for sale now"
          value={catalog.state === "ready" ? `${sellable} of ${profiles.length}` : waiting(catalog)}
          note={catalog.state === "ready" && sellable === 0 ? "preview only until a frozen benchmark measures them" : "backed by fresh benchmark evidence"}
        />
        <Stat label="Settlement" value={status.state === "ready" ? networkName(status.data.network) : waiting(status)} note="USDC through x402" />
        <Stat
          label="Purchases"
          value={status.state === "ready" ? (status.data.paidTools ? "Enabled" : "Previews only") : waiting(status)}
          note={status.state === "ready" && !status.data.paidTools ? "the paid path ships with the payment work" : "x402 paid tools"}
        />
      </dl>
      {catalog.state === "error" || status.state === "error" ? (
        <p className="small error-text">Live figures are unavailable: {catalog.state === "error" ? catalog.message : status.state === "error" ? status.message : ""}</p>
      ) : null}
    </section>
  );
}

/**
 * The dependency names the catalog matches on, per capability: the only
 * package names a profile may carry. Derived from the catalog's supported
 * profiles, the same way the server builds its published interest sets.
 */
function InterestSets({ catalog }: { catalog: Loaded<CatalogView> }) {
  if (catalog.state !== "ready") return null;
  const sets = new Map<CapabilityId, Set<string>>();
  for (const release of catalog.data.releases) {
    const names = sets.get(release.capability) ?? new Set<string>();
    for (const profile of release.profiles) for (const name of Object.keys(profile.platform.dependencies)) names.add(name);
    sets.set(release.capability, names);
  }
  return (
    <>
      <p className="small muted">Dependencies a profile may name, per capability, from this catalog:</p>
      <ul className="small">
        {CAPABILITY_IDS.map((capability) => {
          const names = [...(sets.get(capability) ?? [])].sort();
          return (
            <li key={capability}>
              {CAPABILITY_TEXT[capability]}:{" "}
              {names.length === 0
                ? "none (no release yet)"
                : names.map((name, i) => (
                    <span key={name}>
                      {i > 0 ? ", " : null}
                      <code>{name}</code>
                    </span>
                  ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const ANSWERS: ReadonlyArray<{ readonly decision: string; readonly tone: Tone; readonly text: string }> = [
  { decision: "reuse", tone: "ok", text: "A verified release fits this repository as it is." },
  { decision: "adapt", tone: "accent", text: "A release fits, but local files changed since it was built. The agent merges it by hand." },
  { decision: "build", tone: "neutral", text: "Nothing fits yet. The agent builds it; nothing is charged." },
  { decision: "decline", tone: "danger", text: "An unsupported platform. Lemma will not resolve it; nothing is charged." },
];

const OBJECTS: ReadonlyArray<{ readonly icon: IconName; readonly title: string; readonly text: string; readonly href: string; readonly link: string }> = [
  {
    icon: "package",
    title: "Capability Release",
    text: "A curated, versioned integration with the repository profiles it is proven on, pinned acceptance tests, provenance, license, price and expiry.",
    href: "#/catalog",
    link: "Browse the catalog",
  },
  {
    icon: "resolution",
    title: "Compatibility Resolution",
    text: "What the agent buys: one release matched to one repository profile, delivered as a digest-checked patch with warranty terms.",
    href: "#/resolutions",
    link: "Look up a resolution",
  },
  {
    icon: "receipt",
    title: "Adoption Receipt",
    text: "The outcome after the acceptance tests run: passed, failed or abandoned. It feeds compatibility history and warranty claims.",
    href: "#/evidence",
    link: "See the evidence",
  },
];

const STEPS: ReadonlyArray<{ readonly actor: string; readonly title: string; readonly text: string; readonly built: boolean }> = [
  { actor: "Agent", title: "Ask before building", text: "The agent calls lemma_preview with a typed capability, never free text. The preview is free.", built: true },
  { actor: "Bridge", title: "Scan metadata, not code", text: "The local bridge reads manifests and lockfiles only, and sends a small, typed repository profile.", built: true },
  {
    actor: "Server",
    title: "Answer deterministically",
    text: "The resolver matches the profile against a digest-pinned catalog and answers reuse, build or decline. A no-match never carries a price.",
    built: true,
  },
  {
    actor: "Bridge",
    title: "Check the quote, then pay",
    text: "Price, network, token, recipient and daily caps are checked in code, then the bridge pays in USDC through x402 on Arbitrum.",
    built: false,
  },
  {
    actor: "Server",
    title: "Deliver and recover",
    text: "The paid call returns the resolution and a patch bundle checked by digest. A lost response is recovered without paying twice.",
    built: false,
  },
  {
    actor: "Bridge",
    title: "Preview, then apply",
    text: "The patch is previewed, then applied all or nothing through a crash-safe journal. If local files drifted, the answer becomes adapt.",
    built: true,
  },
  {
    actor: "Bridge",
    title: "Verify and record",
    text: "The release's pinned acceptance tests run without a shell. The outcome is sent as an Adoption Receipt.",
    built: true,
  },
  {
    actor: "Arbitrum",
    title: "Back it with a bond",
    text: "A provider bond backs each sale. An eligible failure inside the claim window is refunded from it.",
    built: false,
  },
];

const SENT: readonly string[] = [
  "Language, Node major version and module system.",
  "Package manager and the name of its lockfile.",
  "Detected web frameworks.",
  "Exact installed versions of the dependencies the catalog matches on, and no others.",
];

const NEVER_SENT: readonly string[] = [
  "Source files or their contents.",
  "File paths, environment variables or Git history.",
  "Names of your other dependencies, including internal packages.",
  "Wallet keys. They never enter the model's context either.",
];

const TRUST: readonly string[] = [
  "Everything runs on Arbitrum Sepolia. Amounts are test USDC, not revenue.",
  "Evidence marked provisional comes from an exploratory probe, not the frozen benchmark, and exists only on testnet.",
  "The server, the provider and the outcome evaluator are operated by the Lemma team. This demonstrates an economic mechanism, not trustless software correctness.",
  "The warranty registry is not deployed yet. Until it is, no provider bond backs a purchase.",
];
