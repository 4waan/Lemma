import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PathLike, RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LedgerError, acquireLock } from "../src/ledger.js";

/** Runs once, just before the next removal of a `spend.lock` file: another process acting at that moment. */
const hooks = vi.hoisted(() => ({ beforeRemovingLock: undefined as undefined | (() => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync = (path: PathLike, options?: RmOptions) => {
    const hook = hooks.beforeRemovingLock;
    if (hook !== undefined && String(path).endsWith("spend.lock")) {
      hooks.beforeRemovingLock = undefined;
      hook();
    }
    actual.rmSync(path, options);
  };
  return { ...actual, rmSync, default: { ...actual, rmSync } };
});

const temps: string[] = [];
afterEach(() => {
  hooks.beforeRemovingLock = undefined;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lemma-lock-"));
  temps.push(dir);
  return join(dir, "spend.lock");
}

describe("the spend ledger's lock", () => {
  it("lets only one of two processes that find the same stale lock take it", () => {
    const lock = lockPath();
    // A bridge crashed holding the lock: its pid is gone.
    writeFileSync(lock, "999999999");
    let second: (() => void) | undefined;
    let secondError: unknown;
    // Just as this bridge clears the stale lock, another finds it stale too and tries to take the lock.
    hooks.beforeRemovingLock = () => {
      try {
        second = acquireLock(lock, 50);
      } catch (error) {
        secondError = error;
      }
    };
    const first = acquireLock(lock, 50);
    expect(second).toBeUndefined();
    expect(secondError).toBeInstanceOf(LedgerError);
    first();
    expect(existsSync(lock)).toBe(false);
  });

  it("releases only a lock that is still its own", () => {
    const lock = lockPath();
    const release = acquireLock(lock, 50);
    // Another process took the lock over meanwhile (it judged this one stale).
    writeFileSync(lock, `${process.ppid}:another`);
    release();
    expect(readFileSync(lock, "utf8")).toBe(`${process.ppid}:another`);
  });
});
