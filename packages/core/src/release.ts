import { z } from "zod";

import { UsdcAtomic, atomicOrNull } from "./amounts.js";
import { digest } from "./canonical.js";
import { Address, ExactVersion, Hex32, IsoTimestamp, PackageName, SafeText, SchemaVersion, isSortedUnique } from "./primitives.js";
import { Framework, Language, ModuleSystem, PackageManager } from "./profile.js";
import { CapabilityId } from "./task.js";

/**
 * A semver range as written in package.json (`^1.2.0`, `>=1.4 <2`). Core only
 * checks the character set; the resolver evaluates ranges with a semver library.
 */
export const SemverRange = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.\-+<>=^~|* ]+$/, "expected a semver range");

function sortedUnique<T extends z.ZodType<string>>(item: T) {
  return z.array(item).min(1).refine(isSortedUnique, "must be sorted and unique");
}

export const MAX_SUPPORTED_PROFILES = 8;

/**
 * Savings evidence for one supported profile, produced by the frozen paired
 * benchmark (docs/benchmark-protocol.md, docs/economic-gates.md). The resolver
 * only offers a resolution for a profile whose evidence is present and fresh.
 *
 * Money fields are atomic units. Model costs are measured in micro-USD and
 * treated 1:1 as atomic USDC in the MVP.
 */
export const ProfileEvidence = z
  .strictObject({
    benchmarkVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    /** Digest of the benchmark's run-record summary that produced these numbers. */
    runSetDigest: Hex32,
    /** Digest of the concrete fixture profile the benchmark ran against. */
    fixtureProfileDigest: Hex32,
    /** Agent model and settings id the saving was measured with. */
    model: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:/-]+$/),
    measuredAt: IsoTimestamp,
    /** After this instant the evidence is stale and the profile is preview-only. */
    staleAfter: IsoTimestamp,
    runs: z.strictObject({ control: z.int().min(1).max(1000), treatment: z.int().min(1).max(1000) }),
    passed: z.strictObject({ control: z.int().min(0).max(1000), treatment: z.int().min(0).max(1000) }),
    /** Median raw model cost of the control arm to reach green. */
    controlMedianCostUsdc: UsdcAtomic,
    /** Conservative raw model-cost saving per resolution; the sale rule prices off this. */
    expectedRawSavingUsdc: UsdcAtomic,
    /** Median total tokens saved; lets a buyer re-price the saving for its own model. */
    expectedTokenSaving: z.int().min(0),
  })
  .superRefine((e, ctx) => {
    if (Date.parse(e.staleAfter) <= Date.parse(e.measuredAt)) {
      ctx.addIssue({ code: "custom", path: ["staleAfter"], message: "staleAfter must be after measuredAt" });
    }
    if (e.passed.control > e.runs.control || e.passed.treatment > e.runs.treatment) {
      ctx.addIssue({ code: "custom", path: ["passed"], message: "passed runs cannot exceed runs" });
    }
    const saving = atomicOrNull(e.expectedRawSavingUsdc);
    const control = atomicOrNull(e.controlMedianCostUsdc);
    if (saving !== null && control !== null && saving > control) {
      ctx.addIssue({ code: "custom", path: ["expectedRawSavingUsdc"], message: "saving cannot exceed the control cost" });
    }
  });

export type ProfileEvidence = z.infer<typeof ProfileEvidence>;

/**
 * One repository shape a release is proven to support. Every listed condition
 * must hold. `evidence` is null for fixture-proven but unbenchmarked profiles,
 * which can be previewed but never sold.
 */
export const SupportedProfile = z
  .strictObject({
    languages: sortedUnique(Language),
    nodeMajor: z.strictObject({ min: z.int().min(0).max(999), max: z.int().min(0).max(999) }),
    packageManagers: sortedUnique(PackageManager),
    moduleSystems: sortedUnique(ModuleSystem),
    dependencies: z.record(PackageName, SemverRange),
    frameworks: z.array(Framework).refine(isSortedUnique, "must be sorted and unique"),
    evidence: ProfileEvidence.nullable(),
  })
  .refine((p) => p.nodeMajor.min <= p.nodeMajor.max, { path: ["nodeMajor"], message: "min must not exceed max" });

export type SupportedProfile = z.infer<typeof SupportedProfile>;

export const Provenance = z.strictObject({
  repository: z
    .string()
    .max(200)
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected an https://github.com/<owner>/<repo> URL"),
  /** Full commit hash. Branches and tags are mutable and rejected. */
  commit: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-hex commit hash"),
  spdxLicense: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$/, "expected an SPDX license expression"),
});

