import type { CatalogView, ProfileSummary, ReleaseSummary } from "@lemma/core";

import { CostComparison } from "../components/CostChart.js";
import { Hash } from "../components/copy.js";
import { Badge, Callout, EmptyState, PageHead, Section, Stat } from "../components/ui.js";
import { percent, usdc, when } from "../format.js";

/** Every profile that carries evidence, with the benchmark numbers behind its price. */
export function Evidence({ view }: { view: CatalogView }) {
  const rows = view.releases.flatMap((r) => r.profiles.filter((p) => p.evidence !== null).map((p) => ({ release: r, profile: p })));
  return (
    <>
      <PageHead eyebrow="Evidence" title="Benchmark evidence">
        <p className="lead">
          A price is only as good as the measurement behind it. Lemma sells a profile only when a frozen, paired benchmark shows it lowers the all-in cost of reaching passing
          tests, without lowering correctness.
        </p>
      </PageHead>

      <Section
        title="How savings are measured"
        intro="A benchmarked profile is backed by a frozen, paired benchmark: control runs without Lemma and treatment runs with it, on the same task, model and fixture. These are the protocol's fixed parameters, set before any measured run."
      >
        <dl className="stats">
          <Stat label="Paired runs" value="20" note="3 tasks × 2 arms × 3 repetitions, plus a no-match task in both arms" />
          <Stat label="Success target" value="25% lower" note="median all-in cost and total tokens, same acceptance results" />
          <Stat label="Saving sold on" value="Lower quartile" note="of the paired savings, not the average" />
          <Stat label="No-match spend" value="0 USDC" note="the treatment arm must pay nothing when nothing fits" />
        </dl>
      </Section>

      <Section title="Measured profiles">
        {rows.some(({ profile }) => profile.label === "provisional") ? (
          <Callout tone="warn" title="Provisional evidence is loaded">
            <p>
              Rows marked probe are testnet-only provisional evidence: a few exploratory control runs and one treatment run with the patch applied by hand. Their saving is
              optimistic and was not measured by the frozen benchmark.
            </p>
          </Callout>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState title="No frozen benchmark has run yet">
            <p>No profile carries evidence yet: nothing is sold until a frozen benchmark measures it.</p>
            <p className="small muted">
              When one does, each profile appears here with its paired control and treatment numbers, the run set they came from, and the expected cost to reach green.
            </p>
          </EmptyState>
        ) : (
          <>
            <div className="grid grid-2">
              {rows.map(({ release, profile }) => (
                <EvidenceCard key={`${release.releaseDigest}-${profile.profileIndex}`} release={release} profile={profile} chainCost={BigInt(view.economics.chainCostUsdc)} />
              ))}
            </div>
            <h3 className="table-title">All numbers</h3>
            <EvidenceTable rows={rows} />
          </>
        )}
      </Section>
    </>
  );
}

function EvidenceCard({ release, profile, chainCost }: { release: ReleaseSummary; profile: ProfileSummary; chainCost: bigint }) {
  const e = profile.evidence;
  if (e === null) return null;
  const control = BigInt(e.controlMedianCostUsdc);
  const saving = BigInt(e.expectedRawSavingUsdc);
  return (
    <article className="card">
      <div className="card-head">
        <h3>
          {release.releaseId}@{release.version} #{profile.profileIndex}
        </h3>
        {profile.label === "provisional" ? <Badge tone="warn">probe (provisional, testnet only)</Badge> : <Badge tone="accent">benchmarked</Badge>}
      </div>
      <p className="small muted">
        {e.benchmarkVersion} · {e.model} · measured {when(e.measuredAt)} · all-in reduction at list price{" "}
        {profile.allInReductionBps === null ? "–" : percent(profile.allInReductionBps)}
      </p>
      <CostComparison
        control={control}
        residual={control - saving}
        price={BigInt(release.priceUsdc)}
        gas={chainCost}
        caption="Expected cost to reach passing tests, from the conservative saving"
      />
    </article>
  );
}

function EvidenceTable({ rows }: { rows: ReadonlyArray<{ release: ReleaseSummary; profile: ProfileSummary }> }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Release and profile</th>
            <th scope="col">Benchmark</th>
            <th scope="col">Runs passed</th>
            <th scope="col" className="num">
              Control median cost
            </th>
            <th scope="col" className="num">
              Expected saving
            </th>
            <th scope="col" className="num">
              Tokens saved
            </th>
            <th scope="col">Measured / stale after</th>
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
                  {profile.label === "provisional" ? (
                    <>
                      {" "}
                      <Badge tone="warn">probe (provisional, testnet only)</Badge>
                    </>
                  ) : null}
                </td>
                <td>
                  {e.benchmarkVersion} · {e.model}
                  <div className="platform-deps">
                    run set <Hash value={e.runSetDigest} what="run set digest" />
                  </div>
                </td>
                <td>
                  control {e.passed.control}/{e.runs.control}, treatment {e.passed.treatment}/{e.runs.treatment}
                </td>
                <td className="num">{usdc(e.controlMedianCostUsdc)}</td>
                <td className="num">{usdc(e.expectedRawSavingUsdc)}</td>
                <td className="num">{e.expectedTokenSaving.toLocaleString("en-US")}</td>
                <td>
                  {when(e.measuredAt)}
                  <div className="platform-deps">{when(e.staleAfter)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
