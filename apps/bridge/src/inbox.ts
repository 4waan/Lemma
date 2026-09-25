import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Address, AdoptionReceipt, CapabilityId, CapabilityRelease, Hex32, IsoTimestamp, type Resolution, ResolutionDelivery, releaseDigest } from "@lemma/core";
import { z } from "zod";

import { ReceiptAnswer } from "./remote.js";

/** `$XDG_STATE_HOME/lemma`, or `~/.local/state/lemma`: per user. An empty or relative XDG_STATE_HOME is ignored, as the XDG spec says. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "lemma");
}

/**
 * The inbox directory for a workspace: LEMMA_STATE_DIR when set and not empty,
 * else `defaultStateDir`. A relative LEMMA_STATE_DIR, or a configured one
 * (LEMMA_STATE_DIR or XDG_STATE_HOME) inside the workspace, is refused, so
 * paid bundles are never written where they could be committed.
 */
export function stateDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["LEMMA_STATE_DIR"];
  if (explicit !== undefined && explicit !== "" && !isAbsolute(explicit)) throw new Error("LEMMA_STATE_DIR must be an absolute path");
  const dir = explicit !== undefined && explicit !== "" ? explicit : defaultStateDir(env);
  const configured = dir !== join(homedir(), ".local", "state", "lemma");
  // Compared as real paths: a state directory named through a link into the workspace is still inside it.
  const rel = relative(realpathSync(root), realOrNearest(dir));
  if (configured && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("the Lemma state directory must be outside the workspace");
  return dir;
}

