import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkReleaseProfile } from "@lemma/catalog";
import { type AdoptionReceipt, CapabilityId, type CapabilityRelease, type Hex32, type ReasonCode, type RepositoryProfile, type Resolution, type ResolutionDelivery, acceptanceArgv, fileDigest, profileDigest } from "@lemma/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { acceptanceScriptMissing, receiptFor, runAcceptance } from "./acceptance.js";
import { type ApplyCheck, checkApply, journalState, takeJournal } from "./apply.js";
import { PackagePath, type PaidToolContext } from "./bridge.js";
import { type PackageRef, type ResolutionInbox, type StoredReceipt, packageRef, samePackage } from "./inbox.js";
import { installCommands, installEnv, runInstalls } from "./install.js";
import { answered } from "./recovery.js";
import { type LemmaRemote, type ReceiptAnswer, RemoteError } from "./remote.js";
import type { ScanCache } from "./scan/cache.js";
import { packageDirAt } from "./scan/files.js";
import { lockfileDir } from "./scan/profile.js";
import { walletKeys } from "./secrets.js";
import {
  APPLY_RUNNING_TEXT,
  NOT_APPLIED_TEXT,
  NOT_A_PACKAGE_TEXT,
  NOT_FOR_THIS_PACKAGE_TEXT,
  NO_RESOLUTION_TEXT,
  PENDING_TEXT,
  type PlanSummary,
  UNFINISHED_TEXT,
  UNREACHABLE_TEXT,
  adaptText,
  alreadyAppliedText,
  applyFailedText,
  applyPreviewText,
  appliedText,
  noLongerFitsText,
  nodeMismatchText,
  notStartedText,
  verifyText,
  walletKeyText,
} from "./text.js";

export interface AdoptionDeps {
  readonly inbox: ResolutionInbox;
  readonly remote: LemmaRemote;
  readonly scanner: ScanCache;
  /** The workspace root; nothing above it is written. */
  readonly root: string;
  readonly cwd: () => string;
  readonly runningNodeMajor: number;
  readonly clock: () => Date;
  /** Run acceptance tests without network (Linux, `unshare`); opt-in. */
  readonly offlineAcceptance: boolean;
  /** Longest a dependency install may take. */
  readonly installTimeoutSec: number;
  /** The payment work's signing hook: the receipt's signature, or null to send it unsigned. */
  readonly signReceipt?: ((receipt: AdoptionReceipt) => Promise<AdoptionReceipt["signature"]>) | undefined;
}

const Target = { capability: CapabilityId, package: PackagePath.optional() };

/** Every lockfile name a package manager may write; each present one is copied before an install. */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"] as const;

/**
 * `lemma_apply_resolution` and `lemma_verify_adoption`. Both work on the
 * purchase `selectPurchase` finds for the capability in this package, and
 * answer in short text built from counts, codes and short validated paths.
 *
 * - Apply defaults to `preview`: what would change, or `adapt` with the
 *   drifted paths when the repository differs from the bundle's base, which
 *   also lets a later verify there count a merge by hand. With
 *   `mode: "apply"` it takes the repository's journal first, then plans and
 *   writes through it, all or nothing (apply.ts).
 * - Verify runs the release's acceptance recipe (acceptance.ts), but only on
 *   evidence about the resolution: its files in place here (or apply
 *   answered adapt here and the agent says it merged by hand), no apply
 *   running or unfinished in the repository, the recipe's script present,
 *   and the package's Node major the bridge's. It records a receipt only
 *   for a run that started: signed by the payment work's hook when there is
 *   one (never sent unsigned when the hook fails), then sent with the
 *   preview id. The first run's receipt is the one that counts; NOT_SETTLED
 *   and TOO_EARLY answers are sent again.
 */
export function adoptionTools(deps: AdoptionDeps): (server: McpServer, ctx: PaidToolContext) => void {
  return (server, ctx) => {
    server.registerTool(
      "lemma_apply_resolution",
      {
        description: 'Apply a purchased Lemma resolution. mode "preview" (default) only reports what would change; "apply" writes it, all or nothing.',
        inputSchema: z.strictObject({ ...Target, mode: z.enum(["preview", "apply"]).optional() }),
      },
      async ({ capability, package: pkg, mode }) => {
        return text(await safely(() => apply(deps, ctx, capability, pkg, mode ?? "preview")));
      },
    );
    server.registerTool(
      "lemma_verify_adoption",
      {
        description: "Run the applied resolution's acceptance tests and record the outcome. adapted: true after merging it by hand.",
        inputSchema: z.strictObject({ ...Target, adapted: z.boolean().optional() }),
      },
      async ({ capability, package: pkg, adapted }) => {
        return text(await safely(() => verify(deps, ctx, capability, pkg, adapted === true)));
      },
    );
  };
}

