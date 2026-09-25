import { CAPABILITY_IDS, type CapabilityId, type CatalogView, type ProfileSummary, type ReleaseSummary } from "@lemma/core";
import { useState } from "react";

import { Hash } from "../components/copy.js";
import { Badge, Callout, PageHead } from "../components/ui.js";
import { CAPABILITY_TEXT, percent, reasonText, usdc, when } from "../format.js";
import { sourceUrl } from "../links.js";

export function Catalog({ view }: { view: CatalogView }) {
  const [filter, setFilter] = useState<CapabilityId | "all">("all");
  const sellable = view.releases.flatMap((r) => r.profiles).filter((p) => p.blocker === null).length;
  const capabilities = CAPABILITY_IDS.filter((c) => filter === "all" || c === filter);
  return (
    <>
      <PageHead eyebrow="Catalog" title="Capability releases">
        <p className="lead">
          Each release is a curated integration, proven on narrow repository profiles by frozen compatibility fixtures. A profile is sold only when fresh benchmark evidence
          supports its price.
        </p>
        <p className="meta-line">
          <span>
            Catalog <Hash value={view.catalogDigest} what="catalog digest" />
          </span>
          <span>as of {when(view.generatedAt)}</span>
          <span>
            chain cost {usdc(view.economics.chainCostUsdc)} per resolution
            {view.economics.status === "placeholder" ? " (a placeholder: not measured yet, so nothing is sold)" : ""}
          </span>
        </p>
      </PageHead>
      {sellable === 0 ? (
        <Callout tone="warn" title="Nothing is for sale yet">
          <p>
            Every release below can be previewed for free. A profile becomes purchasable once a frozen benchmark measures its saving and the price passes both pricing rules. See{" "}
            <a href="#/evidence">Evidence</a>.
          </p>
        </Callout>
      ) : null}
      <div className="filters" role="group" aria-label="Filter by capability">
        <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All capabilities
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
    <article className="card capability-empty">
      <div className="card-head">
        <h3>{CAPABILITY_TEXT[capability]}</h3>
        <Badge>{capability}</Badge>
      </div>
      <p className="muted">
        No release yet. An agent asking for this gets a free build answer ({reasonText("NO_RELEASE_FOR_CAPABILITY")}), and the request is counted in{" "}
        <a href="#/demand">unmet demand</a>.
      </p>
    </article>
  );
}

function Release({ release }: { release: ReleaseSummary }) {
  const source = sourceUrl(release.provenance);
  return (
    <article className="card">
      <div className="card-head">
        <h3>{release.title}</h3>
        <Badge tone="accent">{release.capability}</Badge>
        {release.provisional ? <Badge tone="warn">provisional (testnet only)</Badge> : null}
      </div>
      <p className="meta-line release-sub">
        <code>
          {release.releaseId}@{release.version}
        </code>
        <span>
          release <Hash value={release.releaseDigest} what="release digest" />
        </span>
        <span>
          source{" "}
          {source === null ? (
            "unavailable"
          ) : (
            <a href={source} rel="noopener noreferrer nofollow" target="_blank">
              {release.provenance.repository.replace("https://github.com/", "")} at {release.provenance.commit.slice(0, 10)}
            </a>
          )}{" "}
          ({release.provenance.spdxLicense})
        </span>
      </p>
      <dl className="release-meta">
        <div>
          <dt>Price</dt>
          <dd>{release.priceUsdc === "0" ? "0 USDC (not for sale)" : usdc(release.priceUsdc)}</dd>
        </div>
        <div>
          <dt>Warranty</dt>
          <dd>{release.warrantyHours} h claim window</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{when(release.expiresAt)}</dd>
        </div>
      </dl>
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
