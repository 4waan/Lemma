import { type Preview, formatUsdc } from "@lemma/core";

import type { ApplyOutcome, Undone } from "./apply.js";

/** Tool results stay small: this is what every call costs in the agent's context. */
export const MAX_TOOL_TEXT = 600;

export type DriftCheck = "none" | "likely" | "unchecked";

/**
 * The agent-facing preview answer, built only from enums, numbers and codes.
 * No catalog prose (titles, provenance, file names) reaches the model, which
 * limits prompt injection through release content. `bought` says whether
 * this bridge already bought the offered release for this profile, or has a
 * purchase of it still settling.
 */
export function previewText(preview: Preview, drift: DriftCheck, purchasesEnabled: boolean, incomplete = false, bought?: "bought" | "pending"): string {
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
    const next =
      drift === "likely"
        ? ""
        : bought === "bought"
          ? " It is already bought in this bridge: do not buy it again; use lemma_apply_resolution."
          : bought === "pending"
            ? " A purchase of it is still settling in this bridge: do not buy it again; call lemma_apply_resolution in a minute."
            : purchasesEnabled
              ? " To use it, call lemma_buy_resolution, then lemma_apply_resolution and lemma_verify_adoption."
              : " Purchases are not enabled in this bridge; build it yourself.";
    text = `Lemma: a verified resolution fits (decision ${preview.decision}). Price ${formatUsdc(BigInt(o.terms.amount))} USDC; expected raw model-cost saving ${formatUsdc(BigInt(o.expectedRawSavingUsdc))} USDC, about ${o.expectedTokenSaving} tokens; offer valid until ${o.validUntil}.${driftNote}${next}`;
  }
  if (incomplete && preview.decision !== "reuse") text += " Part of the repository profile (a dependency version, the lockfile or the Node pin) could not be read exactly, which can hide a match; fix that and ask again.";
  return text.length <= MAX_TOOL_TEXT ? text : `${text.slice(0, MAX_TOOL_TEXT - 1)}…`;
}

/** The longest bundle path, and path segment, an answer shows, and the most path text in one answer; the rest are counted, not shown. */
export const MAX_SHOWN_PATH = 100;
export const MAX_SHOWN_SEGMENT = 40;
export const MAX_SHOWN_PATHS = 120;

/**
 * Bundle paths, as many as fit in `room` characters and `MAX_SHOWN_PATHS`.
 * Paths are chosen by the release: they are validated segments (core
 * PatchPath), and only short ones are shown, so a release can put no more
 * than a few short file names in front of the model; the rest are counted.
 */
function pathList(paths: readonly string[], room: number): string {
  const shown: string[] = [];
  let used = 0;
  room = Math.min(room, MAX_SHOWN_PATHS);
  for (const path of paths) {
    if (path.length > MAX_SHOWN_PATH || path.split("/").some((segment) => segment.length > MAX_SHOWN_SEGMENT)) continue;
    if (used + path.length + 2 > room) break;
    shown.push(path);
    used += path.length + 2;
  }
  const more = paths.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `${shown.length > 0 ? ", " : ""}and ${more} more` : ""}`;
}

const cap = (text: string) => (text.length <= MAX_TOOL_TEXT ? text : `${text.slice(0, MAX_TOOL_TEXT - 1)}…`);

export const NO_RESOLUTION_TEXT = "Lemma: no purchased resolution for this capability on this machine. Call lemma_preview first; build it yourself if there is no offer.";

export const PENDING_TEXT = "Lemma: a purchase for this capability is still settling on this machine; nothing is bought twice. Call again in a minute.";

export const UNREACHABLE_TEXT = "Lemma: the Lemma server could not be reached to tell which purchase belongs to this package, so nothing was done. Try again shortly.";

export const APPLY_RUNNING_TEXT = "Lemma: an apply is running in this repository. Wait for it, then ask again.";

export const UNFINISHED_TEXT = 'Lemma: an earlier apply in this repository did not finish. Call lemma_apply_resolution with mode "apply" to undo it first; nothing else is done until then.';

export const NOT_APPLIED_TEXT = "Lemma: the resolution is not applied here, so its acceptance tests were not run and nothing was recorded. Apply it with lemma_apply_resolution; if that answers adapt, merge by hand, then call lemma_verify_adoption with adapted: true.";

/** The package no longer fits the profile the purchase was made for: applying it, or a test result, would say nothing about the release. */
export function noLongerFitsText(reasons: readonly string[]): string {
  return cap(`Lemma: this package no longer fits the profile this machine bought the resolution for (${[...new Set(reasons)].join(", ")}), so nothing was done or recorded. Call lemma_preview to see what fits now.`);
}

export function nodeMismatchText(pinned: number, running: number): string {
  return `Lemma: this package pins Node ${pinned}, but the bridge runs Node ${running}, and acceptance tests run on the bridge's Node, so no test ran and nothing was recorded. Start the bridge with Node ${pinned}, then verify again.`;
}

