import { type DemandView, rankUnmetDemand } from "@lemma/core";

import { reasonText } from "../format.js";

/** What agents asked for that Lemma could not sell, ranked: the list of what to build next. */
export function Demand({ view }: { view: DemandView }) {
  const ranked = rankUnmetDemand(view);
  return (
    <section>
      <h2>Unmet demand</h2>
      <p>
        Every preview is counted once per repository and day, by a salted profile digest that is discarded when the day closes. Only groups with at least {view.minProfiles}{" "}
        repositories are published, and they carry a coarse class, never dependency names or versions.
      </p>
      {ranked.length === 0 ? (
        <p>Nothing to show yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Answer</th>
              <th>Why</th>
              <th>Repository-days</th>
              <th>Days</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((d) => (
              <tr key={`${d.capability}-${d.decision}-${d.reasons.join()}`}>
                <td>{d.capability}</td>
                <td>{d.decision}</td>
                <td>{d.reasons.map(reasonText).join("; ")}</td>
                <td>{d.profileDays}</td>
                <td>{d.days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
