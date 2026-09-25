import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { DIRECTORY, Hex32, type PatchBundle, type PathState, fileDigest, planApply } from "@lemma/core";
import { z } from "zod";

/** What applying a resolution here would do, or the paths that keep it from applying as is. */
export type ApplyCheck =
  | {
      readonly ok: true;
      readonly writes: ReadonlyArray<{ path: string; op: "add" | "modify"; content: string }>;
      readonly deletes: readonly string[];
      /** The digest each modified or deleted file was built against, which it must still hold when it is replaced. */
      readonly bases: Readonly<Record<string, Hex32>>;
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly drifted: readonly string[] };

/**
 * Plans a bundle against a package directory with core `planApply`. A link or
 * special file anywhere on a bundle path is drift too: the bridge never writes
 * through a link. Nothing is written.
 */
export function checkApply(bundle: PatchBundle, packageDir: string): ApplyCheck {
  const unsafe = new Set<string>();
  for (const file of bundle.files) {
    const segments = file.path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const kind = kindOf(join(packageDir, ...segments.slice(0, i)));
      if (kind === "link" || kind === "other") unsafe.add(file.path);
    }
  }
  if (unsafe.size > 0) return { ok: false, drifted: [...unsafe].sort() };
  const plan = planApply(bundle, (path) => stateOf(join(packageDir, ...path.split("/"))));
  if (!plan.ok) return { ok: false, drifted: [...new Set(plan.drift.map((d) => d.path))].sort() };
  const bases = Object.fromEntries(bundle.files.flatMap((f) => (f.baseDigest === null ? [] : [[f.path, f.baseDigest]])));
  return { ...plan, bases };
}

const JournalEntry = z.strictObject({
  /** The bundle path, relative to the package directory. */
  path: z.string().min(1),
  op: z.enum(["add", "modify", "delete"]),
  /** The original file's copy inside the journal, or null when nothing was there. */
  backup: z.string().nullable(),
  /** Digest of the original file, so rollback can tell it from later edits; null for an add. */
  original: Hex32.nullable(),
  /** The staged new content, next to its target so the rename stays on one filesystem; null for a delete. */
  staged: z.string().nullable(),
  /** Digest of what apply writes to the path; rollback touches a written path only if it still holds this. */
  written: Hex32.nullable(),
});

const Manifest = z.strictObject({ path: z.string(), backup: z.string().nullable(), original: Hex32.nullable() });

/**
 * A process as a journal records it. Its pid and start time tell it from a
 * later process given the same pid, but only within the pid and time
 * namespaces they were read in (`ns`) and the boot they were read in
 * (`boot`): a process from another boot is gone, and one from other
 * namespaces is judged by how recently the file naming it was refreshed. The
 * start time is tagged with where it was read (`proc:` or `ps:`); values from
 * different sources are never compared.
 */
const Identity = z.strictObject({ pid: z.int().min(1), start: z.string().nullable(), ns: z.string().nullable(), boot: z.string().nullable() });

type Identity = z.infer<typeof Identity>;

const Journal = z.strictObject({
  resolutionId: Hex32,
  packageDir: z.string().min(1),
  state: z.enum(["writing", "installing"]),
  entries: z.array(JournalEntry),
  /** Directories apply created, outermost first. */
  createdDirs: z.array(z.string()),
  /** Files the dependency installs may change (package.json and every lockfile present), with their copies. */
  manifests: z.array(Manifest),
  /** The running install's process group, by its leader; killed before a rollback so it cannot keep writing. */
  install: Identity.nullable(),
  /** Manifests a rollback already put back, so a rollback run again after a crash still reports them. */
  putBack: z.array(z.string()),
});

type Journal = z.infer<typeof Journal>;

/** The apply that holds a journal; `id` tells it from a later journal under the same name. */
const Owner = z.strictObject({ ...Identity.shape, id: z.string().min(1) });

type Owner = z.infer<typeof Owner>;

/** How often the apply holding a journal refreshes its owner file. */
const HEARTBEAT_MS = 10_000;
/** How long an owner or claim file from other namespaces may go unrefreshed before its holder counts as gone. */
const HEARTBEAT_STALE_MS = 60_000;
/** How long after its bridge stopped refreshing the journal an install recorded in other namespaces counts as ended (installs stop at 10 minutes). */
const INSTALL_ENDED_MS = 15 * 60_000;

export interface JournalOptions {
  /** Where journals live: inside the bridge's private state directory, never in a workspace. */
  readonly journalRoot: string;
  /** Where a rollback keeps copies of what it would not overwrite, or put back over. */
  readonly recoveredRoot: string;
  /**
   * What applies are serialized on: the directory holding the package's
   * lockfile (the repository root in a monorepo), since every install there
   * changes the same manifests. One journal per scope.
   */
  readonly scope: string;
}

