import {
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityRelease,
  type Hex32,
  type PatchBundle,
  type SupportedProfile,
  baseReleaseDigest,
  catalogDigestOf,
} from "@lemma/core";
import { Range, SemVer } from "semver";

import type { LoadedCatalog, ReleaseSource } from "./load.js";

/** A supported profile with its dependency ranges parsed once, at load time. */
export interface IndexedProfile {
  readonly index: number;
  readonly profile: SupportedProfile;
  /** Sorted by package name. */
  readonly ranges: ReadonlyArray<readonly [name: string, range: Range]>;
}

/**
 * A path a release expects in a known state: `baseDigest` is the digest of the
 * file a modify or delete was built against, or null for an add, whose path must
 * be empty and whose parents must be directories or absent.
 */
export interface BaseProbeEntry {
  readonly path: string;
  readonly baseDigest: Hex32 | null;
}

export interface IndexedRelease {
  readonly release: CapabilityRelease;
  readonly releaseDigest: Hex32;
  readonly baseReleaseDigest: Hex32;
  readonly version: SemVer;
  readonly profiles: readonly IndexedProfile[];
  readonly bundle: PatchBundle;
  /** Every path the bundle touches, sorted, so the bridge can predict drift before paying without seeing content. */
  readonly baseProbe: readonly BaseProbeEntry[];
  readonly source: ReleaseSource;
}

export interface CatalogIndex {
  readonly catalogDigest: Hex32;
  /** Sorted by release digest. */
  readonly releases: readonly IndexedRelease[];
  readonly byCapability: ReadonlyMap<CapabilityId, readonly IndexedRelease[]>;
  readonly byDigest: ReadonlyMap<Hex32, IndexedRelease>;
  readonly bundlesByPayloadDigest: ReadonlyMap<Hex32, PatchBundle>;
  /**
   * Per capability, the sorted dependency names the catalog matches on (scale
   * lever 6). The bridge sends only these, so other package names never leave
   * the buyer's machine. Capabilities without a release have an empty list.
   */
  readonly interest: Readonly<Record<CapabilityId, readonly string[]>>;
}

/**
 * Precomputes everything the resolver and the read API need, so no request
 * parses a manifest, a version or a range. Throws on a range the semver library
 * cannot parse, which `checkCatalog` reports first.
 */
/** A supported profile with its dependency ranges parsed, sorted by package name. */
export function indexProfile(profile: SupportedProfile, index: number): IndexedProfile {
  return {
    index,
    profile,
    ranges: Object.keys(profile.dependencies)
      .sort()
      .map((name) => [name, new Range(profile.dependencies[name] as string)] as const),
  };
}

export function buildIndex(catalog: LoadedCatalog): CatalogIndex {
  const releases = catalog.releases.map((loaded): IndexedRelease => {
    const { release } = loaded;
    return {
      release,
      releaseDigest: loaded.releaseDigest,
      baseReleaseDigest: baseReleaseDigest(release),
      version: new SemVer(release.version),
      profiles: release.supportedProfiles.map((profile, index) => indexProfile(profile, index)),
      bundle: loaded.bundle,
      baseProbe: loaded.bundle.files.map((f) => ({ path: f.path, baseDigest: f.baseDigest })),
      source: loaded.source,
    };
  });

  const byCapability = new Map<CapabilityId, IndexedRelease[]>();
  const interest = {} as Record<CapabilityId, string[]>;
  for (const capability of CAPABILITY_IDS) {
    const matching = releases.filter((r) => r.release.capability === capability);
    byCapability.set(capability, matching);
    interest[capability] = [...new Set(matching.flatMap((r) => r.profiles.flatMap((p) => p.ranges.map(([name]) => name))))].sort();
  }

  return {
    catalogDigest: catalogDigestOf(releases.map((r) => r.releaseDigest)),
    releases,
    byCapability,
    byDigest: new Map(releases.map((r) => [r.releaseDigest, r])),
    bundlesByPayloadDigest: new Map(releases.map((r) => [r.release.payloadDigest, r.bundle])),
    interest,
  };
}
