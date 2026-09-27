import { type Address, type Hex32, acceptanceRecipeDigest, deriveResolutionId } from "@lemma/core";

import { ContractFunctionRevertedError, encodeErrorResult } from "viem";

import {
  type ChainSummary,
  ERC8004_ARBITRUM_SEPOLIA,
  type FeedbackRefusal,
  type FeedbackRequest,
  type FinalizedOutcome,
  type ReputationChain,
  SendDeadlineError,
  type SendOptions,
  reputationRegistryAbi,
} from "../src/index.js";
import { sellableIndex } from "./helpers.js";

export const ATTESTER = "0x00000000000000000000000000000000000000f1";
export const PROVIDER_AGENT = "7";
export const BUYER_AGENT = "42";

export interface FakeLog {
  readonly agentId: bigint;
  readonly client: Address;
  readonly request: FeedbackRequest;
  readonly txHash: Hex32;
  readonly block: bigint;
}

/** A broadcast transaction of the attester that is not mined yet. */
export interface FakeTx {
  readonly nonce: number;
  readonly request: FeedbackRequest;
  readonly txHash: Hex32;
  /** Once mined, it reverts and posts nothing. */
  readonly reverts: boolean;
}

/**
 * An in-memory ERC-8004 reputation registry behind the ReputationChain
 * interface: sends become NewFeedback logs (mined at once, or held in a
 * mempool until `mine()`), and every call is counted. Nonces work as on a real
 * chain: transactions are mined in nonce order, one with the nonce of a waiting
 * transaction replaces it, and one with a used nonce is refused.
 */
export class FakeChain implements ReputationChain {
  block = 1000n;
  readonly logs: FakeLog[] = [];
  readonly mempool: FakeTx[] = [];
  /** Every giveFeedback that was broadcast. */
  readonly sends: FeedbackRequest[] = [];
  /** Throw a transport error on the next N sends, before anything is broadcast. */
  failSends = 0;
  /** Mine a send at once; otherwise it waits in the mempool. */
  mineOnSend = true;
  /** Mine the next N sends as reverted (no log). */
  revertSends = 0;
  /** The attester's transactions mined so far, reverted ones included: its next nonce. */
  minedNonce = 0;
  /**
   * Whether the node counts the attester's unmined transactions in its pending
   * nonce. Arbitrum's nodes forward transactions to the sequencer and keep no
   * mempool, so they do not.
   */
  pendingVisible = true;
  /** Runs right after each log search: a transaction mined while the attester was looking. */
  afterSearch: (() => void) | undefined;
  readonly reverted = new Set<Hex32>();
  readonly owners = new Map<bigint, Address>();
  readonly wallets = new Map<bigint, Address>();
  /** Per agent, the address its owner approved (ERC-721 `approve`). */
  readonly approvals = new Map<bigint, Address>();
  /** Per owner, the operators it approved for all its agents (ERC-721 `setApprovalForAll`). */
  readonly operators = new Map<Address, Set<Address>>();
  /** Agents that do not exist: the registries revert with ERC721NonexistentToken for them. */
  readonly missingAgents = new Set<bigint>();
  readonly summaries = new Map<string, ChainSummary>();
  summaryCalls = 0;
  failSummaries = false;
  /** A chain that never answers a summary (a stalled RPC). */
  hangSummaries = false;
  /** How long a summary read takes (timer time, so fake timers drive it). */
  summaryDelayMs = 0;
  down = false;
  private txCounter = 0;
  private held: { readonly reached: () => void; readonly gate: Promise<void> } | undefined;

  /** Another attester key, or another identity registry, than the defaults: as after a key rotation or a registry change. */
  constructor(
    readonly attester: Address = ATTESTER,
    readonly identityRegistry: Address = ERC8004_ARBITRUM_SEPOLIA.identityRegistry,
  ) {}

  /**
   * Holds the next send before it is broadcast (a slow RPC): `reached` resolves
   * once the send is waiting, and `release` lets it go on.
   */
  holdNextSend(): { readonly reached: Promise<void>; readonly release: () => void } {
    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    this.held = { reached, gate };
    return { reached: reachedPromise, release };
  }

  private up(): void {
    if (this.down) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
  }

  async blockNumber(): Promise<bigint> {
    this.up();
    return this.block;
  }

