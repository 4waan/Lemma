import { type CatalogView, MIN_PUBLISHED_BUYERS, type ProfileCompatibility, type ProfileSummary, type ReleaseSummary, type StatusView } from "@lemma/core";

import type { Polled } from "../api.js";
import { percent, thousandths, when } from "../format.js";
import { explorerAddressUrl } from "../links.js";
import { ExplorerLink } from "./chain.js";
import { Panel } from "./ui.js";

export interface MeterPick {
  readonly release: ReleaseSummary;
  readonly profile: ProfileSummary;
  readonly compatibility: ProfileCompatibility;
}

const BEFORE = -1;

/** Orders confidences for the meter: more finalized outcomes first, then the larger effective sample. */
function compareForMeter(a: ProfileCompatibility, b: ProfileCompatibility): number {
  if (a.outcomes !== b.outcomes) return a.outcomes > b.outcomes ? BEFORE : 1;
  const na = BigInt(a.effectiveNMilli);
  const nb = BigInt(b.effectiveNMilli);
  return na === nb ? 0 : na > nb ? BEFORE : 1;
}

/**
 * The profile the meter shows: the one with the most finalized outcomes, then
 * the largest effective sample, the catalog's order breaking ties. Null when
 * no profile has a confidence.
 */
export function meterPick(view: CatalogView): MeterPick | null {
  let best: MeterPick | null = null;
  for (const release of view.releases) {
    for (const profile of release.profiles) {
      const compatibility = profile.compatibility;
      if (compatibility === null) continue;
      if (best === null || compareForMeter(compatibility, best.compatibility) < 0) best = { release, profile, compatibility };
    }
  }
  return best;
}

/**
 * This server's score as it stands: the pass-rate figure (compatibility
 * confidence, the 90% lower bound), what it rests on, when the server
 * computed it, and the engine that keeps it on chain. Before any profile has
 * a score, it shows the releases being scored. It shows only what the catalog
 * answered; between answers nothing moves.
 */
export function LiveMeter({ catalog, status }: { catalog: Polled<CatalogView>; status: Polled<StatusView> }) {
  const view = catalog.loaded.state === "ready" ? catalog.loaded.data : null;
  const chain = status.loaded.state === "ready" ? status.loaded.data.chain : null;
  const pick = view === null ? null : meterPick(view);
  const engineUrl = chain === null || chain.engine === null ? null : explorerAddressUrl(chain.explorer, chain.engine);
  return (
    <Panel title="Live score" label="Live score from this server" className="meter" badge={<span className="live-dot">Live</span>}>
      {catalog.loaded.state === "loading" ? <p className="meter-wait">Loading…</p> : null}
      {catalog.loaded.state === "error" ? <p className="meter-wait">Live figures are unavailable right now ({catalog.loaded.message}).</p> : null}
      {view !== null && pick === null ? (
        <p className="meter-figure">
          <span className="meter-value">{view.releases.length}</span>
          <span className="meter-caption">{view.releases.length === 1 ? "release in the catalog, scored from each test result" : "releases in the catalog, scored from each test result"}</span>
        </p>
      ) : null}
      {pick === null ? null : (
        <>
          <p className="meter-figure">
            <span className="meter-value">{percent(BigInt(pick.compatibility.confidenceBps))}</span>
            <span className="meter-caption">pass rate, a cautious estimate (90% lower bound)</span>
          </p>
          <dl className="meter-stats">
            <div>
              <dt>Test results</dt>
              <dd>{pick.compatibility.outcomes}</dd>
            </div>
            <div>
              <dt>Buyers</dt>
              <dd>{pick.compatibility.buyers === null ? `under ${MIN_PUBLISHED_BUYERS}` : pick.compatibility.buyers}</dd>
            </div>
            <div>
              <dt>Sample size</dt>
              <dd>{thousandths(pick.compatibility.effectiveNMilli)}</dd>
            </div>
          </dl>
          <p className="meter-basis">
            <code>
              {pick.release.releaseId}@{pick.release.version}
            </code>
            , profile {pick.profile.profileIndex}
          </p>
        </>
      )}
      {view === null ? null : (
        <p className="meter-foot">
          Updated {when(view.generatedAt)}. Refreshes every minute.
          {engineUrl === null || chain === null ? null : (
            <>
              {" "}
              Score engine: <ExplorerLink href={engineUrl} explorer={chain.explorer} label="View the score engine" />
            </>
          )}
        </p>
      )}
      {catalog.failure === null ? null : <p className="meter-foot">The last refresh failed ({catalog.failure}). These figures are from the one before.</p>}
    </Panel>
  );
}
