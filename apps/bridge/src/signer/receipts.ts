import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

import { Hex32, IsoTimestamp } from "@lemma/core";
import { z } from "zod";

import { LedgerError, acquireLock } from "../ledger.js";

/** How long the signer remembers a payment it signed, and the receipt it signed for it: receipts for older purchases are refused as NOT_PAID. */
export const PAYMENT_MEMORY_MS = 90 * 24 * 3600 * 1000;

/** The most payments it remembers; past this the oldest are forgotten, never refused, so a flood of payments cannot stop the signer. */
export const PAYMENT_MEMORY_ENTRIES = 10_000;

const Entry = z.strictObject({ nonce: Hex32, at: IsoTimestamp, receipt: Hex32.nullable() });
const BookFile = z.strictObject({ schemaVersion: z.literal("1"), entries: z.array(Entry).max(PAYMENT_MEMORY_ENTRIES) });

type Entry = z.infer<typeof Entry>;

/**
 * The payments the signer signed, by payment nonce, each with the one
 * receipt it signed for it. A resolution's payment nonce comes from its id
 * and preview id, so this is one receipt per resolution. A receipt asked for
 * again with the same digest (a retry of the bridge's stored receipt) is
 * signed again; a different receipt is refused, so a process that got a
 * receipt signed first cannot replace the bridge's, and the bridge's own
 * cannot be replaced after it.
 *
 * Kept apart from the spend ledger, whose entries last two cap windows, under
 * the same kind of lock, and replaced atomically. An unreadable book fails
 * closed: nothing is signed. A full one forgets its oldest payments.
 */
export class ReceiptBook {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(
    readonly dir: string,
    private readonly retainMs: number = PAYMENT_MEMORY_MS,
    private readonly maxEntries: number = PAYMENT_MEMORY_ENTRIES,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "receipts.json");
    this.lockFile = join(dir, "receipts.lock");
  }

  /** Records a payment the signer is about to sign; a nonce signed again (a retry) keeps its entry and its receipt. */
  paid(nonce: Hex32, now: Date): void {
    this.withLock((entries) => (entries.some((e) => e.nonce === nonce) ? undefined : [...entries, { nonce, at: now.toISOString(), receipt: null }]), now);
  }

  /**
   * Under the lock: "signed", and the receipt recorded, when the payment is
   * remembered and has no receipt yet or this one; "not-paid" or "taken"
   * otherwise. The caller signs only on "signed".
   */
  claim(nonce: Hex32, digest: Hex32, now: Date): "signed" | "not-paid" | "taken" {
    let result: "signed" | "not-paid" | "taken" = "not-paid";
    this.withLock((entries) => {
      const entry = entries.find((e) => e.nonce === nonce && this.kept(e, now));
      if (entry === undefined) return undefined;
      if (entry.receipt !== null) {
        result = entry.receipt === digest ? "signed" : "taken";
        return undefined;
      }
      result = "signed";
      return entries.map((e) => (e === entry ? { ...e, receipt: digest } : e));
    }, now);
    return result;
  }

  /** Loads the entries under the lock and saves what `change` returns (nothing saved on undefined). */
  private withLock(change: (entries: readonly Entry[]) => readonly Entry[] | undefined, now: Date): void {
    const release = acquireLock(this.lockFile);
    try {
      const next = change(this.load());
      if (next !== undefined) this.save(next, now);
    } finally {
      release();
    }
  }

  private kept(entry: Entry, now: Date): boolean {
    return Date.parse(entry.at) > now.getTime() - this.retainMs;
  }

  private load(): Entry[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new LedgerError("the signer's receipt book could not be read");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = BookFile.safeParse(json);
    if (!parsed.success) throw new LedgerError("the signer's receipt book is damaged; no receipt is signed until it is repaired");
    return parsed.data.entries;
  }

  private save(entries: readonly Entry[], now: Date): void {
    const kept = entries.filter((e) => this.kept(e, now)).slice(-this.maxEntries);
    const body = `${JSON.stringify(BookFile.parse({ schemaVersion: "1", entries: kept }))}\n`;
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
}
