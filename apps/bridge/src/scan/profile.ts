import { lstatSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { ExactVersion, Framework, type RepositoryProfile, RepositoryProfile as ProfileSchema, SemverRange } from "@lemma/core";
import { satisfies, validRange } from "semver";

import { ScanError, existsRegular, readAllowlisted } from "./files.js";
import { npmVersion, pnpmVersion, yarnVersion } from "./lockfiles.js";

type Manager = "npm" | "pnpm" | "yarn";

// npm reads npm-shrinkwrap.json and ignores package-lock.json when both exist.
const LOCKFILES: ReadonlyArray<[Manager, string]> = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["npm", "npm-shrinkwrap.json"],
  ["npm", "package-lock.json"],
];

/** Node LTS codenames as `.nvmrc` writes them (`lts/iron`); each names one fixed major. */
const LTS_MAJORS: Readonly<Record<string, number>> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

export interface ScanResult {
  readonly profile: RepositoryProfile;
  /** What could not be determined exactly, in plain words for the agent's user; never file contents. */
  readonly notes: readonly string[];
}

export interface ScanOptions {
  /** The workspace root; nothing above it is read. */
  readonly root: string;
  /** Where the agent works; the nearest package.json at or above it is the package being changed. */
  readonly cwd: string;
  /** The catalog's interest set for the capability: the only dependency names that may leave the machine. */
  readonly interest: readonly string[];
  /** The Node major of the running bridge, used when the repository does not pin one. */
  readonly runningNodeMajor: number;
}

/**
 * Builds the privacy-safe RepositoryProfile for a workspace (core
 * RepositoryProfile, scale lever 6):
 *
 * - The package is the nearest package.json at or above `cwd`, within the root.
 * - The lockfile is the nearest one at or above that package, which covers
 *   monorepo workspaces. Its format decides the package manager. When the
 *   lockfile directory's package.json names one in `packageManager`, that
 *   manager's lockfile is read; if it is absent, or several managers' lockfiles
 *   are present and nothing chooses, no version is resolved and that is noted.
 * - Dependencies are declared dependencies and devDependencies that are in the
 *   interest set, each at the exact version the lockfile installed. Only
 *   registry ranges are looked up (not `npm:` aliases, git, file, link or
 *   workspace specifiers), and a version outside the declared range is not
 *   used. A declared dependency the lockfile does not resolve is left out and
 *   noted, never guessed.
 * - Frameworks come from declared dependencies. The module system comes from
 *   `type`, and the language from a tsconfig.json or a `typescript`
 *   dependency. The Node major comes from `.nvmrc` or `.node-version` (a
 *   version or an LTS codename), else from the running Node, noted.
 */
