import { join } from "node:path";

import { CAPABILITY_IDS, type CapabilityId, bundleDigest, baseReleaseDigest, isSellable, maxPriceFor } from "@lemma/core";
import { Range } from "semver";

import { scanTree } from "./files.js";
import { loadFixtures } from "./fixtures.js";
import { type LoadedCatalog, type LoadedRelease, loadCatalogResult, message } from "./load.js";
import { packPayload } from "./pack.js";
import { CATALOG_ROOT, FIXTURES_DIR, PROVISIONAL_DIR, PUBLIC_DIR } from "./paths.js";

/** Benchmark versions reserved for runs and evidence that must never price a public release. */
export const RESERVED_BENCHMARK_PREFIXES = ["probe-", "provisional-"] as const;

const PROVISIONAL_BUILD = /^provisional-[1-9][0-9]*$/;

export interface CheckResult {
  readonly problems: readonly string[];
  /** The loaded catalog, including the provisional overlay, when it loaded. */
  readonly catalog: LoadedCatalog | undefined;
  readonly fixtureCount: number;
}

/**
 * Every rule a catalog must pass before it is served or merged. It is
 * read-only and does not depend on the clock, so the same commit gives the
 * same answer in CI and at server startup.
 *
 * - Manifests and bundles load (see `loadCatalog`), and each `bundle.json` is
 *   exactly what `payload/` packs to.
 * - Every dependency range parses.
 * - Versions without build metadata carry no evidence. Evidence ships as
 *   `X+<benchmarkVersion>` with the same `baseReleaseDigest` as `X`, which must
 *   exist in `releases/`: only price, dates and evidence may differ.
 * - `releases/` holds no reserved (`probe-`, `provisional-`) evidence;
 *   `releases.provisional/` holds only `X+provisional-N`.
 * - Evidenced prices need measured economics and sit in
 *   `[priceFloorAtomic, maxPriceFor(evidence, chainCostAtomic)]`.
 * - Fixtures cover every release and capability (fixtures/README.md) and
 *   reference real releases and profiles.
 */
export function checkCatalog(options: { root?: string } = {}): CheckResult {
  const root = options.root ?? CATALOG_ROOT;
  const problems: string[] = [];

  problems.push(...scanTree(root, PUBLIC_DIR), ...scanTree(root, PROVISIONAL_DIR, { optional: true }), ...scanTree(root, FIXTURES_DIR));
  const loaded = loadCatalogResult({ root, includeProvisional: true });
  problems.push(...loaded.problems.filter((p) => !problems.includes(p)));
  const catalog = loaded.catalog;

  if (catalog !== undefined) {
    const publicByKey = new Map(catalog.releases.filter((r) => r.source === "public").map((r) => [key(r), r]));
    for (const release of catalog.releases) {
      checkPayload(root, release, problems);
      checkRanges(release, problems);
      checkVersionAndEvidence(release, publicByKey, problems);
      checkPrices(catalog, release, problems);
    }
  }

  const fixtures = loadFixtures(root, problems);
  if (catalog !== undefined) {
    const publicReleases = catalog.releases.filter((r) => r.source === "public");
    const byKey = new Map(publicReleases.map((r) => [key(r), r]));
    const withReleases = new Set(publicReleases.map((r) => r.release.capability));
    for (const { id, fixture } of fixtures) {
      if (fixture.class === "no-release" && withReleases.has(fixture.capability)) {
        problems.push(`fixtures/${id}.json: a no-release case for a capability that has releases`);
      }
      const match = fixture.expected.match;
      if (match === null) continue;
      const target = byKey.get(`${match.releaseId}@${match.version}`);
      if (target === undefined) problems.push(`fixtures/${id}.json: matches ${match.releaseId}@${match.version}, which is not in releases/`);
      else if (target.release.capability !== fixture.capability) problems.push(`fixtures/${id}.json: matches a release for ${target.release.capability}`);
      else if (match.profileIndex >= target.release.supportedProfiles.length) problems.push(`fixtures/${id}.json: profile ${match.profileIndex} does not exist`);
    }
    // Exact coverage is per release family: X and X+<benchmark> share a base, and
    // the exact case follows whichever version the resolver prefers.
    const exactBases = new Set(
      fixtures
        .filter(({ fixture: f }) => f.class === "exact" && f.expected.match !== null)
        .map(({ fixture: f }) => byKey.get(`${f.expected.match?.releaseId}@${f.expected.match?.version}`))
        .filter((r) => r !== undefined)
        .map((r) => baseReleaseDigest(r.release)),
    );
    for (const loaded of publicReleases) {
      if (!exactBases.has(baseReleaseDigest(loaded.release))) problems.push(`${loaded.dir}: no exact fixture matches this release or another version of it`);
    }
    const covered = new Set<CapabilityId>(publicReleases.map((r) => r.release.capability));
    for (const capability of CAPABILITY_IDS.filter((c) => covered.has(c))) {
      const cases = fixtures.filter(({ fixture: f }) => f.capability === capability).map(({ fixture: f }) => f);
      if (!cases.some((f) => f.class === "near-miss")) problems.push(`fixtures/${capability}: needs a near-miss case`);
      if (!cases.some((f) => f.class === "unsupported" && f.expected.reasons.some((r) => r === "UNSUPPORTED_LANGUAGE" || r === "UNSUPPORTED_RUNTIME"))) {
        problems.push(`fixtures/${capability}: needs an unsupported-language or unsupported-runtime case`);
      }
    }
  }

  return { problems, catalog, fixtureCount: fixtures.length };
}

