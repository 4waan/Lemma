import { type DemandView, rankUnmetDemand } from "@lemma/core";

import { Badge, EmptyState, PageHead, type Tone } from "../components/ui.js";
import { CAPABILITY_TEXT, reasonText } from "../format.js";

const DECISION_TONE: Readonly<Record<string, Tone>> = { reuse: "ok", adapt: "accent", build: "neutral", decline: "danger" };

/** What agents asked for that Lemma could not sell, ranked: the list of what to build next. */
export function Demand({ view }: { view: DemandView }) {
  const ranked = rankUnmetDemand(view);
  return (
    <>
      <PageHead eyebrow="Demand" title="Unmet demand">
        <p className="lead">What agents asked for that Lemma could not sell, ranked by how many repositories asked. This is the list of what to build or benchmark next.</p>
        <p className="small muted">
          Every preview is counted once per repository and day, by a salted profile digest that is discarded when the day closes. Only groups with at least {view.minProfiles}{" "}
          repositories are published, and they carry a coarse class, never dependency names or versions.
        </p>
      </PageHead>
      {ranked.length === 0 ? (
        <EmptyState title="Nothing to show yet">
          <p>A group appears after its day closes with at least {view.minProfiles} distinct repositories, from at least as many client addresses, asking for it.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">Answer</th>
                <th scope="col">Why</th>
                <th scope="col" className="num">
                  Repository-days
                </th>
                <th scope="col" className="num">
                  Days
                </th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((d) => (
                <tr key={`${d.capability}-${d.decision}-${d.reasons.join()}`}>
                  <td>
                    {CAPABILITY_TEXT[d.capability]}
                    <div className="platform-deps">
                      <code>{d.capability}</code>
                    </div>
                  </td>
                  <td>
                    <Badge tone={DECISION_TONE[d.decision] ?? "neutral"}>{d.decision}</Badge>
                  </td>
                  <td>{d.reasons.length === 0 ? "–" : d.reasons.map(reasonText).join("; ")}</td>
                  <td className="num">{d.profileDays}</td>
                  <td className="num">{d.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