async function apply(deps: AdoptionDeps, ctx: PaidToolContext, capability: CapabilityId, pkg: string | undefined, mode: "preview" | "apply"): Promise<string> {
  const packageDir = packageDirFor(deps, pkg);
  if (packageDir === undefined) return NOT_A_PACKAGE_TEXT;
  const found = await selectPurchase(deps, ctx, capability, packageDir);
  if (typeof found === "string") return NO_PURCHASE_TEXT[found];
  if ("unfit" in found) return noLongerFitsText(found.unfit);
  const { delivery } = found;
  const resolutionId = delivery.resolution.resolutionId;
  const lockDir = lockfileDir(deps.root, packageDir) ?? packageDir;
  if (mode === "preview") {
    // An apply running or left unfinished in this repository would make any plan now misleading.
    const state = journalState(deps.inbox.journalDir, lockDir);
    if (state !== "none") return state === "live" ? APPLY_RUNNING_TEXT : UNFINISHED_TEXT;
    const check = checkApply(delivery.bundle, packageDir);
    return check.ok ? applyPreviewText(summarize(check)) : drifted(deps, delivery, packageDir, check.drifted);
  }
  // The repository's journal comes first: an apply left unfinished is undone and reported, and the plan is checked while no other apply there can run.
  const taken = takeJournal({ journalRoot: deps.inbox.journalDir, recoveredRoot: deps.inbox.recoveredDir, scope: lockDir });
  if (taken.status === "busy") return applyFailedText({ ok: false, step: "busy", error: "BUSY" });
  if (taken.status === "earlier") return applyFailedText({ ok: false, step: "earlier", kept: taken.kept, undone: taken.undone });
  try {
    const check = checkApply(delivery.bundle, packageDir);
    if (!check.ok) return drifted(deps, delivery, packageDir, check.drifted);
    const manager = deps.scanner.scan({ root: deps.root, cwd: packageDir, interest: [], runningNodeMajor: deps.runningNodeMajor }).profile.packageManager;
    const commands = installCommands({ packageManager: manager.name, packageDir, lockDir }, check.dependencies, check.devDependencies);
    const outcome = await taken.apply({
      resolutionId,
      packageDir,
      plan: check,
      // Every lockfile present, whichever one the install ends up writing.
      manifests: [join(packageDir, "package.json"), ...LOCKFILES.map((name) => join(lockDir, name))],
      install: (onGroup) => runInstalls(commands, { env: installEnv(), timeoutSec: deps.installTimeoutSec, onGroup }),
    });
    return outcome.ok ? appliedText(summarize(check)) : applyFailedText(outcome);
  } finally {
    taken.release();
  }
}

/** The answer when the package differs from the bundle's base: already applied, or adapt. */
function drifted(deps: AdoptionDeps, delivery: ResolutionDelivery, packageDir: string, paths: readonly string[]): string {
  // Its files already hold exactly the resolution's content: it is applied here, whoever wrote them.
  if (isApplied(delivery, packageDir)) return alreadyAppliedText();
  // Only a resolution answered with adapt here may later be verified as adapted by hand.
  deps.inbox.markAdapting(delivery.resolution.resolutionId, packageRef(deps.root, packageDir), deps.clock());
  return adaptText(paths, exportFiles(deps.inbox, delivery.resolution.resolutionId, delivery));
}