export interface PlanSummary {
  readonly adds: readonly string[];
  readonly modifies: readonly string[];
  readonly deletes: readonly string[];
  readonly dependencyChanges: number;
}

export function applyPreviewText(plan: PlanSummary): string {
  const head = `Lemma: the resolution applies cleanly here: ${plan.adds.length} files to add, ${plan.modifies.length} to modify, ${plan.deletes.length} to delete, ${plan.dependencyChanges} dependency changes (installed without package scripts). To write them, call lemma_apply_resolution with mode "apply". Files: `;
  return cap(`${head}${pathList([...plan.adds, ...plan.modifies, ...plan.deletes].sort(), MAX_TOOL_TEXT - head.length - 1)}.`);
}

export function appliedText(plan: PlanSummary): string {
  return cap(`Lemma: applied ${plan.adds.length + plan.modifies.length + plan.deletes.length} file changes and ${plan.dependencyChanges} dependency changes. Next, call lemma_verify_adoption to run the release's acceptance tests.`);
}

export function alreadyAppliedText(): string {
  return "Lemma: this resolution is already applied here. Call lemma_verify_adoption to run its acceptance tests.";
}

/** Drift means adapt: nothing is written, and the resolution's files are exported for the agent to merge by hand. */
export function adaptText(drifted: readonly string[], exportDir: string): string {
  const head = `Lemma: decision adapt. ${drifted.length} paths here differ from what the resolution was built against, so nothing was written. Its files are in ${exportDir}; merge them by hand, then call lemma_verify_adoption with adapted: true. Differing: `;
  return cap(`${head}${pathList(drifted, MAX_TOOL_TEXT - head.length - 1)}.`);
}

/** What an undo did, as counts; `restored` only for an earlier apply's undo, since undoing its own changes is what a failed apply always does. */
function undoneText(undone: Undone, restored: boolean): string {
  const parts: string[] = [];
  if (restored && undone.restored > 0) parts.push(`${undone.restored} files were taken back to their state before it`);
  if (undone.putBack > 0) parts.push(`${undone.putBack} package manifests (package.json or a lockfile) were put back to their state before the install, and what they held is kept in the Lemma state directory`);
  if (undone.left > 0) parts.push(`${undone.left} files changed meanwhile were left as they are (the originals of files it had replaced are kept in the Lemma state directory)`);
  return parts.length === 0 ? "" : ` ${parts.join("; ")}.`;
}

export function applyFailedText(outcome: Extract<ApplyOutcome, { ok: false }>): string {
  switch (outcome.step) {
    case "busy":
      return outcome.error === "BUSY" ? APPLY_RUNNING_TEXT : "Lemma: another process undid this apply while it ran, so it is not recorded as applied. Check the files, then apply again.";
    case "drift":
      return "Lemma: the package changed before anything was written, so nothing was. Call lemma_apply_resolution again.";
    case "earlier":
      return cap(
        outcome.kept
          ? `Lemma: an earlier apply in this repository could not be undone completely, so nothing was written. Its journal is kept in the Lemma state directory for a person to look at, and the next apply tries again.${undoneText(outcome.undone, true)}`
          : `Lemma: an earlier unfinished apply in this repository was undone first, so nothing new was written.${undoneText(outcome.undone, true)} Check the package, then apply again.`,
      );
    case "rollback":
      return cap(`Lemma: applying failed (${outcome.error}), and undoing it could not restore every path. The journal is kept in the Lemma state directory for a person to look at; the next apply in this repository tries the undo again.${undoneText(outcome.undone, false)}`);
    default:
      return cap(`Lemma: applying failed while ${outcome.step === "write" ? "writing files" : "installing dependencies"} (${outcome.error}). The changes were rolled back.${undoneText(outcome.undone, false)}${outcome.step === "install" ? " node_modules may still need a fresh install." : ""}`);
  }
}

export const NOT_FOR_THIS_PACKAGE_TEXT = "Lemma: this machine bought this capability for another package or repository profile, not this one. Apply it where it was bought, or preview this package first.";

export const NOT_A_PACKAGE_TEXT = "Lemma: that package is not a package directory in this workspace (it needs its own package.json, reached without links). Check the path and ask again.";

/** The acceptance command as the agent may see it: the package manager and, when it looks like a test script, its name; never the recipe's arguments. */
function commandText(command: { manager: string; script: string }): string {
  // Only a short, plain test script name is shown: a longer one could carry words chosen by the release.
  return /^test(:[a-z0-9]{1,12})?$/.test(command.script) ? `${command.manager} run ${command.script}` : `${command.manager} run of the release's acceptance script`;
}

