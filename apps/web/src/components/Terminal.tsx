import { useCallback, useEffect, useRef, useState } from "react";

import { WORKED_EXAMPLE } from "../calculator.js";
import { DEPLOYMENT } from "../deployment.js";
import { shortHex } from "../format.js";

/**
 * The hero's agent session: a sample, played back line by line. Its prices are
 * the worked example's, and its payment is the recorded run's settlement
 * (DEPLOYMENT), so every number on it is one the site states elsewhere.
 */
export type SessionLine =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly args: string }
  | { readonly kind: "output"; readonly label: string; readonly text: string }
  | { readonly kind: "ok"; readonly text: string; readonly detail?: string }
  | { readonly kind: "diff"; readonly files: ReadonlyArray<{ readonly path: string; readonly add: number; readonly del: number }> }
  | { readonly kind: "card" };

const RELEASE = "mcp-server-payment-gating";

export const DECISION = {
  decision: "REUSE",
  release: RELEASE,
  rows: [
    ["Match", "exact pins · mcp-sdk 1.30.1"],
    ["Price", `${WORKED_EXAMPLE.price} USDC`],
    ["Saves", `about ${WORKED_EXAMPLE.saving} USDC`],
    ["Warranty", "USDC bond · 72 h to claim"],
  ],
} as const;

/** Each line, and how long to wait before it appears, in milliseconds. */
export const SESSION: ReadonlyArray<{ readonly delay: number; readonly line: SessionLine }> = [
  { delay: 400, line: { kind: "prompt", text: "Add x402 payment gating to this MCP server" } },
  { delay: 1900, line: { kind: "tool", name: "lemma_preview", args: "mcp-server.add-payment-gating" } },
  { delay: 700, line: { kind: "output", label: "profile", text: "typescript · mcp-sdk 1.30.1 · zod 4.6.5 · no source sent" } },
  { delay: 800, line: { kind: "card" } },
  { delay: 1200, line: { kind: "tool", name: "lemma_buy_resolution", args: RELEASE } },
  { delay: 600, line: { kind: "ok", text: "within your limits", detail: `${WORKED_EXAMPLE.price} ≤ 0.50 USDC` } },
  { delay: 700, line: { kind: "ok", text: "paid in USDC", detail: `tx ${shortHex(DEPLOYMENT.paymentTx)}` } },
  { delay: 800, line: { kind: "tool", name: "lemma_apply_resolution", args: "--preview" } },
  {
    delay: 600,
    line: {
      kind: "diff",
      files: [
        { path: "src/lemma/x402-paywall.ts", add: 89, del: 0 },
        { path: "src/server.ts", add: 7, del: 5 },
        { path: "test/lemma-x402-paywall.test.ts", add: 89, del: 0 },
      ],
    },
  },
  { delay: 700, line: { kind: "ok", text: "applied", detail: "every file or none · 3 files" } },
  { delay: 800, line: { kind: "tool", name: "lemma_verify_adoption", args: "" } },
  { delay: 900, line: { kind: "ok", text: "tests passed", detail: "4 of 4" } },
  { delay: 600, line: { kind: "ok", text: "result signed", detail: "warranty active · 72 h to claim" } },
];

/** The delays, made once: a new array on every render would restart the playback. */
const DELAYS: readonly number[] = SESSION.map((step) => step.delay);

/** The session as sentences, for screen readers: the animation itself is hidden from them. */
export function transcript(): string[] {
  return SESSION.map(({ line }) => {
    switch (line.kind) {
      case "prompt":
        return `You ask the agent: ${line.text}`;
      case "tool":
        return `The agent calls ${line.name}${line.args === "" ? "" : ` ${line.args}`}`;
      case "output":
        return `${line.label}: ${line.text}`;
      case "ok":
        return `${line.text}${line.detail === undefined ? "" : ` (${line.detail})`}`;
      case "diff":
        return `The patch changes ${line.files.map((f) => `${f.path} (+${f.add} −${f.del})`).join(", ")}`;
      case "card":
        return `Lemma answers ${DECISION.decision} with ${DECISION.release}: ${DECISION.rows.map(([k, v]) => `${k} ${v}`).join("; ")}`;
    }
  });
}

