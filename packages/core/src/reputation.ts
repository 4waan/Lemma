import { keccak256, stringToBytes } from "viem";
import { z } from "zod";

import { canonicalize, digest } from "./canonical.js";
import { Address, Caip10, Hex32, IsoTimestamp, SchemaVersion } from "./primitives.js";
import { AcceptanceResult } from "./receipt.js";
import { AcceptanceRecipe, MatchedRelease } from "./release.js";
import { CapabilityId } from "./task.js";

/**
 * ERC-8004 reputation: what Lemma publishes about finalized adoption outcomes.
 * The server's attester posts one `giveFeedback` per outcome to the provider's
 * agent (and one to a buyer agent that opted in). Each feedback has its own
 * off-chain feedback file (ERC-8004, "Off-Chain Feedback File Structure"):
 * `feedbackURI` points at it and `feedbackHash` is its keccak256. These schemas
 * fix the bytes of those files, so anyone can check a hash on chain against them.
 */

const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * An ERC-8004 agent id: the identity registry's ERC-721 token id, as a decimal
 * uint256 string without leading zeros, so one agent has one spelling.
 */
export const AgentId = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/, "expected a decimal agent id")
  .refine((v) => v.length < 78 || BigInt(v) <= MAX_UINT256, "agent id exceeds uint256");

export type AgentId = z.infer<typeof AgentId>;

/**
 * An agent id as ERC-8004's JSON files write it: a JSON number, as the spec's
 * examples do, up to 2^53 - 1, and its decimal string above that, where a JSON
 * reader would round a number. One agent has one form, which every reader gets
 * exactly.
 */
export const AgentIdJson = z.union([
  z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  AgentId.refine((v) => BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER), "an agent id up to 2^53 - 1 is written as a number"),
]);

export type AgentIdJson = z.infer<typeof AgentIdJson>;

/** `agentId` as an ERC-8004 JSON file writes it (`AgentIdJson`). */
export function agentIdJson(agentId: AgentId): AgentIdJson {
  const id = AgentId.parse(agentId);
  return BigInt(id) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id;
}

/** `tag1` of every Lemma adoption feedback; `tag2` is the capability id. */
export const ADOPTION_FEEDBACK_TAG = "lemma.adoption" as const;

/**
 * The `_meta` key of a `lemma_preview` result that carries the matched
 * release's cached adoption record (`ReleaseReputation`). The preview itself
 * (`PreviewResult`) does not change; a client that does not know the key
 * ignores it.
 */
export const REPUTATION_META_KEY = "lemma/reputation" as const;

export const ADOPTION_EVIDENCE_KIND = "lemma.adoption-evidence" as const;

/** A finalized outcome counts as a pass (feedback value 100) or a failure (0). Void and abandoned outcomes are never posted. */
export const AdoptionVerdict = z.enum(["passed", "failed"]);

export type AdoptionVerdict = z.infer<typeof AdoptionVerdict>;

/** The feedback `value` of a verdict, with `valueDecimals` 0. */
function feedbackValue(verdict: AdoptionVerdict): 0 | 100 {
  return verdict === "passed" ? 100 : 0;
}

/**
 * Lemma's own evidence for one finalized outcome, carried under the `lemma`
 * key of each of its feedback files (`AdoptionFeedbackFile`). It names the
 * resolution, the release and profile, the capability, the acceptance recipe
 * (by digest), the acceptance result, the verdict, when it was finalized and
 * the warranty registry that finalized it. It never names the buyer or payer,
 * the preview id, the payment nonce or the settlement: those would join a
 * wallet to what it bought.
 */
export const AdoptionEvidence = z
  .strictObject({
    schemaVersion: SchemaVersion,
    kind: z.literal(ADOPTION_EVIDENCE_KIND),
    resolutionId: Hex32,
    release: MatchedRelease,
    capability: CapabilityId,
    /** `acceptanceRecipeDigest` of the release's recipe: what the buyer ran. */
    acceptanceRecipeDigest: Hex32,
    acceptance: AcceptanceResult,
    verdict: AdoptionVerdict,
    finalizedAt: IsoTimestamp,
    /** The warranty registry that finalized the outcome. */
    registry: z.strictObject({ chainId: z.int().min(1).max(2 ** 53 - 1), address: Address }),
  })
  .superRefine((e, ctx) => {
    const code = e.acceptance.exitCode;
    if ((e.verdict === "passed" && code !== 0) || (e.verdict === "failed" && code === 0)) {
      ctx.addIssue({ code: "custom", path: ["acceptance", "exitCode"], message: `exit code ${code} contradicts verdict ${e.verdict}` });
    }
  });

export type AdoptionEvidence = z.infer<typeof AdoptionEvidence>;

