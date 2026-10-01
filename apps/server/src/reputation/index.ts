import type { CapabilityId } from "@lemma/core";

import type { Logger } from "../log.js";
import type { LemmaStore } from "../persistence.js";
import { Attester } from "./attester.js";
import { type ReputationChain, viemReputationChain } from "./chain.js";
import type { ReputationConfig } from "./config.js";
import type { OutcomeFeed } from "./feed.js";
import { ReputationSummaries, SUMMARY_CHECK_MS } from "./summary.js";

export * from "./abi.js";
export * from "./attester.js";
export * from "./chain.js";
export * from "./config.js";
export * from "./evidence.js";
export * from "./feed.js";
export * from "./registration.js";
export * from "./routes.js";
export * from "./register.js";
export * from "./summary.js";

export interface ReputationRuntime {
  /** The cached records for previews and the catalog; undefined while reputation is off. */
  readonly summaries: ReputationSummaries | undefined;
  readonly attester: Attester | undefined;
  /** Stops the background jobs. */
  stop(): void;
}

export interface StartReputationDeps {
  readonly config: ReputationConfig;
  readonly store: LemmaStore;
  /** Finalized outcomes, from the outcome pipeline (`noOutcomes` until it exists). */
  readonly feed: OutcomeFeed;
  /** The catalog's capabilities, whose records are kept warm. */
  readonly capabilities: readonly CapabilityId[];
  readonly clock: () => Date;
  readonly logger: Logger;
  /** Overrides the viem chain client (tests). */
  readonly chain?: ReputationChain;
  readonly attesterIntervalMs?: number;
}

/**
 * Starts ERC-8004 reputation when it is configured (the attester key, the RPC
 * URL, the provider's agent id and the public base URL): the attester job
 * every minute, and every minute a refresh of each capability's cached record
 * that is five minutes old. Otherwise it starts nothing and returns no
 * summaries, so the server behaves exactly as without it. Both jobs run on
 * timers that never hold the process open, and no request ever waits for them.
 */
export function startReputation(deps: StartReputationDeps): ReputationRuntime {
  const { config } = deps;
  if (config.attester === undefined || config.agentId === undefined || config.publicBaseUrl === undefined) {
    return { summaries: undefined, attester: undefined, stop() {} };
  }
  const chain =
    deps.chain ??
    viemReputationChain({
      rpcUrl: config.attester.rpcUrl,
      key: config.attester.key,
      identityRegistry: config.identityRegistry,
      reputationRegistry: config.reputationRegistry,
      logRange: BigInt(config.logRange),
    });
  const summaries = new ReputationSummaries(chain, config.agentId, deps.logger);
  const attester = new Attester({ store: deps.store, chain, feed: deps.feed, providerAgentId: config.agentId, publicBaseUrl: config.publicBaseUrl, clock: deps.clock, logger: deps.logger });
  const stopAttester = attester.start(deps.attesterIntervalMs);
  const refresh = () => void summaries.refreshAll(deps.capabilities);
  const timer = setInterval(refresh, SUMMARY_CHECK_MS);
  timer.unref();
  refresh();
  deps.logger.log("info", "reputation.on", {
    agentId: config.agentId,
    attester: chain.attester,
    identityRegistry: config.identityRegistry,
    reputationRegistry: config.reputationRegistry,
  });
  return {
    summaries,
    attester,
    stop() {
      stopAttester();
      clearInterval(timer);
    },
  };
}
