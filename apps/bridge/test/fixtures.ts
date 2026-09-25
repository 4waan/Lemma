import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type Hex32, type PatchBundle, fileDigest } from "@lemma/core";

export const NOW = new Date("2026-10-01T00:00:00.000Z");
export const BUYER = "0x00000000000000000000000000000000000000b1";
export const ID = `0x${"ab".repeat(32)}` as Hex32;

const temps: string[] = [];

/** A temporary directory, removed by `removeTemps` (each test file calls it after every test). */
export function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Keeps a path made outside `temp` (a moved workspace, say) for removal after the test. */
export function removeLater(path: string): void {
  temps.push(path);
}

export function removeTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A temporary directory holding these files. */
export function tree(files: Record<string, string>): string {
  const root = temp("lemma-apply-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Every file (with its content) and directory under a root. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out[`${path}/`] = "dir";
        visit(path);
      } else out[path] = readFileSync(join(root, path), "utf8");
    }
  };
  visit("");
  return out;
}

/** Adds two files (one in a new directory), modifies one, deletes one, and installs one dependency. */
export const bundle: PatchBundle = {
  schemaVersion: "1",
  files: [
    { path: "old.ts", op: "delete", baseDigest: fileDigest("old\n"), content: null },
    { path: "run.sh", op: "modify", baseDigest: fileDigest("echo 1\n"), content: "echo 2\n" },
    { path: "src/lemma/a.ts", op: "add", baseDigest: null, content: "export const a = 1;\n" },
    { path: "src/lemma/b.ts", op: "add", baseDigest: null, content: "export const b = 2;\n" },
  ],
  dependencies: { "@x402/mcp": ">=2.27.0 <3" },
  devDependencies: {},
};

/** A package `bundle` applies to cleanly. */
export const start = { "old.ts": "old\n", "run.sh": "echo 1\n", "package.json": "{}\n", "src/keep.ts": "keep\n" };
