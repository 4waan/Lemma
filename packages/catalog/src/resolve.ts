import {
  type Address,
  type Hex32,
  Preview,
  PreviewInput,
  type ReasonCode,
  normalizeReasons,
  profileDigest,
  saleBlocker,
  taskDigest,
} from "@lemma/core";
import type { z } from "zod";

import type { CatalogIndex, IndexedProfile, IndexedRelease } from "./build-index.js";

type Profile = z.infer<typeof PreviewInput>["profile"];

export interface ResolveContext {
  readonly now: Date;
  /** Random, chosen by the server; the resolver never invents one. */
  readonly previewId: Hex32;
  /** CAIP-2 network, asset and authorization window for offers; the server's configuration. */
  readonly payment: { readonly network: string; readonly asset: Address; readonly maxTimeoutSeconds: number };
  /** How long an offer stays open, capped again by the release expiry and the evidence's staleAfter. */
  readonly offerTtlSeconds: number;
}

interface Candidate {
  readonly release: IndexedRelease;
  readonly profile: IndexedProfile;
  readonly reasons: readonly ReasonCode[];
  readonly blocker: ReasonCode | null;
  readonly netSaving: bigint | null;
}

/**
 * The deterministic resolver: a typed task and a privacy-safe profile against
 * the catalog index, giving a free Preview. Pure: the clock, the preview id and
 * the payment settings are injected, so the same inputs give the same answer.
 *
 * 1. With no release for the capability, the answer is `build` with
 *    NO_RELEASE_FOR_CAPABILITY: the task is in scope, and demand is recorded.
 * 2. Every supported profile of every candidate is checked, collecting all
 *    failing codes (`checkProfile`).
 * 3. Matches are ranked by a published total order (`compareMatches`). The
 *    top match gives `reuse`, with an offer only when `saleBlocker` is null.
 * 4. Without a match, the nearest candidate supplies the reasons. Nearest means
 *    the fewest distinct reason codes; among equally near candidates, one on a
 *    supported platform comes first; then the identity order below. The answer
 *    is `decline` when its reasons include an UNSUPPORTED_* code (then every
 *    equally near candidate is on an unsupported platform, so Lemma does not
 *    serve it), and `build` otherwise. Manifest order therefore cannot flip it.
 *
 * `adapt` is never decided here: it needs the buyer's files, so the bridge
 * decides it from drift. The result is parsed before it is returned, so a
 * resolver bug fails closed.
 */
export function resolve(input: PreviewInput, index: CatalogIndex, ctx: ResolveContext): Preview {
  const { task, profile } = PreviewInput.parse(input);
  const base = {
    schemaVersion: "1" as const,
    previewId: ctx.previewId,
    taskDigest: taskDigest(task),
    profileDigest: profileDigest(profile),
    catalogDigest: index.catalogDigest,
    createdAt: ctx.now.toISOString(),
  };

  const releases = index.byCapability.get(task.capability) ?? [];
  if (releases.length === 0) return Preview.parse({ ...base, decision: "build", reasons: ["NO_RELEASE_FOR_CAPABILITY"] });

  const candidates: Candidate[] = [];
  for (const release of releases) {
    for (const indexed of release.profiles) {
      const reasons = checkProfile(release, indexed, profile, ctx.now);
      const evidence = indexed.profile.evidence;
      const price = BigInt(release.release.price);
      candidates.push({
        release,
        profile: indexed,
        reasons,
        blocker: reasons.length === 0 ? saleBlocker(price, evidence, ctx.now) : null,
        netSaving: evidence === null ? null : BigInt(evidence.expectedRawSavingUsdc) - price,
      });
    }
  }

  const matches = candidates.filter((c) => c.reasons.length === 0).sort(compareMatches);
  const top = matches[0];
  if (top !== undefined) {
    const { release, profile: indexed, blocker } = top;
    const r = release.release;
    const evidence = indexed.profile.evidence;
    const offer =
      blocker === null && evidence !== null
        ? {
            terms: {
              scheme: "exact" as const,
              network: ctx.payment.network,
              asset: ctx.payment.asset,
              amount: r.price,
              payTo: r.provider.payTo,
              maxTimeoutSeconds: ctx.payment.maxTimeoutSeconds,
            },
            expectedRawSavingUsdc: evidence.expectedRawSavingUsdc,
            expectedTokenSaving: evidence.expectedTokenSaving,
            claimWindowHours: r.warranty.claimWindowHours,
            validUntil: new Date(
              Math.min(ctx.now.getTime() + ctx.offerTtlSeconds * 1000, Date.parse(r.expiresAt), Date.parse(evidence.staleAfter)),
            ).toISOString(),
          }
        : null;
    return Preview.parse({
      ...base,
      decision: "reuse",
      release: { releaseId: r.releaseId, version: r.version, releaseDigest: release.releaseDigest, profileIndex: indexed.index },
      offer,
      reasons: blocker === null ? [] : [blocker],
    });
  }

  const nearest = candidates
    .map((c) => ({ c, codes: normalizeReasons(c.reasons) }))
    .sort((a, b) => a.codes.length - b.codes.length || Number(unsupported(a.codes)) - Number(unsupported(b.codes)) || compareIdentity(a.c, b.c))[0];
  const reasons = nearest?.codes ?? [];
  const decision = unsupported(reasons) ? "decline" : "build";
  return Preview.parse({ ...base, decision, reasons });
}