/** The real path of `path`, resolving its deepest existing ancestor when it does not exist yet. */
function realOrNearest(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/**
 * A purchase in progress. `releaseDigest` names what is being bought, so a new
 * offer for the same release is not paid for again; a mark without it (from an
 * older bridge) holds back every offer until it is recovered or dropped.
 */
const Pending = z.strictObject({ previewId: Hex32, buyer: Address, since: IsoTimestamp, releaseDigest: Hex32.optional() });

export type PendingPurchase = z.infer<typeof Pending>;

/**
 * A receipt kept on the buyer's machine. `answer` is the server's final answer
 * (null while it still has to be sent); `lastAnswer` a retryable one it gave;
 * `needsSignature` marks a receipt whose signing failed, which is never sent
 * unsigned and is signed again at the next verify.
 */
const StoredReceipt = z.strictObject({
  receipt: AdoptionReceipt,
  previewId: Hex32,
  answer: ReceiptAnswer.nullable(),
  lastAnswer: ReceiptAnswer.nullable(),
  needsSignature: z.boolean(),
});

export type StoredReceipt = z.infer<typeof StoredReceipt>;

/**
 * A package directory a purchase is for: the absolute path, and the path
 * relative to the workspace root with the package's name, which together
 * still identify the package after its repository moves.
 */
const PackageRef = z.strictObject({ packageDir: z.string().min(1), rel: z.string(), name: z.string().min(1).max(214).nullable() });

export type PackageRef = z.infer<typeof PackageRef>;

/** A package directory as the inbox records it: also relative to the workspace root, and with its package.json name. */
export function packageRef(root: string, packageDir: string): PackageRef {
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  return { packageDir, rel: relative(root, packageDir).split(sep).join("/"), name: typeof name === "string" && name !== "" && name.length <= 214 ? name : null };
}

/**
 * Whether a recorded package is this one: the same package.json name (or
 * both without one), in the same directory or, when the recorded directory
 * no longer exists (the repository moved), at the same path in its
 * workspace. Apply and verify also check that the package still fits the
 * profile a purchase was made for, so a different project that happens to
 * match gets nothing it could not have bought.
 */
export function samePackage(recorded: PackageRef, here: PackageRef): boolean {
  if (recorded.name !== here.name) return false;
  return recorded.packageDir === here.packageDir || (recorded.rel === here.rel && !existsSync(recorded.packageDir));
}

/** The package and capability a preview was made for, so apply and verify find a purchase from it, and know its capability without its release. */
const PreviewContext = z.strictObject({ previewId: Hex32, capability: CapabilityId, ...PackageRef.shape });

/** A package a purchase was chosen for by apply or verify, so a later change to the package's profile does not lose it. */
const Link = z.strictObject({ resolutionId: Hex32, ...PackageRef.shape });

/** A package where apply answered adapt for a resolution. */
const Adapting = z.strictObject({ resolutionId: Hex32, since: IsoTimestamp, ...PackageRef.shape });

const SUBDIRS = ["", "pending", "resolutions", "releases", "receipts", "adapting", "links", "journal", "export", "recovered", "previews"] as const;

/** A per-package record's file name: one purchase can serve several packages, each with its own record. */
const perPackage = (resolutionId: Hex32, packageDir: string) => `${Hex32.parse(resolutionId)}.${createHash("sha256").update(packageDir).digest("hex").slice(0, 16)}.json`;

/**
 * Paid resolutions, kept on the buyer's machine (bridge README: recover
 * interrupted purchases). A purchase is marked pending before the paid call,
 * so a response lost in transit is recovered (`recoverPending`) instead of
 * bought again: while a release is pending or stored, `blocksOffer` holds and
 * the bridge hands out no new offer for it.
 * A delivery is stored only if its bundle is the one its resolution names.
 * Files are private to the user and written atomically.
 */
export class ResolutionInbox {
  constructor(readonly dir: string) {
    for (const sub of SUBDIRS) {
      mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
      chmodSync(join(dir, sub), 0o700);
    }
  }

  markPending(previewId: Hex32, buyer: Address, now: Date, releaseDigest?: Hex32): void {
    this.write(join("pending", `${previewId}.json`), Pending.parse({ previewId, buyer, since: now.toISOString(), releaseDigest }));
  }

  /**
   * Whether buying this release could pay twice: it is already stored for
   * this profile, or for this package whatever its profile is now ("bought");
   * or a purchase of it is pending, or a mark names no release ("pending").
   */
  offerBlock(releaseDigest: Hex32, profileDigest: Hex32, here?: PackageRef): "bought" | "pending" | undefined {
    const bought = this.resolutions().some((r) => r.release.releaseDigest === releaseDigest && (r.profileDigest === profileDigest || (here !== undefined && this.packagesOf(r).some((ref) => samePackage(ref, here)))));
    if (bought) return "bought";
    return this.pending().some((p) => p.releaseDigest === undefined || p.releaseDigest === releaseDigest) ? "pending" : undefined;
  }

  blocksOffer(releaseDigest: Hex32, profileDigest: Hex32, here?: PackageRef): boolean {
    return this.offerBlock(releaseDigest, profileDigest, here) !== undefined;
  }

  pending(): PendingPurchase[] {
    return this.list("pending").flatMap((name) => {
      const parsed = Pending.safeParse(this.read(join("pending", name)));
      return parsed.success ? [parsed.data] : [];
    });
  }

  clearPending(previewId: Hex32): void {
    rmSync(join(this.dir, "pending", `${Hex32.parse(previewId)}.json`), { force: true });
  }

  /** Validates and stores a delivery (from the paid tool or recovery), then clears its pending mark. */
  put(delivery: unknown): ResolutionDelivery {
    const parsed = ResolutionDelivery.parse(delivery);
    this.write(join("resolutions", `${parsed.resolution.resolutionId}.json`), parsed);
    this.clearPending(parsed.resolution.previewId);
    return parsed;
  }

  get(resolutionId: Hex32): ResolutionDelivery | undefined {
    const value = this.read(join("resolutions", `${Hex32.parse(resolutionId)}.json`));
    return value === undefined ? undefined : ResolutionDelivery.parse(value);
  }

  /** Stored resolutions, newest first. */
  resolutions(): Resolution[] {
    return this.list("resolutions")
      .flatMap((name) => {
        const parsed = ResolutionDelivery.safeParse(this.read(join("resolutions", name)));
        return parsed.success ? [parsed.data.resolution] : [];
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Stores a release manifest under its digest, checked here. */
  putRelease(release: CapabilityRelease): void {
    const parsed = CapabilityRelease.parse(release);
    this.write(join("releases", `${releaseDigest(parsed)}.json`), parsed);
  }

  /** A stored release manifest, only if it still hashes to its digest. */
  release(digest: Hex32): CapabilityRelease | undefined {
    const parsed = CapabilityRelease.safeParse(this.read(join("releases", `${Hex32.parse(digest)}.json`)));
    return parsed.success && releaseDigest(parsed.data) === digest ? parsed.data : undefined;
  }

  putReceipt(stored: StoredReceipt): void {
    const parsed = StoredReceipt.parse(stored);
    this.write(join("receipts", `${parsed.receipt.resolutionId}.json`), parsed);
  }

  receipt(resolutionId: Hex32): StoredReceipt | undefined {
    const parsed = StoredReceipt.safeParse(this.read(join("receipts", `${Hex32.parse(resolutionId)}.json`)));
    return parsed.success ? parsed.data : undefined;
  }

  /** Signed (or hook-less) receipts without a final answer, for another try. */
  unpostedReceipts(): StoredReceipt[] {
    return this.list("receipts").flatMap((name) => {
      const parsed = StoredReceipt.safeParse(this.read(join("receipts", name)));
      return parsed.success && parsed.data.answer === null && !parsed.data.needsSignature ? [parsed.data] : [];
    });
  }

  /** Remembers which package and capability a preview (and so a purchase from it) was for. */
  notePreview(previewId: Hex32, where: PackageRef, capability: CapabilityId): void {
    this.write(join("previews", `${Hex32.parse(previewId)}.json`), PreviewContext.parse({ previewId, capability, ...where }));
  }

  /** The package and capability a preview was for, when this bridge made it. */
  preview(previewId: Hex32): { where: PackageRef; capability: CapabilityId } | undefined {
    const parsed = PreviewContext.safeParse(this.read(join("previews", `${Hex32.parse(previewId)}.json`)));
    return parsed.success ? { where: { packageDir: parsed.data.packageDir, rel: parsed.data.rel, name: parsed.data.name }, capability: parsed.data.capability } : undefined;
  }

  /** Remembers that apply or verify chose a purchase for a package. */
  link(resolutionId: Hex32, where: PackageRef): void {
    this.write(join("links", perPackage(resolutionId, where.packageDir)), Link.parse({ resolutionId, ...where }));
  }

  /** Every package a purchase is for: the one its preview was made for, and the ones apply or verify chose it for. */
  packagesOf(resolution: Resolution): PackageRef[] {
    const prefix = `${Hex32.parse(resolution.resolutionId)}.`;
    const linked = this.list("links")
      .filter((name) => name.startsWith(prefix))
      .flatMap((name) => {
        const parsed = Link.safeParse(this.read(join("links", name)));
        return parsed.success ? [{ packageDir: parsed.data.packageDir, rel: parsed.data.rel, name: parsed.data.name }] : [];
      });
    const previewed = this.preview(resolution.previewId)?.where;
    return previewed === undefined ? linked : [previewed, ...linked];
  }

  /** Records that apply answered adapt for a resolution in a package, so a verify there may count a merge by hand. */
  markAdapting(resolutionId: Hex32, where: PackageRef, now: Date): void {
    this.write(join("adapting", perPackage(resolutionId, where.packageDir)), Adapting.parse({ resolutionId, since: now.toISOString(), ...where }));
  }

  /** Whether apply answered adapt for a resolution in this package (`samePackage`, so a moved repository keeps it). */
  adaptingHere(resolutionId: Hex32, here: PackageRef): boolean {
    const prefix = `${Hex32.parse(resolutionId)}.`;
    return this.list("adapting")
      .filter((name) => name.startsWith(prefix))
      .some((name) => {
        const parsed = Adapting.safeParse(this.read(join("adapting", name)));
        return parsed.success && samePackage({ packageDir: parsed.data.packageDir, rel: parsed.data.rel, name: parsed.data.name }, here);
      });
  }

  /** Where apply keeps its journal and backups, outside every workspace. */
  get journalDir(): string {
    return join(this.dir, "journal");
  }

  /** Where a rollback keeps what it would not overwrite: originals of files edited after an apply, manifests an install changed. */
  get recoveredDir(): string {
    return join(this.dir, "recovered");
  }

  /** Where a resolution's files are written for the agent to adapt by hand. */
  exportDir(resolutionId: Hex32): string {
    return join(this.dir, "export", Hex32.parse(resolutionId));
  }

  private write(rel: string, value: unknown): void {
    const path = join(this.dir, rel);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "w" });
    renameSync(temp, path);
  }

  private read(rel: string): unknown {
    try {
      return JSON.parse(readFileSync(join(this.dir, rel), "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  private list(sub: string): string[] {
    return readdirSync(join(this.dir, sub)).filter((n) => n.endsWith(".json")).sort();
  }
}
