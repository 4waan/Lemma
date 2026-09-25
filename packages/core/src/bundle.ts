import { keccak256, stringToBytes } from "viem";
import { z } from "zod";

import { digest, hasLoneSurrogate } from "./canonical.js";
import { type Hex32, PackageName, SchemaVersion } from "./primitives.js";
import { SemverRange } from "./release.js";

export const MAX_BUNDLE_FILES = 200;
export const MAX_FILE_CONTENT = 256 * 1024;
export const MAX_BUNDLE_CONTENT = 2 * 1024 * 1024;

const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,127}$/;
// Files a patch may never write. Dependency changes go through `dependencies`
// and `devDependencies`, which the bridge applies with the package manager, so
// package.json scripts and lockfiles are never edited as text.
const PROTECTED = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "node_modules"]);

/**
 * A workspace-relative POSIX path: no leading "/", no "." or ".." segments,
 * no backslashes, no dotfiles (.env, .npmrc, .git, .github) and no protected files.
 */
export const PatchPath = z
  .string()
  .min(1)
  .max(256)
  .refine((p) => p.split("/").every((s) => SEGMENT.test(s)), "expected a relative POSIX path of safe segments without dotfiles")
  .refine((p) => !p.split("/").some((s) => PROTECTED.has(s)), "package manifests, lockfiles and node_modules cannot be patched");

/** keccak256 of a file's bytes, used as `baseDigest` to detect drift before applying. */
export function fileDigest(content: string | Uint8Array): Hex32 {
  return keccak256(typeof content === "string" ? stringToBytes(content) : content);
}

const Content = z
  .string()
  .max(MAX_FILE_CONTENT)
  .refine((c) => !c.includes("\0") && !c.includes("\r") && !hasLoneSurrogate(c), "content is UTF-8 text with LF line endings");

/**
 * One file change. `baseDigest` is the digest of the file the patch was built
 * against; the bridge refuses to apply when the buyer's file differs.
 */
export const PatchFile = z
  .strictObject({
    path: PatchPath,
    op: z.enum(["add", "modify", "delete"]),
    baseDigest: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
    content: Content.nullable(),
  })
  .superRefine((f, ctx) => {
    const ok =
      (f.op === "add" && f.baseDigest === null && f.content !== null) ||
      (f.op === "modify" && f.baseDigest !== null && f.content !== null) ||
      (f.op === "delete" && f.baseDigest !== null && f.content === null);
    if (!ok) ctx.addIssue({ code: "custom", path: ["op"], message: "add needs content and no base; modify needs both; delete needs a base and no content" });
  });

const DependencyChanges = z
  .record(PackageName, SemverRange)
  .refine((d) => Object.keys(d).length <= 32, "at most 32 dependency changes");

/**
 * The deterministic payload of a Capability Release. Its digest is the release's
 * `payloadDigest` and the resolution's `payloadDigest`.
 */
export const PatchBundle = z
  .strictObject({
    schemaVersion: SchemaVersion,
    files: z.array(PatchFile).min(1).max(MAX_BUNDLE_FILES),
    dependencies: DependencyChanges,
    devDependencies: DependencyChanges,
  })
  .superRefine((b, ctx) => {
    const paths = b.files.map((f) => f.path);
    for (let i = 1; i < paths.length; i++) {
      if ((paths[i - 1] as string) >= (paths[i] as string)) {
        ctx.addIssue({ code: "custom", path: ["files", i, "path"], message: "files must be sorted by path and unique" });
        break;
      }
    }
    if (new Set(paths.map((p) => p.toLowerCase())).size !== paths.length) {
      ctx.addIssue({ code: "custom", path: ["files"], message: "paths must be unique ignoring case" });
    }
    const dirs = new Set(paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
    if (paths.some((p) => dirs.has(p))) ctx.addIssue({ code: "custom", path: ["files"], message: "a path cannot be both a file and a directory" });
    const total = b.files.reduce((n, f) => n + (f.content?.length ?? 0), 0);
    if (total > MAX_BUNDLE_CONTENT) ctx.addIssue({ code: "custom", path: ["files"], message: `total content exceeds ${MAX_BUNDLE_CONTENT} characters` });
  });

export type PatchBundle = z.infer<typeof PatchBundle>;

export function bundleDigest(bundle: PatchBundle): Hex32 {
  return digest("patch-bundle", PatchBundle.parse(bundle));
}

/** What `planApply` is told about a workspace path: a file's `fileDigest`, a directory, or nothing. */
export const DIRECTORY = "directory" as const;

export type PathState = Hex32 | typeof DIRECTORY | null;

/** A path the bundle expects in a different state than the buyer's workspace holds it. */
export type Drift = {
  path: string;
  op: "add" | "modify" | "delete";
  /** What the bundle needs there: its base file's digest, nothing (null), or a directory. */
  expected: PathState;
  /** What the workspace holds now. */
  actual: PathState;
};

/** What applying a bundle would do, or every path that has drifted. */
export type ApplyPlan =
  | {
      ok: true;
      /** Files to write, sorted by path. */
      writes: Array<{ path: string; op: "add" | "modify"; content: string }>;
      /** Files to delete, sorted by path. */
      deletes: string[];
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }
  | { ok: false; drift: Drift[] };

/**
 * Plans a bundle against the buyer's workspace without touching it.
 *
 * - An add needs nothing at its path, and a directory or nothing at every
 *   parent path.
 * - A modify or delete needs the file whose digest is its `baseDigest`.
 *
 * Any other state is drift. Then nothing is planned, and every drifted path is
 * reported, so the bridge can answer `adapt`.
 *
 * `state(path)` reports the workspace, for bundle paths and their parents:
 * `fileDigest` of a regular file, `DIRECTORY`, or null when nothing exists
 * there. The caller reads the files, and this function stays pure, so the
 * bridge, the benchmark probe and tests share one rule. On a case-insensitive
 * filesystem the caller's lookup already finds a file that differs only in
 * case, which then counts as drift.
 */
export function planApply(bundle: PatchBundle, state: (path: string) => PathState): ApplyPlan {
  const b = PatchBundle.parse(bundle);
  const drift: Drift[] = [];
  const writes: Array<{ path: string; op: "add" | "modify"; content: string }> = [];
  const deletes: string[] = [];
  const seenParents = new Set<string>();
  for (const file of b.files) {
    if (file.op === "add") {
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const parent = segments.slice(0, i).join("/");
        if (seenParents.has(parent)) continue;
        seenParents.add(parent);
        const actual = state(parent);
        if (actual !== null && actual !== DIRECTORY) drift.push({ path: parent, op: file.op, expected: DIRECTORY, actual });
      }
    }
    const actual = state(file.path);
    if (actual !== file.baseDigest) {
      drift.push({ path: file.path, op: file.op, expected: file.baseDigest, actual });
    } else if (file.op === "delete") {
      deletes.push(file.path);
    } else {
      writes.push({ path: file.path, op: file.op, content: file.content as string });
    }
  }
  if (drift.length > 0) return { ok: false, drift };
  return { ok: true, writes, deletes, dependencies: { ...b.dependencies }, devDependencies: { ...b.devDependencies } };
}