  async giveFeedback(request: FeedbackRequest, options: SendOptions): Promise<Hex32> {
    this.up();
    if (this.failSends > 0) {
      this.failSends--;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    // The simulation: the registry's own refusals, before anything is sent.
    const refusal = this.refusalFor(request.agentId);
    if (refusal !== undefined) throw registryRevert(refusal, request.agentId);
    const held = this.held;
    this.held = undefined;
    if (held !== undefined) {
      held.reached();
      await held.gate;
    }
    // Like the viem client: the last check before the broadcast, after which the transaction may be out, on the clock
    // that set the deadline (the attester's).
    if (options.clock().getTime() >= options.notAfter.getTime()) throw new SendDeadlineError();
    // The nonce asked for, else the node's pending count, as viem reads it.
    const nonce = options.nonce ?? this.pendingNonce();
    if (nonce < this.minedNonce) throw Object.assign(new Error("nonce too low"), { name: "NonceTooLowError" });
    this.sends.push(request);
    const txHash = `0x${(++this.txCounter).toString(16).padStart(64, "0")}` as Hex32;
    const replaced = this.mempool.findIndex((t) => t.nonce === nonce);
    if (replaced >= 0) this.mempool.splice(replaced, 1);
    this.mempool.push({ nonce, request, txHash, reverts: this.revertSends > 0 });
    if (this.revertSends > 0) this.revertSends--;
    if (this.mineOnSend) this.mine();
    return txHash;
  }

  /** Mines the waiting transactions in nonce order, up to the first gap. */
  mine(): void {
    this.block++;
    for (let tx = this.nextToMine(); tx !== undefined; tx = this.nextToMine()) {
      this.mempool.splice(this.mempool.indexOf(tx), 1);
      this.minedNonce++;
      if (tx.reverts) this.reverted.add(tx.txHash);
      else this.logs.push({ agentId: tx.request.agentId, client: this.attester, request: tx.request, txHash: tx.txHash, block: this.block });
    }
  }

  private nextToMine(): FakeTx | undefined {
    return this.mempool.find((t) => t.nonce === this.minedNonce);
  }

  private pendingNonce(): number {
    return this.pendingVisible ? this.minedNonce + this.mempool.length : this.minedNonce;
  }

  async feedbackOutcome(txHash: Hex32): Promise<"success" | "reverted" | "unknown"> {
    this.up();
    if (this.reverted.has(txHash)) return "reverted";
    return this.logs.some((l) => l.txHash === txHash) ? "success" : "unknown";
  }

  async receiptStatus(txHash: Hex32): Promise<"success" | "reverted" | "unknown"> {
    return this.feedbackOutcome(txHash);
  }

  /** An RPC node whose log index lags behind its receipts. */
  logsLag = false;

  async findFeedback(query: { agentId: bigint; feedbackHash: Hex32; fromBlock: bigint }): Promise<Hex32 | undefined> {
    this.up();
    const hit = this.logsLag
      ? undefined
      : this.logs.find((l) => l.agentId === query.agentId && l.client === this.attester && l.request.feedbackHash === query.feedbackHash && l.block >= query.fromBlock)?.txHash;
    this.afterSearch?.();
    return hit;
  }

  async nonces(): Promise<{ pending: number; mined: number }> {
    this.up();
    return { pending: this.pendingNonce(), mined: this.minedNonce };
  }

  async summary(query: { agentId: bigint; tag1: string; tag2: string }): Promise<ChainSummary> {
    this.summaryCalls++;
    if (this.hangSummaries) return new Promise(() => undefined);
    if (this.summaryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.summaryDelayMs));
    if (this.failSummaries) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
    return this.summaries.get(`${query.agentId}/${query.tag1}/${query.tag2}`) ?? { count: 0n, value: 0n, decimals: 0 };
  }

  async controlsAgent(agentId: bigint, address: Address): Promise<boolean> {
    this.up();
    if (this.missingAgents.has(agentId)) return false;
    return this.owners.get(agentId) === address || this.wallets.get(agentId) === address;
  }

  async feedbackRefusal(agentId: bigint): Promise<FeedbackRefusal | undefined> {
    this.up();
    return this.refusalFor(agentId);
  }

  /** The reputation registry's rule: no feedback to an agent that does not exist, nor from its owner or anyone it approved. */
  private refusalFor(agentId: bigint): FeedbackRefusal | undefined {
    if (this.missingAgents.has(agentId)) return "NO_SUCH_AGENT";
    const owner = this.owners.get(agentId);
    const authorized = owner === this.attester || this.approvals.get(agentId) === this.attester || (owner !== undefined && (this.operators.get(owner)?.has(this.attester) ?? false));
    return authorized ? "SELF_FEEDBACK" : undefined;
  }

  /** Feedback posted to an agent, from the logs. */
  postedTo(agentId: string): FakeLog[] {
    return this.logs.filter((l) => l.agentId === BigInt(agentId));
  }
}

/** The revert a simulated `giveFeedback` meets, as viem reports it from the official registry. */
export function registryRevert(refusal: FeedbackRefusal, agentId: bigint): ContractFunctionRevertedError {
  const data =
    refusal === "SELF_FEEDBACK"
      ? encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], errorName: "Error", args: ["Self-feedback not allowed"] })
      : encodeErrorResult({ abi: reputationRegistryAbi, errorName: "ERC721NonexistentToken", args: [agentId] });
  return new ContractFunctionRevertedError({ abi: reputationRegistryAbi, data, functionName: "giveFeedback" });
}

/** A finalized outcome for the sellable test release, as the outcome pipeline would feed it. */
export function outcomeFor(previewId: Hex32, buyer: Address, over: Partial<FinalizedOutcome> = {}): FinalizedOutcome {
  const entry = sellableIndex().releases[0];
  if (entry === undefined) throw new Error("no sellable release");
  return {
    resolutionId: deriveResolutionId(previewId, buyer),
    releaseDigest: entry.releaseDigest,
    releaseId: entry.release.releaseId,
    version: entry.release.version,
    profileIndex: 0,
    capability: entry.release.capability,
    verdict: "passed",
    acceptanceRecipeDigest: acceptanceRecipeDigest(entry.release.acceptanceRecipe),
    acceptance: { exitCode: 0, durationMs: 41_250, outputDigest: `0x${"88".repeat(32)}` },
    registry: { chainId: 421614, address: "0x00000000000000000000000000000000000000e1" },
    buyerAgentId: null,
    finalizedAt: "2026-10-01T01:00:00.000Z",
    ...over,
  };
}