const chainOf = (id: Caip10) => id.slice(0, id.lastIndexOf(":"));

/**
 * The off-chain feedback file behind one Lemma feedback (ERC-8004,
 * "Off-Chain Feedback File Structure"): what `feedbackURI` serves and
 * `feedbackHash` covers. An outcome has one file per feedback, since the
 * provider's agent and an opted-in buyer agent have different `agentId`s.
 *
 * - The spec's MUST fields, equal to the `giveFeedback` call that points at
 *   the file: `agentRegistry` (`eip155:<chainId>:<identity registry>`),
 *   `agentId` (`AgentIdJson`), `clientAddress` (`eip155:<chainId>:<attester>`:
 *   the address that calls `giveFeedback`, public on chain anyway, never the
 *   buyer), `createdAt` (when the outcome was finalized), `value` (100 for a
 *   pass, 0 for a failure) and `valueDecimals` (0).
 * - The spec's optional `tag1` ("lemma.adoption"), `tag2` (the capability) and
 *   `endpoint` (""), equal to the call too.
 * - Lemma's own evidence under `lemma` (the spec allows other fields). Its
 *   `schemaVersion` and `kind` version the file.
 *
 * It has no `proofOfPayment`, the optional field the spec suggests for x402:
 * it would name the payer and its payment transaction, and so join a wallet to
 * what it bought. The schema is strict, so neither that nor any buyer, payer,
 * preview id, nonce or settlement field can be added.
 */
export const AdoptionFeedbackFile = z
  .strictObject({
    agentRegistry: Caip10,
    agentId: AgentIdJson,
    clientAddress: Caip10,
    createdAt: IsoTimestamp,
    value: z.union([z.literal(100), z.literal(0)]),
    valueDecimals: z.literal(0),
    tag1: z.literal(ADOPTION_FEEDBACK_TAG),
    tag2: CapabilityId,
    endpoint: z.literal(""),
    lemma: AdoptionEvidence,
  })
  .superRefine((f, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (f.value !== feedbackValue(f.lemma.verdict)) issue("value", `value ${f.value} contradicts verdict ${f.lemma.verdict}`);
    if (f.tag2 !== f.lemma.capability) issue("tag2", "tag2 must be the evidence's capability");
    if (f.createdAt !== f.lemma.finalizedAt) issue("createdAt", "createdAt must be when the outcome was finalized");
    // The reputation registry and the identity registry it reads are on one chain, where the client calls it.
    if (chainOf(f.clientAddress) !== chainOf(f.agentRegistry)) issue("clientAddress", "the client and the identity registry must be on one chain");
  });

export type AdoptionFeedbackFile = z.infer<typeof AdoptionFeedbackFile>;

/** Who a feedback is for and from: the target agent in its identity registry, and the client that gives it. */
export interface FeedbackParties {
  /** `eip155:<chainId>:<identity registry>`. */
  readonly agentRegistry: Caip10;
  readonly agentId: AgentId;
  /** `eip155:<chainId>:<address that calls giveFeedback>`. */
  readonly clientAddress: Caip10;
}

/**
 * The feedback file for one feedback on an outcome: the spec's fields for its
 * parties, the rest derived from the evidence so that they equal the
 * `giveFeedback` call (see `AdoptionFeedbackFile`), and the evidence itself.
 */
export function adoptionFeedbackFile(evidence: AdoptionEvidence, parties: FeedbackParties): AdoptionFeedbackFile {
  return AdoptionFeedbackFile.parse({
    agentRegistry: parties.agentRegistry,
    agentId: agentIdJson(parties.agentId),
    clientAddress: parties.clientAddress,
    createdAt: evidence.finalizedAt,
    value: feedbackValue(evidence.verdict),
    valueDecimals: 0,
    tag1: ADOPTION_FEEDBACK_TAG,
    tag2: evidence.capability,
    endpoint: "",
    lemma: evidence,
  });
}

/** A feedback file's exact bytes (UTF-8 of its RFC 8785 canonical JSON): what the server serves and `feedbackHash` covers. */
export function adoptionFeedbackFileBytes(file: AdoptionFeedbackFile): string {
  return canonicalize(AdoptionFeedbackFile.parse(file));
}

/** ERC-8004 `feedbackHash`: keccak256 of the bytes served at `feedbackURI`. */
export function feedbackHashOf(bytes: string): Hex32 {
  return keccak256(stringToBytes(bytes));
}

/** Digest of an acceptance recipe, which the evidence names instead of repeating the recipe. */
export function acceptanceRecipeDigest(recipe: AcceptanceRecipe): Hex32 {
  return digest("acceptance-recipe", AcceptanceRecipe.parse(recipe));
}
