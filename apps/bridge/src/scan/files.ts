import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** The only files the scanner ever reads (bridge README: "Read only reviewed manifest and lockfile names"). */
export const READABLE = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version"]);

/** Lockfiles in monorepos can be large; anything bigger is refused rather than read. */
export const MAX_READ_BYTES = 32 * 1024 * 1024;

export class ScanError extends Error {
  override name = "ScanError";
}

/**
 * Reads an allowlisted file under the workspace root. Every path segment from
 * the root down is checked with lstat, so a symlink anywhere on the way is
 * refused (bridge README: "Reject symlinks, absolute paths, parent traversal").
 * Returns undefined when the file does not exist.
 */
export function readAllowlisted(root: string, dir: string, name: string): string | undefined {
  if (!READABLE.has(name)) throw new ScanError(`${name} is not an allowlisted file`);
  const rel = relative(root, dir);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new ScanError("the directory is outside the workspace");
  let path = root;
  for (const segment of [...(rel === "" ? [] : rel.split(sep)), name]) {
    path = join(path, segment);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) throw new ScanError(`${relative(root, path)} is a symbolic link; the scanner does not follow links`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new ScanError(`${relative(root, path)} is not a regular file`);
  if (stat.size > MAX_READ_BYTES) throw new ScanError(`${relative(root, path)} is larger than ${MAX_READ_BYTES} bytes`);
  return readFileSync(path, "utf8");
}

/**
 * Whether a regular file exists, without reading it. Like `readAllowlisted`,
 * it refuses rather than skips: a link or another non-regular file under that
 * name throws, so a search never passes over it to an ancestor's file.
 */
export function existsRegular(root: string, dir: string, name: string): boolean {
  const path = join(dir, name);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) throw new ScanError(`${rel} is a symbolic link; the scanner does not follow links`);
  if (!stat.isFile()) throw new ScanError(`${rel} is not a regular file`);
  return true;
}

/**
 * The directory of a package the agent named (`apps/api`), or undefined unless
 * every segment from the root down is a real directory, none a link, and it
 * holds its own package.json. A named package is never replaced by a parent.
 */
export function packageDirAt(root: string, pkg: string): string | undefined {
  let path = root;
  for (const segment of pkg.split("/")) {
    path = join(path, segment);
    try {
      if (!lstatSync(path).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return readAllowlisted(root, path, "package.json") === undefined ? undefined : path;
  } catch {
    return undefined;
  }
}