async function verify(deps: AdoptionDeps, ctx: PaidToolContext, capability: CapabilityId, pkg: string | undefined, adapted: boolean): Promise<string> {
  const keys = walletKeys();
  if (keys.length > 0) return walletKeyText(keys);
  const packageDir = packageDirFor(deps, pkg);
  if (packageDir === undefined) return NOT_A_PACKAGE_TEXT;
  const found = await selectPurchase(deps, ctx, capability, packageDir);
  if (typeof found === "string") return NO_PURCHASE_TEXT[found];
  if ("unfit" in found) return noLongerFitsText(found.unfit);
  const { delivery, release, profile } = found;
  const resolutionId = delivery.resolution.resolutionId;
  const previewId = delivery.resolution.previewId;
  // Tests run while an apply is running, or half undone, would say nothing about the resolution.
  const state = journalState(deps.inbox.journalDir, lockfileDir(deps.root, packageDir) ?? packageDir);
  if (state !== "none") return state === "live" ? APPLY_RUNNING_TEXT : UNFINISHED_TEXT;
  const earlier = deps.inbox.receipt(resolutionId);
  // A run on a resolution that is not in place says nothing about it either: nothing is run, nothing recorded.
  if (earlier === undefined && !isApplied(delivery, packageDir) && !(adapted && deps.inbox.adaptingHere(resolutionId, packageRef(deps.root, packageDir)))) return NOT_APPLIED_TEXT;
  // The tests run on the bridge's Node: a package pinned to another major would be tested on the wrong one.
  if (profile.runtime.major !== deps.runningNodeMajor) return nodeMismatchText(profile.runtime.major, deps.runningNodeMajor);
  const manager = profile.packageManager.name;
  const command = { manager, script: release.acceptanceRecipe.script };
  // Without the script the recipe runs, the package manager fails before any test: that is no result either.
  if (acceptanceScriptMissing(packageDir, release.acceptanceRecipe.script)) return notStartedText(command, "script-missing");
  const run = await runAcceptance(acceptanceArgv(release.acceptanceRecipe, manager), { cwd: packageDir, recipe: release.acceptanceRecipe, offline: deps.offlineAcceptance });
  if (!run.started) return notStartedText(command, run.notStarted);

  // The first run's receipt is the one that counts; a later run only retries sending (or signing) it, and every answer says so.
  if (earlier !== undefined) {
    const first = earlier.receipt.outcome;
    if (earlier.answer !== null) return verifyText(run, command, earlier.answer === "ACCEPTED" || earlier.answer === "DUPLICATE" ? "recorded-before" : earlier.answer, first);
    let stored = earlier;
    if (stored.needsSignature) {
      const signature = await sign(deps, stored.receipt);
      if (signature === "failed") return verifyText(run, command, "unsigned", first);
      stored = { ...stored, receipt: { ...stored.receipt, signature }, needsSignature: false };
      deps.inbox.putReceipt(stored);
    }
    return verifyText(run, command, await send(deps, stored), first);
  }

  // Never dated before the resolution: a buyer clock running slow would make the server refuse it.
  const now = new Date(Math.max(deps.clock().getTime(), Date.parse(delivery.resolution.createdAt)));
  const receipt = receiptFor(resolutionId, run, now);
  const signature = await sign(deps, receipt);
  if (signature === "failed") {
    // Kept, never sent unsigned: the first write wins on the server, so an unsigned copy would block the signed one.
    deps.inbox.putReceipt({ receipt, previewId, answer: null, lastAnswer: null, needsSignature: true });
    return verifyText(run, command, "unsigned");
  }
  const stored = { receipt: { ...receipt, signature }, previewId, answer: null, lastAnswer: null, needsSignature: false };
  deps.inbox.putReceipt(stored);
  return verifyText(run, command, await send(deps, stored));
}

/** The receipt's signature from the payment work's hook: null without a hook, "failed" when the hook throws. */
async function sign(deps: AdoptionDeps, receipt: AdoptionReceipt): Promise<AdoptionReceipt["signature"] | "failed"> {
  if (deps.signReceipt === undefined) return null;
  try {
    return await deps.signReceipt(receipt);
  } catch {
    return "failed";
  }
}

/** Posts a stored receipt and keeps the answer; "unsent" when the server could not be reached. */
async function send(deps: AdoptionDeps, stored: StoredReceipt): Promise<ReceiptAnswer | "unsent"> {
  try {
    const answer = await deps.remote.postReceipt(stored.receipt, stored.previewId);
    deps.inbox.putReceipt({ ...stored, ...answered(answer) });
    return answer;
  } catch {
    return "unsent";
  }
}

interface Purchase {
  readonly delivery: ResolutionDelivery;
  readonly release: CapabilityRelease;
}

