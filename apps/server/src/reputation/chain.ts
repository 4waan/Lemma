import { type Address, type Hex32, toAddress } from "@lemma/core";
import {
  BaseError,
  type Hex,
  ContractFunctionRevertedError,
  type PublicClient,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import { reputationRegistryAbi, identityRegistryAbi } from "./abi.js";
import type { SecretKey } from "./config.js";

/** The arguments of one `giveFeedback` call. */
export interface FeedbackRequest {
  readonly agentId: bigint;
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly endpoint: string;
  readonly feedbackURI: string;
  readonly feedbackHash: Hex32;
}

/** `getSummary`'s answer. */
export interface ChainSummary {
  readonly count: bigint;
  readonly value: bigint;
  readonly decimals: number;
}

/**
 * Every chain call the reputation work makes, behind one small interface so
 * tests replace it. The server's implementation is `viemReputationChain`.
 */
export interface ReputationChain {
  /** The attester's address: the client of every feedback (each feedback file's `clientAddress`), and the one reviewer summaries count. */
  readonly attester: Address;
  /** The identity registry the agent ids are in: each feedback file's `agentRegistry`. */
  readonly identityRegistry: Address;
  blockNumber(): Promise<bigint>;
  /**
   * Simulates `giveFeedback` from the attester, then signs and broadcasts it;
   * resolves with the transaction hash once it is broadcast. Once
   * `options.clock` reads `options.notAfter` or later, it broadcasts nothing
   * and rejects with `SendDeadlineError`.
   */
  giveFeedback(request: FeedbackRequest, options: SendOptions): Promise<Hex32>;
  /** Waits a bounded time for a sent transaction: mined and succeeded, mined and reverted, or not known yet. */
  feedbackOutcome(txHash: Hex32): Promise<"success" | "reverted" | "unknown">;
  /** The same answer without waiting: the receipt if the transaction is mined, else "unknown". */
  receiptStatus(txHash: Hex32): Promise<"success" | "reverted" | "unknown">;
  /** The transaction of the attester's `NewFeedback` for this agent and feedback hash at or after `fromBlock`, if one exists. */
  findFeedback(query: { readonly agentId: bigint; readonly feedbackHash: Hex32; readonly fromBlock: bigint }): Promise<Hex32 | undefined>;
  /**
   * The attester's transaction counts: `mined` (the latest block's count, so
   * its next nonce) and `pending` (with the unmined transactions the node
   * knows of; Arbitrum's nodes keep no mempool and usually report none).
   */
  nonces(): Promise<{ readonly pending: number; readonly mined: number }>;
  /** `getSummary(agentId, [attester], tag1, tag2)`. */
  summary(query: { readonly agentId: bigint; readonly tag1: string; readonly tag2: string }): Promise<ChainSummary>;
  /**
   * Whether `address` owns the agent or is its ERC-8004 agent wallet; false for
   * an agent that does not exist. It decides whether a buyer may name the agent.
   */
  controlsAgent(agentId: bigint, address: Address): Promise<boolean>;
  /**
   * Why the registry would refuse the attester's feedback to this agent, by the
   * registry's own rule, or undefined when it would take it: `SELF_FEEDBACK`
   * when the identity registry's `isAuthorizedOrOwner(attester, agentId)` holds
   * (the attester owns the agent, is its approved address or an operator of its
   * owner; being its agent wallet does not count), `NO_SUCH_AGENT` when the
   * agent does not exist.
   */
  feedbackRefusal(agentId: bigint): Promise<FeedbackRefusal | undefined>;
}

/** A refusal of the reputation registry that no retry changes. */
export type FeedbackRefusal = "SELF_FEEDBACK" | "NO_SUCH_AGENT";

/** The revert reason of `giveFeedback` for self-feedback (ReputationRegistryUpgradeable.sol at b9e466c). */
const SELF_FEEDBACK_REASON = "Self-feedback not allowed";
/** The selector of OpenZeppelin's `ERC721NonexistentToken(uint256)`, for a revert decoded without it. */
const NONEXISTENT_TOKEN_SELECTOR = "0x7e273289";

/** The registry's final refusal a viem error carries (a `giveFeedback` or `isAuthorizedOrOwner` revert), if it is one. */
export function refusalOf(error: unknown): FeedbackRefusal | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  if (revert.reason === SELF_FEEDBACK_REASON) return "SELF_FEEDBACK";
  if (revert.data?.errorName === "ERC721NonexistentToken" || revert.signature === NONEXISTENT_TOKEN_SELECTOR) return "NO_SUCH_AGENT";
  return undefined;
}

