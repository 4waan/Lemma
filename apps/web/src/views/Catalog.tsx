import { CAPABILITY_IDS, type CapabilityId, type CatalogView, type ProfileSummary, type ReleaseSummary } from "@lemma/core";

import { COMPATIBILITY_EXPLAINED, buyersText, compatibilityBasis } from "../components/Compatibility.js";
import { Hash } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { Badge, KeyValue, PageHead } from "../components/ui.js";
import { CAPABILITY_SHORT, CAPABILITY_TEXT, EVIDENCE_LABEL, percent, usdc, when } from "../format.js";
import { sourceUrl } from "../links.js";
import { REPOSITORY_URL } from "../routes.js";

/** Where a developer starts adding a release: the catalog's authoring guide. */
export const CONTRIBUTE_URL = `${REPOSITORY_URL}/blob/main/packages/catalog/README.md#author-a-release`;

/**
 * The catalog: one compact card per release, with what a buyer decides on
 * first (what it does, its price, what it fits, the warranty, its record and
 * its source) and everything else folded under Details; then the integrations
 * without a release yet, and how to add one.
 */
export function Catalog({ view }: { view: CatalogView }) {
  const releases = CAPABILITY_IDS.flatMap((c) => view.releases.filter((r) => r.capability === c));
  const unmet = CAPABILITY_IDS.filter((c) => !view.releases.some((r) => r.capability === c));
  return (
    <>
      <PageHead eyebrow="Catalog" title="What your agent can reuse">
        <p className="lead">Tested integrations, and the projects each one fits.</p>
        <p className="meta-line">
          <span>
            {view.releases.length} {view.releases.length === 1 ? "release" : "releases"}
          </span>
          <span>updated {when(view.generatedAt)}</span>
        </p>
      </PageHead>
      <div className="release-grid">
        {releases.map((r) => (
          <Release key={r.releaseDigest} release={r} />
        ))}
      </div>
      {unmet.length === 0 ? null : <NotYet capabilities={unmet} />}
      <Contribute />
    </>
  );
}

/** Integrations with no release: one line each. Agents asking for them get a free answer to build it themselves. */
function NotYet({ capabilities }: { capabilities: readonly CapabilityId[] }) {
  return (
    <section className="not-yet" aria-labelledby="not-yet-title">
      <h2 id="not-yet-title">Not available yet</h2>
      <ul>
        {capabilities.map((c) => (
          <li key={c}>
            <strong>{CAPABILITY_SHORT[c]}</strong>
            <span className="muted">{CAPABILITY_TEXT[c]}</span>
          </li>
        ))}
      </ul>
      <p className="small muted">
        Agents asking for these get a free answer to build it themselves. Each request is counted in <a href="#/demand">Demand</a>.
      </p>
    </section>
  );
}

const CONTRIBUTE_STEPS: readonly string[] = [
  "Pick one integration and the projects it fits.",
  "Add the patch, its tests and its source commit.",
  "Run the catalog checks and open a pull request.",
];

