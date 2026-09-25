import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Catalog content is reviewed repository data, so it is read without following
 * links, as strict UTF-8, and a symlink or special file anywhere in it is an
 * error, never something to resolve.
 */
export function readBytes(root: string, relative: string): Uint8Array {
  const path = walk(root, relative);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${relative}: not a regular file`);
  return readFileSync(path);
}

// Keep a leading BOM: the bundle must carry exactly the bytes a reviewer saw.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reads a file as strict UTF-8: invalid bytes are an error, not replacement characters. */
export function readText(root: string, relative: string): string {
  try {
    return utf8.decode(readBytes(root, relative));
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${relative}: not valid UTF-8`);
    throw error;
  }
}

export function readJson(root: string, relative: string): unknown {
  const text = readText(root, relative);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${relative}: not valid JSON`);
  }
}

export interface ListOptions {
  /** Treat a missing directory as empty (only the optional provisional overlay is). */
  readonly optional?: boolean;
}

/** Names of the directories directly under `relative`, sorted. */
export function listDirectories(root: string, relative: string, options: ListOptions = {}): string[] {
  return list(root, relative, options).filter((e) => e.kind === "dir").map((e) => e.name);
}

/** Every regular file under `relative`, as sorted POSIX paths relative to it. A missing directory is empty. */
export function listFilesRecursive(root: string, relative: string): string[] {
  const out: string[] = [];
  const visit = (prefix: string) => {
    for (const entry of list(root, prefix === "" ? relative : `${relative}/${prefix}`, { optional: prefix === "" })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.kind === "dir") visit(path);
      else out.push(path);
    }
  };
  visit("");
  return out.sort();
}

/**
 * Walks a whole subtree and reports every entry that is not a directory or a
 * regular file, or whose name is not valid UTF-8. Every text file must also
 * be strict UTF-8. The loader and packer read only some files, so this is what
 * makes "no links, no special files" true for everything else too.
 */
export function scanTree(root: string, relative: string, options: ListOptions = {}): string[] {
  const problems: string[] = [];
  const visit = (rel: string, optional: boolean) => {
    let entries: Entry[];
    try {
      entries = entriesOf(root, rel, { optional });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.problem !== null) problems.push(entry.problem);
      else if (entry.kind === "dir") visit(path, false);
      else {
        try {
          readText(root, path);
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  };
  visit(relative, options.optional ?? false);
  return problems;
}

/**
 * Writes a catalog file without following links: every directory on the way
 * must be real, and the new content is written to a temporary file and renamed
 * over the target, which replaces a link rather than writing through it.
 */
export function writeText(root: string, relative: string, content: string): void {
  const segments = relative.split("/");
  const name = segments.pop() as string;
  const dir = segments.length === 0 ? root : walk(root, segments.join("/"));
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, content, { flag: "wx" });
  renameSync(temp, join(dir, name));
}

interface Entry {
  readonly name: string;
  readonly kind: "dir" | "file";
  /** Why the entry is not allowed in the catalog, or null. */
  readonly problem: string | null;
}

function entriesOf(root: string, relative: string, options: ListOptions): Entry[] {
  let path: string;
  try {
    path = walk(root, relative);
  } catch (error) {
    if (options.optional === true && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${relative}: missing`);
    throw error;
  }
  if (!lstatSync(path).isDirectory()) throw new Error(`${relative}: not a directory`);
  return readdirSync(path, { withFileTypes: true })
    .map((entry): Entry => {
      const at = `${relative}/${entry.name}`;
      if (entry.name.includes("\uFFFD")) return { name: entry.name, kind: "file", problem: `${relative}: an entry name is not valid UTF-8` };
      if (entry.isSymbolicLink()) return { name: entry.name, kind: "file", problem: `${at}: symbolic links are not allowed in the catalog` };
      if (entry.isDirectory()) return { name: entry.name, kind: "dir", problem: null };
      if (entry.isFile()) return { name: entry.name, kind: "file", problem: null };
      return { name: entry.name, kind: "file", problem: `${at}: not a regular file or directory` };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Directory entries for the loader and packer: any disallowed entry is an error. */
function list(root: string, relative: string, options: ListOptions): Array<{ name: string; kind: "dir" | "file" }> {
  return entriesOf(root, relative, options).map((entry) => {
    if (entry.problem !== null) throw new Error(entry.problem);
    return { name: entry.name, kind: entry.kind };
  });
}

/** Joins a POSIX relative path onto `root`, refusing links, traversal and absolute segments. */
function walk(root: string, relative: string): string {
  let path = root;
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
      throw new Error(`${relative}: expected a relative path without traversal`);
    }
    path = join(path, segment);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${relative}: symbolic links are not allowed in the catalog`);
  }
  return path;
}
