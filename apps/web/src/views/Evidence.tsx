import type { CatalogView, ProfileSummary, ReleaseSummary } from "@lemma/core";

import { BUYERS_EXPLAINED, COMPATIBILITY_EXPLAINED, compatibilityBasis } from "../components/Compatibility.js";
import { CostComparison } from "../components/CostChart.js";
import { Hash } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { Badge, Callout, EmptyState, PageHead, Section, Stat } from "../components/ui.js";
import { percent, thousandths, usdc, when } from "../format.js";
import { PricingCalculator } from "./PricingCalculator.js";

/** The proof page: how savings are measured, every profile that carries evidence, compatibility confidence, the pricing math, and what to trust. */
export function Evidence({ view }: { view: CatalogView }) {
  const rows = view.releases.flatMap((r) => r.profiles.filter((p) => p.evidence !== null).map((p) => ({ release: r, profile: p })));
  const confident = view.releases.flatMap((r) => r.profiles.filter((p) => p.compatibility !== null).map((p) => ({ release: r, profile: p })));
  return (
    <>
      <PageHead eyebrow="Proof" title="Measured, not promised">
        <p className="lead">A release is sold only when a frozen, paired benchmark shows it lowers the cost of reaching passing tests. This is how that is measured, and what has been measured.</p>
      </PageHead>

      <Section title="The benchmark" intro="Two arms run the same task on the same model and fixture. The only difference is Lemma.">
        <div className="arms">
          <div className="arm">
            <h3>
              <Icon name="x" size={18} />
              Control: the agent alone
            </h3>
            <ol>
              <li>Gets the task and the fixture repository.</li>
              <li>Builds the integration itself.</li>
              <li>Its model cost to passing tests is recorded.</li>
            </ol>
          </div>
          <div className="arm-vs" aria-hidden="true">
            vs
          </div>
          <div className="arm treatment">
            <h3>
              <Icon name="check" size={18} />
              Treatment: the agent with Lemma
            </h3>
            <ol>
              <li>Gets the same task, plus the Lemma rule and bridge.</li>
              <li>Checks Lemma, then buys and applies the patch.</li>
              <li>Its model cost, price and chain cost are recorded.</li>
            </ol>
          </div>
        </div>
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
            <p>No profile carries evidence yet, so nothing is sold. When a benchmark runs, each measured profile appears here with its numbers and the run set they came from.</p>
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

      <Section title="Compatibility confidence" intro={COMPATIBILITY_EXPLAINED}>
        {confident.length === 0 ? (
          <EmptyState title="Nothing to be confident about yet">
            <p>No profile has benchmark evidence or a finalized adoption outcome yet. Each one that does appears here with its confidence and what it rests on.</p>
          </EmptyState>
        ) : (
          <CompatibilityTable rows={confident} />
        )}
        <p className="small muted">
          {BUYERS_EXPLAINED} The same integer engine is built as a Stylus contract for Arbitrum, where the warranty registry records each finalized outcome, so once it is deployed
          anyone can recompute these numbers on chain.
        </p>
      </Section>

      <Section title="Try the pricing math" intro="Both rules are code in the shared core package, and the catalog check refuses any price that breaks them.">
        <div className="rules">
          <div className="rule">
            <strong>At most 30% of the saving</strong>
            <span>The price is capped at 30% of the conservative model-cost saving the benchmark measured.</span>
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

      <Section id="what-to-trust" title="What to trust" intro="This is a hackathon MVP that demonstrates an economic mechanism. These limits are stated wherever they apply.">
        <ul className="check-list warn">
          {TRUST.map((item) => (
            <li key={item}>
              <Icon name="alert" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

const TRUST: readonly string[] = [
  "Everything runs on Arbitrum Sepolia. Amounts are test USDC, not revenue.",
  "Evidence marked provisional comes from an exploratory probe, not the frozen benchmark, and exists only on testnet.",
  "The server, the provider and the outcome evaluator are operated by the Lemma team, and every pass, failure and refund needs the evaluator's signature. This demonstrates an economic mechanism, not trustless software correctness.",
  "A provider bond backs a purchase only when the server runs the warranty pipeline against a deployed registry. The Status page names the registry this server uses, if any.",
  "Compatibility confidence counts only the outcomes the warranty registry recorded into its engine. Without any, it is the benchmark prior alone.",
  "A release's acceptance tests run as the buyer's own user, so they could reach the buyer's signer and the bridge's state and post a signed passing receipt before the bridge does. Until the bridge runs them out of that reach, failures and disputes rely on the evaluator.",
];

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
        {profile.compatibility === null ? null : (
          <>
            {" "}
            · compatibility confidence {percent(BigInt(profile.compatibility.confidenceBps))} ({compatibilityBasis(profile.compatibility, profile.label)})
          </>
        )}
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

function CompatibilityTable({ rows }: { rows: ReadonlyArray<{ release: ReleaseSummary; profile: ProfileSummary }> }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Release and profile</th>
            <th scope="col" className="num">
              Confidence
            </th>
            <th scope="col" className="num">
              Effective sample
            </th>
            <th scope="col" className="num">
              Outcomes
            </th>
            <th scope="col">Built from</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ release, profile }) => {
            const c = profile.compatibility;
            if (c === null) return null;
            return (
              <tr key={`${release.releaseDigest}-${profile.profileIndex}`}>
                <td>
                  {release.releaseId}@{release.version} #{profile.profileIndex}
                </td>
                <td className="num">{percent(BigInt(c.confidenceBps))}</td>
                <td className="num">{thousandths(c.effectiveNMilli)}</td>
                <td className="num">{c.outcomes}</td>
                <td>{c.source === "benchmark" ? <Badge tone={profile.label === "provisional" ? "warn" : "accent"}>{compatibilityBasis(c, profile.label)}</Badge> : compatibilityBasis(c, profile.label)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
