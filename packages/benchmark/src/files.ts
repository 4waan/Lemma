import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** Every regular file under `dir`, as sorted POSIX paths, skipping installed dependencies and VCS data. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const entry of readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`${path}: fixtures may not contain symbolic links`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  visit("");
  return out.sort();
}

/** True when `path` is `root` or lies under it (both absolute). */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
