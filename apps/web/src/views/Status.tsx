import type { StatusView } from "@lemma/core";

import { networkName, shortHex } from "../format.js";

export function Status({ view }: { view: StatusView }) {
  return (
    <section>
      <h2>System status</h2>
      <dl>
        <dt>Service</dt>
        <dd>{view.status === "ok" ? "ok" : <span className="error">degraded: the database is not answering, so offers and resolutions may fail</span>}</dd>
        <dt>Network</dt>
        <dd>{networkName(view.network)}</dd>
        <dt>Catalog</dt>
        <dd>
          {shortHex(view.catalogDigest)}, {view.releases} releases
        </dd>
        <dt>Purchases</dt>
        <dd>{view.paidTools ? "enabled" : "disabled: previews only"}</dd>
        <dt>Provisional evidence</dt>
        <dd>{view.provisionalEvidence ? "loaded (testnet only)" : "not loaded"}</dd>
        <dt>Economics</dt>
        <dd>{view.economics === "measured" ? "measured" : "placeholder: nothing can be sold"}</dd>
        <dt>Storage</dt>
        <dd>{view.store === "postgres" ? "Postgres" : "in memory (development)"}</dd>
      </dl>
    </section>
  );
}
