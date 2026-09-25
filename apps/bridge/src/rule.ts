import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** The Lemma rule a Cursor project installs; the benchmark's treatment arm receives exactly this file. */
export const RULE_PATH = fileURLToPath(new URL("../rules/lemma.mdc", import.meta.url));

/** Rules are read on every turn, so the rule stays within this many characters. */
export const MAX_RULE_CHARS = 600;

/** Writes the rule to `<dir>/.cursor/rules/lemma.mdc`, refusing to write through symbolic links. */
export function installRule(dir: string): string {
  const base = resolvePath(dir);
  const target = join(base, ".cursor", "rules");
  for (const path of [join(base, ".cursor"), target, join(target, "lemma.mdc")]) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to write through it`);
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "lemma.mdc"), readFileSync(RULE_PATH));
  return join(target, "lemma.mdc");
}
