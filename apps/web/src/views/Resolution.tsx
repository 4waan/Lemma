import type { ResolutionView } from "@lemma/core";
import { type ReactNode, useState } from "react";

import { Hash } from "../components/copy.js";
import { Icon, type IconName } from "../components/Icon.js";
import { Badge, KeyValue, PageHead, type Tone } from "../components/ui.js";
import { networkName, shortHex, usdc, when } from "../format.js";
import { explorerAddressUrl } from "../links.js";

/** Same rule as core's read models: a provisional release carries `+provisional-` build metadata. */
const PROVISIONAL = /\+provisional-/;

const HEX32 = /^0x[0-9a-f]{64}$/;

const STATE_TEXT: Readonly<Record<ResolutionView["state"], string>> = {
  prepared: "payment in flight",
  settled: "paid and delivered",
  expired: "payment never settled",
};

const STATE_TONE: Readonly<Record<ResolutionView["state"], Tone>> = { prepared: "warn", settled: "ok", expired: "danger" };

type Mark = "done" | "wait" | "fail" | "todo";

const MARK_ICON: Readonly<Record<Mark, IconName>> = { done: "check", wait: "clock", fail: "x", todo: "clock" };

/** Looks a resolution up by id. A resolution id is public; the preview id that recovers it never appears here. */
export function ResolutionLookup() {
  const [id, setId] = useState("");
  const normalized = id.trim().toLowerCase();
  const valid = HEX32.test(normalized);
  return (
    <>
      <PageHead eyebrow="Resolutions" title="Look up a resolution">
        <p className="lead">
          Every paid resolution has a public id. Its page shows what was bought, on which terms, and what happened after: never the buyer, the secret that recovers the purchase, or
          the patch itself.
        </p>
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
              A 0x-prefixed 32-byte hex id, as the bridge reports it after a purchase.
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

export function Resolution({ view }: { view: ResolutionView }) {
  const provisional = PROVISIONAL.test(view.release.version);
  const payment: { mark: Mark; title: string; text: string } =
    view.state === "settled"
      ? { mark: "done", title: "Paid and delivered", text: "The x402 settlement was recorded and the patch bundle delivered to the buyer's bridge." }
      : view.state === "prepared"
        ? { mark: "wait", title: "Payment in flight", text: "The payment authorization has not settled yet. A lost response is recovered without paying twice." }
        : { mark: "fail", title: "Payment never settled", text: "The authorization window closed without settlement. No patch was delivered and nothing was charged." };
  const receipt = view.receipt;
  const adoption: { mark: Mark; title: string; text: string } =
    receipt === null
      ? { mark: "todo", title: "No adoption receipt yet", text: "The buyer's bridge sends one after it applies the patch and runs the release's acceptance tests." }
      : {
          mark: receipt.outcome === "passed" ? "done" : receipt.outcome === "failed" ? "fail" : "wait",
          title: `Acceptance tests ${receipt.outcome}`,
          text: receipt.verified ? "The receipt's signature is verified." : "The receipt is unverified: it counts for nothing until its signature is checked.",
        };
  return (
    <>
      <PageHead eyebrow="Resolution" title={`Resolution ${shortHex(view.resolutionId)}`}>
        <p className="meta-line">
          <Badge tone={STATE_TONE[view.state]}>{STATE_TEXT[view.state]}</Badge>
          {provisional ? <Badge tone="warn">provisional (testnet only)</Badge> : null}
          <span>created {when(view.createdAt)}</span>
        </p>
      </PageHead>
      <div className="grid grid-2">
        <section className="card">
          <h2 className="h3">Lifecycle</h2>
          <ol className="timeline">
            <Step mark="done" title="Offer quoted" text={`${usdc(view.terms.amount)} on ${networkName(view.terms.network)}, after a free preview matched the buyer's profile.`} />
            <Step mark={payment.mark} title={payment.title} text={payment.text} />
            <Step
              mark={adoption.mark}
              title={adoption.title}
              text={adoption.text}
              badge={receipt === null ? undefined : receipt.verified ? <Badge tone="ok">signature verified</Badge> : <Badge tone="warn">unverified</Badge>}
            />
            <Step
              mark="todo"
              title="Warranty"
              text="Warranty activation arrives with the warranty registry, which the payment work is building. Until then no provider bond backs this resolution."
            />
          </ol>
        </section>
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
              ["Token", <Address key="asset" value={view.terms.asset} />],
              ["Paid to", <Address key="payTo" value={view.terms.payTo} />],
              ["Authorization window", `${view.terms.maxTimeoutSeconds} s`],
            ]}
          />
        </section>
      </div>
    </>
  );
}

function Step({ mark, title, text, badge }: { mark: Mark; title: string; text: string; badge?: ReactNode }) {
  const dot = mark === "todo" ? "timeline-dot" : `timeline-dot ${mark}`;
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

function Address({ value }: { value: string }) {
  const href = explorerAddressUrl(value);
  return (
    <>
      <Hash value={value} what="address" />{" "}
      {href === null ? null : (
        <a href={href} rel="noopener noreferrer nofollow" target="_blank" className="small">
          Arbiscan <Icon name="external" size={12} />
        </a>
      )}
    </>
  );
}
