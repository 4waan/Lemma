import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { Address, Hex32, IsoTimestamp, UsdcAtomic } from "@lemma/core";
import { z } from "zod";

/** The cap window: a signed authorization counts against the daily cap for this long after it was signed. */
export const DAY_MS = 24 * 3600 * 1000;

/**
 * One signed (or about to be signed) EIP-3009 authorization, keyed by its
 * nonce. USDC executes at most one authorization per payer and nonce, and the
 * nonce is derived from the resolution, so a nonce is one possible payment
 * however often it is signed: a retry never counts twice.
 *
 * - `reserved`: counted; signed, or about to be, with no proof it went unspent.
 * - `settled`: counted; the delivery came back.
 * - `released`: not counted; nothing was signed (the signer refused).
 */
const Entry = z.strictObject({
  nonce: Hex32,
  amount: UsdcAtomic,
  payTo: Address,
  at: IsoTimestamp,
  state: z.enum(["reserved", "settled", "released"]),
});

export type SpendEntry = z.infer<typeof Entry>;

const LedgerFile = z.strictObject({ schemaVersion: z.literal("1"), entries: z.array(Entry).max(50_000) });

export class LedgerError extends Error {
  override name = "LedgerError";
}

/**
 * The local spend ledger: what has been committed in the rolling cap window.
 * The bridge keeps one in its state directory, and the signer keeps its own,
 * so each enforces the daily cap by itself.
 *
 * Every read-check-write runs under a lock file (created exclusively, so two
 * bridges on one state directory cannot both reserve), and the file is
 * replaced atomically (written, flushed, renamed). A signed authorization
 * stays counted for the whole window even when its purchase failed: only
 * the chain can prove it unspent, and neither the bridge nor the signer reads
 * the chain. An unreadable ledger fails closed: nothing more is reserved.
 */
export class SpendLedger {
  private readonly file: string;
  private readonly lockFile: string;

  /**
   * `retainMs` is how long an entry is kept after it was last written (two
   * cap windows by default). The signer keeps its entries longer, since it
   * also answers whether it paid for a resolution when asked for its receipt.
   */
  constructor(
    readonly dir: string,
    private readonly windowMs: number = DAY_MS,
    private readonly retainMs: number = 2 * windowMs,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "spend.json");
    this.lockFile = join(dir, "spend.lock");
  }

  /** Everything counted in the window ending at `now`, leaving out `except` (a nonce being signed again). */
  committed(now: Date, except?: Hex32): bigint {
    return this.withLock(() => this.sum(this.load(), now, except));
  }

  /**
   * Under the lock: works out what is committed apart from this nonce, asks
   * `decide`, and when it says ok records the reservation (the larger amount
   * when the nonce is already there). A settled entry stays settled.
   */
  reserve<D extends { readonly ok: boolean }>(entry: { readonly nonce: Hex32; readonly amount: bigint; readonly payTo: Address }, now: Date, decide: (committed: bigint) => D): D {
    return this.withLock(() => {
      const entries = this.load();
      const decision = decide(this.sum(entries, now, entry.nonce));
      if (!decision.ok) return decision;
      const existing = entries.find((e) => e.nonce === entry.nonce);
      const amount = existing !== undefined && existing.state !== "released" && BigInt(existing.amount) > entry.amount ? BigInt(existing.amount) : entry.amount;
      const next: SpendEntry = { nonce: entry.nonce, amount: amount.toString(), payTo: entry.payTo, at: now.toISOString(), state: existing?.state === "settled" ? "settled" : "reserved" };
      this.save([...entries.filter((e) => e.nonce !== entry.nonce), next], now);
      return decision;
    });
  }

  /** Marks a reservation settled: its delivery came back. */
  settle(nonce: Hex32, now: Date): void {
    this.update(nonce, now, (e) => ({ ...e, state: "settled" }));
  }

  /** Frees a reservation for which nothing was signed. Never frees a settled one. */
  release(nonce: Hex32, now: Date): void {
    this.update(nonce, now, (e) => (e.state === "reserved" ? { ...e, state: "released" } : e));
  }

  /** Whether an authorization with this nonce was signed (or reserved to be) and is still kept: `reserved` or `settled`. */
  signed(nonce: Hex32): boolean {
    return this.withLock(() => this.load().some((e) => e.nonce === nonce && e.state !== "released"));
  }

  entries(): SpendEntry[] {
    return this.withLock(() => this.load());
  }

  private update(nonce: Hex32, now: Date, change: (e: SpendEntry) => SpendEntry): void {
    this.withLock(() => {
      const entries = this.load();
      this.save(
        entries.map((e) => (e.nonce === nonce ? change(e) : e)),
        now,
      );
    });
  }

  private sum(entries: readonly SpendEntry[], now: Date, except?: Hex32): bigint {
    const since = now.getTime() - this.windowMs;
    return entries.filter((e) => e.state !== "released" && e.nonce !== except && Date.parse(e.at) > since).reduce((total, e) => total + BigInt(e.amount), 0n);
  }

  private load(): SpendEntry[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new LedgerError("the spend ledger could not be read");
    }
    const parsed = LedgerFile.safeParse(safeJson(text));
    if (!parsed.success) throw new LedgerError("the spend ledger is damaged; nothing more is spent until it is repaired");
    return parsed.data.entries;
  }

  /** Writes a temporary file, flushes it, then renames it over the ledger. Entries older than `retainMs` are dropped. */
  private save(entries: readonly SpendEntry[], now: Date): void {
    const keepSince = now.getTime() - this.retainMs;
    const body = `${JSON.stringify(LedgerFile.parse({ schemaVersion: "1", entries: entries.filter((e) => Date.parse(e.at) > keepSince) }))}\n`;
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
  }

  private withLock<T>(fn: () => T): T {
    const release = acquireLock(this.lockFile);
    try {
      return fn();
    } finally {
      release();
    }
  }
}

