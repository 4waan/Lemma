import type { CatalogIndex } from "@lemma/catalog";
import { type Address, type WarrantyVoucher, warrantyVoucherTypedData } from "@lemma/core";
import { type Hex, createPublicClient, createWalletClient, hashTypedData, keccak256, nonceManager, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import type { ServerConfig, WarrantyConfig } from "../config.js";
import { describeError } from "../errors.js";
import type { Logger } from "../log.js";
import { redactingTransport } from "../payments/rpc.js";
import type { LemmaStore } from "../persistence.js";
import { WarrantyActivator } from "./activator.js";
import { type WarrantyChain, viemWarrantyChain } from "./chain.js";
import { WarrantyEvaluator } from "./evaluator.js";
import { WarrantyExpirer } from "./expirer.js";
import { RegistryIndexer } from "./indexer.js";
import { RegistryOutcomeFeed, RegistryOutcomeSource, RegistrySnapshot } from "./outcomes.js";
import { CreditRelay } from "./relay.js";
import { WarrantyViews } from "./view.js";

/** The only chain the pipeline works on: Arbitrum Sepolia. */
export const WARRANTY_CHAIN_ID = 421_614;

/** A startup check that failed: its message names addresses and codes only, never a key or an RPC URL. */
export class WarrantyStartupError extends Error {
  override name = "WarrantyStartupError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The running pipeline: what `main.ts` hands to the app and the attester, and a stop for shutdown. */
export interface WarrantyPipeline {
  readonly snapshot: RegistrySnapshot;
  /** For the catalog's `CompatibilityReader` (`AppDeps.outcomes`). */
  readonly source: RegistryOutcomeSource;
  /** For the attester (`startReputation({ feed })`) and the catalog's reputation buyers (`AppDeps.reputationBuyers`). */
  readonly feed: RegistryOutcomeFeed;
  /** For the resolution and status routes (`AppDeps.warranty`). */
  readonly views: WarrantyViews;
  readonly indexer: RegistryIndexer;
  readonly activator: WarrantyActivator;
  readonly evaluator: WarrantyEvaluator;
  readonly expirer: WarrantyExpirer;
  readonly relay: CreditRelay;
  /** Stops every job. */
  stop(): void;
}

export interface WarrantyPipelineDeps {
  readonly config: WarrantyConfig;
  readonly store: LemmaStore;
  readonly index: CatalogIndex;
  readonly chain: WarrantyChain;
  /** The USDC the server quotes in, which the registry must hold bonds in. */
  readonly usdc: Address;
  readonly clock: () => Date;
  readonly logger: Logger;
  /** Overrides the job intervals (tests); `start: false` builds the jobs without starting them. */
  readonly intervals?: { readonly indexerMs?: number; readonly actionsMs?: number };
  readonly start?: boolean;
}

/** A fixed voucher whose digest the registry must compute as core does. */
const PROBE: WarrantyVoucher = {
  schemaVersion: "1",
  resolutionId: keccak256(stringToHex("lemma warranty startup probe: resolution")),
  releaseDigest: keccak256(stringToHex("lemma warranty startup probe: release")),
  profileIndex: 1,
  amount: "1",
  paymentRef: keccak256(stringToHex("lemma warranty startup probe: reference")),
  claimHash: keccak256(stringToHex("lemma warranty startup probe: claim")),
  activateBy: 1,
};

/**
 * Checks, before anything starts, that the chain client is the one to sign
 * with: on chain 421614, its keys are the configured provider and evaluator,
 * and the registry at the configured address holds the configured USDC and
 * hashes a voucher exactly as core does (its EIP-712 domain and layout are
 * the ones the server signs). A mismatch throws a `WarrantyStartupError`.
 */
export async function checkRegistry(chain: WarrantyChain, config: WarrantyConfig, usdc: Address): Promise<void> {
  if (chain.chainId !== WARRANTY_CHAIN_ID) throw new WarrantyStartupError("WRONG_CHAIN", `the warranty chain client works on chain ${chain.chainId}, not ${WARRANTY_CHAIN_ID}`);
  if (chain.registry !== config.registry) throw new WarrantyStartupError("REGISTRY_MISMATCH", `the chain client names registry ${chain.registry}, not ${config.registry}`);
  if (chain.provider !== config.providerAddress || chain.evaluator !== config.evaluatorAddress) throw new WarrantyStartupError("SENDER_MISMATCH", "the chain client's provider or evaluator is not the configured one");
  // Also the first read: an RPC endpoint of another chain is refused here.
  await chain.head();
  const identity = await chain.registryIdentity(PROBE);
  if (identity.usdc !== usdc) throw new WarrantyStartupError("REGISTRY_TOKEN_MISMATCH", `the registry at ${config.registry} holds bonds in ${identity.usdc}, not in ${usdc}`);
  const expected = hashTypedData(warrantyVoucherTypedData(PROBE, { chainId: WARRANTY_CHAIN_ID, registry: config.registry }));
  if (identity.voucherDigest !== expected) {
    throw new WarrantyStartupError("REGISTRY_DOMAIN_MISMATCH", `the contract at ${config.registry} does not hash vouchers as this server signs them: not the Lemma Warranty Registry this build knows`);
  }
}

/**
 * Builds the outcome pipeline over a chain client and starts its jobs: the
 * snapshot (refreshed from what is already indexed, then after every indexer
 * run), the outcome source and feed, the warranty view, the indexer (every
 * 15 s) and the activator, evaluator, expirer and credit relay (every 30 s).
 * Every job runs on a timer that never holds the process open, handles a
 * bounded batch and never throws out of its loop; no request waits on one.
 */
export async function startWarrantyPipeline(deps: WarrantyPipelineDeps): Promise<WarrantyPipeline> {
  const { config, store, index, chain, clock, logger } = deps;
  await checkRegistry(chain, config, deps.usdc);
  const snapshot = new RegistrySnapshot({ store, index, logger, clock, buyersRefreshMs: config.buyerCountsRefreshSeconds * 1000 });
  try {
    // What earlier runs indexed, before the first new run: the catalog shows it at once.
    await snapshot.refresh();
  } catch (error) {
    logger.log("warn", "warranty.snapshot_failed", { error: describeError(error) });
  }
  const source = new RegistryOutcomeSource(snapshot);
  const feed = new RegistryOutcomeFeed(snapshot, { store, index, registry: { chainId: WARRANTY_CHAIN_ID, address: config.registry }, logger });
  const views = new WarrantyViews({ store, snapshot, clock });
  const indexer = new RegistryIndexer({ store, chain, startBlock: config.startBlock, confirmations: config.indexerConfirmations, clock, logger, onIndexed: () => snapshot.refresh() });
  const common = { store, chain, clock, logger };
  const activator = new WarrantyActivator({ ...common, jitterSeconds: config.activationJitterSeconds, batchSeconds: config.activationBatchSeconds });
  const evaluator = new WarrantyEvaluator({ ...common, failures: config.failures });
  const expirer = new WarrantyExpirer(common);
  const relay = new CreditRelay(common);
  const stops: Array<() => void> = [];
  if (deps.start !== false) {
    const actionsMs = deps.intervals?.actionsMs;
    stops.push(indexer.start(deps.intervals?.indexerMs), activator.start(actionsMs), evaluator.start(actionsMs), expirer.start(actionsMs), relay.start(actionsMs));
  }
  if (config.startBlock === 0n) logger.log("warn", "warranty.start_block_unset", { note: "WARRANTY_REGISTRY_START_BLOCK is not set: the indexer reads the registry's logs from block 0" });
  logger.log("info", "warranty.on", { registry: config.registry, provider: config.providerAddress, evaluator: config.evaluatorAddress, failures: config.failures, startBlock: config.startBlock.toString(), confirmations: config.indexerConfirmations.toString() });
  return { snapshot, source, feed, views, indexer, activator, evaluator, expirer, relay, stop: () => stops.forEach((stop) => stop()) };
}

/**
 * The pipeline's chain client on the configured Arbitrum Sepolia RPC: viem
 * clients whose errors are scrubbed of the URL (track C's transport), and one
 * account per sender with viem's nonce manager, shared by every job that
 * sends from it. Logs a warning for a sender without ETH for gas.
 */
export async function viemWarrantyChainFor(config: ServerConfig, logger: Logger): Promise<WarrantyChain> {
  const warranty = config.warranty;
  if (warranty === undefined || config.chain.rpcUrl === undefined) throw new WarrantyStartupError("NOT_CONFIGURED", "the warranty pipeline needs its settings and ARBITRUM_SEPOLIA_RPC_URL");
  const transport = redactingTransport(config.chain.rpcUrl);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
  const wallet = (key: string) => createWalletClient({ account: privateKeyToAccount(key as Hex, { nonceManager }), chain: arbitrumSepolia, transport });
  const chain = viemWarrantyChain({
    publicClient,
    providerWallet: wallet(warranty.providerKey.reveal()),
    evaluatorWallet: wallet(warranty.evaluatorKey.reveal()),
    registry: warranty.registry,
    chainId: WARRANTY_CHAIN_ID,
  });
  for (const [role, address] of [["provider", warranty.providerAddress], ["evaluator", warranty.evaluatorAddress]] as const) {
    try {
      const balance = await publicClient.getBalance({ address: address as Hex });
      if (balance === 0n) logger.log("warn", "warranty.sender_unfunded", { role, address, note: "it has no ETH, so its sends will fail" });
    } catch (error) {
      logger.log("warn", "warranty.balance_unknown", { role, error: describeError(error) });
    }
  }
  return chain;
}
