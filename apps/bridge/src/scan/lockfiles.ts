/**
 * Exact installed versions from lockfiles, without a YAML parser: npm lockfiles
 * are JSON, and the pnpm and yarn formats are read line by line, only as far
 * as needed. Each function answers for one package directory (`rel`, POSIX,
 * relative to the lockfile's directory, "" for the root) and one dependency
 * name, or undefined when the lockfile does not say.
 */

/**
 * npm lockfile v2/v3: `packages["<rel>/node_modules/<n>"]`, walking up like
 * Node's resolution, but only for a package directory the lockfile records
 * (`packages["<rel>"]`). v1 has no per-package tree, so it answers only for the
 * root. An aliased entry (its `name` differs) or one installed from git, a file
 * or a link gives undefined: its version is not the registry release of `name`.
 */
export function npmVersion(lock: unknown, rel: string, name: string): string | undefined {
  if (typeof lock !== "object" || lock === null) return undefined;
  const packages = (lock as { packages?: Record<string, { name?: unknown; version?: unknown; resolved?: unknown; link?: unknown }> }).packages;
  if (packages !== undefined) {
    if (rel !== "" && packages[rel] === undefined) return undefined;
    const parts = rel === "" ? [] : rel.split("/");
    for (let i = parts.length; i >= 0; i--) {
      const prefix = parts.slice(0, i).join("/");
      const entry = packages[`${prefix === "" ? "" : `${prefix}/`}node_modules/${name}`];
      if (entry === undefined) continue;
      if (entry.link === true || typeof entry.version !== "string") return undefined;
      if (entry.name !== undefined && entry.name !== name) return undefined;
      if (typeof entry.resolved === "string" && !/^https?:\/\//.test(entry.resolved)) return undefined;
      return entry.version;
    }
    return undefined;
  }
  if (rel !== "") return undefined;
  const dependencies = (lock as { dependencies?: Record<string, { version?: unknown }> }).dependencies;
  const version = dependencies?.[name]?.version;
  return typeof version === "string" ? version : undefined;
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

/**
 * pnpm lockfile (v5.4, v6 and v9). A workspace lockfile, and every v9
 * lockfile, lists each package directory under `importers:`; a single-project
 * v5.4 or v6 lockfile has the root's blocks at top level instead:
 *
 *   importers:                        dependencies:
 *     packages/api:                     zod:
 *       dependencies:                     specifier: ^3.22.4
 *         '@modelcontextprotocol/sdk':    version: 3.22.4
 *           specifier: ^1.30.0
 *           version: 1.30.1(zod@3.25.76)
 *
 * v5.4 writes the version inline (`zod: 3.22.4`). The peer suffix in
 * parentheses is dropped; `link:` versions are workspace links, not installs,
 * and give undefined.
 */
export function pnpmVersion(text: string, rel: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => /^importers:/.test(line))) return rel === "" ? sectionVersion(lines, name) : undefined;
  const importer = rel === "" ? "." : rel;
  const block: string[] = [];
  let inImporters = false;
  let inImporter = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith("importers:");
      inImporter = false;
      continue;
    }
    if (!inImporters || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 2) inImporter = unquote(line.trim().replace(/:$/, "")) === importer;
    else if (inImporter) block.push(line.slice(4));
  }
  return sectionVersion(block, name);
}

/** The `dependencies`, `devDependencies` and `optionalDependencies` blocks of one importer, dedented to the top level. */
function sectionVersion(lines: readonly string[], name: string): string | undefined {
  let inSection = false;
  let inPackage = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 0) {
      inSection = /^(dependencies|devDependencies|optionalDependencies):$/.test(content);
      inPackage = false;
    } else if (inSection && indent === 2) {
      const colon = content.lastIndexOf(":");
      const key = unquote(content.slice(0, colon));
      const inline = content.slice(colon + 1).trim();
      inPackage = key === name;
      if (inPackage && inline !== "") return clean(unquote(inline));
    } else if (inSection && inPackage && indent === 4 && content.startsWith("version:")) {
      return clean(unquote(content.slice("version:".length)));
    }
  }
  return undefined;
}

function clean(version: string): string | undefined {
  if (version.startsWith("link:") || version.startsWith("file:") || version.startsWith("workspace:")) return undefined;
  // Peers follow the version: `1.30.1(zod@3.25.76)` (v6, v9) or `1.30.1_zod@3.22.4` (v5.4); a version never holds `_` or `(`.
  return version.replace(/[(_].*$/, "");
}

/**
 * yarn.lock, classic (v1) and berry: the block whose header lists
 * `<name>@<specifier>` (berry: `<name>@npm:<specifier>`), then its version.
 *
 *   "@modelcontextprotocol/sdk@^1.30.0", "@modelcontextprotocol/sdk@^1.30.1":
 *     version "1.30.1"
 */
export function yarnVersion(text: string, name: string, specifier: string): string | undefined {
  const wanted = new Set([`${name}@${specifier}`, `${name}@npm:${specifier}`]);
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const header = line.replace(/:$/, "");
      inBlock = header.split(",").some((entry) => wanted.has(unquote(entry)));
      continue;
    }
    if (!inBlock) continue;
    const match = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}
