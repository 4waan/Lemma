import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** The Lemma rule a Cursor project installs; the benchmark's treatment arm receives exactly this file. */
export const RULE_PATH = fileURLToPath(new URL("../rules/lemma.mdc", import.meta.url));

/** Rules are read on every turn, so the rule stays within this many characters. */
export const MAX_RULE_CHARS = 600;

/**
 * Where the rule can be installed. `cursor` writes the `.mdc` file as it is.
 * The others receive its body without Cursor's frontmatter: `claude` as a
 * rule file Claude Code loads at the start of every session, `agents` as a
 * marked block in AGENTS.md, the file many coding agents read.
 */
export type RuleTarget = "cursor" | "claude" | "agents";
export type RuleAgent = RuleTarget | "all";
export const RULE_TARGETS: readonly RuleTarget[] = ["cursor", "claude", "agents"];

export function isRuleAgent(value: string): value is RuleAgent {
  return value === "all" || (RULE_TARGETS as readonly string[]).includes(value);
}

/** The rule's text without Cursor's frontmatter, ending in one newline. */
export function ruleBody(): string {
  const raw = readFileSync(RULE_PATH, "utf8");
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  return `${(frontmatter === null ? raw : raw.slice(frontmatter[0].length)).trim()}\n`;
}

const BEGIN = "<!-- lemma:begin -->";
const END = "<!-- lemma:end -->";

/** Refuses to write through a symbolic link anywhere on the way to `target`. */
function refuseLinks(paths: readonly string[]): void {
  for (const path of paths) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to write through it`);
  }
}

/** Writes through a temporary file and a rename, so a crash never leaves a half-written rule. Unchanged content is left alone. */
function writeIfChanged(path: string, content: string): void {
  let existing: string | null = null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = null;
  }
  if (existing === content) return;
  const temp = `${path}.lemma-${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

/**
 * The file with the Lemma block in place: a missing file becomes the block,
 * an existing block is replaced, and otherwise the block is appended. Text
 * outside the block is never touched. A begin marker without its end marker
 * (or the reverse) is refused rather than guessed at.
 */
export function withBlock(existing: string | null, body: string, path: string): string {
  const block = `${BEGIN}\n## Lemma\n\n${body}${END}`;
  if (existing === null) return `${block}\n`;
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (begin === -1 && end === -1) {
    if (existing.trim() === "") return `${block}\n`;
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
  }
  if (begin === -1 || end === -1 || end < begin) throw new Error(`${path} has a half-open Lemma block; remove the markers by hand and run again`);
  return `${existing.slice(0, begin)}${block}${existing.slice(end + END.length)}`;
}

/** Installs the rule for one agent under `dir` and returns the file it wrote or left as it was. */
export function installRule(dir: string, target: RuleTarget = "cursor"): string {
  const base = resolvePath(dir);
  if (target === "cursor") {
    const rules = join(base, ".cursor", "rules");
    const file = join(rules, "lemma.mdc");
    refuseLinks([join(base, ".cursor"), rules, file]);
    mkdirSync(rules, { recursive: true });
    writeIfChanged(file, readFileSync(RULE_PATH, "utf8"));
    return file;
  }
  if (target === "claude") {
    const rules = join(base, ".claude", "rules");
    const file = join(rules, "lemma.md");
    refuseLinks([join(base, ".claude"), rules, file]);
    mkdirSync(rules, { recursive: true });
    writeIfChanged(file, ruleBody());
    return file;
  }
  const file = join(base, "AGENTS.md");
  refuseLinks([file]);
  let existing: string | null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = null;
  }
  writeIfChanged(file, withBlock(existing, ruleBody(), file));
  return file;
}

/** Installs the rule for one agent, or for every agent with `all`, and returns the files. */
export function installRules(dir: string, agent: RuleAgent): string[] {
  return (agent === "all" ? RULE_TARGETS : [agent]).map((target) => installRule(dir, target));
}