/** Why no purchase was chosen: none for this capability, one only for other packages or profiles, the server needed and unreachable, or one for this package still settling. */
type NoPurchase = "none" | "elsewhere" | "unreachable" | "pending";

const NO_PURCHASE_TEXT: Record<NoPurchase, string> = { none: NO_RESOLUTION_TEXT, elsewhere: NOT_FOR_THIS_PACKAGE_TEXT, unreachable: UNREACHABLE_TEXT, pending: PENDING_TEXT };

/** A release manifest as the bridge can get it: stored or fetched, "missing" when the server has none, "unreachable" when it could not be asked. */
type ReleaseLookup = CapabilityRelease | "missing" | "unreachable";

/**
 * The purchase apply and verify work on, for a capability in a package:
 *
 * 1. A purchase for this package still settling comes first: it is recovered
 *    now, and while it settles the answer is to wait, never an older
 *    purchase or another package's.
 * 2. The newest one for this package: bought from a preview of it, or chosen
 *    for it before by apply or verify (`samePackage`, so a moved repository
 *    keeps it).
 * 3. Else the newest one bought for this package's current repository
 *    profile (a second worktree, a sibling package with the same profile),
 *    which is what the preview's "already bought" block matches on.
 *
 * The package must still fit the profile the purchase was made for (core
 * checks, less expiry): otherwise the answer names what no longer fits, and
 * nothing is applied or recorded. The purchase chosen is linked to the
 * package, so a later change to its profile keeps it. A candidate whose
 * release cannot be fetched makes the answer "unreachable" rather than fall
 * back to an older one, which could be the wrong purchase; one the server has
 * no manifest for is left out.
 */
async function selectPurchase(deps: AdoptionDeps, ctx: PaidToolContext, capability: CapabilityId, packageDir: string): Promise<(Purchase & { readonly profile: RepositoryProfile }) | { readonly unfit: readonly ReasonCode[] } | NoPurchase> {
  const here = packageRef(deps.root, packageDir);
  if (await pendingHere(deps, capability, here)) {
    await ctx.recover().catch(() => undefined);
    if (await pendingHere(deps, capability, here)) return "pending";
  }
  const found = await findPurchase(deps, capability, here);
  if (typeof found === "string") return found;
  const profileIndex = found.delivery.resolution.release.profileIndex;
  const supported = found.release.supportedProfiles[profileIndex];
  // Scanned for the dependencies the bought profile names, which is all the check reads; no server needed.
  const { profile } = deps.scanner.scan({ root: deps.root, cwd: packageDir, interest: Object.keys(supported?.dependencies ?? {}), runningNodeMajor: deps.runningNodeMajor });
  // Expiry only stops new sales: what was bought stays the buyer's.
  const unfit = checkReleaseProfile(found.release, profileIndex, profile, deps.clock()).filter((reason) => reason !== "RELEASE_EXPIRED");
  if (unfit.length > 0) return { unfit };
  deps.inbox.link(found.delivery.resolution.resolutionId, here);
  return { ...found, profile };
}

async function findPurchase(deps: AdoptionDeps, capability: CapabilityId, here: PackageRef): Promise<Purchase | Exclude<NoPurchase, "pending">> {
  const purchases: Array<{ resolution: Resolution; release: ReleaseLookup }> = [];
  for (const resolution of deps.inbox.resolutions()) {
    // A purchase this bridge previewed says its capability; only the others need their release to tell.
    const noted = deps.inbox.preview(resolution.previewId)?.capability;
    if (noted !== undefined && noted !== capability) continue;
    const release = await releaseOf(deps, resolution.release.releaseDigest);
    if (release === "missing" || (release !== "unreachable" && release.capability !== capability)) continue;
    purchases.push({ resolution, release });
  }
  if (purchases.length === 0) return "none";
  const forHere = pick(deps, purchases.filter((p) => deps.inbox.packagesOf(p.resolution).some((ref) => samePackage(ref, here))));
  if (forHere !== "none") return forHere;
  let interest;
  try {
    interest = await deps.remote.interest();
  } catch {
    return "unreachable";
  }
  // A package that cannot be scanned fails the call with its own error, never as an unreachable server.
  const digest = profileDigest(deps.scanner.scan({ root: deps.root, cwd: here.packageDir, interest: interest.capabilities[capability] ?? [], runningNodeMajor: deps.runningNodeMajor }).profile);
  const sameProfile = pick(deps, purchases.filter((p) => p.resolution.profileDigest === digest));
  if (sameProfile !== "none") return sameProfile;
  return purchases.some((p) => p.release === "unreachable") ? "unreachable" : "elsewhere";
}

