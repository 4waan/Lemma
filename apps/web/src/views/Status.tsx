import type { ChainView, StatusView } from "@lemma/core";
import type { ReactNode } from "react";

import { AddressLink } from "../components/chain.js";
import { Hash } from "../components/copy.js";
import { Badge, KeyValue, PageHead, Section, Stat } from "../components/ui.js";
import { networkName } from "../format.js";
import { explorerBase } from "../links.js";

/** The contracts in the chain section: each address from the status, what to call it, and why it is null when it is. */
const CONTRACTS: ReadonlyArray<{
  readonly field: keyof Omit<ChainView, "explorer" | "providerAgentId">;
  readonly name: string;
  /** How labels name its address. */
  readonly what: string;
  readonly off: (chain: ChainView) => string;
}> = [
  { field: "usdc", name: "USDC (testnet)", what: "USDC contract address", off: () => "not configured" },
  { field: "registry", name: "Warranty registry", what: "warranty registry address", off: () => "not used: this server runs no warranty pipeline" },
  {
    field: "engine",
    name: "Compatibility engine",
    what: "compatibility engine address",
    off: (chain) => (chain.registry === null ? "not used: this server runs no warranty pipeline" : "none set: the registry records outcomes into no engine"),
  },
  { field: "identityRegistry", name: "ERC-8004 identity registry", what: "ERC-8004 identity registry address", off: () => "not used: no provider agent is configured" },
  { field: "reputationRegistry", name: "ERC-8004 reputation registry", what: "ERC-8004 reputation registry address", off: () => "not used: the attester is off" },
];

export function Status({ view }: { view: StatusView }) {
  const { chain } = view;
  const warranty = chain.registry !== null;
  const explorer = explorerBase(chain.explorer);
  const facts: Array<readonly [string, ReactNode]> = [
    ["Network", networkName(view.network)],
    ["Block explorer", explorer === null ? <span className="muted">links off</span> : <code>{explorer}</code>],
    [
      "Provider agent",
      chain.providerAgentId === null ? (
        <span className="muted">none configured</span>
      ) : (
        <>
          ERC-8004 agent <code>{chain.providerAgentId}</code>
        </>
      ),
    ],
  ];
  return (
    <>
      <PageHead eyebrow="Status" title="System status">
        <p className="lead">What this server is running right now.</p>
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
          label="Warranties"
          value={warranty ? "On" : "Off"}
          note={warranty ? "provider bonds back purchases on the warranty registry" : "this server runs no warranty pipeline"}
        />
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
              ["Catalog", <Hash key="catalog" full value={view.catalogDigest} what="catalog digest" />],
              ["Releases", String(view.releases)],
              ["Provisional evidence", view.provisionalEvidence ? <Badge tone="warn">loaded (testnet only)</Badge> : "not loaded"],
              ["Schema version", view.schemaVersion],
            ]}
          />
        </div>
      </Section>

      <Section
        title="Chain"
        intro="The contracts this server works with, all on Arbitrum Sepolia (testnet), and its provider agent's public identity. The warranty registry records each finalized pass or failure into the compatibility engine."
      >
        <div className="card">
          <KeyValue items={facts} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Address</th>
              </tr>
            </thead>
            <tbody>
              {CONTRACTS.map(({ field, name, what, off }) => {
                const address = chain[field];
                return (
                  <tr key={field}>
                    <td>{name}</td>
                    <td>{address === null ? <span className="muted">{off(chain)}</span> : <AddressLink value={address} explorer={chain.explorer} what={what} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