/** The widest block range the log search asks of `eth_getLogs` at once, unless configured: what most RPC providers allow. */
export const DEFAULT_LOG_RANGE = 10_000n;

export class WrongChainError extends Error {
  override name = "WrongChainError";
  readonly code = "WRONG_CHAIN";
}

/** How a `giveFeedback` transaction is sent. */
export interface SendOptions {
  /**
   * The last instant it may be broadcast, on `clock`. A send still under way
   * then gives up before broadcasting (`SendDeadlineError`), so a slow send
   * never goes out after the attester's claim on its post has lapsed.
   */
  readonly notAfter: Date;
  /**
   * The clock `notAfter` is read on: the attester's own, which set it from the
   * claim, so the deadline and the claim's lease are measured alike. Never the
   * wall clock, which may disagree with the attester's.
   */
  readonly clock: () => Date;
  /** The nonce to send with; by default the attester's next one, as the node counts it. */
  readonly nonce?: number | undefined;
}

/** A send given up before its broadcast because its deadline passed: nothing was sent. */
export class SendDeadlineError extends Error {
  override name = "SendDeadlineError";
  readonly code = "SEND_DEADLINE";

  constructor() {
    super("the send's deadline passed before it was broadcast; nothing was sent");
  }
}

/** Whether a viem error is a contract revert (as opposed to a transport or node failure). */
export function isRevert(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

export interface ViemReputationChainOptions {
  readonly rpcUrl: string;
  readonly key: SecretKey;
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
  /** Per RPC request; the attester's own backoff does the retrying. */
  readonly requestTimeoutMs?: number;
  /** How long `feedbackOutcome` waits for a receipt. */
  readonly receiptTimeoutMs?: number;
  /** The widest block range asked of `eth_getLogs` at once (`ERC8004_LOG_RANGE`; default `DEFAULT_LOG_RANGE`). */
  readonly logRange?: bigint;
  /** Overrides the clients (tests against a local node). */
  readonly clients?: { readonly publicClient: PublicClient; readonly walletClient: WalletClient };
}

/**
 * The reputation chain client over viem, on Arbitrum Sepolia. It refuses to do
 * anything against an RPC endpoint of another chain. The RPC URL and the key
 * never appear in what it throws to callers that log only error names and codes
 * (`describeError`).
 */
export function viemReputationChain(options: ViemReputationChainOptions): ReputationChain {
  const account = privateKeyToAccount(options.key.reveal());
  const attester = toAddress(account.address);
  const transport = http(options.rpcUrl, { timeout: options.requestTimeoutMs ?? 10_000, retryCount: 0 });
  const publicClient = options.clients?.publicClient ?? createPublicClient({ chain: arbitrumSepolia, transport });
  const walletClient: WalletClient = options.clients?.walletClient ?? createWalletClient({ account, chain: arbitrumSepolia, transport });
  const logRange = options.logRange ?? DEFAULT_LOG_RANGE;
  const identity = { address: options.identityRegistry as Hex, abi: identityRegistryAbi } as const;
  const reputation = { address: options.reputationRegistry as Hex, abi: reputationRegistryAbi } as const;

  let chainChecked: Promise<void> | undefined;
  const onChain = () => {
    chainChecked ??= publicClient.getChainId().then((id) => {
      if (id !== arbitrumSepolia.id) throw new WrongChainError(`the RPC endpoint serves chain ${id}, not Arbitrum Sepolia`);
    });
    // A failed check (the node was down) is tried again next time; a wrong chain stays refused.
    chainChecked.catch((error: unknown) => {
      if (!(error instanceof WrongChainError)) chainChecked = undefined;
    });
    return chainChecked;
  };

  return {
    attester,
    identityRegistry: toAddress(options.identityRegistry),

    async blockNumber() {
      await onChain();
      return publicClient.getBlockNumber({ cacheTime: 0 });
    },

    async giveFeedback(r, { notAfter, clock, nonce }) {
      await onChain();
      const args = [r.agentId, r.value, r.valueDecimals, r.tag1, r.tag2, r.endpoint, r.feedbackURI, r.feedbackHash as Hex] as const;
      // Simulated first, so a revert costs no gas and is reported as a revert.
      await publicClient.simulateContract({ ...reputation, account, functionName: "giveFeedback", args });
      // viem's writeContract steps, taken one by one so the deadline is checked after the slow part (nonce, fees and
      // gas from the RPC) and right before the broadcast, the one step after which the transaction may be out.
      const data = encodeFunctionData({ abi: reputationRegistryAbi, functionName: "giveFeedback", args });
      const prepared = await walletClient.prepareTransactionRequest({
        account,
        chain: publicClient.chain ?? arbitrumSepolia,
        to: reputation.address,
        data,
        type: "eip1559",
        ...(nonce === undefined ? {} : { nonce }),
      });
      const serializedTransaction = await account.signTransaction({
        type: "eip1559",
        chainId: prepared.chainId,
        nonce: prepared.nonce,
        to: reputation.address,
        data,
        gas: prepared.gas,
        maxFeePerGas: prepared.maxFeePerGas,
        maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
      });
      if (clock().getTime() >= notAfter.getTime()) throw new SendDeadlineError();
      const hash = await walletClient.sendRawTransaction({ serializedTransaction });
      return hash.toLowerCase() as Hex32;
    },

    async feedbackOutcome(txHash) {
      await onChain();
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: options.receiptTimeoutMs ?? 30_000 });
        return receipt.status === "success" ? "success" : "reverted";
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) return "unknown";
        throw error;
      }
    },

    async receiptStatus(txHash) {
      await onChain();
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
        return receipt.status === "success" ? "success" : "reverted";
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return "unknown";
        throw error;
      }
    },

    async findFeedback({ agentId, feedbackHash, fromBlock }) {
      await onChain();
      const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
      for (let from = fromBlock; from <= latest; from += logRange) {
        const to = from + logRange - 1n < latest ? from + logRange - 1n : latest;
        const logs = await publicClient.getContractEvents({
          ...reputation,
          eventName: "NewFeedback",
          args: { agentId, clientAddress: attester as Hex },
          fromBlock: from,
          toBlock: to,
          strict: true,
        });
        const hit = logs.find((log) => log.args.feedbackHash.toLowerCase() === feedbackHash && !log.removed);
        if (hit !== undefined) return hit.transactionHash.toLowerCase() as Hex32;
      }
      return undefined;
    },

    async nonces() {
      await onChain();
      const [pending, mined] = await Promise.all([
        publicClient.getTransactionCount({ address: attester as Hex, blockTag: "pending" }),
        publicClient.getTransactionCount({ address: attester as Hex, blockTag: "latest" }),
      ]);
      return { pending, mined };
    },

    async summary({ agentId, tag1, tag2 }) {
      await onChain();
      const [count, value, decimals] = await publicClient.readContract({ ...reputation, functionName: "getSummary", args: [agentId, [attester as Hex], tag1, tag2] });
      return { count, value, decimals };
    },

    async controlsAgent(agentId, address) {
      await onChain();
      let owner: string;
      let wallet: string;
      try {
        [owner, wallet] = await Promise.all([
          publicClient.readContract({ ...identity, functionName: "ownerOf", args: [agentId] }),
          publicClient.readContract({ ...identity, functionName: "getAgentWallet", args: [agentId] }),
        ]);
      } catch (error) {
        // An agent that does not exist reverts (ERC721NonexistentToken): nobody controls it.
        if (isRevert(error)) return false;
        throw error;
      }
      return owner.toLowerCase() === address || wallet.toLowerCase() === address;
    },

    async feedbackRefusal(agentId) {
      await onChain();
      try {
        const authorized = await publicClient.readContract({ ...identity, functionName: "isAuthorizedOrOwner", args: [attester as Hex, agentId] });
        return authorized ? "SELF_FEEDBACK" : undefined;
      } catch (error) {
        // An agent that does not exist reverts (ERC721NonexistentToken); anything else is the node's failure.
        if (refusalOf(error) === "NO_SUCH_AGENT") return "NO_SUCH_AGENT";
        throw error;
      }
    },
  };
}
