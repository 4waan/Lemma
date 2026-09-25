import type { CatalogView } from "@lemma/core";

import { shortHex, usdc, when } from "../format.js";

/** Every profile that carries evidence, with the benchmark numbers behind its price. */
export function Evidence({ view }: { view: CatalogView }) {
  const rows = view.releases.flatMap((r) => r.profiles.filter((p) => p.evidence !== null).map((p) => ({ release: r, profile: p })));
  return (
    <section>
      <h2>Benchmark evidence</h2>
      <p>
        A benchmarked profile is backed by a frozen, paired benchmark: control runs without Lemma and treatment runs with it, on the same task, model and fixture. Its sold saving
        is a conservative quantile of the paired savings, not the average.
      </p>
      {rows.some(({ profile }) => profile.label === "provisional") ? (
        <p className="warn-note">
          Rows marked probe are testnet-only provisional evidence: a few exploratory control runs and one treatment run with the patch applied by hand. Their saving is optimistic
          and was not measured by the frozen benchmark.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p>No profile carries evidence yet: nothing is sold until a frozen benchmark measures it.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Release and profile</th>
              <th>Benchmark</th>
              <th>Runs passed</th>
              <th>Control median cost</th>
              <th>Expected saving</th>
              <th>Tokens saved</th>
              <th>Measured / stale after</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ release, profile }) => {
              const e = profile.evidence;
              if (e === null) return null;
              return (
                <tr key={`${release.releaseDigest}-${profile.profileIndex}`}>
                  <td>
                    {release.releaseId}@{release.version} #{profile.profileIndex}
                    {profile.label === "provisional" ? <span className="badge warn">probe (provisional, testnet only)</span> : null}
                  </td>
                  <td>
                    {e.benchmarkVersion} · {e.model}
                    <div className="meta">run set {shortHex(e.runSetDigest)}</div>
                  </td>
                  <td>
                    control {e.passed.control}/{e.runs.control}, treatment {e.passed.treatment}/{e.runs.treatment}
                  </td>
                  <td>{usdc(e.controlMedianCostUsdc)}</td>
                  <td>{usdc(e.expectedRawSavingUsdc)}</td>
                  <td>{e.expectedTokenSaving.toLocaleString("en-US")}</td>
                  <td>
                    {when(e.measuredAt)}
                    <div className="meta">{when(e.staleAfter)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