/** How a developer adds a release, in three short steps. */
function Contribute() {
  return (
    <section className="contribute" aria-labelledby="contribute-title">
      <div>
        <h2 id="contribute-title">Add a release</h2>
        <p className="muted">Built an integration that works? Share it so every agent can reuse it.</p>
      </div>
      <ol>
        {CONTRIBUTE_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a className="btn btn-secondary" href={CONTRIBUTE_URL} target="_blank" rel="noopener noreferrer">
        Read the guide <Icon name="external" size={16} />
      </a>
    </section>
  );
}

/** What a release fits, as short chips: one entry per distinct value across its profiles. */
export function fitChips(release: ReleaseSummary): string[] {
  const chips = new Set<string>();
  for (const p of release.profiles) {
    for (const language of p.platform.languages) chips.add(language === "typescript" ? "TypeScript" : language === "javascript" ? "JavaScript" : language);
    chips.add(p.platform.nodeMajor.min === p.platform.nodeMajor.max ? `Node ${p.platform.nodeMajor.min}` : `Node ${p.platform.nodeMajor.min}–${p.platform.nodeMajor.max}`);
    for (const pm of p.platform.packageManagers) chips.add(pm);
    for (const ms of p.platform.moduleSystems) chips.add(ms === "esm" ? "ESM" : ms === "cjs" ? "CommonJS" : ms);
    for (const fw of p.platform.frameworks) chips.add(fw);
    for (const name of Object.keys(p.platform.dependencies)) chips.add(name);
  }
  return [...chips];
}

function Release({ release }: { release: ReleaseSummary }) {
  const source = sourceUrl(release.provenance);
  const sellable = release.profiles.some((p) => p.blocker === null);
  const record = release.reputation;
  return (
    <article className="release">
      <div className="release-head">
        <h3>{CAPABILITY_SHORT[release.capability]}</h3>
        {sellable ? <Badge tone="ok">{usdc(release.priceUsdc)}</Badge> : <Badge>Free preview</Badge>}
      </div>
      <p className="release-what">{CAPABILITY_TEXT[release.capability]}</p>
      <ul className="chips" aria-label="Fits">
        {fitChips(release).map((chip) => (
          <li key={chip}>{chip}</li>
        ))}
      </ul>
      <dl className="release-facts">
        <div>
          <dt>Warranty</dt>
          <dd>{release.warrantyHours} h to claim</dd>
        </div>
        {record === null ? null : (
          <div>
            <dt>Record</dt>
            <dd>
              {percent(BigInt(record.passBps))} passed · {record.count} {record.count === 1 ? "result" : "results"} · {buyersText(record.buyers)}
            </dd>
          </div>
        )}
        <div>
          <dt>Source</dt>
          <dd>
            {source === null ? (
              <span className="muted">{release.provenance.spdxLicense}</span>
            ) : (
              <a href={source} rel="noopener noreferrer nofollow" target="_blank">
                {release.provenance.repository.replace("https://github.com/", "")}
              </a>
            )}
          </dd>
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
            ["License", release.provenance.spdxLicense],
            ["Published", when(release.publishedAt)],
            ["Valid until", when(release.expiresAt)],
            ["Commit", <code key="commit">{release.provenance.commit.slice(0, 12)}</code>],
            ["Digest", <Hash key="digest" value={release.releaseDigest} what="release digest" />],
          ]}
        />
        <h4 className="profiles-title">Projects it fits</h4>
        <ul className="profile-list">
          {release.profiles.map((p) => (
            <Profile key={p.profileIndex} profile={p} />
          ))}
        </ul>
        <p className="small muted">{COMPATIBILITY_EXPLAINED}</p>
      </details>
    </article>
  );
}

function Profile({ profile: p }: { profile: ProfileSummary }) {
  const deps = Object.entries(p.platform.dependencies).map(([name, range]) => `${name} ${range}`);
  const c = p.compatibility;
  return (
    <li className="profile">
      <div className="profile-head">
        <span className="profile-name">Profile {p.profileIndex}</span>
        {p.label === "none" ? null : <Badge tone={p.label === "provisional" ? "warn" : "accent"}>{EVIDENCE_LABEL[p.label]}</Badge>}
        {p.blocker === null ? <Badge tone="ok">For sale</Badge> : <Badge>Free preview</Badge>}
      </div>
      <p className="profile-platform">
        {p.platform.languages.join("/")}, Node {p.platform.nodeMajor.min}–{p.platform.nodeMajor.max}, {p.platform.packageManagers.join("/")}, {p.platform.moduleSystems.join("/")}
        {p.platform.frameworks.length > 0 ? `, ${p.platform.frameworks.join("/")}` : ""}
        {deps.length > 0 ? ` · ${deps.join("; ")}` : ""}
      </p>
      <dl className="profile-facts">
        {p.allInReductionBps === null ? null : (
          <div>
            <dt>Cheaper than building</dt>
            <dd>{percent(p.allInReductionBps)}</dd>
          </div>
        )}
        {p.maxPriceUsdc === null ? null : (
          <div>
            <dt>Highest fair price</dt>
            <dd>{usdc(p.maxPriceUsdc)}</dd>
          </div>
        )}
        {c === null ? null : (
          <div>
            <dt>Score</dt>
            <dd>
              {percent(BigInt(c.confidenceBps))} <span className="muted">({compatibilityBasis(c, p.label)})</span>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}
