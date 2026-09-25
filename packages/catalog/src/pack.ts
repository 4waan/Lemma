import { PackageName, PatchBundle, PatchPath, SemverRange, fileDigest } from "@lemma/core";
import { z } from "zod";

import { listEntries, listFilesRecursive, readBytes, readJson, readText } from "./files.js";
import { issues } from "./load.js";
import { PAYLOAD_DIR } from "./paths.js";

/**
 * `payload/ops.json`: which files a release adds, modifies or deletes, and the
 * dependency changes the bridge applies through the package manager. Content
 * lives in `payload/files/<path>`. The file each modify or delete was built
 * against lives in `payload/base/<path>`, so its drift digest is computed, not
 * typed in, and reviewers can read what the patch assumes.
 */
export const PayloadOps = z.strictObject({
  dependencies: z.record(PackageName, SemverRange),
  devDependencies: z.record(PackageName, SemverRange),
  files: z
    .array(z.strictObject({ path: PatchPath, op: z.enum(["add", "modify", "delete"]) }))
    .min(1),
});

export type PayloadOps = z.infer<typeof PayloadOps>;

/**
 * Builds a release's PatchBundle from its `payload/` directory. The result is
 * deterministic: files are sorted by path, and every file in `files/` and
 * `base/` must be named by an op, so nothing unreviewed rides along.
 *
 * `releaseDir` is relative to the catalog `root`, and every error names its
 * path from the catalog root, the same way the catalog scan does, so a fault
 * both see is reported once.
 */
export function packPayload(root: string, releaseDir: string): PatchBundle {
  const payload = `${releaseDir}/${PAYLOAD_DIR}`;
  const stray = listEntries(root, payload)
    .filter((e) => !(e.kind === "file" && e.name === "ops.json") && !(e.kind === "dir" && (e.name === "files" || e.name === "base")))
    .map((e) => e.name);
  if (stray.length > 0) throw new Error(`${payload}: holds only ops.json, files/ and base/, not ${stray.join(", ")}`);
  const parsedOps = PayloadOps.safeParse(readJson(root, `${payload}/ops.json`));
  if (!parsedOps.success) throw new Error(`${payload}/ops.json: ${issues(parsedOps.error)}`);
  const ops = parsedOps.data;
  const needsContent = new Set(ops.files.filter((f) => f.op !== "delete").map((f) => f.path));
  const needsBase = new Set(ops.files.filter((f) => f.op !== "add").map((f) => f.path));
  assertExactly(needsContent, listFilesRecursive(root, `${payload}/files`), `${payload}/files`);
  assertExactly(needsBase, listFilesRecursive(root, `${payload}/base`), `${payload}/base`);

  const files = ops.files
    .map((f) => ({
      path: f.path,
      op: f.op,
      baseDigest: f.op === "add" ? null : fileDigest(readBytes(root, `${payload}/base/${f.path}`)),
      content: f.op === "delete" ? null : readText(root, `${payload}/files/${f.path}`),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const bundle = PatchBundle.safeParse({ schemaVersion: "1", files, dependencies: ops.dependencies, devDependencies: ops.devDependencies });
  if (!bundle.success) throw new Error(`${payload}: packs to an invalid bundle: ${issues(bundle.error)}`);
  return bundle.data;
}

/** The committed form of `bundle.json`: two-space JSON with a trailing newline. */
export function formatBundle(bundle: PatchBundle): string {
  return `${JSON.stringify(PatchBundle.parse(bundle), null, 2)}\n`;
}

function assertExactly(expected: ReadonlySet<string>, present: readonly string[], dir: string): void {
  const missing = [...expected].filter((p) => !present.includes(p)).sort();
  const extra = present.filter((p) => !expected.has(p));
  if (missing.length > 0) throw new Error(`${dir}: missing ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${dir}: not named in ops.json: ${extra.join(", ")}`);
}
