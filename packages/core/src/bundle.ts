import { keccak256, stringToBytes } from "viem";
import { z } from "zod";

import { digest } from "./canonical.js";
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
  .refine((c) => !c.includes("\0") && !c.includes("\r"), "content is UTF-8 text with LF line endings");

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
