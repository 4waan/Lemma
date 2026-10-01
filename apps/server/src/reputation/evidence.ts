import {
  ADOPTION_EVIDENCE_KIND,
  ARBITRUM_SEPOLIA,
  type AdoptionEvidence,
  AdoptionFeedbackFile,
  type AgentId,
  type Hex32,
  adoptionFeedbackFile,
  adoptionFeedbackFileBytes,
  caip10,
  feedbackHashOf,
} from "@lemma/core";

import type { ReputationPost, ReputationTarget } from "../persistence.js";
import type { FeedbackRequest, ReputationChain } from "./chain.js";
import type { FinalizedOutcome } from "./feed.js";

/** Each target's segment in its feedback file's path: the provider's agent, or the buyer agent that opted in. */
export const EVIDENCE_TARGETS = { provider: "provider", buyer: "buyer-agent" } as const satisfies Record<ReputationTarget, string>;

/** Where one feedback's file is served, under the public base URL: `/api/v1/evidence/<resolutionId>/<provider|buyer-agent>`. */
export function evidencePath(resolutionId: Hex32, target: ReputationTarget): string {
  return `/api/v1/evidence/${resolutionId}/${EVIDENCE_TARGETS[target]}`;
}

/** The target a path segment names (`provider` or `buyer-agent`), if any. */
export function evidenceTarget(segment: string): ReputationTarget | undefined {
  if (segment === EVIDENCE_TARGETS.provider) return "provider";
  if (segment === EVIDENCE_TARGETS.buyer) return "buyer";
  return undefined;
}

/**
 * The feedback file for one feedback on a finalized outcome (core
 * `AdoptionFeedbackFile`), its exact bytes and their ERC-8004 `feedbackHash`.
 * It is built from the outcome and the target agent alone, so it comes out the
 * same every time. It names the agent in the chain client's identity registry,
 * and the chain client's attester, which sends the feedback, as its client, on
 * Arbitrum Sepolia (the only chain the client works on). Lemma's evidence
 * fields are picked one by one from the outcome, so nothing else it might
 * carry can reach the published file.
 */
export function buildEvidence(
  outcome: FinalizedOutcome,
  agentId: AgentId,
  chain: Pick<ReputationChain, "attester" | "identityRegistry">,
): { readonly file: AdoptionFeedbackFile; readonly bytes: string; readonly feedbackHash: Hex32 } {
  const evidence: AdoptionEvidence = {
    schemaVersion: "1",
    kind: ADOPTION_EVIDENCE_KIND,
    resolutionId: outcome.resolutionId,
    release: { releaseId: outcome.releaseId, version: outcome.version, releaseDigest: outcome.releaseDigest, profileIndex: outcome.profileIndex },
    capability: outcome.capability,
    acceptanceRecipeDigest: outcome.acceptanceRecipeDigest,
    acceptance: { exitCode: outcome.acceptance.exitCode, durationMs: outcome.acceptance.durationMs, outputDigest: outcome.acceptance.outputDigest },
    verdict: outcome.verdict,
    finalizedAt: outcome.finalizedAt,
    registry: { chainId: outcome.registry.chainId, address: outcome.registry.address },
  };
  const file = adoptionFeedbackFile(evidence, {
    agentRegistry: caip10(ARBITRUM_SEPOLIA, chain.identityRegistry),
    agentId,
    clientAddress: caip10(ARBITRUM_SEPOLIA, chain.attester),
  });
  const bytes = adoptionFeedbackFileBytes(file);
  return { file, bytes, feedbackHash: feedbackHashOf(bytes) };
}

/**
 * The `giveFeedback` call of a queued post, read from the post's own stored
 * file, so the call always equals the file its `feedbackURI` serves. Undefined
 * when the file does not fit the post and this attester: its bytes do not hash
 * to the post's `feedbackHash` or do not parse, it is about another resolution
 * or agent, or it names another client or identity registry than the chain
 * client's (a post queued before the attester key or the identity registry
 * changed). Such a file must never be pointed at by this attester's feedback.
 */
export function feedbackRequest(post: ReputationPost, chain: Pick<ReputationChain, "attester" | "identityRegistry">, publicBaseUrl: string): FeedbackRequest | undefined {
  if (feedbackHashOf(post.evidence) !== post.feedbackHash) return undefined;
  let file: AdoptionFeedbackFile;
  try {
    file = AdoptionFeedbackFile.parse(JSON.parse(post.evidence));
  } catch {
    return undefined;
  }
  const fits =
    file.lemma.resolutionId === post.resolutionId &&
    BigInt(file.agentId) === BigInt(post.agentId) &&
    file.clientAddress === caip10(ARBITRUM_SEPOLIA, chain.attester) &&
    file.agentRegistry === caip10(ARBITRUM_SEPOLIA, chain.identityRegistry);
  if (!fits) return undefined;
  return {
    agentId: BigInt(file.agentId),
    value: BigInt(file.value),
    valueDecimals: file.valueDecimals,
    tag1: file.tag1,
    tag2: file.tag2,
    endpoint: file.endpoint,
    feedbackURI: `${publicBaseUrl}${evidencePath(post.resolutionId, post.target)}`,
    feedbackHash: post.feedbackHash,
  };
}
