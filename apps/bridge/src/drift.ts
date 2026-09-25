import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_FILE_CONTENT, fileDigest } from "@lemma/core";

import type { BaseProbeEntry } from "./remote.js";
import type { DriftCheck } from "./text.js";

/**
 * Predicts before paying whether a release would apply cleanly, using only the
 * release's base probe (paths and base digests). Nothing is sent: local files
 * are hashed and compared here.
 *
 * - An add needs an empty path whose parents are directories or absent.
 * - A modify or delete needs the file whose digest is its base digest.
 *
 * Symlinks count as drift, because the bridge never writes through links. So
 * does a file larger than a patch may carry, which is not read. Probe paths are
 * safe relative paths (core PatchPath), so nothing outside the package is read.
 */
export function driftCheck(packageDir: string, entries: readonly BaseProbeEntry[]): DriftCheck {
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const state = stateOf(join(packageDir, ...segments.slice(0, i)));
      if (state !== "absent" && state !== "directory") return "likely";
    }
    const state = stateOf(join(packageDir, ...segments));
    if (entry.baseDigest === null ? state !== "absent" : state !== entry.baseDigest) return "likely";
  }
  return "none";
}

function stateOf(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "absent";
  }
  if (stat.isSymbolicLink()) return "link";
  if (stat.isDirectory()) return "directory";
  if (!stat.isFile()) return "other";
  if (stat.size > MAX_FILE_CONTENT) return "oversize";
  return fileDigest(readFileSync(path));
}
