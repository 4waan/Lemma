import { ARBITRUM_SEPOLIA_USDC, type StatusView } from "@lemma/core";

import { Hash } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { Badge, KeyValue, PageHead, Section, Stat } from "../components/ui.js";
import { networkName } from "../format.js";
import { explorerAddressUrl } from "../links.js";

export function Status({ view }: { view: StatusView }) {
  const usdcUrl = explorerAddressUrl(ARBITRUM_SEPOLIA_USDC);
  return (
    <>
      <PageHead eyebrow="Status" title="System status">
        <p className="lead">What this server is running right now. The dashboard itself is read-only: it holds no keys and cannot sign or change anything.</p>
      </PageHead>
      <dl className="stats">
        <Stat
          label="Service"
          value={view.status === "ok" ? "OK" : "Degraded"}
          tone={view.status === "ok" ? "ok" : "danger"}
          note={view.status === "ok" ? "the store answers" : "degraded: the database is not answering, so offers and resolutions may fail"}
        />
        <Stat label="Purchases" value={view.paidTools ? "Enabled" : "Previews only"} note={view.paidTools ? "x402 paid tools are registered" : "the paid tools are not registered yet"} />
        <Stat
          label="Economics"
          value={view.economics === "measured" ? "Measured" : "Not measured"}
          tone={view.economics === "measured" ? undefined : "warn"}
          note={view.economics === "measured" ? "chain cost and price floor are dated measurements" : "placeholder: nothing can be sold"}
        />
        <Stat label="Storage" value={view.store === "postgres" ? "Postgres" : "In memory"} note={view.store === "postgres" ? "durable" : "development: lost on restart"} />
      </dl>

      <Section title="Configuration">
        <div className="card">
          <KeyValue
            items={[
              ["Network", networkName(view.network)],
              ["Catalog", <Hash key="catalog" full value={view.catalogDigest} what="catalog digest" />],
              ["Releases", String(view.releases)],
              ["Provisional evidence", view.provisionalEvidence ? <Badge tone="warn">loaded (testnet only)</Badge> : "not loaded"],
              ["Schema version", view.schemaVersion],
            ]}
          />
        </div>
      </Section>

      <Section title="Contracts">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Address</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>USDC on Arbitrum Sepolia</td>
                <td>
                  <Hash value={ARBITRUM_SEPOLIA_USDC} what="USDC address" />
                </td>
                <td>
                  {usdcUrl === null ? null : (
                    <a href={usdcUrl} rel="noopener noreferrer nofollow" target="_blank">
                      View on Arbiscan <Icon name="external" size={12} />
                    </a>
                  )}
                </td>
              </tr>
              <tr>
                <td>Resolution warranty registry</td>
                <td className="muted">not deployed yet</td>
                <td>
                  <Badge tone="warn">In progress</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
