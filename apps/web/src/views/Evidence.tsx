import type { CatalogView, ProfileSummary, ReleaseSummary } from "@lemma/core";

import { BUYERS_EXPLAINED, compatibilityBasis } from "../components/Compatibility.js";
import { CostComparison } from "../components/CostChart.js";
import { Hash } from "../components/copy.js";
import { Icon, type IconName } from "../components/Icon.js";
import { Badge, Callout, PageHead, Section, Stat } from "../components/ui.js";
import { EVIDENCE_LABEL, percent, thousandths, usdc, when } from "../format.js";
import { PricingCalculator } from "./PricingCalculator.js";

/** The proof page: how savings are measured, every profile that carries evidence, the score, the pricing math, and what each guarantee covers. */
export function Evidence({ view }: { view: CatalogView }) {
  const rows = view.releases.flatMap((r) => r.profiles.filter((p) => p.evidence !== null).map((p) => ({ release: r, profile: p })));
  const scored = view.releases.flatMap((r) => r.profiles.filter((p) => p.compatibility !== null).map((p) => ({ release: r, profile: p })));
  return (
    <>
      <PageHead eyebrow="Proof" title="Measured, not promised">
        <p className="lead">A release is sold only after a benchmark shows it saves money. Here is how that is measured.</p>
      </PageHead>

      <Section title="The benchmark" intro="The same task, model and starting project, run twice. The only difference is Lemma.">
        <div className="arms">
          <div className="arm">
            <h3>
              <Icon name="x" size={18} />
              Without Lemma
            </h3>
            <ol>
              <li>Gets the task and the starting project.</li>
              <li>Writes the integration itself.</li>
              <li>We record its model cost to passing tests.</li>
            </ol>
          </div>
          <div className="arm-vs" aria-hidden="true">
            vs
          </div>
          <div className="arm treatment">
            <h3>
              <Icon name="check" size={18} />
              With Lemma
            </h3>
            <ol>
              <li>Gets the same task, plus the Lemma rule and bridge.</li>
              <li>Checks Lemma, buys the patch and applies it.</li>
              <li>We record its model cost, the price and the gas.</li>
            </ol>
          </div>
        </div>
        <dl className="stats">
          <Stat label="Paired runs" value="20" note="3 tasks, each run 3 times both ways, plus one task with no match" />
          <Stat label="Target" value="25% cheaper" note="in total cost and tokens, with the same test results" />
          <Stat label="Saving we price from" value="The low end" note="the lower quartile of the paired savings, not the average" />
          <Stat label="Spend when nothing fits" value="0 USDC" note="no match, no charge" />
        </dl>
      </Section>

      {rows.length === 0 ? null : (
        <Section title="Measured profiles">
          {rows.some(({ profile }) => profile.label === "provisional") ? (
            <Callout title="Early estimates are loaded">
              <p>An early estimate comes from a short probe: a few runs without Lemma and one with the patch applied by hand. It is more optimistic than the full benchmark.</p>
            </Callout>
          ) : null}
          <div className="grid grid-2">
            {rows.map(({ release, profile }) => (
              <EvidenceCard key={`${release.releaseDigest}-${profile.profileIndex}`} release={release} profile={profile} chainCost={BigInt(view.economics.chainCostUsdc)} />
            ))}
          </div>
          <h3 className="table-title">All numbers</h3>
          <EvidenceTable rows={rows} />
        </Section>
      )}

      <Section title="The score" intro="A cautious estimate (the 90% lower bound) of how often a release's tests pass on a project like yours.">
        <ol className="score-steps">
          {SCORE_STEPS.map((step) => (
            <li key={step.title}>
              <span className="feature-icon" aria-hidden="true">
                <Icon name={step.icon} size={18} />
              </span>
              <strong>{step.title}</strong>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
        {scored.length === 0 ? null : (
          <>
            <CompatibilityTable rows={scored} />
            <p className="small muted">{BUYERS_EXPLAINED}</p>
          </>
        )}
      </Section>

      <Section title="Try the pricing math" intro="Both rules are checked in code. Change a number to see the result.">
        <div className="rules">
          <div className="rule">
            <strong>At most 30% of the saving</strong>
            <span>The price can't go above 30% of the saving the benchmark measured.</span>
          </div>
          <div className="rule">
            <strong>At least 25% cheaper</strong>
            <span>With the price and gas paid, you still spend at least 25% less than building it.</span>
          </div>
          <div className="rule">
            <strong>Free when nothing fits</strong>
            <span>No match means no price. A patch without a benchmark is never sold.</span>
          </div>
        </div>
        <PricingCalculator />
      </Section>

      <Section id="what-to-trust" title="What to trust" intro="What each guarantee covers, in plain words.">
        <ul className="check-list">
          {TRUST.map((item) => (
            <li key={item}>
              <Icon name="info" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** How a score is built, as three steps instead of a paragraph. */
const SCORE_STEPS: ReadonlyArray<{ readonly icon: IconName; readonly title: string; readonly text: string }> = [
  { icon: "gauge", title: "Starts from the benchmark", text: "The runs with Lemma set the starting score." },
  { icon: "receipt", title: "Moves with each result", text: "Every final pass or failure updates it, on chain." },
  { icon: "clock", title: "Stays current", text: "A result counts half as much every 30 days." },
];

const TRUST: readonly string[] = [
  "Lemma runs the server and the evaluator. Every pass, failure and refund carries the evaluator's signature.",
  "A provider bond backs a purchase when the server uses the warranty contract. The Status page names it.",
  "A score counts only results the warranty contract recorded. Before the first one, it is the benchmark's starting score.",
  "An early estimate comes from a short probe, not the full benchmark.",
  "A release's tests run as your user, so they could reach your signer. Disputes go to the evaluator. Running the signer as another user keeps it out of reach.",
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
        <Badge tone={profile.label === "provisional" ? "warn" : "accent"}>{EVIDENCE_LABEL[profile.label]}</Badge>
      </div>
      <p className="small muted">
        {e.benchmarkVersion} · {e.model} · measured {when(e.measuredAt)} · {profile.allInReductionBps === null ? "–" : percent(profile.allInReductionBps)} cheaper at list price
        {profile.compatibility === null ? null : (
          <>
            {" "}
            · score {percent(BigInt(profile.compatibility.confidenceBps))} ({compatibilityBasis(profile.compatibility, profile.label)})
          </>
        )}
      </p>
      <CostComparison
        control={control}
        residual={control - saving}
        price={BigInt(release.priceUsdc)}
        gas={chainCost}
        caption="Expected cost to reach passing tests, from the measured saving"
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
              Cost without Lemma
            </th>
            <th scope="col" className="num">
              Expected saving
            </th>
            <th scope="col" className="num">
              Tokens saved
            </th>
            <th scope="col">Measured / good until</th>
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
                      <Badge tone="warn">{EVIDENCE_LABEL.provisional}</Badge>
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
                  without {e.passed.control}/{e.runs.control}, with {e.passed.treatment}/{e.runs.treatment}
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
              Score
            </th>
            <th scope="col" className="num">
              Sample size
            </th>
            <th scope="col" className="num">
              Results
            </th>
            <th scope="col">Based on</th>
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