/** How long to wait for another process's lock before giving up. */
const LOCK_WAIT_MS = 3000;
/** A lock older than this is stale whatever its holder: every holder keeps it for one short read-check-write. */
const LOCK_STALE_MS = 30_000;

/**
 * An exclusive lock file (`O_CREAT | O_EXCL`) holding its owner's token: the
 * pid and random bytes. A lock whose owner is gone, or that is older than any
 * holder keeps one, is stale. It is broken only under a second exclusive file
 * (`<lock>.break`) and only while it still holds the token judged stale, so
 * two processes that find the same lock stale cannot both clear it and each
 * take the lock after the other. Release removes the lock only while it still
 * holds this owner's token. Waits by blocking briefly, since every holder is
 * synchronous and quick.
 *
 * What remains is a process that crashes inside the break (a few system
 * calls): its break file is cleared once it is older than any holder keeps one.
 */
export function acquireLock(path: string, waitMs: number = LOCK_WAIT_MS): () => void {
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (createExclusive(path, token)) return () => removeIfHolds(path, token);
    const stale = staleToken(path);
    if (stale !== undefined && breakStaleLock(path, stale, token)) continue;
    if (Date.now() >= deadline) throw new LedgerError("the spend ledger is locked by another process");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

/** Creates `path` holding `token`; false when it exists. */
function createExclusive(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** A lock file's token and age, read through one descriptor; undefined when it is gone. */
function readLock(path: string): { readonly token: string; readonly ageMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return undefined;
  }
  try {
    return { token: readFileSync(fd, "utf8"), ageMs: Date.now() - fstatSync(fd).mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** The lock's token when it is stale (its owner is gone, or it is older than any holder keeps one); otherwise undefined. */
function staleToken(path: string): string | undefined {
  const lock = readLock(path);
  if (lock === undefined) return undefined;
  if (lock.ageMs > LOCK_STALE_MS) return lock.token;
  // An empty token is a lock being written. An older bridge wrote the bare pid.
  const pid = Number(lock.token.split(":")[0]);
  if (lock.token === "" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return undefined;
  } catch (error) {
    // ESRCH: the owner is gone. EPERM: alive, another user's.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? lock.token : undefined;
  }
}

/**
 * Clears a stale lock under `<path>.break`, and only while it still holds
 * `stale`, the token judged stale. True when the caller should try to take the
 * lock again; false when another process is breaking it.
 */
function breakStaleLock(path: string, stale: string, token: string): boolean {
  const breaker = `${path}.break`;
  if (!createExclusive(breaker, token)) {
    const left = readLock(breaker);
    if (left !== undefined && left.ageMs > LOCK_STALE_MS) removeIfHolds(breaker, left.token);
    return false;
  }
  try {
    if (readLock(path)?.token === stale) rmSync(path, { force: true });
    return true;
  } finally {
    removeIfHolds(breaker, token);
  }
}

/** Removes a lock file only while it holds `token`. */
function removeIfHolds(path: string, token: string): void {
  if (readLock(path)?.token === token) rmSync(path, { force: true });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
