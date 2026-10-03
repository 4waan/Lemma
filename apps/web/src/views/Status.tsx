import type { ChainView, StatusView } from "@lemma/core";
import type { ReactNode } from "react";

import { AddressLink } from "../components/chain.js";
import { CodeBlock, Hash } from "../components/copy.js";
import { Badge, KeyValue, PageHead, Section, Stat } from "../components/ui.js";
import { networkName } from "../format.js";
import { explorerBase } from "../links.js";

/** This server's contracts, in the order a purchase meets them. Only the ones it uses are listed. */
const CONTRACTS: ReadonlyArray<{ readonly field: keyof Omit<ChainView, "explorer" | "providerAgentId">; readonly name: string; readonly what: string }> = [
  { field: "usdc", name: "USDC", what: "USDC contract address" },
  { field: "registry", name: "Warranty contract", what: "warranty contract address" },
  { field: "engine", name: "Score engine (Stylus)", what: "score engine address" },
  { field: "identityRegistry", name: "ERC-8004 identity registry", what: "ERC-8004 identity registry address" },
  { field: "reputationRegistry", name: "ERC-8004 reputation registry", what: "ERC-8004 reputation registry address" },
];

export function Status({ view }: { view: StatusView }) {
  const warranty = view.chain.registry !== null;
  return (
    <>
      <PageHead eyebrow="Status" title="What this server runs">
        <p className="lead">Live from this server.</p>
      </PageHead>
      <dl className="stats">
        <Stat
          label="Service"
          value={view.status === "ok" ? "OK" : "Degraded"}
          tone={view.status === "ok" ? "ok" : "danger"}
          note={view.status === "ok" ? "answering" : "the database is not answering, so purchases may fail"}
        />
        <Stat label="Purchases" value={view.paidTools ? "On" : "Previews only"} note={view.paidTools ? "paid tools ready" : "every check is free"} />
        <Stat label="Warranties" value={warranty ? "On" : "Off"} note={warranty ? "a bond backs each sale" : "sales carry no bond here"} />
        <Stat label="Prices" value={view.economics === "measured" ? "Measured" : "Free previews"} note={view.economics === "measured" ? "set from dated measurements" : "every check costs nothing"} />
        <Stat label="Storage" value={view.store === "postgres" ? "Postgres" : "In memory"} note={view.store === "postgres" ? "kept across restarts" : "cleared on restart"} />
      </dl>

      <Section title="Catalog">
        <div className="card">
          <KeyValue
            items={[
              ["Digest", <Hash key="catalog" full value={view.catalogDigest} what="catalog digest" />],
              ["Releases", String(view.releases)],
              ...(view.provisionalEvidence ? ([["Early estimates", <Badge key="early" tone="warn">loaded</Badge>]] as const) : []),
            ]}
          />
        </div>
      </Section>

      <VerifyIt view={view} />
    </>
  );
}

/**
 * Verify it yourself: the contracts this server uses, each with its explorer
 * page, and the read-only check that recomputes every score from the chain.
 */
export function VerifyIt({ view }: { view: StatusView }) {
  const { chain } = view;
  const explorer = explorerBase(chain.explorer);
  const used = CONTRACTS.filter(({ field }) => chain[field] !== null);
  const facts: Array<readonly [string, ReactNode]> = [["Network", networkName(view.network)]];
  if (explorer !== null) facts.push(["Explorer", <code key="explorer">{explorer}</code>]);
  if (chain.providerAgentId !== null) {
    facts.push([
      "Provider agent",
      <span key="agent">
        ERC-8004 agent <code>{chain.providerAgentId}</code>
      </span>,
    ]);
  }
  for (const { field, name, what } of used) {
    const address = chain[field];
    if (address !== null) facts.push([name, <AddressLink key={field} value={address} explorer={chain.explorer} what={what} />]);
  }
  return (
    <Section id="verify" title="Verify it yourself" intro="Check every claim against the chain. No account and no key needed.">
      <div className="verify-grid">
        <div className="card">
          <h3 className="card-title">This server's contracts</h3>
          <KeyValue items={facts} />
        </div>
        <div className="card">
          <h3 className="card-title">Recompute it</h3>
          <p>A read-only script replays every result. It compares the scores with the engine's, the bonds with the contract's balance, and each contract's code with its record.</p>
          <CodeBlock code="ARBITRUM_SEPOLIA_RPC_URL=<rpc> npm run sepolia:check" label="from a Lemma checkout" />
        </div>
      </div>
    </Section>
  );
}
