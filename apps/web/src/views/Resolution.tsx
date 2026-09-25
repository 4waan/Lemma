import type { ResolutionView } from "@lemma/core";

import { networkName, shortHex, usdc, when } from "../format.js";

/** Same rule as core's read models: a provisional release carries `+provisional-` build metadata. */
const PROVISIONAL = /\+provisional-/;

const STATE_TEXT: Readonly<Record<ResolutionView["state"], string>> = {
  prepared: "payment in flight",
  settled: "paid and delivered",
  expired: "payment never settled",
};

export function Resolution({ view }: { view: ResolutionView }) {
  return (
    <section>
      <h2>Resolution {shortHex(view.resolutionId)}</h2>
      <dl>
        <dt>State</dt>
        <dd>{STATE_TEXT[view.state]}</dd>
        <dt>Release</dt>
        <dd>
          {view.release.releaseId}@{view.release.version}, profile #{view.release.profileIndex}
          {PROVISIONAL.test(view.release.version) ? <span className="badge warn">provisional (testnet only)</span> : null}
          <div className="meta">{shortHex(view.release.releaseDigest)}</div>
        </dd>
        <dt>Payload</dt>
        <dd>{shortHex(view.payloadDigest)}</dd>
        <dt>Terms</dt>
        <dd>
          {usdc(view.terms.amount)} on {networkName(view.terms.network)} to {shortHex(view.terms.payTo)}
        </dd>
        <dt>Created</dt>
        <dd>{when(view.createdAt)}</dd>
        <dt>Adoption</dt>
        <dd>
          {view.receipt === null
            ? "no receipt yet"
            : `${view.receipt.outcome}${view.receipt.verified ? " (signature verified)" : " (unverified: counts for nothing until its signature is checked)"}`}
        </dd>
      </dl>
    </section>
  );
}