export function notStartedText(command: { manager: string; script: string }, reason: "command-not-found" | "manager-unusable" | "offline-unavailable" | "script-missing" | null): string {
  if (reason === "offline-unavailable") {
    return "Lemma: offline acceptance (LEMMA_ACCEPTANCE_OFFLINE=1) needs Linux with unprivileged network namespaces and the ip tool, which are not available here, so no test ran and nothing was recorded. Unset it, or run where it works.";
  }
  if (reason === "script-missing") {
    // Only a short, plain test script name is shown, as in every answer.
    const script = /^test(:[a-z0-9]{1,12})?$/.test(command.script) ? `"${command.script}"` : "acceptance";
    return cap(`Lemma: this package has no ${script} script (or only npm's placeholder), so no test ran and nothing was recorded. Add one that runs the project's tests, then call lemma_verify_adoption again.`);
  }
  if (reason === "manager-unusable") {
    return cap(`Lemma: ${command.manager} is on the acceptance PATH but does not run there, so no test ran and nothing was recorded. It may be a corepack shim for a version not downloaded yet (run ${command.manager} --version once in this package), or a version manager's shim that needs your HOME (put a real ${command.manager} on the bridge's PATH). Then call lemma_verify_adoption again.`);
  }
  return cap(`Lemma: the acceptance command could not start (${command.manager} not found on the acceptance PATH), so no test ran and nothing was recorded. Make ${command.manager} available, then call lemma_verify_adoption again.`);
}

export function walletKeyText(names: readonly string[]): string {
  return cap(`Lemma: acceptance tests are not run while the bridge's environment holds a wallet key (${names.join(", ")}): the tests run as your user and could read it from /proc. Start the bridge without it (load the key from a file only the signer reads), then verify again.`);
}

/** What happened to a receipt: the server's answer, or why it was not sent; "recorded-before" when the first run's receipt already has its answer. */
export type ReceiptNote = "ACCEPTED" | "DUPLICATE" | "NOT_SETTLED" | "TOO_EARLY" | "UNKNOWN_RESOLUTION" | "MISMATCH" | "unsent" | "unsigned" | "recorded-before";

/**
 * The verify answer. With `firstOutcome`, the receipt in question is the
 * first run's (the one that counts), and every note says so: this run is
 * never the one recorded.
 */
export function verifyText(run: { exitCode: number | null; timedOut: boolean; durationMs: number }, command: { manager: string; script: string }, note: ReceiptNote, firstOutcome?: string): string {
  const seconds = (run.durationMs / 1000).toFixed(1);
  const what = commandText(command);
  const result =
    run.exitCode === 0
      ? `passed (${what}, ${seconds} s)`
      : run.timedOut
        ? `timed out after ${seconds} s (${what})`
        : `failed${run.exitCode === null ? "" : ` with exit code ${run.exitCode}`} (${what}, ${seconds} s); run it yourself to see why`;
  return cap(`Lemma: acceptance ${result}. ${firstOutcome === undefined ? THIS_RUN[note] : firstRun(note, firstOutcome)}`);
}

const THIS_RUN: Record<ReceiptNote, string> = {
  ACCEPTED: "Receipt recorded.",
  DUPLICATE: "The receipt from the first run stands; this run is not recorded.",
  "recorded-before": "The receipt from the first run stands; this run is not recorded.",
  NOT_SETTLED: "The purchase has not settled yet; the receipt is kept and sent again later.",
  TOO_EARLY: "The server's clock is behind this machine's; the receipt is kept and sent again later.",
  UNKNOWN_RESOLUTION: "The server does not know this purchase, so the receipt was not recorded.",
  MISMATCH: "The server refused the receipt as inconsistent, so it was not recorded.",
  unsent: "The receipt will be sent when the Lemma server is reachable.",
  unsigned: "The receipt could not be signed yet; it is kept, never sent unsigned, and signed at the next verify.",
};

function firstRun(note: ReceiptNote, outcome: string): string {
  const first = `the first run's receipt (outcome ${outcome})`;
  const notes: Record<ReceiptNote, string> = {
    ACCEPTED: `${upper(first)} was sent now and recorded`,
    DUPLICATE: `${upper(first)} was sent now and recorded`,
    "recorded-before": `${upper(first)} is the one recorded`,
    NOT_SETTLED: `The purchase has not settled yet; ${first} is kept and sent again later`,
    TOO_EARLY: `The server's clock is behind this machine's; ${first} is kept and sent again later`,
    UNKNOWN_RESOLUTION: `The server does not know this purchase, so ${first} was not recorded`,
    MISMATCH: `The server refused ${first} as inconsistent`,
    unsent: `${upper(first)} will be sent when the Lemma server is reachable`,
    unsigned: `${upper(first)} could not be signed yet; it is kept, never sent unsigned, and signed at the next verify`,
  };
  return `${notes[note]}; this run is not recorded.`;
}

const upper = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
