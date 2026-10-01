import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { type Address, toAddress } from "@lemma/core";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export class KeyFileError extends Error {
  override name = "KeyFileError";
}

const KEY_TEXT = /^0x[0-9a-fA-F]{64}$/;

/**
 * Reads the buyer key from its file, refusing a file anyone but its owner
 * could read or change: it must be a regular file (not a symbolic link),
 * mode 0600 or stricter, owned by the user running the signer, and hold
 * `0x` and 64 hex digits. It is opened without following links and checked
 * again through the open descriptor, so it cannot be swapped between the
 * check and the read. Errors never quote the file's content.
 */
export function readKeyFile(path: string): Hex {
  let link;
  try {
    link = lstatSync(path);
  } catch {
    throw new KeyFileError("the key file does not exist; create one with lemma-signer init");
  }
  if (link.isSymbolicLink()) throw new KeyFileError("the key file must not be a symbolic link");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== link.ino || st.dev !== link.dev) throw new KeyFileError("the key file must be a regular file");
    if ((st.mode & 0o077) !== 0) throw new KeyFileError("the key file must be readable by its owner only (chmod 600)");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new KeyFileError("the key file must belong to the user running the signer");
    const text = readFileSync(fd, "utf8").trim();
    if (!KEY_TEXT.test(text)) throw new KeyFileError("the key file must hold 0x followed by 64 hex digits");
    return text.toLowerCase() as Hex;
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates a new key file (`lemma-signer init`): a fresh key from viem's
 * `generatePrivateKey` (the platform's secure random source), written with
 * mode 0600 into a 0700 directory. An existing file is never overwritten.
 * Returns the address only.
 */
export function initKeyFile(path: string): Address {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = generatePrivateKey();
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new KeyFileError("a key file already exists there; it is never overwritten");
    throw new KeyFileError("the key file could not be created");
  }
  try {
    writeSync(fd, `${key}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return toAddress(privateKeyToAccount(key).address);
}
