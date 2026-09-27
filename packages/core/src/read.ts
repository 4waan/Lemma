import { z } from "zod";

import { UsdcAtomic } from "./amounts.js";
import { PaymentTerms } from "./payment.js";
import { Address, ExactVersion, Hex32, IsoTimestamp, SchemaVersion } from "./primitives.js";
import { allInReductionBps, maxPriceFor, saleBlocker } from "./pricing.js";
import { Framework, Language, ModuleSystem, PackageManager } from "./profile.js";
import { ReasonCode } from "./reasons.js";
import { AdoptionOutcome } from "./receipt.js";
import { type CapabilityRelease, MatchedRelease, ProfileEvidence, Provenance, ReleaseId } from "./release.js";
import { AgentId } from "./reputation.js";
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

const U64_MAX = 2n ** 64n - 1n;
const U64Decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, "expected a non-negative decimal integer")
  .refine((s) => !/^(0|[1-9][0-9]{0,19})$/.test(s) || BigInt(s) <= U64_MAX, "exceeds 2^64 - 1");

/**
 * The fewest distinct buyers a read model publishes a count of. Below it the
 * count is null: a small count would say too much about who bought, and a
 * record made by one or two buyers is not much of one.
 */
export const MIN_PUBLISHED_BUYERS = 3;

/**
 * How many distinct buyers are behind a set of counted outcomes, published
 * only from `MIN_PUBLISHED_BUYERS` up (else null). The server counts them (it
 * alone knows each resolution's payer); nothing names a buyer.
 */
export const DistinctBuyers = z.int().min(MIN_PUBLISHED_BUYERS).nullable();

export type DistinctBuyers = z.infer<typeof DistinctBuyers>;

/** A raw distinct-buyer count as a read model publishes it: the count from `MIN_PUBLISHED_BUYERS` up, else null. */
export function publishedBuyers(count: number): DistinctBuyers {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`invalid buyer count: ${String(count)}`);
  return count >= MIN_PUBLISHED_BUYERS ? count : null;
}

/**
 * What a profile's compatibility confidence is built from: the benchmark prior
 * alone, the prior plus finalized adoption outcomes, or outcomes alone (no evidence).
 */
export const CompatibilitySource = z.enum(["benchmark", "benchmark+outcomes", "outcomes"]);

/**
 * Compatibility confidence for one (release, profile): the 90% Wilson lower bound
 * on the acceptance pass rate, over the evidence's treatment arm as a prior
 * (`passes = passed.treatment`, `failures = runs.treatment - passed.treatment`)
 * plus finalized adoption outcomes whose weight halves every 30 days. Computed by
 * `@lemma/confidence`, the same engine as the Stylus contract. A read-model
 * value only: it is never signed, paid for or persisted.
 */
export const ProfileCompatibility = z
  .strictObject({
    confidenceBps: z.int().min(0).max(10_000),
    /** The effective sample size in thousandths of an outcome, after decay. */
    effectiveNMilli: U64Decimal,
    /** Finalized adoption outcomes counted. */
    outcomes: z.int().min(0),
    source: CompatibilitySource,
    /** Distinct buyers among the counted outcomes (`DistinctBuyers`): null below three. */
    buyers: DistinctBuyers,
  })
  .refine((c) => (c.source === "benchmark") === (c.outcomes === 0), { path: ["outcomes"], message: "only a benchmark-only confidence has no outcomes" })
  .refine((c) => c.buyers === null || c.buyers <= c.outcomes, { path: ["buyers"], message: "more buyers than outcomes" });

export type ProfileCompatibility = z.infer<typeof ProfileCompatibility>;

/** One supported profile of a release, with what its evidence means for a buyer at the list price. */
const ProfileSummaryFields = z.strictObject({
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
  /**
   * Compatibility confidence, or null when the profile has neither evidence nor an
   * outcome, or when the server could not read its outcomes (it logs that).
   */
  compatibility: ProfileCompatibility.nullable(),
});

export const ProfileSummary = ProfileSummaryFields.refine(
  (p) => p.compatibility === null || (p.compatibility.source === "outcomes") === (p.evidence === null),
  { path: ["compatibility", "source"], message: "a confidence without evidence comes from outcomes alone, and one with evidence includes it" },
);

export type ProfileSummary = z.infer<typeof ProfileSummary>;

/**
 * A capability's public adoption record: the ERC-8004 reputation summary of the
 * provider's agent for that capability, counting only feedback from Lemma's
 * attester (`getSummary(agentId, [attester], "lemma.adoption", capability)`).
 * `passBps` is the share of posted finalized outcomes that passed, in basis
 * points, and `count` how many were posted. The server reads it from the chain
 * and caches it; it is null while nothing is known.
 */
export const ReleaseReputation = z.strictObject({
  passBps: z.int().min(0).max(10_000),
  count: z.int().min(1),
});

export type ReleaseReputation = z.infer<typeof ReleaseReputation>;