/**
 * Every condition of one supported profile, in a fixed order, collecting all
 * failures. Dependency ranges were parsed when the index was built; a
 * prerelease version satisfies a range only if the range names that prerelease.
 */
export function checkProfile(release: IndexedRelease, indexed: IndexedProfile, profile: Profile, now: Date): ReasonCode[] {
  const p = indexed.profile;
  const reasons: ReasonCode[] = [];
  if (now.getTime() >= Date.parse(release.release.expiresAt)) reasons.push("RELEASE_EXPIRED");
  if (!p.languages.includes(profile.language)) reasons.push("UNSUPPORTED_LANGUAGE");
  if (profile.runtime.major < p.nodeMajor.min || profile.runtime.major > p.nodeMajor.max) reasons.push("UNSUPPORTED_RUNTIME");
  if (!p.packageManagers.includes(profile.packageManager.name)) reasons.push("UNSUPPORTED_PACKAGE_MANAGER");
  if (!p.moduleSystems.includes(profile.moduleSystem)) reasons.push("UNSUPPORTED_MODULE_SYSTEM");
  for (const [name, range] of indexed.ranges) {
    const version = Object.hasOwn(profile.dependencies, name) ? profile.dependencies[name] : undefined;
    if (version === undefined) reasons.push("MISSING_DEPENDENCY");
    else if (!range.test(version)) reasons.push("DEPENDENCY_OUT_OF_RANGE");
  }
  if (p.frameworks.some((f) => !profile.frameworks.includes(f))) reasons.push("MISSING_FRAMEWORK");
  return reasons;
}

/**
 * The published ranking of matches (docs/economic-gates.md, scale lever 8):
 * sellable now, then expected net saving `S - P` descending (no evidence last),
 * then semver precedence descending, release id, release digest (build
 * metadata ties under semver precedence) and profile index.
 */
function compareMatches(a: Candidate, b: Candidate): number {
  const sellable = Number(b.blocker === null) - Number(a.blocker === null);
  if (sellable !== 0) return sellable;
  if (a.netSaving !== b.netSaving) {
    if (a.netSaving === null) return 1;
    if (b.netSaving === null) return -1;
    return a.netSaving > b.netSaving ? -1 : 1;
  }
  return compareIdentity(a, b);
}

function compareIdentity(a: Candidate, b: Candidate): number {
  return (
    b.release.version.compare(a.release.version) ||
    cmp(a.release.release.releaseId, b.release.release.releaseId) ||
    cmp(a.release.releaseDigest, b.release.releaseDigest) ||
    a.profile.index - b.profile.index
  );
}

function unsupported(codes: readonly ReasonCode[]): boolean {
  return codes.some((r) => r.startsWith("UNSUPPORTED_"));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