function key(loaded: LoadedRelease): string {
  return `${loaded.release.releaseId}@${loaded.release.version}`;
}

function checkPayload(root: string, loaded: LoadedRelease, problems: string[]): void {
  try {
    const packed = packPayload(join(root, loaded.dir));
    if (bundleDigest(packed) !== loaded.release.payloadDigest) {
      problems.push(`${loaded.dir}: bundle.json is not what payload/ packs to; run catalog:pack`);
    }
  } catch (error) {
    problems.push(`${loaded.dir}: ${message(error)}`);
  }
}

/**
 * Every range must parse, and must be bounded above. An open range (`*`,
 * `>=2`) would claim support for, or install, versions nobody has tested.
 * Dist-tags such as `latest` do not parse and are refused with the rest.
 */
function checkRanges(loaded: LoadedRelease, problems: string[]): void {
  const check = (where: string, name: string, range: string) => {
    let parsed: Range;
    try {
      parsed = new Range(range);
    } catch {
      problems.push(`${loaded.dir}: ${where} range for ${name} does not parse: ${range}`);
      return;
    }
    if (parsed.test(UNBOUNDED_PROBE)) problems.push(`${loaded.dir}: ${where} range for ${name} has no upper bound: ${range || "(empty)"}`);
  };
  loaded.release.supportedProfiles.forEach((profile, index) => {
    for (const [name, range] of Object.entries(profile.dependencies)) check(`profile ${index}`, name, range);
  });
  for (const [name, range] of Object.entries(loaded.bundle.dependencies)) check("bundle dependency", name, range);
  for (const [name, range] of Object.entries(loaded.bundle.devDependencies)) check("bundle devDependency", name, range);
}

/** A version no real range should reach; a range that accepts it has no upper bound. */
const UNBOUNDED_PROBE = "999999.999999.999999";

function checkVersionAndEvidence(loaded: LoadedRelease, publicByKey: ReadonlyMap<string, LoadedRelease>, problems: string[]): void {
  const { release, dir, source } = loaded;
  const plus = release.version.indexOf("+");
  const build = plus === -1 ? null : release.version.slice(plus + 1);
  const evidence = release.supportedProfiles.map((p) => p.evidence).filter((e) => e !== null);

  for (const e of evidence) {
    if (e.benchmarkVersion !== build) problems.push(`${dir}: evidence ${e.benchmarkVersion} must equal the version's build metadata (${build ?? "none"})`);
  }

  if (build === null) {
    if (source === "provisional") problems.push(`${dir}: releases.provisional/ holds only X+provisional-N versions`);
    if (evidence.length > 0) problems.push(`${dir}: a version without build metadata carries no evidence; ship evidence as ${release.version}+<benchmarkVersion>`);
    return;
  }

  if (evidence.length === 0) problems.push(`${dir}: build metadata ${build} is reserved for evidence, but no profile has any`);
  const reserved = RESERVED_BENCHMARK_PREFIXES.find((p) => build.startsWith(p));
  if (source === "provisional" && !PROVISIONAL_BUILD.test(build)) problems.push(`${dir}: releases.provisional/ holds only X+provisional-N versions`);
  if (source === "public" && reserved !== undefined) problems.push(`${dir}: ${reserved} evidence is never served from releases/`);

  const baseKey = `${release.releaseId}@${release.version.slice(0, plus)}`;
  const base = publicByKey.get(baseKey);
  if (base === undefined) problems.push(`${dir}: base version ${baseKey} is not in releases/`);
  else if (baseReleaseDigest(base.release) !== baseReleaseDigest(release)) {
    problems.push(`${dir}: differs from ${baseKey} in more than build metadata, evidence, price and dates`);
  }

  if (source === "public" && reserved === undefined) {
    // Reports come from the benchmark harness; until they can be verified here,
    // no public release may carry evidence.
    problems.push(`${dir}: no verified benchmark report backs evidence ${build}`);
  }
}

function checkPrices(catalog: LoadedCatalog, loaded: LoadedRelease, problems: string[]): void {
  const { economics } = catalog;
  const price = BigInt(loaded.release.price);
  loaded.release.supportedProfiles.forEach((profile, index) => {
    const e = profile.evidence;
    if (e === null) return;
    if (economics.status !== "measured") {
      problems.push(`${loaded.dir}: profile ${index} has evidence, but economics.json is still a placeholder`);
      return;
    }
    const cap = maxPriceFor(e, { chainCostAtomic: BigInt(economics.chainCostAtomic) });
    if (!isSellable(price, BigInt(e.expectedRawSavingUsdc)) || price > cap) {
      problems.push(`${loaded.dir}: profile ${index} price ${price} exceeds maxPriceFor ${cap}`);
    }
    if (/^0x0{40}$/.test(loaded.release.provider.payTo)) {
      problems.push(`${loaded.dir}: profile ${index} has evidence, but the release pays to the zero address`);
    }
    if (price < BigInt(economics.priceFloorAtomic)) {
      problems.push(`${loaded.dir}: profile ${index} price ${price} is below the price floor ${economics.priceFloorAtomic}`);
    }
  });
}
