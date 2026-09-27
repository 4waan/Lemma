import { CAPABILITY_IDS, type CapabilityId, type CatalogView, type ProfileSummary, type ReleaseSummary } from "@lemma/core";
import { useState } from "react";

import { Hash } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { Badge, Callout, KeyValue, PageHead } from "../components/ui.js";
import { CAPABILITY_TEXT, percent, reasonText, usdc, when } from "../format.js";
import { sourceUrl } from "../links.js";

export function Catalog({ view }: { view: CatalogView }) {
  const [filter, setFilter] = useState<CapabilityId | "all">("all");
  const sellable = view.releases.flatMap((r) => r.profiles).filter((p) => p.blocker === null).length;
  const capabilities = CAPABILITY_IDS.filter((c) => filter === "all" || c === filter);
  return (
    <>
      <PageHead eyebrow="Catalog" title="What your agent can reuse">
        <p className="lead">Each release is a curated integration, proven on the repository profiles it fits. A release is sold only when benchmark evidence supports its price.</p>
        <p className="meta-line">
          <span>
            Catalog <Hash value={view.catalogDigest} what="catalog digest" />
          </span>
          <span>as of {when(view.generatedAt)}</span>
          <span>
            chain cost {usdc(view.economics.chainCostUsdc)} per resolution
            {view.economics.status === "placeholder" ? " (a placeholder: not measured yet)" : ""}
          </span>
        </p>
      </PageHead>
      {sellable === 0 ? (
        <Callout tone="warn" title="Nothing is for sale yet">
          <p>
            Every release can be previewed for free. A release becomes purchasable once a frozen benchmark measures its saving and the price passes both pricing rules. See{" "}
            <a href="#/evidence">Proof</a>.
          </p>
        </Callout>
      ) : null}
      <div className="filters" role="group" aria-label="Filter by capability">
        <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All
        </button>
        {CAPABILITY_IDS.map((c) => (
          <button type="button" key={c} className="chip" aria-pressed={filter === c} onClick={() => setFilter(c)}>
            {CAPABILITY_TEXT[c]}
          </button>
        ))}
      </div>
      {capabilities.map((capability) => {
        const releases = view.releases.filter((r) => r.capability === capability);
        return releases.length === 0 ? <NoRelease key={capability} capability={capability} /> : releases.map((r) => <Release key={r.releaseDigest} release={r} />);
      })}
    </>
  );
}

function NoRelease({ capability }: { capability: CapabilityId }) {
  return (
    <article className="capability-empty">
      <h3>{CAPABILITY_TEXT[capability]}</h3>
      <p>
        No release yet. An agent asking for this gets a free build answer ({reasonText("NO_RELEASE_FOR_CAPABILITY")}), and the request is counted in{" "}
        <a href="#/demand">unmet demand</a>.
      </p>
    </article>
  );
}

/** The platforms a release fits, as short chips: one entry per distinct value across its profiles. */
function fitChips(release: ReleaseSummary): string[] {
  const chips = new Set<string>();
  for (const p of release.profiles) {
    for (const language of p.platform.languages) chips.add(language);
    chips.add(p.platform.nodeMajor.min === p.platform.nodeMajor.max ? `Node ${p.platform.nodeMajor.min}` : `Node ${p.platform.nodeMajor.min}–${p.platform.nodeMajor.max}`);
    for (const pm of p.platform.packageManagers) chips.add(pm);
    for (const ms of p.platform.moduleSystems) chips.add(ms);
    for (const fw of p.platform.frameworks) chips.add(fw);
    for (const name of Object.keys(p.platform.dependencies)) chips.add(name);
  }
  return [...chips];
}

function Release({ release }: { release: ReleaseSummary }) {
  const source = sourceUrl(release.provenance);
  const sellable = release.profiles.some((p) => p.blocker === null);
  return (
    <article className="release">
      <div className="release-head">
        <h3>{CAPABILITY_TEXT[release.capability]}</h3>
        <div className="badges">
          {sellable ? <Badge tone="ok">For sale</Badge> : <Badge>Preview only</Badge>}
          {release.provisional ? <Badge tone="warn">provisional (testnet only)</Badge> : null}
        </div>
      </div>
      <p>{release.title}</p>
      <div className="fits">
        <span className="fits-label">Fits</span>
        <ul className="chips" aria-label="Fits">
          {fitChips(release).map((chip) => (
            <li key={chip}>{chip}</li>
          ))}
        </ul>
      </div>
      <dl className="release-facts">
        <div>
          <dt>Price</dt>
          <dd>{release.priceUsdc === "0" ? "not for sale yet" : usdc(release.priceUsdc)}</dd>
        </div>
        <div>
          <dt>Warranty</dt>
          <dd>{release.warrantyHours} h claim window</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {source === null ? (
              "unavailable"
            ) : (
              <a href={source} rel="noopener noreferrer nofollow" target="_blank">
                {release.provenance.repository.replace("https://github.com/", "")}
              </a>
            )}{" "}
            <span className="muted">({release.provenance.spdxLicense})</span>
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{when(release.expiresAt)}</dd>
        </div>
      </dl>
      <details className="release-details">
        <summary>
          <Icon name="chevron" size={18} />
          Details
        </summary>
        <KeyValue
          items={[
            [
              "Release",
              <code key="id">
                {release.releaseId}@{release.version}
              </code>,
            ],
            ["Release digest", <Hash key="digest" full value={release.releaseDigest} what="release digest" />],
            ["Commit", <code key="commit">{release.provenance.commit}</code>],
            ["Published", when(release.publishedAt)],
          ]}
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Platform</th>
                <th scope="col">Evidence</th>
                <th scope="col">Sale</th>
                <th scope="col" className="num">
                  All-in reduction at list price
                </th>
                <th scope="col" className="num">
                  Highest price that keeps the target
                </th>
              </tr>
            </thead>
            <tbody>
              {release.profiles.map((p) => (
                <Profile key={p.profileIndex} profile={p} />
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}

function Profile({ profile: p }: { profile: ProfileSummary }) {
  const deps = Object.entries(p.platform.dependencies).map(([name, range]) => `${name} ${range}`);
  return (
    <tr>
      <td>#{p.profileIndex}</td>
      <td>
        {p.platform.languages.join("/")}, Node {p.platform.nodeMajor.min}–{p.platform.nodeMajor.max}, {p.platform.packageManagers.join("/")}, {p.platform.moduleSystems.join("/")}
        {p.platform.frameworks.length > 0 ? `, ${p.platform.frameworks.join("/")}` : ""}
        {deps.length > 0 ? <div className="platform-deps">{deps.join("; ")}</div> : null}
      </td>
      <td>
        {p.label === "none" ? (
          <span className="muted">none</span>
        ) : p.label === "provisional" ? (
          <Badge tone="warn">probe (provisional, testnet only)</Badge>
        ) : (
          <Badge tone="accent">benchmarked</Badge>
        )}
      </td>
      <td>{p.blocker === null ? <Badge tone="ok">sellable</Badge> : <span className="muted">not sold: {reasonText(p.blocker)}</span>}</td>
      <td className="num">{p.allInReductionBps === null ? "–" : percent(p.allInReductionBps)}</td>
      <td className="num">{p.maxPriceUsdc === null ? "–" : usdc(p.maxPriceUsdc)}</td>
    </tr>
  );
}