function reducedMotion(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveals the session's lines one after another once the terminal is in view.
 * With reduced motion, or outside a browser, every line shows at once.
 * `delays` must keep its identity between renders.
 */
export function useSession(delays: readonly number[]) {
  const total = delays.length;
  const target = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => (reducedMotion() ? total : 0));
  const [run, setRun] = useState(0);
  useEffect(() => {
    const el = target.current;
    if (reducedMotion() || el === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setRun(1);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          observer.disconnect();
          setRun(1);
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (run === 0) return undefined;
    setVisible(0);
    let at = 0;
    const timers = delays.map((delay, index) => {
      at += delay;
      return setTimeout(() => setVisible(index + 1), at);
    });
    return () => timers.forEach(clearTimeout);
  }, [run, delays]);
  const replay = useCallback(() => setRun((n) => n + 1), []);
  return { target, visible, done: visible >= total, replay };
}

/** Types `text` out while `active`; shows it whole otherwise. */
function Typed({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) {
      setShown(text.length);
      return undefined;
    }
    setShown(0);
    const timer = setInterval(() => setShown((n) => (n >= text.length ? n : n + 1)), 28);
    return () => clearInterval(timer);
  }, [active, text]);
  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length ? <span className="term-caret" /> : null}
    </>
  );
}

function Line({ line, running, typing }: { line: SessionLine; running: boolean; typing: boolean }) {
  switch (line.kind) {
    case "prompt":
      return (
        <p className="term-prompt">
          <span className="term-dim">› </span>
          <Typed text={line.text} active={typing} />
        </p>
      );
    case "tool":
      return (
        <p className="term-tool">
          {running ? <span className="term-spinner" /> : <span className="term-dim">●</span>} {line.name}
          {line.args === "" ? null : <span className="term-faint"> {line.args}</span>}
        </p>
      );
    case "output":
      return (
        <p className="term-indent term-dim">
          <span className="term-faint">{line.label} </span>
          {line.text}
        </p>
      );
    case "ok":
      return (
        <p className="term-indent">
          <span className="term-ok">✓</span> {line.text}
          {line.detail === undefined ? null : <span className="term-dim"> · {line.detail}</span>}
        </p>
      );
    case "diff":
      return (
        <ul className="term-indent term-diff">
          {line.files.map((file) => (
            <li key={file.path}>
              <span className="term-path">{file.path}</span>
              <span className="term-ok">+{file.add}</span>
              <span className="term-faint">−{file.del}</span>
            </li>
          ))}
        </ul>
      );
    case "card":
      return (
        <div className="term-indent">
          <div className="decision-card">
            <div className="decision-head">
              <span>Lemma · preview</span>
              <span className="decision-tag">{DECISION.decision}</span>
            </div>
            <p className="decision-release">{DECISION.release}</p>
            <dl>
              {DECISION.rows.map(([term, value]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      );
  }
}

/** The animated agent session for the hero, with a replay button once it has played. */
export function AgentTerminal() {
  const { target, visible, done, replay } = useSession(DELAYS);
  return (
    <div className="terminal-wrap" ref={target}>
      <div className="terminal-top">
        <span className="terminal-chip">Sample session</span>
        <button type="button" className="terminal-chip terminal-replay" onClick={replay} disabled={!done} aria-label="Replay the session">
          Replay
        </button>
      </div>
      <div className="terminal" aria-hidden="true">
        <div className="term-bar">
          <span className="term-dots">
            <span />
            <span />
            <span />
          </span>
          <span className="term-title">agent · mcp-server</span>
        </div>
        <div className="term-body">
          <p className="term-faint">lemma connected · limits 0.50 per purchase, 1.00 a day</p>
          {SESSION.map((step, index) => (
            <div key={index} className={index < visible ? "term-step shown" : "term-step"}>
              <Line line={step.line} running={index === visible - 1 && step.line.kind === "tool"} typing={index === 0 && visible === 1} />
            </div>
          ))}
        </div>
        <div className="term-status">
          <span>~/apps/mcp-server</span>
          <span>x402 · USDC</span>
        </div>
      </div>
      <ol className="sr-only" aria-label="The sample session">
        {transcript().map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
    </div>
  );
}