export interface ApplyStep {
  readonly resolutionId: Hex32;
  readonly packageDir: string;
  /** A plan checked while the journal was held (`takeJournal`), so no other apply can have changed the package since. */
  readonly plan: Extract<ApplyCheck, { ok: true }>;
  /** Files the installs may change; copied first so a failed install is undone too. */
  readonly manifests: readonly string[];
  /**
   * Runs the dependency installs, throwing when one fails; reports each
   * install's process group, and stops every one before it returns or throws.
   * Not called when there are none.
   */
  readonly install: (onGroup: (pgid: number) => void) => Promise<void>;
}

/** What an undo did, as counts for the answer. */
export interface Undone {
  /** Bundle paths taken back to their state before the apply. */
  readonly restored: number;
  /** Bundle paths changed after the apply, left as they are; the originals of files it replaced are kept in the recovered directory. */
  readonly left: number;
  /** package.json or lockfiles put back to their state before the install; what they held is kept in the recovered directory. */
  readonly putBack: number;
}

export type ApplyOutcome =
  | { readonly ok: true }
  /** The package no longer matches the plan (checked with the journal held): nothing was written. */
  | { readonly ok: false; readonly step: "drift"; readonly drifted: readonly string[] }
  /** The apply failed and was undone. */
  | { readonly ok: false; readonly step: "write" | "install"; readonly error: string; readonly undone: Undone }
  /** Another apply in this scope holds the journal (BUSY), or undid this one while it ran (LOST). */
  | { readonly ok: false; readonly step: "busy"; readonly error: "BUSY" | "LOST" }
  /**
   * An earlier unfinished apply in this scope was undone first and changed
   * the workspace, or could not be undone at all (`kept`): nothing new was
   * written, so the package can be checked first.
   */
  | { readonly ok: false; readonly step: "earlier"; readonly kept: boolean; readonly undone: Undone }
  /** The apply failed and undoing it could not restore every path: the journal is kept for a person, and the next apply in this scope retries the undo. */
  | { readonly ok: false; readonly step: "rollback"; readonly error: string; readonly journal: string; readonly undone: Undone };

/** What a rollback did. `kept` means the journal stays for a person to look at, and the next apply in its scope retries it. */
export interface RollbackResult {
  readonly status: "none" | "rolled-back" | "kept";
  readonly restored: readonly string[];
  /** Bundle paths changed after the apply and left as they are. */
  readonly left: readonly string[];
  /** Manifests put back to their state before the install. */
  readonly putBack: readonly string[];
  /** Where copies of what was left or put back went, when there were any. */
  readonly recoveredDir: string | null;
}

const NOTHING = { restored: [], left: [], putBack: [], recoveredDir: null } as const;

/** The journal held for a scope: `apply` writes a plan through it; `release` gives it up unused. */
export type Taken =
  | { readonly status: "taken"; apply(step: ApplyStep): Promise<ApplyOutcome>; release(): void }
  | { readonly status: "busy" }
  | { readonly status: "earlier"; readonly kept: boolean; readonly undone: Undone };

/** The journal directory for a scope. */
export function journalDirFor(journalRoot: string, scope: string): string {
  return join(journalRoot, journalName(scope));
}

/** Whether a scope has a journal: one a live apply holds, or one an apply left unfinished. Reads only. */
export function journalState(journalRoot: string, scope: string): "none" | "live" | "unfinished" {
  const holders = holdersOf(journalDirFor(journalRoot, scope));
  if (holders === undefined) return "none";
  return anyMayRun(holders) ? "live" : "unfinished";
}

/**
 * Takes the journal for a scope before anything is planned, so that the
 * plan is checked, and the workspace written, while no other apply in the
 * scope can run:
 *
 * 1. The journal directory is built under a temporary name with its owner
 *    file (identity and a unique id) inside, then renamed into place, which
 *    fails if another apply holds it (BUSY).
 * 2. A journal an earlier apply left unfinished (its holders are gone) is
 *    rolled back first. If that changed the workspace, or could not finish,
 *    nothing new is written ("earlier"), so the package can be checked.
 * 3. While held, the owner file is refreshed every 10 seconds, which is how
 *    a bridge in other namespaces tells a live apply from a dead one.
 */
