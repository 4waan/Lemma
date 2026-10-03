import type { ResolutionView, WarrantyState, WarrantyView } from "@lemma/core";
import { type ReactNode, useState } from "react";

import { AddressLink, TxLink } from "../components/chain.js";
import { Hash } from "../components/copy.js";
import { Icon, type IconName } from "../components/Icon.js";
import { Badge, KeyValue, PageHead, type Tone } from "../components/ui.js";
import { networkName, shortHex, usdc, when } from "../format.js";

/** Same rule as core's read models: a provisional release carries `+provisional-` build metadata. */
const PROVISIONAL = /\+provisional-/;

const HEX32 = /^0x[0-9a-f]{64}$/;

const STATE_TEXT: Readonly<Record<ResolutionView["state"], string>> = {
  prepared: "payment in flight",
  settled: "paid and delivered",
  expired: "payment never settled",
};

const STATE_TONE: Readonly<Record<ResolutionView["state"], Tone>> = { prepared: "warn", settled: "ok", expired: "danger" };

/** A timeline step: done, waiting, failed, not started, or closed without success or failure. */
type Mark = "done" | "wait" | "fail" | "todo" | "closed";

const MARK_ICON: Readonly<Record<Mark, IconName>> = { done: "check", wait: "clock", fail: "x", todo: "clock", closed: "check" };

/** How each warranty state reads: its badge and its step on the timeline. */
const WARRANTY: Readonly<Record<WarrantyState, { readonly badge: string; readonly tone: Tone; readonly mark: Mark }>> = {
  none: { badge: "no warranty", tone: "neutral", mark: "todo" },
  pending: { badge: "warranty pending", tone: "warn", mark: "wait" },
  active: { badge: "warranty active", tone: "ok", mark: "wait" },
  passed: { badge: "warranty passed", tone: "ok", mark: "done" },
  failed: { badge: "refund due", tone: "warn", mark: "wait" },
  refunded: { badge: "refunded", tone: "ok", mark: "done" },
  void: { badge: "warranty void", tone: "neutral", mark: "closed" },
  expired: { badge: "warranty expired", tone: "neutral", mark: "closed" },
};

