import { z } from "zod";

import { UsdcAtomic } from "./amounts.js";
import { PaymentTerms } from "./payment.js";
import { ExactVersion, Hex32, IsoTimestamp, SchemaVersion } from "./primitives.js";
import { allInReductionBps, maxPriceFor, saleBlocker } from "./pricing.js";
import { Framework, Language, ModuleSystem, PackageManager } from "./profile.js";
import { ReasonCode } from "./reasons.js";
import { AdoptionOutcome } from "./receipt.js";
import { type CapabilityRelease, MatchedRelease, ProfileEvidence, Provenance, ReleaseId } from "./release.js";
import { CapabilityId } from "./task.js";

/**
 * Public read models: what the server's read API returns and the dashboard
 * renders. They are derived from catalog, resolution and demand data and never
 * carry a preview id, a buyer, a bundle or a settlement reference. The
 * dashboard parses every response with these schemas before rendering it.
 */

const SignedBps = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/, "expected an integer number of basis points");

/** Where a profile's evidence comes from: a frozen benchmark, the testnet-only provisional overlay, or none. */
export const EvidenceLabel = z.enum(["benchmarked", "provisional", "none"]);

/** One supported profile of a release, with what its evidence means for a buyer at the list price. */
export const ProfileSummary = z.strictObject({
  profileIndex: z.int().min(0),
  platform: z.strictObject({
    languages: z.array(Language),
    nodeMajor: z.strictObject({ min: z.int().min(0), max: z.int().min(0) }),
    packageManagers: z.array(PackageManager),
    moduleSystems: z.array(ModuleSystem),
    dependencies: z.record(z.string().max(214), z.string().max(256)),
    frameworks: z.array(Framework),
  }),
  label: EvidenceLabel,
  evidence: ProfileEvidence.nullable(),
  /** Why the profile cannot be sold now (core `saleBlocker`), or null when it can. */
  blocker: ReasonCode.nullable(),
  /** The buyer's expected all-in cost reduction at the list price, after chain cost; null without evidence. */
  allInReductionBps: SignedBps.nullable(),
  /** `maxPriceFor(evidence, g)`: the highest price that keeps the benchmark target; null without evidence. */
  maxPriceUsdc: UsdcAtomic.nullable(),
});

export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const ReleaseSummary = z.strictObject({
  releaseDigest: Hex32,
  baseReleaseDigest: Hex32,
  releaseId: ReleaseId,
  version: ExactVersion,
  capability: CapabilityId,
  /** Catalog prose: rendered as text only. */
  title: z.string().max(120),
  provenance: Provenance,
  priceUsdc: UsdcAtomic,
  warrantyHours: z.int().min(1),
  publishedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  /** Served from the testnet-only provisional overlay. */
  provisional: z.boolean(),
  profiles: z.array(ProfileSummary).min(1),
});

export type ReleaseSummary = z.infer<typeof ReleaseSummary>;

export const CatalogView = z.strictObject({
  schemaVersion: SchemaVersion,
  catalogDigest: Hex32,
  generatedAt: IsoTimestamp,
  /** A placeholder means chain cost and price floor are not measured yet, so nothing carries evidence. */
  economics: z.strictObject({ status: z.enum(["placeholder", "measured"]), chainCostUsdc: UsdcAtomic, priceFloorUsdc: UsdcAtomic }),
  releases: z.array(ReleaseSummary),
});

export type CatalogView = z.infer<typeof CatalogView>;

const PROVISIONAL_BUILD = /\+provisional-/;

/**
 * The dashboard's view of one release at `now`: per profile, whether it can be
 * sold and why not, and what its evidence promises the buyer at the list price
 * once chain cost `g` is paid.
 */
export function summarizeRelease(
  entry: { readonly release: CapabilityRelease; readonly releaseDigest: Hex32; readonly baseReleaseDigest: Hex32; readonly provisional: boolean },
  economics: { readonly chainCostAtomic: bigint },
  now: Date,
): ReleaseSummary {
  const { release } = entry;
  const price = BigInt(release.price);
  const provisional = entry.provisional || PROVISIONAL_BUILD.test(release.version);
  return ReleaseSummary.parse({
    releaseDigest: entry.releaseDigest,
    baseReleaseDigest: entry.baseReleaseDigest,
    releaseId: release.releaseId,
    version: release.version,
    capability: release.capability,
    title: release.title,
    provenance: release.provenance,
    priceUsdc: release.price,
    warrantyHours: release.warranty.claimWindowHours,
    publishedAt: release.publishedAt,
    expiresAt: release.expiresAt,
    provisional,
    profiles: release.supportedProfiles.map((profile, profileIndex) => {
      const { evidence, ...platform } = profile;
      const expired = now.getTime() >= Date.parse(release.expiresAt);
      return {
        profileIndex,
        platform,
        label: evidence === null ? "none" : provisional ? "provisional" : "benchmarked",
        evidence,
        blocker: expired ? "RELEASE_EXPIRED" : saleBlocker(price, evidence, now),
        allInReductionBps: evidence === null ? null : allInReductionBps(evidence, price, economics.chainCostAtomic).toString(),
        maxPriceUsdc: evidence === null ? null : maxPriceFor(evidence, { chainCostAtomic: economics.chainCostAtomic }).toString(),
      };
    }),
  });
}

