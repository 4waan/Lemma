import { CAPABILITY_IDS, type CapabilityId, bundleDigest, baseReleaseDigest, isSellable, maxPriceFor } from "@lemma/core";
import { Range, SemVer } from "semver";

import { buildIndex } from "./build-index.js";
import { listEntries, scanTree } from "./files.js";
import { type LoadedFixture, loadFixtures } from "./fixtures.js";
import { type LoadedCatalog, type LoadedRelease, loadCatalogResult, message } from "./load.js";
import { packPayload } from "./pack.js";
import { BUNDLE_FILE, CATALOG_ROOT, FIXTURES_DIR, MANIFEST_FILE, PAYLOAD_DIR, PROVISIONAL_DIR, PUBLIC_DIR } from "./paths.js";
import { resolve } from "./resolve.js";

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
 *   exactly what `payload/` packs to. A release directory holds nothing else.
 * - Every dependency range parses and is bounded above.
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

  // `payload/base/` is hashed as raw bytes, so a binary base file is fine; everything else, `payload/files/` included, must be text.
  const notText = (path: string) => {
    const p = path.split("/");
    return p[3] === PAYLOAD_DIR && p[4] === "base";
  };
  problems.push(...scanTree(root, PUBLIC_DIR, { notText }), ...scanTree(root, PROVISIONAL_DIR, { optional: true, notText }), ...scanTree(root, FIXTURES_DIR));
  const loaded = loadCatalogResult({ root, includeProvisional: true });
  problems.push(...loaded.problems);
  const catalog = loaded.catalog;

  if (catalog !== undefined) {
    const publicByKey = new Map(catalog.releases.filter((r) => r.source === "public").map((r) => [key(r), r]));
    for (const release of catalog.releases) {
      checkLayout(root, release, problems);
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
    // A release that failed to load may be the capability's, so "no releases" is only known once releases/ loads cleanly.
    const publicIncomplete = loaded.problems.some((p) => p.split(/[/:]/)[0] === PUBLIC_DIR);
    for (const { id, fixture } of fixtures) {
      // A capability without releases has one answer, build with NO_RELEASE_FOR_CAPABILITY; one with releases never has it.
      if (fixture.class === "no-release" && withReleases.has(fixture.capability)) {
        problems.push(`fixtures/${id}.json: a no-release case for a capability that has releases`);
      }
      if (fixture.class !== "no-release" && !withReleases.has(fixture.capability) && !publicIncomplete) {
        problems.push(`fixtures/${id}.json: ${fixture.capability} has no releases, so its only case is no-release`);
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
    if (!problems.some((p) => p.includes("does not parse"))) {
      try {
        problems.push(...goldenMismatches({ ...catalog, releases: publicReleases }, fixtures));
      } catch (error) {
        problems.push(`fixtures could not be replayed: ${message(error)}`);
      }
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

  // Several passes can see the same fault (the scan and the loader both see a link); report it once.
  return { problems: [...new Set(problems)], catalog, fixtureCount: fixtures.length };
}

function key(loaded: LoadedRelease): string {
  return `${loaded.release.releaseId}@${loaded.release.version}`;
}

/** A release directory holds its manifest, its bundle and its payload, and nothing that could ride along unreviewed. */
function checkLayout(root: string, loaded: LoadedRelease, problems: string[]): void {
  try {
    const stray = listEntries(root, loaded.dir, { problems })
      .filter((e) => !(e.kind === "file" && (e.name === MANIFEST_FILE || e.name === BUNDLE_FILE)) && !(e.kind === "dir" && e.name === PAYLOAD_DIR))
      .map((e) => e.name);
    if (stray.length > 0) problems.push(`${loaded.dir}: holds only ${MANIFEST_FILE}, ${BUNDLE_FILE} and ${PAYLOAD_DIR}/, not ${stray.join(", ")}`);
  } catch (error) {
    problems.push(message(error));
  }
}

function checkPayload(root: string, loaded: LoadedRelease, problems: string[]): void {
  try {
    const packed = packPayload(root, loaded.dir);
    if (bundleDigest(packed) !== loaded.release.payloadDigest) {
      problems.push(`${loaded.dir}: bundle.json is not what payload/ packs to; run catalog:pack`);
    }
  } catch (error) {
    // The packer names paths from the catalog root, like the scan, so a fault both see merges into one problem.
    problems.push(message(error));
  }
}

/**
 * Every range must parse, and must be bounded above. An open range (`*`,
 * `>=2`, `<2 || >=3`) would claim support for, or install, versions nobody has
 * tested. Dist-tags such as `latest` do not parse and are refused with the
 * rest.
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
    if (!boundedAbove(parsed)) problems.push(`${loaded.dir}: ${where} range for ${name} has no upper bound: ${range || "(empty)"}`);
  };
  try {
    new SemVer(loaded.release.version);
  } catch {
    problems.push(`${loaded.dir}: version ${loaded.release.version} does not parse as semver`);
  }
  loaded.release.supportedProfiles.forEach((profile, index) => {
    for (const [name, range] of Object.entries(profile.dependencies)) check(`profile ${index}`, name, range);
  });
  for (const [name, range] of Object.entries(loaded.bundle.dependencies)) check("bundle dependency", name, range);
  for (const [name, range] of Object.entries(loaded.bundle.devDependencies)) check("bundle devDependency", name, range);
}

/**
 * True when every alternative of the range (each side of `||`) caps the
 * version: a `<` or `<=` comparator, or an exact version. Read from the parsed
 * comparators, so no probe version can be out-ranged.
 */
export function boundedAbove(range: Range): boolean {
  return range.set.every((alternative) => alternative.some((c) => c.operator === "<" || c.operator === "<=" || ((c.operator === "" || c.operator === "=") && c.value !== "")));
}

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

/** Settings for replaying fixtures. They do not affect decisions, only offer terms. */
const GOLDEN_CONTEXT = {
  previewId: `0x${"00".repeat(32)}`,
  payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
  offerTtlSeconds: 900,
} as const;

/**
 * Replays every fixture through the resolver against the public catalog at the
 * fixture's pinned instant, and reports each case whose decision, reasons,
 * match or offer differs from what it expects.
 */
export function goldenMismatches(catalog: LoadedCatalog, fixtures: readonly LoadedFixture[]): string[] {
  const index = buildIndex(catalog);
  const out: string[] = [];
  for (const { id, fixture } of fixtures) {
    const preview = resolve(
      { task: { schemaVersion: "1", capability: fixture.capability }, profile: fixture.profile },
      index,
      { ...GOLDEN_CONTEXT, now: new Date(fixture.now) },
    );
    const got = {
      decision: preview.decision,
      reasons: preview.reasons,
      match: "release" in preview ? { releaseId: preview.release.releaseId, version: preview.release.version, profileIndex: preview.release.profileIndex } : null,
      offer: "offer" in preview && preview.offer !== null,
    };
    if (JSON.stringify(got) !== JSON.stringify(fixture.expected)) {
      out.push(`fixtures/${id}.json: expected ${JSON.stringify(fixture.expected)}, the resolver gives ${JSON.stringify(got)}`);
    }
  }
  return out;
}