/** Looks a resolution up by id. A resolution id is public; the preview id that recovers it never appears here. */
export function ResolutionLookup() {
  const [id, setId] = useState("");
  const normalized = id.trim().toLowerCase();
  const valid = HEX32.test(normalized);
  return (
    <>
      <PageHead eyebrow="Resolutions" title="Look up a resolution">
        <p className="lead">Every purchase has a public id. Its page shows what was bought, on what terms, and what happened next. Never the buyer, and never the patch.</p>
      </PageHead>
      <div className="card">
        <div className="lookup">
          <div className="field">
            <label className="field-label" htmlFor="resolution-id">
              Resolution id
            </label>
            <div className="input-wrap">
              <input
                id="resolution-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                aria-describedby="resolution-id-note"
              />
            </div>
            <span id="resolution-id-note" className="field-hint">
              The 0x id the bridge reports after a purchase.
            </span>
          </div>
          {valid ? (
            <a className="btn btn-primary" href={`#/resolutions/${normalized}`}>
              Show <Icon name="arrow" />
            </a>
          ) : (
            <span className="btn btn-secondary" aria-disabled="true">
              Show
            </span>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * One resolution: its lifecycle, its warranty and what was bought. `explorer`
 * is the block explorer the server names (`StatusView.chain.explorer`); while
 * it is null (links off, or the status not loaded yet) no explorer link is shown.
 */
export function Resolution({ view, explorer }: { view: ResolutionView; explorer: string | null }) {
  const provisional = PROVISIONAL.test(view.release.version);
  const payment: { mark: Mark; title: string; text: string } =
    view.state === "settled"
      ? { mark: "done", title: "Paid and delivered", text: "The payment settled and the patch went to the buyer's bridge." }
      : view.state === "prepared"
        ? { mark: "wait", title: "Payment in flight", text: "The payment has not settled yet. A lost answer is recovered without paying twice." }
        : { mark: "fail", title: "Payment never settled", text: "The payment window closed. Nothing was charged and no patch was sent." };
  const receipt = view.receipt;
  const adoption: { mark: Mark; title: string; text: string } =
    receipt === null
      ? { mark: "todo", title: "Waiting for the test result", text: "The buyer's bridge sends it after applying the patch and running its tests." }
      : {
          mark: receipt.outcome === "passed" ? "done" : receipt.outcome === "failed" ? "fail" : "wait",
          title: `Tests ${receipt.outcome}`,
          text: receipt.verified ? "The result's signature is verified." : "The signature is not checked yet, so the result does not count yet.",
        };
  const warranty = warrantyStep(view);
  return (
    <>
      <PageHead eyebrow="Resolution" title={`Resolution ${shortHex(view.resolutionId)}`}>
        <p className="meta-line">
          <Badge tone={STATE_TONE[view.state]}>{STATE_TEXT[view.state]}</Badge>
          {view.warranty === null ? null : <Badge tone={WARRANTY[view.warranty.state].tone}>{WARRANTY[view.warranty.state].badge}</Badge>}
          {provisional ? <Badge tone="warn">Early estimate</Badge> : null}
          <span>created on {view.createdOn} (UTC)</span>
        </p>
      </PageHead>
      <div className="grid grid-2">
        <section className="card">
          <h2 className="h3">Lifecycle</h2>
          <ol className="timeline">
            <Step mark="done" title="Offer made" text={`${usdc(view.terms.amount)}, after a free check matched the buyer's project.`} />
            <Step mark={payment.mark} title={payment.title} text={payment.text} />
            <Step
              mark={adoption.mark}
              title={adoption.title}
              text={adoption.text}
              badge={receipt === null ? undefined : receipt.verified ? <Badge tone="ok">signature verified</Badge> : <Badge tone="warn">unverified</Badge>}
            />
            <Step mark={warranty.mark} title={warranty.title} text={warranty.text} />
          </ol>
        </section>
        <Warranty warranty={view.warranty} explorer={explorer} />
      </div>
      <section className="card">
        <h2 className="h3">Details</h2>
        <KeyValue
          items={[
            ["Resolution id", <Hash key="id" full value={view.resolutionId} what="resolution id" />],
            [
              "Release",
              <code key="release">
                {view.release.releaseId}@{view.release.version}, profile #{view.release.profileIndex}
              </code>,
            ],
            ["Release digest", <Hash key="rd" full value={view.release.releaseDigest} what="release digest" />],
            ["Payload digest", <Hash key="pd" full value={view.payloadDigest} what="payload digest" />],
            ["Price", usdc(view.terms.amount)],
            ["Network", networkName(view.terms.network)],
            ["Token", <AddressLink key="asset" value={view.terms.asset} explorer={explorer} what="token contract address" />],
            ["Paid to", <AddressLink key="payTo" value={view.terms.payTo} explorer={explorer} what="payee address" />],
            ["Authorization window", `${view.terms.maxTimeoutSeconds} s`],
          ]}
        />
      </section>
    </>
  );
}

/** The warranty's step on the timeline: what happened to it, or why there is none. */
function warrantyStep(view: ResolutionView): { mark: Mark; title: string; text: string } {
  const w = view.warranty;
  if (w === null) {
    return { mark: "todo", title: "Sold without a warranty", text: "This server does not use the warranty contract." };
  }
  const mark = WARRANTY[w.state].mark;
  switch (w.state) {
    case "none":
      if (view.state === "prepared") return { mark, title: "Warranty follows the payment", text: "Once the payment settles, the provider starts the warranty." };
      if (view.state === "expired") return { mark, title: "No warranty", text: "The payment never settled, so there is nothing to warrant." };
      return { mark, title: "No warranty", text: "Bought without a warranty claim, or its release has no active warranty." };
    case "pending":
      return { mark, title: "Warranty starting", text: "The provider starts it after a short random delay, so its timing does not point to the payment." };
    case "active":
      return { mark, title: "Warranty active", text: "The evaluator settles it from the buyer's verified result before the deadline. Without one, it expires." };
    case "passed":
      return { mark, title: "Warranty passed", text: "The tests passed, and the reserved bond went back to the provider." };
    case "failed":
      return { mark, title: "Refund due", text: "The failure was confirmed. The refund waits until the buyer's bridge claims it (lemma_claim_refund)." };
    case "refunded":
      return { mark, title: "Refunded", text: "The failure was confirmed, and the refund went to the buyer's refund address." };
    case "void":
      return { mark, title: "Warranty void", text: "The result could not count. The bond went back to the provider." };
    case "expired":
      return { mark, title: "Warranty expired", text: "The claim window closed without a result, and the bond went back to the provider." };
  }
}

/** Each transaction the warranty view names, with its label: none of them is shown before it exists. */
const TRANSACTIONS: ReadonlyArray<readonly ["activation" | "outcome" | "expiry" | "withdrawal" | "feedback", string, string]> = [
  ["activation", "Activation", "activation transaction"],
  ["outcome", "Outcome", "outcome transaction"],
  ["expiry", "Expiry", "expiry transaction"],
  ["withdrawal", "Refund", "refund transaction"],
  ["feedback", "ERC-8004 feedback", "feedback transaction"],
];

/** The warranty's facts: its state, amount and claim deadline, and every transaction with its explorer page. */
function Warranty({ warranty: w, explorer }: { warranty: WarrantyView | null; explorer: string | null }) {
  const items: Array<readonly [string, ReactNode]> = [];
  if (w !== null) {
    if (w.amount !== null) {
      items.push([
        "Amount",
        <span key="amount">{usdc(w.amount)}</span>,
      ]);
    }
    if (w.claimDeadline !== null) items.push(["Claim deadline", when(w.claimDeadline)]);
    for (const [field, label, what] of TRANSACTIONS) {
      const hash = w[field];
      if (hash !== null) items.push([label, <TxLink key={field} value={hash} explorer={explorer} what={what} />]);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="h3 card-title">Warranty</h2>
        {w === null ? null : <Badge tone={WARRANTY[w.state].tone}>{WARRANTY[w.state].badge}</Badge>}
      </div>
      {w === null ? (
        <p className="muted">This server sells without a warranty.</p>
      ) : items.length === 0 ? (
        <p className="muted">
          {w.state === "pending" ? "The amount, the deadline and each transaction appear here once the warranty starts." : "This purchase has no warranty."}
        </p>
      ) : (
        <KeyValue items={items} />
      )}
      {w === null ? null : (
        <p className="small muted card-note">
          Read from the warranty contract's own events.
          {w.state === "active" ? " If the contract is paused, the deadline moves later by as long as the pause." : ""}
        </p>
      )}
    </section>
  );
}

function Step({ mark, title, text, badge }: { mark: Mark; title: string; text: string; badge?: ReactNode }) {
  const dot = mark === "todo" || mark === "closed" ? "timeline-dot" : `timeline-dot ${mark}`;
  return (
    <li>
      <span className={dot}>
        <Icon name={MARK_ICON[mark]} size={14} />
      </span>
      <h3>
        {title} {badge}
      </h3>
      <p>{text}</p>
    </li>
  );
}
