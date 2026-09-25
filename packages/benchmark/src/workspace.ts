import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { fileDigest } from "@lemma/core";

import { isInside } from "./files.js";

/**
 * Names that give an agent ambient settings when found in any directory above
 * its workspace. `@cursor/sdk` loads `.cursor/rules`, `AGENTS.md`, `CLAUDE.md`
 * and `CLAUDE.local.md` from every ancestor of the working directory, and
 * `.cursorrules` from the enclosing git repository; `.git` would also put the
 * run inside another repository, where the agent's git commands act on it.
 */
export const AMBIENT_SETTING_NAMES = [".cursor", ".cursorrules", "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".git"] as const;

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

export interface RunWorkspace {
  readonly root: string;
  /** The fixture copy the agent works in. */
  readonly cwd: string;
  /** A fresh home directory: no user-level settings, credentials or caches. */
  readonly home: string;
  /** Where the Lemma bridge writes its initialize and tool-call trace. */
  readonly trace: string;
  dispose(): void;
}

/**
 * A fresh, isolated copy of a fixture for one run (benchmark-protocol.md
 * "Controls"). The copy lives outside the Lemma repository, so neither
 * relative paths nor the SDK's discovery of project settings reach the
 * catalog or this repository's settings, and nothing above it may carry
 * ambient agent settings, because those are loaded from every ancestor. The
 * treatment copy also gets the Lemma rule, the only file that differs between
 * arms. This keeps discovery out, not a determined agent: with the sandbox
 * off, an agent can reach any path the operator's user can read.
 */
export function prepareWorkspace(options: {
  readonly base: string;
  readonly runId: string;
  readonly fixtureDir: string;
  readonly repositoryRoot: string;
  readonly rulePath: string | null;
}): RunWorkspace {
  const base = prepareRunBase(options.base, options.repositoryRoot);
  const root = join(base, options.runId.slice(2, 18));
  const cwd = join(root, "work");
  const home = join(root, "home");
  const dispose = () => removeTree(root);
  try {
    mkdirSync(join(home, "tmp"), { recursive: true });
    cpSync(join(options.fixtureDir, "repo"), cwd, { recursive: true, errorOnExist: true, force: false });
    if (options.rulePath !== null) {
      mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
      cpSync(options.rulePath, join(cwd, ".cursor", "rules", "lemma.mdc"));
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { root, cwd, home, trace: join(root, "bridge-trace.jsonl"), dispose };
}

/**
 * Creates the directory runs go under and returns its real path, refusing one
 * inside the repository or below ambient agent settings. Every agent the
 * harness starts, the freeze smoke run included, works under this.
 */
export function prepareRunBase(dir: string, repositoryRoot: string): string {
  // Checked before anything is created, from the nearest directory that exists, so a refused base leaves nothing behind.
  let existing = resolve(dir);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (isInside(realpathSync(existing), realpathSync(repositoryRoot))) {
    throw new WorkspaceError(`run directory ${resolve(dir)} is inside the repository; use a directory outside it`);
  }
  // Real paths: a symlinked run directory must not smuggle the copy into the repository.
  mkdirSync(dir, { recursive: true });
  const base = realpathSync(dir);
  if (isInside(base, realpathSync(repositoryRoot))) {
    throw new WorkspaceError(`run directory ${base} is inside the repository; use a directory outside it`);
  }
  assertNoAmbientSettings(base);
  return base;
}

/**
 * Removes a run directory. A run can leave directories without write
 * permission (a Go module cache, a test that chmods), so a failed removal is
 * retried after making the tree writable; if it still fails, the directory is
 * left with a warning. Cleanup never throws, so it can never replace a run's
 * result.
 */
export function removeTree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
    return;
  } catch {
    // Retried below.
  }
  try {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.warn(`could not remove run directory ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeWritable(dir: string): void {
  if (!lstatSync(dir).isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) makeWritable(join(dir, entry.name));
}

/** Refuses to run when `dir` or any ancestor holds ambient agent settings or a repository. */
export function assertNoAmbientSettings(dir: string): void {
  let current = realpathSync(dir);
  for (;;) {
    for (const name of AMBIENT_SETTING_NAMES) {
      if (existsSync(join(current, name))) throw new WorkspaceError(`${join(current, name)} would give agents ambient settings or an enclosing repository`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const SKIP = new Set(["node_modules", ".git", ".cursor"]);

/** Digest of every file under `dir`, skipping dependencies, VCS data and the rule. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.set(path, fileDigest(readFileSync(join(dir, path))));
    }
  };
  visit("");
  return out;
}

/** Files added, removed or changed between two snapshots. */
export function filesChanged(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): number {
  let n = 0;
  for (const [path, digest] of after) if (before.get(path) !== digest) n++;
  for (const path of before.keys()) if (!after.has(path)) n++;
  return n;
}

/** What the bridge trace says: whether it initialized and how many tool calls it served. */
export function readTrace(path: string): { initialized: boolean; toolCalls: number } {
  if (!existsSync(path)) return { initialized: false, toolCalls: 0 };
  let initialized = false;
  let toolCalls = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = (JSON.parse(line) as { event?: unknown }).event;
      if (event === "initialize") initialized = true;
      if (event === "tool") toolCalls++;
    } catch {
      // A torn last line from a killed bridge; ignore it.
    }
  }
  return { initialized, toolCalls };
}
