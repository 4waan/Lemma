import type { CatalogView, ProfileSummary, ReleaseSummary } from "@lemma/core";

import { percent, reasonText, shortHex, usdc, when } from "../format.js";
import { sourceUrl } from "../links.js";

export function Catalog({ view }: { view: CatalogView }) {
  return (
    <section>
      <h2>Capability catalog</h2>
      <p className="meta">
        Catalog {shortHex(view.catalogDigest)}, as of {when(view.generatedAt)}. Chain cost per resolution {usdc(view.economics.chainCostUsdc)}
        {view.economics.status === "placeholder" ? " (a placeholder: not measured yet, so nothing is sold)" : ""}.
      </p>
      {view.releases.length === 0 ? <p>No releases yet.</p> : view.releases.map((r) => <Release key={r.releaseDigest} release={r} />)}
    </section>
  );
}

function Release({ release }: { release: ReleaseSummary }) {
  const source = sourceUrl(release.provenance);
  return (
    <article className="card">
      <h3>
        {release.title} <span className="badge">{release.capability}</span>
        {release.provisional ? <span className="badge warn">provisional (testnet only)</span> : null}
      </h3>
      <p className="meta">
        {release.releaseId}@{release.version} · {shortHex(release.releaseDigest)} · price {usdc(release.priceUsdc)} · warranty {release.warrantyHours} h · expires {when(release.expiresAt)}
      </p>
      <p className="meta">
        Source:{" "}
        {source === null ? (
          "unavailable"
        ) : (
          <a href={source} rel="noopener noreferrer nofollow" target="_blank">
            {release.provenance.repository.replace("https://", "")} at {release.provenance.commit.slice(0, 10)}
          </a>
        )}{" "}
        ({release.provenance.spdxLicense})
      </p>
      <table>
        <thead>
          <tr>
            <th>Profile</th>
            <th>Platform</th>
            <th>Evidence</th>
            <th>Sale</th>
            <th>All-in reduction at list price</th>
            <th>Highest price that keeps the target</th>
          </tr>
        </thead>
        <tbody>
          {release.profiles.map((p) => (
            <Profile key={p.profileIndex} profile={p} />
          ))}
        </tbody>
      </table>
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
        {deps.length > 0 ? <div className="meta">{deps.join("; ")}</div> : null}
      </td>
      <td>{p.label === "none" ? "none" : p.label === "provisional" ? <span className="badge warn">probe (provisional, testnet only)</span> : <span className="badge">benchmarked</span>}</td>
      <td>{p.blocker === null ? <span className="badge ok">sellable</span> : `not sold: ${reasonText(p.blocker)}`}</td>
      <td>{p.allInReductionBps === null ? "–" : percent(p.allInReductionBps)}</td>
      <td>{p.maxPriceUsdc === null ? "–" : usdc(p.maxPriceUsdc)}</td>
    </tr>
  );
}