/**
 * A resolution as anyone may see it by id: never the preview id (the recovery
 * secret), the buyer, the bundle or the settlement reference. This holds only
 * while the resolution id is not published next to the buyer elsewhere, so the
 * payment's on-chain nonce must not be the resolution id itself (core
 * `deriveResolutionId`).
 */
export const ResolutionView = z.strictObject({
  resolutionId: Hex32,
  state: z.enum(["prepared", "settled", "expired"]),
  release: MatchedRelease,
  payloadDigest: Hex32,
  terms: PaymentTerms,
  createdAt: IsoTimestamp,
  /** A receipt counts for compatibility history only once its signature is verified. */
  receipt: z.strictObject({ outcome: AdoptionOutcome, verified: z.boolean() }).nullable(),
});

export type ResolutionView = z.infer<typeof ResolutionView>;

/** What a demand bucket counts: no dependency names or versions, only a coarse repository class. */
export const DemandKey = z.strictObject({
  capability: CapabilityId,
  decision: z.enum(["reuse", "adapt", "build", "decline"]),
  release: z.string().max(200).nullable(),
  profileIndex: z.int().min(0).nullable(),
  reasons: z.array(ReasonCode),
  offer: z.boolean(),
  class: z.strictObject({ packageManager: PackageManager, moduleSystem: ModuleSystem, nodeMajor: z.int().min(0), frameworks: z.array(Framework) }),
});

export type DemandKey = z.infer<typeof DemandKey>;

export const DemandView = z.strictObject({
  /** Buckets with fewer distinct repositories, or fewer distinct client addresses, are never published. */
  minProfiles: z.int().min(1),
  buckets: z.array(z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), profiles: z.int().min(0), sources: z.int().min(0), key: DemandKey })),
});

export type DemandView = z.infer<typeof DemandView>;

export interface UnmetDemand {
  readonly capability: CapabilityId;
  readonly decision: DemandKey["decision"];
  readonly reasons: readonly string[];
  /** Distinct repositories per day, summed over days: a repository asking on two days counts twice. */
  readonly profileDays: number;
  readonly days: number;
}

/**
 * Previews Lemma could not sell, grouped by capability, decision and reasons
 * and ranked by how many repositories asked: the "what to build next" list
 * (docs/economic-gates.md, roadmap). A reuse without an offer counts too,
 * because its blocker (for example missing evidence) is work Lemma can do.
 */
export function rankUnmetDemand(view: DemandView): UnmetDemand[] {
  const groups = new Map<string, { capability: CapabilityId; decision: DemandKey["decision"]; reasons: string[]; profileDays: number; days: Set<string> }>();
  for (const { day, profiles, key } of view.buckets) {
    if (key.offer) continue;
    const reasons = [...key.reasons].sort();
    const id = JSON.stringify([key.capability, key.decision, reasons]);
    const group = groups.get(id) ?? { capability: key.capability, decision: key.decision, reasons, profileDays: 0, days: new Set<string>() };
    group.profileDays += profiles;
    group.days.add(day);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((g) => ({ capability: g.capability, decision: g.decision, reasons: g.reasons, profileDays: g.profileDays, days: g.days.size }))
    .sort((a, b) => b.profileDays - a.profileDays || (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0) || (a.reasons.join() < b.reasons.join() ? -1 : 1));
}

export const StatusView = z.strictObject({
  schemaVersion: SchemaVersion,
  /** `degraded` when the store does not answer: previews still work, offers and resolutions may not. */
  status: z.enum(["ok", "degraded"]),
  /** CAIP-2 network the offers settle on. */
  network: z.string().max(64),
  catalogDigest: Hex32,
  releases: z.int().min(0),
  paidTools: z.boolean(),
  /** The testnet-only provisional overlay is loaded. */
  provisionalEvidence: z.boolean(),
  store: z.enum(["postgres", "memory"]),
  economics: z.enum(["placeholder", "measured"]),
});

export type StatusView = z.infer<typeof StatusView>;