/** The newest candidate with a stored delivery; "unreachable" when a newer one's release could not be fetched. */
function pick(deps: AdoptionDeps, candidates: ReadonlyArray<{ resolution: Resolution; release: ReleaseLookup }>): Purchase | "none" | "unreachable" {
  for (const { resolution, release } of candidates) {
    if (release === "unreachable" || release === "missing") return "unreachable";
    const delivery = deps.inbox.get(resolution.resolutionId);
    if (delivery !== undefined) return { delivery, release };
  }
  return "none";
}

/** A release manifest by digest: stored, or fetched from the server (which the client checks against the digest) and stored. */
async function releaseOf(deps: AdoptionDeps, digest: Hex32): Promise<ReleaseLookup> {
  const stored = deps.inbox.release(digest);
  if (stored !== undefined) return stored;
  try {
    const release = await deps.remote.release(digest);
    deps.inbox.putRelease(release);
    return release;
  } catch (error) {
    return error instanceof RemoteError && error.missing ? "missing" : "unreachable";
  }
}

/**
 * Whether a pending purchase may be this package's for this capability: its
 * preview was made here for this capability, or, for a mark this bridge has
 * no preview record of, its release is this capability's or cannot be read.
 */
async function pendingHere(deps: AdoptionDeps, capability: CapabilityId, here: PackageRef): Promise<boolean> {
  for (const pending of deps.inbox.pending()) {
    const noted = deps.inbox.preview(pending.previewId);
    if (noted !== undefined) {
      if (noted.capability === capability && samePackage(noted.where, here)) return true;
      continue;
    }
    if (pending.releaseDigest === undefined) return true;
    const release = await releaseOf(deps, pending.releaseDigest);
    if (typeof release === "string" || release.capability === capability) return true;
  }
  return false;
}

/** The package directory the agent named (a real directory with its own package.json, reached without links), or the working directory's package. */
function packageDirFor(deps: AdoptionDeps, pkg: string | undefined): string | undefined {
  if (pkg === undefined) return deps.scanner.packageDir(deps.root, deps.cwd());
  const dir = packageDirAt(deps.root, pkg);
  return dir === undefined ? undefined : deps.scanner.packageDir(deps.root, dir);
}

function summarize(check: Extract<ApplyCheck, { ok: true }>): PlanSummary {
  return {
    adds: check.writes.filter((w) => w.op === "add").map((w) => w.path),
    modifies: check.writes.filter((w) => w.op === "modify").map((w) => w.path),
    deletes: check.deletes,
    dependencyChanges: Object.keys(check.dependencies).length + Object.keys(check.devDependencies).length,
  };
}

/** Whether every file the bundle writes holds exactly its content, and every file it deletes is gone. */
function isApplied(delivery: ResolutionDelivery, packageDir: string): boolean {
  return delivery.bundle.files.every((f) => {
    const digest = digestAt(packageDir, f.path);
    return f.content === null ? digest === "absent" : digest === fileDigest(f.content);
  });
}

/** A regular file's digest, "absent", or "other" for anything else (links included). */
function digestAt(packageDir: string, path: string): Hex32 | "absent" | "other" {
  const full = join(packageDir, ...path.split("/"));
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return "absent";
  }
  return stat.isFile() ? fileDigest(readFileSync(full)) : "other";
}

/** Writes the resolution's files where the agent can read them to adapt by hand; returns that directory. */
function exportFiles(inbox: ResolutionInbox, resolutionId: Hex32, delivery: ResolutionDelivery): string {
  const dir = inbox.exportDir(resolutionId);
  for (const f of delivery.bundle.files) {
    if (f.content === null) continue;
    const target = join(dir, ...f.path.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, f.content, { mode: 0o600 });
  }
  return dir;
}

async function safely(fn: () => Promise<string>): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: await fn(), isError: false };
  } catch (error) {
    return { text: `Lemma: the step could not run (${error instanceof Error ? error.name : "error"}). Try again, or build it yourself.`, isError: true };
  }
}

function text(result: { text: string; isError: boolean }) {
  return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }] };
}