/**
 * A capability's adoption record as the catalog shows it: the ERC-8004
 * summary (`ReleaseReputation`) and the distinct buyers behind the outcomes
 * the server fed to its attester for the capability (`DistinctBuyers`). The
 * buyer count covers every outcome fed, and the summary's `count` those the
 * registry has taken so far, so the two can differ for a moment.
 */
export const CatalogReputation = ReleaseReputation.extend({ buyers: DistinctBuyers });

export type CatalogReputation = z.infer<typeof CatalogReputation>;

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
  /** The public adoption record of the release's capability (ERC-8004), or null while there is none or it is not known. */
  reputation: CatalogReputation.nullable(),
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
 * once chain cost `g` is paid. `compatibility` maps a profile index to its
 * confidence (the server computes it with `@lemma/confidence`); a profile missing
 * from it shows null.
 */
export function summarizeRelease(
  entry: {
    readonly release: CapabilityRelease;
    readonly releaseDigest: Hex32;
    readonly baseReleaseDigest: Hex32;
    readonly provisional: boolean;
    /** The cached adoption record of the release's capability; absent reads as none. */
    readonly reputation?: ReleaseReputation | null | undefined;
    /** Distinct buyers behind the outcomes fed to the attester for the capability, raw (`publishedBuyers` applies); absent reads as none. */
    readonly reputationBuyers?: number | undefined;
  },
  economics: { readonly chainCostAtomic: bigint },
  now: Date,
  compatibility?: ReadonlyMap<number, ProfileCompatibility>,
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
        compatibility: compatibility?.get(profileIndex) ?? null,
      };
    }),
    reputation: entry.reputation == null ? null : { ...entry.reputation, buyers: publishedBuyers(entry.reputationBuyers ?? 0) },
  });
}

/**
 * Where a resolution's warranty stands, from the warranty registry's own
 * events as the server indexed them:
 *
 * - `none`: never activated, and it will not be: no warranty was bought (no
 *   claim, or not paid), the release has no warranty on the registry, or
 *   activation gave up.
 * - `pending`: paid with a claim; the provider's activation is on its way.
 * - `active`: activated, and neither finalized nor expired yet.
 * - `passed` and `void`: finalized; the bond went back to the provider.
 * - `failed`: finalized as an eligible failure; the credit is outstanding.
 * - `refunded`: the failed warranty's credit was withdrawn.
 * - `expired`: the claim window closed without an outcome.
 */
export const WarrantyState = z.enum(["none", "pending", "active", "passed", "failed", "refunded", "void", "expired"]);

export type WarrantyState = z.infer<typeof WarrantyState>;

const ACTIVATED_STATES: ReadonlySet<WarrantyState> = new Set(["active", "passed", "failed", "refunded", "void", "expired"]);
const FINALIZED_STATES: ReadonlySet<WarrantyState> = new Set(["passed", "failed", "refunded", "void"]);
const FEEDBACK_STATES: ReadonlySet<WarrantyState> = new Set(["passed", "failed", "refunded"]);

/**
 * A resolution's warranty as anyone may see it. Every chain fact (the state,
 * the amount, the claim deadline and each transaction hash) comes from the
 * registry's events the server indexed, so an action anyone relayed shows up
 * too. The claim deadline is the one in force: every second the registry was
 * paused after activation moves it later.
 *
 * `feedback` is the ERC-8004 feedback the server's attester posted to the
 * provider's agent about the outcome. The view never names the buyer, the
 * payer, the claim hash or secret, the refund address or the payment
 * reference.
 */
export const WarrantyView = z
  .strictObject({
    state: WarrantyState,
    /** The reserved warranty in atomic USDC (testnet), once activated. */
    amount: UsdcAtomic.nullable(),
    claimDeadline: IsoTimestamp.nullable(),
    /** `ResolutionActivated`'s transaction. */
    activation: Hex32.nullable(),
    /** `OutcomeFinalized`'s transaction. */
    outcome: Hex32.nullable(),
    /** `ResolutionExpired`'s transaction. */
    expiry: Hex32.nullable(),
    /** `CreditWithdrawn`'s transaction. */
    withdrawal: Hex32.nullable(),
    /** The attester's `giveFeedback` to the provider's agent about this outcome. */
    feedback: Hex32.nullable(),
  })
  .superRefine((w, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const activated = ACTIVATED_STATES.has(w.state);
    if ((w.activation !== null) !== activated) issue("activation", `state ${w.state} ${activated ? "needs" : "has no"} an activation`);
    if ((w.amount !== null) !== activated) issue("amount", `state ${w.state} ${activated ? "needs" : "has no"} an amount`);
    if ((w.claimDeadline !== null) !== activated) issue("claimDeadline", `state ${w.state} ${activated ? "needs" : "has no"} a claim deadline`);
    if ((w.outcome !== null) !== FINALIZED_STATES.has(w.state)) issue("outcome", `state ${w.state} does not match the outcome transaction`);
    if ((w.expiry !== null) !== (w.state === "expired")) issue("expiry", `state ${w.state} does not match the expiry transaction`);
    if ((w.withdrawal !== null) !== (w.state === "refunded")) issue("withdrawal", `state ${w.state} does not match the withdrawal transaction`);
    if (w.feedback !== null && !FEEDBACK_STATES.has(w.state)) issue("feedback", `state ${w.state} has no feedback`);
  });