/** Environment variables an acceptance run may receive. Nothing else reaches it. */
export const ACCEPTANCE_ENV = ["CI", "FORCE_COLOR", "LANG", "NODE_ENV", "NO_COLOR", "TZ"] as const;

/**
 * One argument passed through to the acceptance script: no whitespace, shell
 * metacharacters, absolute paths, parent traversal or URLs.
 */
export const SafeArg = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_=:@.,+-][A-Za-z0-9_=:@.,/+-]*$/, "argument contains characters outside the allowlist")
  .refine((a) => !a.split(/[/=]/).includes(".."), "parent traversal is not allowed")
  .refine((a) => !/=\//.test(a) && !a.startsWith("/"), "absolute paths are not allowed")
  .refine((a) => !a.includes("://") && !/^(?:data|file|git|github|https?):/i.test(a), "URLs and remote specs are not allowed");

/**
 * How the bridge checks an applied resolution. A release names a package.json
 * script and its arguments; the bridge builds argv itself with the buyer's
 * package manager (`acceptanceArgv`), spawns it without a shell, passes through
 * only the listed environment variables, and stops it at `timeoutSec`.
 *
 * This fixes what runs; it does not make running it safe. The bridge still has
 * to confine the run (fresh HOME, network off after install, writes limited to
 * the workspace), and it must refuse patches that change package.json scripts.
 */
export const AcceptanceRecipe = z.strictObject({
  script: z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/, "expected a package.json script name"),
  args: z.array(SafeArg).max(8),
  timeoutSec: z.int().min(1).max(1800),
  env: z.array(z.enum(ACCEPTANCE_ENV)).max(ACCEPTANCE_ENV.length).refine(isSortedUnique, "must be sorted and unique"),
});

export type AcceptanceRecipe = z.infer<typeof AcceptanceRecipe>;

/** The exact argv the bridge spawns for a recipe, for the buyer's package manager. */
export function acceptanceArgv(recipe: AcceptanceRecipe, packageManager: z.infer<typeof PackageManager>): string[] {
  const r = AcceptanceRecipe.parse(recipe);
  // npm needs `--` to stop parsing its own flags; pnpm and yarn pass everything after the script name through.
  if (packageManager === "npm") return ["npm", "run", r.script, ...(r.args.length ? ["--", ...r.args] : [])];
  return [packageManager, "run", r.script, ...r.args];
}

/** Warranty terms. The bond reserved for each resolution equals its price (docs/economics.md). */
export const WarrantyTerms = z.strictObject({
  claimWindowHours: z.int().min(1).max(720),
});

export const ReleaseId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a lowercase kebab-case release id");

/** A curated, versioned Capability Release manifest. */
export const CapabilityRelease = z
  .strictObject({
    schemaVersion: SchemaVersion,
    releaseId: ReleaseId,
    version: ExactVersion,
    capability: CapabilityId,
    title: SafeText(120),
    supportedProfiles: z.array(SupportedProfile).min(1).max(MAX_SUPPORTED_PROFILES),
    provenance: Provenance,
    /** `bundleDigest` of the release's PatchBundle. */
    payloadDigest: Hex32,
    acceptanceRecipe: AcceptanceRecipe,
    price: UsdcAtomic,
    /** The x402 recipient for this release's resolutions. */
    provider: z.strictObject({ payTo: Address }),
    warranty: WarrantyTerms,
    publishedAt: IsoTimestamp,
    expiresAt: IsoTimestamp,
  })
  .refine((r) => Date.parse(r.expiresAt) > Date.parse(r.publishedAt), {
    path: ["expiresAt"],
    message: "expiresAt must be after publishedAt",
  });

export type CapabilityRelease = z.infer<typeof CapabilityRelease>;

export function releaseDigest(release: CapabilityRelease): Hex32 {
  return digest("capability-release", CapabilityRelease.parse(release));
}

/**
 * Digest of a catalog snapshot: the sorted set of its release digests. Every
 * Preview records it, so a decision can be reproduced against the exact catalog.
 */
export function catalogDigest(releases: readonly CapabilityRelease[]): Hex32 {
  const digests = [...new Set(releases.map(releaseDigest))].sort();
  return digest("catalog", { schemaVersion: "1", releases: digests });
}

/** The exact release version, and which of its supported profiles matched. */
export const MatchedRelease = z.strictObject({
  releaseId: ReleaseId,
  version: ExactVersion,
  releaseDigest: Hex32,
  profileIndex: z.int().min(0).max(MAX_SUPPORTED_PROFILES - 1),
});

export type MatchedRelease = z.infer<typeof MatchedRelease>;
