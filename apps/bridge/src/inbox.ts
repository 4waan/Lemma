import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Address, Hex32, IsoTimestamp, type Resolution, ResolutionDelivery } from "@lemma/core";
import { z } from "zod";

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
    for (const sub of ["", "pending", "resolutions"]) {
      mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
      chmodSync(join(dir, sub), 0o700);
    }
  }

  markPending(previewId: Hex32, buyer: Address, now: Date, releaseDigest?: Hex32): void {
    this.write(join("pending", `${previewId}.json`), Pending.parse({ previewId, buyer, since: now.toISOString(), releaseDigest }));
  }

  /** Whether buying this release for this profile could pay twice: it is pending (or a mark names no release), or already stored. */
  blocksOffer(releaseDigest: Hex32, profileDigest: Hex32): boolean {
    if (this.pending().some((p) => p.releaseDigest === undefined || p.releaseDigest === releaseDigest)) return true;
    return this.resolutions().some((r) => r.release.releaseDigest === releaseDigest && r.profileDigest === profileDigest);
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
