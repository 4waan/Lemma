import { useEffect, useState } from "react";

import { shortHex } from "../format.js";

type CopyState = "idle" | "copied" | "failed";

/**
 * Copies `text` to the clipboard. The Clipboard API exists only in a secure
 * context (https or localhost); elsewhere the button says so, and the value
 * stays readable on the page.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = () => {
    const clipboard: Clipboard | undefined = typeof window !== "undefined" && window.isSecureContext ? navigator.clipboard : undefined;
    if (clipboard === undefined) {
      setState("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy unavailable" : "Copy";
  return (
    <button type="button" className="copy-btn" onClick={copy} aria-label={state === "idle" ? label : shown} title={label}>
      {shown}
    </button>
  );
}

/** A digest or address: shortened in dense places, in full where someone may verify it. Always copyable. */
export function Hash({ value, full = false, what = "value" }: { value: string; full?: boolean | undefined; what?: string | undefined }) {
  return (
    <span className={full ? "hash full" : "hash"}>
      <code title={value}>{full ? value : shortHex(value)}</code>
      <CopyButton text={value} label={`Copy ${what}`} />
    </span>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string | undefined }) {
  return (
    <div className="code">
      {label === undefined ? null : <span className="code-label">{label}</span>}
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} label={label === undefined ? "Copy code" : `Copy ${label}`} />
    </div>
  );
}