export function scanWorkspace(options: ScanOptions): ScanResult {
  const notes: string[] = [];
  const pkgDir = findPackageDir(options.root, options.cwd);
  const pkg = parsePackage(readAllowlisted(options.root, pkgDir, "package.json") as string);

  const lockDir = findUp(options.root, pkgDir, (dir) => LOCKFILES.some(([, name]) => existsRegular(options.root, dir, name)));
  const lockDirPkg = lockDir === undefined ? undefined : readAllowlisted(options.root, lockDir, "package.json");
  const packageManager = lockDirPkg === undefined ? undefined : parsePackage(lockDirPkg).packageManager;
  const declaredManager = parseManager(packageManager);
  const present = lockDir === undefined ? [] : LOCKFILES.filter(([, name]) => existsRegular(options.root, lockDir, name));
  const managers = [...new Set(present.map(([m]) => m))];
  let chosen: [Manager, string] | undefined;
  if (present.length === 0) notes.push("no lockfile was found, so no dependency version could be resolved");
  else if (typeof packageManager === "string") {
    chosen = present.find(([m]) => m === declaredManager);
    if (chosen === undefined) notes.push("packageManager names a manager whose lockfile is not there, so no dependency version was resolved");
  } else if (managers.length > 1) notes.push(`lockfiles of ${managers.join(", ")} are all present and packageManager does not choose, so no dependency version was resolved`);
  else chosen = present[0];
  const manager: Manager = chosen?.[0] ?? declaredManager ?? managers[0] ?? "npm";

  const declared: Record<string, string> = { ...pkg.devDependencies, ...pkg.dependencies };
  const dependencies: Record<string, string> = {};
  if (chosen !== undefined && lockDir !== undefined) {
    const text = readAllowlisted(options.root, lockDir, chosen[1]) as string;
    const rel = relative(lockDir, pkgDir).split(sep).join("/");
    let lockJson: unknown;
    if (manager === "npm") {
      try {
        lockJson = JSON.parse(text) as unknown;
      } catch {
        throw new ScanError(`${chosen[1]} is not valid JSON`);
      }
    }
    for (const name of [...new Set(options.interest)].sort()) {
      const spec = declared[name];
      if (spec === undefined) continue;
      const version = !SemverRange.safeParse(spec).success
        ? undefined
        : manager === "npm"
          ? npmVersion(lockJson, rel, name)
          : manager === "pnpm"
            ? pnpmVersion(text, rel, name)
            : yarnVersion(text, name, spec);
      // A tag such as `latest` is not a range and cannot be checked; a range must hold.
      const inRange = version !== undefined && (validRange(spec) === null || satisfies(version, spec));
      if (version !== undefined && ExactVersion.safeParse(version).success && inRange) dependencies[name] = version;
      else notes.push(`${name} is declared but ${chosen[1]} does not resolve it to an exact version`);
    }
  }

  const frameworks = Framework.options.filter((f) => declared[f] !== undefined);
  // tsconfig.json is never read, only noticed, so a linked one (a shared base config) still counts.
  const typescript = pathExists(join(pkgDir, "tsconfig.json")) || declared["typescript"] !== undefined;
  // The nearest pin file decides, as nvm does: one that names no major is not overridden by an ancestor's.
  const pins = [nodePin(options.root, pkgDir), lockDir === undefined || lockDir === pkgDir ? undefined : nodePin(options.root, lockDir)];
  const nearest = pins.find((p) => p !== undefined);
  let major = typeof nearest === "number" ? nearest : undefined;
  if (major === undefined) {
    major = options.runningNodeMajor;
    // Only the absence of a pin is expected; a pin that names no major (lts/*, node, a range) is a guess, noted as such.
    notes.push(
      pins.includes("unpinned")
        ? `.nvmrc or .node-version does not name a Node major, so the running Node ${major} is assumed`
        : `no .nvmrc or .node-version pins Node, so the running Node ${major} is assumed`,
    );
  }

  const lockfile = manager === "npm" ? "package-lock.json" : manager === "pnpm" ? "pnpm-lock.yaml" : "yarn.lock";
  const profile = ProfileSchema.parse({
    schemaVersion: "1",
    language: typescript ? "typescript" : "javascript",
    runtime: { name: "node", major },
    packageManager: { name: manager, lockfile },
    moduleSystem: pkg.type === "module" ? "esm" : "cjs",
    dependencies,
    frameworks,
  });
  return { profile, notes };
}

/** The nearest directory at or above `cwd`, within `root`, that holds a package.json. */
export function findPackageDir(root: string, cwd: string): string {
  const dir = findUp(root, cwd, (d) => readAllowlisted(root, d, "package.json") !== undefined);
  if (dir === undefined) throw new ScanError("no package.json at or above the working directory");
  return dir;
}

interface PackageFields {
  readonly type?: unknown;
  readonly packageManager?: unknown;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

function parsePackage(text: string): PackageFields {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ScanError("package.json is not valid JSON");
  }
  if (typeof value !== "object" || value === null) throw new ScanError("package.json is not an object");
  const record = value as Record<string, unknown>;
  const deps = (v: unknown): Record<string, string> =>
    typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  return { type: record["type"], packageManager: record["packageManager"], dependencies: deps(record["dependencies"]), devDependencies: deps(record["devDependencies"]) };
}

function parseManager(field: unknown): Manager | undefined {
  if (typeof field !== "string") return undefined;
  const name = field.split("@")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" ? name : undefined;
}

/** The Node major a directory pins, "unpinned" when a pin file names none, undefined when there is no pin file. */
function nodePin(root: string, dir: string): number | "unpinned" | undefined {
  let found = false;
  for (const name of [".nvmrc", ".node-version"]) {
    const text = readAllowlisted(root, dir, name);
    if (text === undefined) continue;
    found = true;
    const match = /^\s*v?(\d{1,3})(?:\.|\s|$)/.exec(text);
    if (match?.[1] !== undefined) return Number(match[1]);
    const lts = LTS_MAJORS[/^\s*lts\/([a-z]+)\s*$/i.exec(text)?.[1]?.toLowerCase() ?? ""];
    if (lts !== undefined) return lts;
  }
  return found ? "unpinned" : undefined;
}

/**
 * The first directory from `start` up to `root` (inclusive) for which `test`
 * holds. A directory that does not exist is passed over; a link is refused,
 * never passed over, so a linked package is not silently replaced by a parent.
 */
function findUp(root: string, start: string, test: (dir: string) => boolean): string | undefined {
  const rel = relative(root, start);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new ScanError("the working directory is outside the workspace");
  let dir = start;
  for (;;) {
    const kind = kindOf(dir);
    if (kind === "link") throw new ScanError(`${relative(root, dir) || "the workspace root"} is a symbolic link; the scanner does not follow links`);
    if (kind === "directory" && test(dir)) return dir;
    if (relative(root, dir) === "") return undefined;
    dir = dirname(dir);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function kindOf(path: string): "directory" | "link" | "other" {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "other";
  } catch {
    return "other";
  }
}
