import { type Preview, formatUsdc } from "@lemma/core";

/** Tool results stay small: this is what every call costs in the agent's context. */
export const MAX_TOOL_TEXT = 600;

export type DriftCheck = "none" | "likely" | "unchecked";

/**
 * The agent-facing preview answer, built only from enums, numbers and codes.
 * No catalog prose (titles, provenance, file names) reaches the model, which
 * limits prompt injection through release content.
 */
export function previewText(preview: Preview, drift: DriftCheck, purchasesEnabled: boolean, incomplete = false, alreadyBought = false): string {
  const reasons = preview.reasons.join(", ");
  let text: string;
  if (preview.decision === "build") {
    text = `Lemma: no release fits this repository (${reasons}). Build it yourself; nothing is charged.`;
  } else if (preview.decision === "decline") {
    text = `Lemma: this repository's platform is not supported (${reasons}). Build it yourself; nothing is charged.`;
  } else if (preview.offer === null) {
    text = `Lemma: a matching release exists but cannot be sold (${reasons}). Build it yourself; nothing is charged.`;
  } else {
    const o = preview.offer;
    const driftNote = drift === "likely" ? " Local files differ from what it expects: applying it will likely need adaptation, so do not buy it." : "";
    const next = drift === "likely" ? "" : alreadyBought ? " A purchase of it is already pending or stored in this bridge; do not buy it again." : purchasesEnabled ? " To use it, call lemma_buy_resolution, then lemma_apply_resolution and lemma_verify_adoption." : " Purchases are not enabled in this bridge; build it yourself.";
    text = `Lemma: a verified resolution fits (decision ${preview.decision}). Price ${formatUsdc(BigInt(o.terms.amount))} USDC; expected raw model-cost saving ${formatUsdc(BigInt(o.expectedRawSavingUsdc))} USDC, about ${o.expectedTokenSaving} tokens; offer valid until ${o.validUntil}.${driftNote}${next}`;
  }
  if (incomplete && preview.decision !== "reuse") text += " Part of the repository profile (a dependency version, the lockfile or the Node pin) could not be read exactly, which can hide a match; fix that and ask again.";
  return text.length <= MAX_TOOL_TEXT ? text : `${text.slice(0, MAX_TOOL_TEXT - 1)}…`;
}
