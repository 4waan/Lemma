import { type CatalogView, MIN_PUBLISHED_BUYERS, type ProfileCompatibility, type ProfileSummary, type ReleaseSummary, type StatusView } from "@lemma/core";

import type { Polled } from "../api.js";
import { percent, thousandths, when } from "../format.js";
import { explorerAddressUrl } from "../links.js";
import { ExplorerLink } from "./chain.js";
import { compatibilityBasis } from "./Compatibility.js";
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
 * This server's compatibility confidence as it stands: the figure, what it
 * rests on, when the server computed it, and the engine that computes it on
 * chain from the same outcomes. It shows only what the catalog answered;
 * between answers nothing moves.
 */
export function LiveMeter({ catalog, status }: { catalog: Polled<CatalogView>; status: Polled<StatusView> }) {
  const view = catalog.loaded.state === "ready" ? catalog.loaded.data : null;
  const chain = status.loaded.state === "ready" ? status.loaded.data.chain : null;
  const pick = view === null ? null : meterPick(view);
  const engineUrl = chain === null || chain.engine === null ? null : explorerAddressUrl(chain.explorer, chain.engine);
  return (
    <Panel title="Live from this server" label="Live compatibility confidence" className="meter" badge={<span className="live-dot">Live</span>}>
      {catalog.loaded.state === "loading" ? <p className="meter-wait">Loading…</p> : null}
      {catalog.loaded.state === "error" ? <p className="meter-wait">Live figures are unavailable: {catalog.loaded.message}</p> : null}
      {view !== null && pick === null ? (
        <p className="meter-wait">No profile has a confidence yet: the first benchmark or finalized adoption on this server starts the record.</p>
      ) : null}
      {pick === null ? null : (
        <>
          <p className="meter-figure">
            <span className="meter-value">{percent(BigInt(pick.compatibility.confidenceBps))}</span>
            <span className="meter-caption">compatibility confidence, the 90% lower bound</span>
          </p>
          <dl className="meter-stats">
            <div>
              <dt>Effective n</dt>
              <dd>{thousandths(pick.compatibility.effectiveNMilli)}</dd>
            </div>
            <div>
              <dt>Outcomes</dt>
              <dd>{pick.compatibility.outcomes}</dd>
            </div>
            <div>
              <dt>Buyers</dt>
              <dd>{pick.compatibility.buyers === null ? `under ${MIN_PUBLISHED_BUYERS}` : pick.compatibility.buyers}</dd>
            </div>
          </dl>
          <p className="meter-basis">
            <code>
              {pick.release.releaseId}@{pick.release.version}
            </code>
            , profile {pick.profile.profileIndex}: {compatibilityBasis(pick.compatibility, pick.profile.label)}.
          </p>
        </>
      )}
      {view === null ? null : (
        <p className="meter-foot">
          Computed {when(view.generatedAt)}; refreshes every minute while this page is open.
          {engineUrl === null || chain === null ? null : (
            <>
              {" "}
              The Stylus engine computes it on chain from the same outcomes: <ExplorerLink href={engineUrl} explorer={chain.explorer} label="View the compatibility engine" />
            </>
          )}
        </p>
      )}
      {catalog.failure === null ? null : <p className="meter-foot">The latest refresh failed ({catalog.failure}); these figures are from the last one that loaded.</p>}
    </Panel>
  );
}