export type WarrantyView = z.infer<typeof WarrantyView>;

/**
 * A resolution as anyone may see it by id: never the preview id (the recovery
 * secret), the buyer, the bundle or the settlement reference. This holds only
 * while the resolution id is not published next to the buyer elsewhere, so the
 * payment's on-chain nonce must not be the resolution id itself (core
 * `deriveResolutionId`).
 *
 * A warranted resolution's id is public on chain (`ResolutionActivated`), and
 * the payment that bought it is a public USDC transfer of the price to
 * `terms.payTo` from the buyer's wallet. So the view gives no time finer than
 * the day: `createdOn` is the UTC day the resolution was created, inside the
 * paid request that settled it. The precise time stays in the signed
 * `Resolution` the buyer holds and in the server's own row.
 */
export const ResolutionView = z.strictObject({
  resolutionId: Hex32,
  state: z.enum(["prepared", "settled", "expired"]),
  release: MatchedRelease,
  payloadDigest: Hex32,
  terms: PaymentTerms,
  /** The UTC day (`YYYY-MM-DD`) the resolution was created. */
  createdOn: z.iso.date(),
  /** A receipt counts for compatibility history only once its signature is verified. */
  receipt: z.strictObject({ outcome: AdoptionOutcome, verified: z.boolean() }).nullable(),
  /** The resolution's warranty, or null when the server runs no warranty pipeline. */
  warranty: WarrantyView.nullable(),
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
  /** `buyers`: distinct bridges with a buyer pass (one that has bought before), at most `sources` apart from a bridge moving address. */
  buckets: z.array(z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), profiles: z.int().min(0), sources: z.int().min(0), buyers: z.int().min(0), key: DemandKey })),
});

export type DemandView = z.infer<typeof DemandView>;

export interface UnmetDemand {
  readonly capability: CapabilityId;
  readonly decision: DemandKey["decision"];
  readonly reasons: readonly string[];
  /** Distinct bridges that have bought before, per day, summed over days: the ranking. */
  readonly buyerDays: number;
  /** Distinct repositories per day, summed over days: a repository asking on two days counts twice. Shown apart, and only breaks ties. */
  readonly profileDays: number;
  readonly days: number;
}

/**
 * Previews Lemma could not sell, grouped by capability, decision and reasons
 * and ranked by how many bridges that have bought before asked, then by how
 * many repositories asked: the "what to build next" list (docs/economic-gates.md,
 * roadmap). Previews from addresses that never bought can only reorder groups
 * with as many buyers, never lift one above a group with more. A reuse without
 * an offer counts too, because its blocker (for example missing evidence) is
 * work Lemma can do.
 */
export function rankUnmetDemand(view: DemandView): UnmetDemand[] {
  const groups = new Map<string, { capability: CapabilityId; decision: DemandKey["decision"]; reasons: string[]; buyerDays: number; profileDays: number; days: Set<string> }>();
  for (const { day, profiles, buyers, key } of view.buckets) {
    if (key.offer) continue;
    const reasons = [...key.reasons].sort();
    const id = JSON.stringify([key.capability, key.decision, reasons]);
    const group = groups.get(id) ?? { capability: key.capability, decision: key.decision, reasons, buyerDays: 0, profileDays: 0, days: new Set<string>() };
    group.buyerDays += buyers;
    group.profileDays += profiles;
    group.days.add(day);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((g) => ({ capability: g.capability, decision: g.decision, reasons: g.reasons, buyerDays: g.buyerDays, profileDays: g.profileDays, days: g.days.size }))
    .sort((a, b) => b.buyerDays - a.buyerDays || b.profileDays - a.profileDays || (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0) || (a.reasons.join() < b.reasons.join() ? -1 : 1));
}

/**
 * The chain the server works with, from its configuration, for explorer
 * links. `explorer` is the block explorer's base URL, or null when links are
 * off. Each contract address is null when the server does not use it:
 * `registry` (the warranty registry) and `engine` (the compatibility engine the
 * registry records outcomes into, as the server last indexed `EngineSet`)
 * while the warranty pipeline is off, `identityRegistry` and
 * `providerAgentId` while no provider agent is configured, and
 * `reputationRegistry` while the attester is off.
 */
export const ChainView = z.strictObject({
  explorer: z.url({ protocol: /^https?$/ }).nullable(),
  usdc: Address.nullable(),
  registry: Address.nullable(),
  engine: Address.nullable(),
  identityRegistry: Address.nullable(),
  reputationRegistry: Address.nullable(),
  providerAgentId: AgentId.nullable(),
});

export type ChainView = z.infer<typeof ChainView>;

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
  /** Contract addresses and the explorer, for links. */
  chain: ChainView,
});

export type StatusView = z.infer<typeof StatusView>;