export function takeJournal(options: JournalOptions): Taken {
  mkdirSync(options.journalRoot, { recursive: true, mode: 0o700 });
  const name = journalName(options.scope);
  const dir = join(options.journalRoot, name);
  const acquired = acquire(options.journalRoot, name, options.recoveredRoot);
  if (acquired.status !== "acquired") return acquired;
  const heartbeat = setInterval(() => {
    // Only this apply's own owner file: once the journal is released, or undone and taken by another apply, the heartbeat stops.
    if (!holds(dir, acquired.owner, false)) {
      clearInterval(heartbeat);
      return;
    }
    try {
      const now = new Date();
      utimesSync(join(dir, "owner.json"), now, now);
    } catch {
      // Gone meanwhile; the next beat stops.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let done = false;
  const finish = () => {
    done = true;
    clearInterval(heartbeat);
  };
  return {
    status: "taken",
    release() {
      if (done) return;
      finish();
      // Nothing was written: the journal has no journal file yet.
      if (holds(dir, acquired.owner, false)) discard(dir);
    },
    async apply(step) {
      if (done) throw new Error("the journal was released");
      try {
        return await applyHeld(dir, acquired.owner, options.recoveredRoot, step);
      } finally {
        finish();
      }
    },
  };
}

/**
 * Applies a bundle through the scope's journal, all or nothing: takes the
 * journal (`takeJournal`), checks the plan while holding it, then writes it.
 * A package that no longer matches the bundle's base answers `drift`, and
 * nothing is written.
 */
export async function applyPlan(options: JournalOptions & Omit<ApplyStep, "plan"> & { readonly bundle: PatchBundle }): Promise<ApplyOutcome> {
  const taken = takeJournal(options);
  if (taken.status === "busy") return { ok: false, step: "busy", error: "BUSY" };
  if (taken.status === "earlier") return { ok: false, step: "earlier", kept: taken.kept, undone: taken.undone };
  const plan = checkApply(options.bundle, options.packageDir);
  if (!plan.ok) {
    taken.release();
    return { ok: false, step: "drift", drifted: plan.drifted };
  }
  return taken.apply({ ...options, plan });
}

/**
 * Writes a checked plan through a held journal, so that it happens
 * completely or not at all:
 *
 * 1. The journal records every path, a copy and digest of every file it will
 *    replace or delete, and every directory it will create. Copies and
 *    journal are flushed to disk before anything in the workspace changes.
 * 2. New content is staged next to each target and flushed. An added file is
 *    then linked into place, which fails if something appeared there; a
 *    replaced or deleted file must still hold what was copied, or the apply
 *    stops before touching it.
 * 3. Dependency changes are installed with lifecycle scripts disabled, after
 *    package.json and every lockfile are copied into the journal; the
 *    install's process group is recorded.
 * 4. On any failure the journal is rolled back; a journal left by a crash is
 *    rolled back the next time the bridge starts (`recoverJournals`). A
 *    rollback restores a file only if it still holds what apply wrote, and
 *    keeps a copy of anything it would otherwise overwrite.
 *
 * A failed install can leave `node_modules` partly changed; package.json and
 * the lockfiles are restored, so the next install puts it right.
 */
async function applyHeld(dir: string, owner: Owner, recoveredRoot: string, step: ApplyStep): Promise<ApplyOutcome> {
  const tag = step.resolutionId.slice(2, 10);
  const changes = [...step.plan.writes.map((w) => ({ path: w.path, op: w.op, content: w.content as string | null })), ...step.plan.deletes.map((path) => ({ path, op: "delete" as const, content: null }))];
  const journal: Journal = { resolutionId: step.resolutionId, packageDir: step.packageDir, state: "writing", entries: [], createdDirs: [], manifests: [], install: null, putBack: [] };
  try {
    changes.forEach((change, i) => {
      const target = join(step.packageDir, ...change.path.split("/"));
      let backup: string | null = null;
      let original: Hex32 | null = null;
      if (change.op !== "add") {
        backup = `backup/${i}`;
        copyFileSync(target, join(dir, backup));
        fsyncPath(join(dir, backup));
        original = fileDigest(readFileSync(join(dir, backup)));
        // Changed since the plan was checked: stop before anything is written.
        if (original !== step.plan.bases[change.path]) throw Object.assign(new Error(`${change.path} changed while applying`), { code: "CHANGED" });
      }
      const staged = change.content === null ? null : join(dirname(target), `.lemma-${tag}-${i}.tmp`);
      journal.entries.push({ path: change.path, op: change.op, backup, original, staged, written: change.content === null ? null : fileDigest(change.content) });
      const segments = change.path.split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        const parent = join(step.packageDir, ...segments.slice(0, depth));
        if (!existsSync(parent) && !journal.createdDirs.includes(parent)) journal.createdDirs.push(parent);
      }
    });
    fsyncPath(join(dir, "backup"));
    // The commit point: from here on the workspace may change, and the journal says how to undo it.
    saveJournal(dir, journal);
    for (const created of journal.createdDirs) mkdirSync(created);
    changes.forEach((change, i) => {
      const entry = journal.entries[i] as z.infer<typeof JournalEntry>;
      if (entry.staged === null || change.content === null) return;
      writeFileSync(entry.staged, change.content, { flag: "wx" });
      // A modified file keeps its permissions, such as an executable bit.
      if (change.op === "modify") chmodSync(entry.staged, lstatSync(join(step.packageDir, ...change.path.split("/"))).mode & 0o7777);
      fsyncPath(entry.staged);
    });
    for (const entry of journal.entries) {
      const target = join(step.packageDir, ...entry.path.split("/"));
      if (entry.op === "add") {
        placeNew(entry.staged as string, target);
        continue;
      }
      // Changed since its copy was taken: stop before touching it, and let the rollback leave the change as it is.
      if (digestOf(target) !== entry.original) throw Object.assign(new Error(`${entry.path} changed while applying`), { code: "CHANGED" });
      if (entry.staged !== null) renameSync(entry.staged, target);
      else rmSync(target);
    }
  } catch (error) {
    return undo(dir, recoveredRoot, "write", error);
  }

  const installs = Object.keys(step.plan.dependencies).length + Object.keys(step.plan.devDependencies).length;
  if (installs > 0) {
    try {
      journal.manifests = [...new Set(step.manifests)].map((path, i) => {
        if (!existsSync(path)) return { path, backup: null, original: null };
        const backup = `backup/m${i}`;
        copyFileSync(path, join(dir, backup));
        fsyncPath(join(dir, backup));
        return { path, backup, original: fileDigest(readFileSync(join(dir, backup))) };
      });
      fsyncPath(join(dir, "backup"));
      journal.state = "installing";
      saveJournal(dir, journal);
      await step.install((pgid) => {
        journal.install = { ...selfIdentity(), pid: pgid, start: processStart(pgid) };
        saveJournal(dir, journal);
      });
    } catch (error) {
      return undo(dir, recoveredRoot, "install", error);
    }
  }
  // Something else undid the journal while this apply ran (it can only if this process looked dead): do not claim success.
  if (!holds(dir, owner, true)) return { ok: false, step: "busy", error: "LOST" };
  // Done: the journal file goes first, so a crash from here on leaves nothing to undo.
  rmSync(join(dir, "journal.json"));
  fsyncPath(dir);
  discard(dir);
  return { ok: true };
}

/**
 * Puts a staged file at a path that must still be free: a hard link fails if
 * something appeared there since the plan was checked. On a filesystem
 * without hard links, a rename after a last check is the next best.
 */
function placeNew(staged: string, target: string): void {
  try {
    linkSync(staged, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "EMLINK") throw error;
    if (kindOf(target) !== "absent") throw Object.assign(new Error("the path appeared while applying"), { code: "EEXIST" });
    renameSync(staged, target);
    return;
  }
  rmSync(staged);
}

/** Rolls back this process's own journal after a failed step; one it cannot fully undo is released for a later retry, and reported. */
function undo(dir: string, recoveredRoot: string, step: "write" | "install", error: unknown): ApplyOutcome {
  // This apply's installs are stopped before its install step returns or throws: there is nothing left to kill.
  const result = rollbackJournal(dir, recoveredRoot, { installStopped: true });
  const undone = counts(result);
  if (result.status !== "kept") return { ok: false, step, error: errorName(error), undone };
  // Released: the next apply in this scope retries the undo instead of answering BUSY.
  rmSync(join(dir, "owner.json"), { force: true });
  return { ok: false, step: "rollback", error: errorName(error), journal: dir, undone };
}

function counts(result: RollbackResult | Recovery): Undone {
  return { restored: result.restored.length, left: result.left.length, putBack: result.putBack.length };
}

type Acquired = { readonly status: "acquired"; readonly owner: Owner } | { readonly status: "busy" } | { readonly status: "earlier"; readonly kept: boolean; readonly undone: Undone };

/**
 * Takes the journal directory: built under a temporary name with its owner
 * inside, then renamed into place. A rename onto an existing journal fails,
 * so of two applies only one gets it. A journal whose holders are gone is
 * recovered first (`recoverOne`); if that changed anything, or could not undo
 * it, nothing new is written.
 */
function acquire(journalRoot: string, name: string, recoveredRoot: string): Acquired {
  const dir = join(journalRoot, name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = Owner.parse({ ...selfIdentity(), id: randomUUID() });
    const fresh = join(journalRoot, `.new-${name}-${process.pid}-${owner.id}`);
    mkdirSync(fresh, { mode: 0o700 });
    writeDurably(join(fresh, "owner.json"), JSON.stringify(owner));
    mkdirSync(join(fresh, "backup"), { mode: 0o700 });
    try {
      renameSync(fresh, dir);
      fsyncPath(journalRoot);
      return { status: "acquired", owner };
    } catch (error) {
      rmSync(fresh, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }
    const earlier = recoverOne(journalRoot, name, recoveredRoot);
    if (earlier.status === "live") return { status: "busy" };
    const undone = counts(earlier);
    if (earlier.status === "kept" || undone.restored + undone.left + undone.putBack > 0) return { status: "earlier", kept: earlier.status === "kept", undone };
  }
  return { status: "busy" };
}

type Recovery = RollbackResult | { readonly status: "live" | "gone"; readonly restored: readonly string[]; readonly left: readonly string[]; readonly putBack: readonly string[]; readonly recoveredDir: null };

/**
 * Recovers one journal whose holders are all gone: the apply that made it,
 * and every recoverer that claimed it before. It is claimed in place, never
 * moved, so a live apply is never disturbed:
 *
 * - A claim is a directory `claim.<n>` with its holder inside, built under a
 *   temporary name and renamed into place; the rename fails if another
 *   process took that number, so only one recoverer holds the next claim.
 * - With its claim in place, the recoverer reads the holders again. If the
 *   journal was replaced by a new apply's since it was first read, or any
 *   other holder may be running, it drops its claim and leaves the journal.
 * - The rollback runs under the journal's own name, which stays taken until
 *   it is done.
 */
function recoverOne(journalRoot: string, name: string, recoveredRoot: string): Recovery {
  const dir = join(journalRoot, name);
  const gone = { status: "gone", ...NOTHING } as const;
  const live = { status: "live", ...NOTHING } as const;
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = holdersOf(dir);
    if (seen === undefined) return gone;
    if (anyMayRun(seen)) return live;
    const n = seen.top + 1;
    const took = takeClaim(dir, n);
    if (took === "gone") return gone;
    if (took === "taken") continue;
    const now = holdersOf(dir);
    if (now === undefined || now.ownerId !== seen.ownerId || now.top > n || anyMayRun(now, n)) {
      dropClaim(dir, n);
      return now === undefined ? gone : live;
    }
    return rollbackJournal(dir, recoveredRoot, { claim: n });
  }
  return live;
}

interface Holders {
  /** The owner file's id, which tells this journal from a later one under the same name. */
  readonly ownerId: string | undefined;
  /** The apply that made it (claim 0, none once released) and each recoverer that claimed it, with the file that names it. */
  readonly holders: ReadonlyArray<{ readonly n: number; readonly id: Identity; readonly file: string }>;
  /** The highest claim number taken, 0 when none. */
  readonly top: number;
}

/** A journal's holders; undefined when the journal is gone. */
function holdersOf(dir: string): Holders | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const ownerFile = join(dir, "owner.json");
  const owner = readJson(ownerFile, Owner);
  const holders: Array<{ n: number; id: Identity; file: string }> = owner === undefined ? [] : [{ n: 0, id: owner, file: ownerFile }];
  let top = 0;
  for (const entry of names) {
    const claim = /^claim\.(\d{1,9})$/.exec(entry);
    if (claim === null) continue;
    const n = Number(claim[1]);
    top = Math.max(top, n);
    const file = join(dir, entry, "holder.json");
    const id = readJson(file, Identity);
    if (id !== undefined) holders.push({ n, id, file });
  }
  return { ownerId: owner?.id, holders, top };
}

/** Whether any holder, other than claim `except`, may still be running. */
function anyMayRun(holders: Holders, except?: number): boolean {
  return holders.holders.some((h) => h.n !== except && identify(h.id, h.file) !== "gone");
}

/** Takes claim `n` on a journal: built under a temporary name with this process inside, then renamed into place, which fails if the number is taken. */
function takeClaim(dir: string, n: number): "claimed" | "taken" | "gone" {
  const temp = join(dir, `.claiming-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(temp, { mode: 0o700 });
    writeDurably(join(temp, "holder.json"), JSON.stringify(selfIdentity()));
    renameSync(temp, join(dir, `claim.${n}`));
    return "claimed";
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return "taken";
    if (code === "ENOENT") return "gone";
    throw error;
  }
}

/** Gives up a claim: renamed to a name of its own first, so removing it never reaches a claim someone else takes under that number. */
function dropClaim(dir: string, n: number): void {
  const dropped = join(dir, `.dropped-${randomUUID()}`);
  try {
    renameSync(join(dir, `claim.${n}`), dropped);
  } catch {
    return;
  }
  rmSync(dropped, { recursive: true, force: true });
}

/** Removes a finished journal: renamed to a name of its own first, so its name is free at once and the removal never reaches a newer journal. */
function discard(dir: string): void {
  const done = join(dirname(dir), `.done-${randomUUID()}`);
  try {
    renameSync(dir, done);
  } catch {
    return;
  }
  rmSync(done, { recursive: true, force: true });
}

/**
 * Undoes whatever an unfinished apply did, from its journal. The caller holds
 * the journal (its own apply, or claim `claim`, which is dropped when the
 * journal is kept so that a later apply can retry).
 *
 * - A recorded install still running is killed first, unless the caller
 *   already stopped it. One that cannot be verified to be the install is
 *   never signalled, and the journal is kept rather than undone under it.
 * - package.json and the lockfiles are put back as they were before the
 *   install, since an interrupted install leaves them half changed; what they
 *   held is kept in `recoveredRoot/<resolution>-<time>/manifests/`, and named
 *   in `putBack`. Each put-back is saved in the journal at once, so a
 *   rollback run again after a crash still reports it.
 * - Staged files are removed. A modified or added path is restored (or
 *   removed) only if it still holds what apply wrote, and a deleted one only
 *   if it is still absent; those are named in `restored`. Anything else is
 *   left as it is, named in `left`, with a copy of the original, when there
 *   was one, in `files/` there.
 * - Created directories are removed if empty.
 *
 * Restores go through a temporary file with a fixed name per path, removed
 * first on every run, so a crash never leaves one behind for good. Every step
 * is attempted; one that fails keeps the journal (`kept`, with a
 * `failed.json` naming the paths) instead of throwing. The kept journal then
 * lists only the steps that failed, so a retry never repeats one that was
 * done, such as putting an old manifest over one edited since. A journal
 * directory without a journal file had changed nothing yet and is removed; a
 * journal file that cannot be read is kept.
 */
export function rollbackJournal(dir: string, recoveredRoot: string, options: { installStopped?: boolean; claim?: number } = {}): RollbackResult {
  const release = () => {
    if (options.claim !== undefined) dropClaim(dir, options.claim);
  };
  if (!existsSync(dir)) return { status: "none", ...NOTHING };
  const journalPath = join(dir, "journal.json");
  if (!existsSync(journalPath)) {
    // The journal is written, atomically, before anything in the workspace changes.
    discard(dir);
    return { status: "none", ...NOTHING };
  }
  let journal: Journal;
  try {
    journal = Journal.parse(JSON.parse(readFileSync(journalPath, "utf8")));
  } catch {
    writeFailed(dir, ["journal.json could not be read"]);
    release();
    return { status: "kept", ...NOTHING };
  }
  if (journal.install !== null && options.installStopped !== true && killRecordedGroup(journal.install, join(dir, "owner.json")) === "unverified") {
    writeFailed(dir, [`the install (process group ${journal.install.pid}) may still be running and could not be verified`]);
    release();
    return { status: "kept", ...NOTHING, putBack: journal.putBack };
  }

  const recoveredDir = join(recoveredRoot, `${journal.resolutionId}-${Date.now()}-${process.pid}`);
  const tag = journal.resolutionId.slice(2, 10);
  const restored: string[] = [];
  const left: string[] = [];
  const putBack = [...journal.putBack];
  const failed: string[] = [];
  const keep = (from: string, as: string) => {
    const to = join(recoveredDir, as);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
  };
  const step = (path: string, action: () => void): boolean => {
    try {
      action();
      return true;
    } catch (error) {
      failed.push(`${path}: ${errorName(error)}`);
      return false;
    }
  };

  let manifests = journal.manifests;
  journal.manifests.forEach((m, i) => {
    const ok = step(m.path, () => {
      const temp = `${m.path}.lemma-restore-${tag}-m${i}.tmp`;
      rmSync(temp, { force: true });
      const now = digestOf(m.path);
      if (now === m.original) return;
      // What the install (or someone after it) left is kept before the manifest is put back.
      if (now !== null) keep(m.path, `manifests/${i}-${basename(m.path)}`);
      if (m.backup !== null) restore(join(dir, m.backup), m.path, temp);
      else rmSync(m.path, { force: true });
      putBack.push(m.path);
      manifests = manifests.filter((other) => other !== m);
      saveJournal(dir, { ...journal, manifests, putBack });
    });
    if (ok) manifests = manifests.filter((other) => other !== m);
  });
  const entries = journal.entries.filter(
    (entry, i) =>
      !step(entry.path, () => {
        const target = join(journal.packageDir, ...entry.path.split("/"));
        const temp = `${target}.lemma-restore-${tag}-${i}.tmp`;
        rmSync(temp, { force: true });
        if (entry.staged !== null) rmSync(entry.staged, { force: true });
        const now = digestOf(target);
        const absent = kindOf(target) === "absent";
        if (entry.op === "add") {
          if (now !== null && now === entry.written) {
            rmSync(target);
            restored.push(entry.path);
          } else if (!absent) left.push(entry.path);
          return;
        }
        if (now === entry.original) return;
        const untouchedSinceApply = entry.op === "modify" ? now === entry.written : absent;
        if (untouchedSinceApply && entry.backup !== null) {
          restore(join(dir, entry.backup), target, temp);
          restored.push(entry.path);
          return;
        }
        // Changed after apply: leave it, and keep the original where it can be found.
        left.push(entry.path);
        if (entry.backup !== null) keep(join(dir, entry.backup), `files/${entry.path}`);
      }),
  );
  for (const created of [...journal.createdDirs].reverse()) {
    try {
      rmdirSync(created);
    } catch {
      // Not empty (something else was put there) or already gone.
    }
  }
  const recovered = existsSync(recoveredDir) ? recoveredDir : null;
  if (failed.length > 0) {
    try {
      // Only what failed is left to retry, and what this run reports is not reported again; the install is stopped by now.
      saveJournal(dir, { ...journal, manifests, entries, install: null, putBack: [] });
    } catch {
      // The full journal stays: a retry redoes only steps whose paths still differ.
    }
    writeFailed(dir, failed);
    release();
    return { status: "kept", restored, left, putBack, recoveredDir: recovered };
  }
  rmSync(journalPath, { force: true });
  discard(dir);
  return { status: "rolled-back", restored, left, putBack, recoveredDir: recovered };
}

export interface RecoveryReport {
  /** Journals rolled back. */
  readonly recovered: number;
  /** Journals left for a person: unreadable, or a step failed; the next apply in their scope retries them. */
  readonly kept: number;
  /** Journals a live apply, or another bridge's recovery, still holds. */
  readonly live: number;
  /** Bundle paths changed after an apply, left as they are; the originals of files it replaced are kept in the recovered directory. */
  readonly left: number;
  /** Manifests put back to their state before an interrupted install; what they held is kept in the recovered directory. */
  readonly putBack: number;
}

const NEW_DIR = /^\.new-0x[0-9a-f]{64}-(\d+)-/;

/**
 * Rolls back every journal an interrupted apply left behind; the bridge calls
 * this at startup. A journal a live process holds is skipped, one journal
 * that cannot be rolled back never stops the others or the bridge, and two
 * bridges starting at once never roll the same journal back twice. A journal
 * an undo could not finish waits for the next apply in its scope.
 */
export function recoverJournals(journalRoot: string, recoveredRoot: string): RecoveryReport {
  const report = { recovered: 0, kept: 0, live: 0, left: 0, putBack: 0 };
  let names: string[];
  try {
    names = readdirSync(journalRoot);
  } catch {
    return report;
  }
  for (const name of names) {
    const path = join(journalRoot, name);
    try {
      // A journal still being built never touched the workspace: one whose builder is gone is removed.
      const fresh = NEW_DIR.exec(name);
      if (fresh !== null) {
        const builder = readJson(join(path, "owner.json"), Owner);
        const running = builder === undefined ? alive(Number(fresh[1])) : identify(builder, join(path, "owner.json")) !== "gone";
        if (!running) rmSync(path, { recursive: true, force: true });
        continue;
      }
      // A finished journal whose removal was interrupted.
      if (name.startsWith(".done-")) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (!Hex32.safeParse(name).success) continue;
      const holders = holdersOf(path);
      if (holders !== undefined && existsSync(join(path, "failed.json")) && !anyMayRun(holders)) {
        report.kept++;
        continue;
      }
      const result = recoverOne(journalRoot, name, recoveredRoot);
      if (result.status === "live") report.live++;
      else if (result.status === "kept") report.kept++;
      else if (result.status === "rolled-back") report.recovered++;
      report.left += result.left.length;
      report.putBack += result.putBack.length;
    } catch {
      report.kept++;
    }
  }
  return report;
}

function journalName(scope: string): string {
  return `0x${createHash("sha256").update(scope).digest("hex")}`;
}

function readJson<T extends z.ZodType>(path: string, schema: T): z.infer<T> | undefined {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** Whether this apply still holds its journal: its owner file names it, and (once written) the journal was not undone under it. */
function holds(dir: string, owner: Owner, written: boolean): boolean {
  return readJson(join(dir, "owner.json"), Owner)?.id === owner.id && (!written || existsSync(join(dir, "journal.json")));
}

let self: Identity | undefined;

/** This process as a journal records it. */
function selfIdentity(): Identity {
  self ??= { pid: process.pid, start: processStart(process.pid), ns: namespaces(), boot: bootId() };
  return self;
}

/**
 * Whether a recorded process is still the one running under its pid, from
 * here: gone when it ran in another boot; in other namespaces, where its pid
 * means nothing here, running while the file naming it (`heartbeat`) was
 * refreshed within the last minute; otherwise by pid and start time.
 */
function identify(id: Identity, heartbeat: string): "same" | "gone" | "unknown" {
  const here = selfIdentity();
  if (id.boot !== null && here.boot !== null && id.boot !== here.boot) return "gone";
  if (id.ns !== here.ns) return ageOf(heartbeat) < HEARTBEAT_STALE_MS ? "unknown" : "gone";
  if (!alive(id.pid)) return "gone";
  const now = processStart(id.pid);
  if (id.start === null || now === null || sourceOf(now) !== sourceOf(id.start)) return "unknown";
  return now === id.start ? "same" : "gone";
}

const sourceOf = (start: string) => start.slice(0, start.indexOf(":") + 1);

/** Milliseconds since a file was last written or refreshed; infinite when it is gone. */
function ageOf(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Kills an install's process group, but only one known to be the install:
 * its leader is the same process (pid and start time). When the leader is
 * gone, a pid that now belongs to another process means the group ended (a
 * group id is not reused while any member lives); a free pid with the group
 * still there means a leaderless group, whose members cannot be told from
 * another program's, so it is left alone. An install recorded in other
 * namespaces cannot be named from here: it counts as ended once its bridge
 * has not refreshed the journal for longer than any install runs.
 */
function killRecordedGroup(install: Identity, ownerFile: string): "gone" | "killed" | "unverified" {
  const here = selfIdentity();
  if (install.boot !== null && here.boot !== null && install.boot !== here.boot) return "gone";
  if (install.ns !== here.ns) return ageOf(ownerFile) > INSTALL_ENDED_MS ? "gone" : "unverified";
  let groupExists: boolean;
  try {
    process.kill(-install.pid, 0);
    groupExists = true;
  } catch (error) {
    groupExists = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!groupExists) return "gone";
  const leader = identify(install, ownerFile);
  if (leader === "unknown") return "unverified";
  if (leader === "gone") return alive(install.pid) ? "gone" : "unverified";
  try {
    process.kill(-install.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  return "killed";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** This process's pid and time namespaces (Linux); null where they cannot be read. */
function namespaces(): string | null {
  try {
    const pid = readlinkSync("/proc/self/ns/pid");
    let time = "";
    try {
      time = readlinkSync("/proc/self/ns/time");
    } catch {
      // A kernel without time namespaces.
    }
    return `${pid} ${time}`.trim();
  } catch {
    return null;
  }
}

/** The current boot: the kernel's boot id on Linux, the boot session UUID on macOS; null elsewhere. */
function bootId(): string | null {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (id !== "") return id;
  } catch {
    // No /proc here: ask sysctl.
  }
  const sysctl = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 5_000 });
  const id = sysctl.status === 0 ? sysctl.stdout.trim() : "";
  return id === "" ? null : id;
}

/**
 * A process's start time, to tell a process from a later one given the same
 * pid: `/proc/<pid>/stat` field 22 on Linux (`proc:<ticks>`), else
 * `ps -o lstart=` (`ps:<time>`, macOS and other Unix systems), read in UTC
 * and the C locale so that every reader gets the same text whatever its own
 * time zone; null where neither can be read.
 */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (field !== undefined && /^\d+$/.test(field)) return `proc:${field}`;
  } catch {
    // No /proc here: ask ps.
  }
  return psStart(pid);
}

/** A process's start time from `ps -o lstart=`, asked in UTC and the C locale whatever this process's own settings; null when ps cannot tell. */
export function psStart(pid: number): string | null {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", TZ: "UTC0", LC_ALL: "C" } });
  const start = ps.status === 0 ? ps.stdout.trim().replace(/\s+/g, " ") : "";
  return start === "" ? null : `ps:${start}`;
}

function writeFailed(dir: string, failed: readonly string[]): void {
  try {
    writeDurably(join(dir, "failed.json"), JSON.stringify({ failed }));
  } catch {
    // The journal stays either way.
  }
}

function saveJournal(dir: string, journal: Journal): void {
  writeDurably(join(dir, "journal.json"), JSON.stringify(Journal.parse(journal)));
}

/** Writes a file through a flushed temporary copy (named for this process) and a rename, then flushes the directory. */
function writeDurably(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  fsyncPath(temp);
  renameSync(temp, path);
  fsyncPath(dirname(path));
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Puts a copy back through `temp`, flushed, then renamed over the target. */
function restore(backup: string, target: string, temp: string): void {
  copyFileSync(backup, temp);
  fsyncPath(temp);
  renameSync(temp, target);
}

function kindOf(path: string): "absent" | "file" | "directory" | "link" | "other" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "absent";
  }
  if (stat.isSymbolicLink()) return "link";
  if (stat.isDirectory()) return "directory";
  return stat.isFile() ? "file" : "other";
}

function stateOf(path: string): PathState {
  const kind = kindOf(path);
  if (kind === "absent") return null;
  if (kind === "directory") return DIRECTORY;
  return fileDigest(readFileSync(path));
}

function digestOf(path: string): Hex32 | null {
  return kindOf(path) === "file" ? fileDigest(readFileSync(path)) : null;
}

function errorName(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "error";
}
