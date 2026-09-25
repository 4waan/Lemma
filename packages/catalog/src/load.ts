import { CapabilityRelease, type Hex32, PatchBundle, bundleDigest, releaseDigest } from "@lemma/core";

import { Economics } from "./economics.js";
import { listDirectories, readJson } from "./files.js";
import { BUNDLE_FILE, CATALOG_ROOT, ECONOMICS_FILE, MANIFEST_FILE, PROVISIONAL_DIR, PUBLIC_DIR } from "./paths.js";

export type ReleaseSource = "public" | "provisional";

export interface LoadedRelease {
  readonly release: CapabilityRelease;
  readonly releaseDigest: Hex32;
  readonly bundle: PatchBundle;
  readonly source: ReleaseSource;
  /** Directory of the release relative to the catalog root, e.g. `releases/<id>/<version>`. */
  readonly dir: string;
}

export interface LoadedCatalog {
  readonly root: string;
  readonly economics: Economics;
  /** Sorted by release digest, so iteration order never depends on the filesystem. */
  readonly releases: readonly LoadedRelease[];
}

/** Every problem found while loading or checking, so one run reports them all. */
export class CatalogError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`catalog is invalid:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "CatalogError";
  }
}

export interface LoadOptions {
  /** Defaults to this package's directory. */
  readonly root?: string;
  /**
   * Also load `releases.provisional/` (testnet-only evidence for stages 5 and 6).
   * The public service never sets this.
   */
  readonly includeProvisional: boolean;
}

/**
 * Loads and validates the catalog: every manifest and bundle parses with the
 * core schemas, each lives at `<dir>/<releaseId>/<version>`, each bundle's digest
 * is its manifest's `payloadDigest`, and no `releaseId@version` appears twice.
 * Throws a CatalogError listing every problem.
 */
export function loadCatalog(options: LoadOptions): LoadedCatalog {
  const { catalog, problems } = loadCatalogResult(options);
  if (problems.length > 0 || catalog === undefined) throw new CatalogError(problems);
  return catalog;
}

/**
 * The loader's full result: every release that loaded cleanly, and every
 * problem found. `checkCatalog` keeps checking the valid releases, so one run
 * reports all problems instead of stopping at the first bad release. The
 * catalog is undefined only when economics.json itself does not load.
 */
export function loadCatalogResult(options: LoadOptions): { catalog: LoadedCatalog | undefined; problems: string[] } {
  const root = options.root ?? CATALOG_ROOT;
  const problems: string[] = [];
  const releases: LoadedRelease[] = [];

  let economics: Economics | undefined;
  try {
    const parsed = Economics.safeParse(readJson(root, ECONOMICS_FILE));
    if (parsed.success) economics = parsed.data;
    else problems.push(`${ECONOMICS_FILE}: ${issues(parsed.error)}`);
  } catch (error) {
    problems.push(message(error));
  }

  const sources: Array<[ReleaseSource, string, boolean]> = [["public", PUBLIC_DIR, false]];
  if (options.includeProvisional) sources.push(["provisional", PROVISIONAL_DIR, true]);
  const seen = new Map<string, string>();

  for (const [source, base, optional] of sources) {
    let ids: string[];
    try {
      ids = listDirectories(root, base, { optional, problems });
    } catch (error) {
      problems.push(message(error));
      continue;
    }
    for (const id of ids) {
      let versions: string[];
      try {
        versions = listDirectories(root, `${base}/${id}`, { problems });
      } catch (error) {
        problems.push(message(error));
        continue;
      }
      for (const version of versions) {
        const dir = `${base}/${id}/${version}`;
        const loaded = loadRelease(root, dir, source, problems);
        if (loaded === undefined) continue;
        if (loaded.release.releaseId !== id || loaded.release.version !== version) {
          problems.push(`${dir}: manifest names ${loaded.release.releaseId}@${loaded.release.version}; the directory must be <releaseId>/<version>`);
          continue;
        }
        const key = `${id}@${version}`;
        const other = seen.get(key);
        if (other !== undefined) {
          problems.push(`${dir}: ${key} is already defined in ${other}`);
          continue;
        }
        seen.set(key, dir);
        releases.push(loaded);
      }
    }
  }

  releases.sort((a, b) => (a.releaseDigest < b.releaseDigest ? -1 : a.releaseDigest > b.releaseDigest ? 1 : 0));
  return { catalog: economics === undefined ? undefined : { root, economics, releases }, problems };
}

function loadRelease(root: string, dir: string, source: ReleaseSource, problems: string[]): LoadedRelease | undefined {
  let manifest: unknown;
  let bundleJson: unknown;
  try {
    manifest = readJson(root, `${dir}/${MANIFEST_FILE}`);
    bundleJson = readJson(root, `${dir}/${BUNDLE_FILE}`);
  } catch (error) {
    problems.push(message(error));
    return undefined;
  }
  const release = CapabilityRelease.safeParse(manifest);
  const bundle = PatchBundle.safeParse(bundleJson);
  if (!release.success) problems.push(`${dir}/${MANIFEST_FILE}: ${issues(release.error)}`);
  if (!bundle.success) problems.push(`${dir}/${BUNDLE_FILE}: ${issues(bundle.error)}`);
  if (!release.success || !bundle.success) return undefined;
  let payload: string;
  try {
    payload = bundleDigest(bundle.data);
  } catch (error) {
    problems.push(`${dir}/${BUNDLE_FILE}: ${message(error)}`);
    return undefined;
  }
  if (payload !== release.data.payloadDigest) {
    problems.push(`${dir}: payloadDigest ${release.data.payloadDigest} does not match ${BUNDLE_FILE} (${payload})`);
    return undefined;
  }
  return { release: release.data, releaseDigest: releaseDigest(release.data), bundle: bundle.data, source, dir };
}

export function issues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
