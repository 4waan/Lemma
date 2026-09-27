import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

import { Hex32, IsoTimestamp } from "@lemma/core";
import { z } from "zod";

import { LedgerError, acquireLock } from "../ledger.js";

/** How long the signer remembers a receipt it signed, and a payment it signed for. */
export const RECEIPT_MEMORY_MS = 30 * 24 * 3600 * 1000;

const Entry = z.strictObject({ resolutionId: Hex32, digest: Hex32, at: IsoTimestamp });
const BookFile = z.strictObject({ schemaVersion: z.literal("1"), entries: z.array(Entry).max(50_000) });

type Entry = z.infer<typeof Entry>;

/**
 * The receipts the signer has signed: one receipt per resolution. A receipt
 * asked for again with the same digest (a retry of the bridge's stored
 * receipt) is signed again; a different receipt for the same resolution is
 * refused, so a process that got a receipt signed first cannot replace the
 * bridge's, and the bridge's own cannot be replaced after it.
 *
 * Kept next to the signer's spend ledger, under the same kind of lock, and
 * replaced atomically. An unreadable book fails closed: nothing is signed.
 */
export class ReceiptBook {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(
    readonly dir: string,
    private readonly retainMs: number = RECEIPT_MEMORY_MS,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "receipts.json");
    this.lockFile = join(dir, "receipts.lock");
  }

  /**
   * Under the lock: true, and the receipt recorded, when this resolution has
   * no receipt yet or the same one; false when another receipt was signed for
   * it. The caller signs only on true.
   */
  claim(resolutionId: Hex32, digest: Hex32, now: Date): boolean {
    const release = acquireLock(this.lockFile);
    try {
      const entries = this.load();
      const earlier = entries.find((e) => e.resolutionId === resolutionId);
      if (earlier !== undefined) return earlier.digest === digest;
      this.save([...entries, { resolutionId, digest, at: now.toISOString() }], now);
      return true;
    } finally {
      release();
    }
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
    const keepSince = now.getTime() - this.retainMs;
    const body = `${JSON.stringify(BookFile.parse({ schemaVersion: "1", entries: entries.filter((e) => Date.parse(e.at) > keepSince) }))}\n`;
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
