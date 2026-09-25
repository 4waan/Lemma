import { lstatSync } from "node:fs";
import { join } from "node:path";

import { type ScanOptions, type ScanResult, findPackageDir, scanWorkspace } from "./profile.js";

/**
 * Scans again only when a file the scan could have read changed (by size and
 * modification time), or the interest set changed. A preview after an
 * unrelated edit costs a few lstat calls, not a lockfile parse.
 */
export class ScanCache {
  private last: { key: string; result: ScanResult } | undefined;

  scan(options: ScanOptions): ScanResult {
    const key = this.key(options);
    if (this.last?.key === key) return this.last.result;
    const result = scanWorkspace(options);
    this.last = { key, result };
    return result;
  }

  /** The package directory a scan from `cwd` would use (bundle paths are relative to it). */
  packageDir(root: string, cwd: string): string {
    return findPackageDir(root, cwd);
  }

  private key(options: ScanOptions): string {
    const stats: string[] = [];
    let dir = options.cwd;
    for (let i = 0; i < 64; i++) {
      for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version", "tsconfig.json"]) {
        try {
          const s = lstatSync(join(dir, name));
          stats.push(`${dir}/${name}:${s.size}:${s.mtimeMs}:${s.isSymbolicLink()}`);
        } catch {
          // absent
        }
      }
      if (dir === options.root || dir === join(dir, "..")) break;
      dir = join(dir, "..");
    }
    return JSON.stringify([options.root, options.cwd, [...options.interest].sort(), options.runningNodeMajor, stats]);
  }
}
