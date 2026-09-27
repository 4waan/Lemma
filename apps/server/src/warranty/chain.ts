import {
  type Address,
  type Hex32,
  type WarrantyOutcome,
  type WarrantyRegistryRef,
  type WarrantyVoucher,
  toAddress,
  warrantyOutcomeTypedData,
  warrantyVoucherTypedData,
} from "@lemma/core";
import {
  type Account,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type Transport,
  WaitForTransactionReceiptTimeoutError,
  type WalletClient,
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  numberToHex,
} from "viem";
import type { LocalAccount } from "viem/accounts";

import type { ChainHead } from "../payments/chain.js";
import type { RegistryEventRow } from "../persistence.js";
import { SendDeadlineError, WrongChainError } from "../reputation/chain.js";
import { warrantyRegistryAbi } from "./abi.js";

/**
 * Who sends a registry call and pays its gas. The provider activates (its
 * voucher reserves its bond) and expires (it gets its bond back); the
 * evaluator finalizes (its outcome) and relays credit withdrawals. The
 * facilitator, which settles payments, sends none of them: its transaction
 * order would put a buyer's settlement next to the activation it paid for.
 */
export type WarrantySender = "provider" | "evaluator";

/** One registry call the pipeline sends. */
export type RegistryCall =
  | { readonly fn: "activateResolution"; readonly voucher: WarrantyVoucher; readonly signature: Hex }
  | { readonly fn: "finalizeOutcome"; readonly outcome: WarrantyOutcome; readonly signature: Hex }
  | { readonly fn: "expireResolution"; readonly resolutionId: Hex32 }
  | { readonly fn: "withdrawCredit"; readonly resolutionId: Hex32; readonly claimSecret: Hex32; readonly to: Address };

/** Which sender sends each call: fixed here, so no job can send one from the wrong key. */
export const SENDER_OF: { readonly [F in RegistryCall["fn"]]: WarrantySender } = {
  activateResolution: "provider",
  expireResolution: "provider",
  finalizeOutcome: "evaluator",
  withdrawCredit: "evaluator",
};

/** The registry's `Status` enum, in order: `none` is never activated. */
export const REGISTRY_STATUSES = ["none", "active", "passed", "failed", "refunded", "voided", "expired"] as const;

export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

/** `release(digest)`: `provider` is the zero address for a release that was never registered. */
export interface RegistryRelease {
  readonly provider: Address;
  readonly evaluator: Address;
  readonly claimWindowSeconds: number;
  readonly active: boolean;
  readonly available: bigint;
  readonly reserved: bigint;
}

/** `resolution(id)` with `claimDeadlineOf(id)`: the deadline in force, which pauses move later (0 unless active). */
export interface RegistryResolution {
  readonly status: RegistryStatus;
  readonly releaseDigest: Hex32;
  readonly profileIndex: number;
  readonly amount: bigint;
  readonly claimDeadline: bigint;
}

/** A registry log as read, decoded into the row the indexer stores; `removed` marks a log a reorg took back. */
export interface RegistryLog extends RegistryEventRow {
  readonly removed: boolean;
}

export type TxStatus = "success" | "reverted" | "unknown";

/** How a registry transaction is sent (mirrors the attester's `SendOptions`). */
export interface RegistrySendOptions {
  /**
   * The last instant it may be broadcast, on `clock`: a send still under way
   * then gives up before broadcasting (`SendDeadlineError`), so it never goes
   * out after the job's claim on its action has lapsed.
   */
  readonly notAfter: Date;
  /** The clock `notAfter` is read on: the job's own, which set it from the claim. */
  readonly clock: () => Date;
  /** The nonce to send with (a resend's, read before the checks); by default the sender's nonce manager's next one. */
  readonly nonce?: number | undefined;
}

/**
 * Every chain call the outcome pipeline makes, behind one small interface
 * like track C's `PaymentChain` and track F's `ReputationChain`, so jobs are
 * tested without a chain (a fake registry) and run against the real one
 * (`viemWarrantyChain`). It holds the provider's and the evaluator's keys and
 * signs with them; nothing outside it sees a key.
 */
export interface WarrantyChain {
  readonly chainId: number;
  /** The registry's address (the EIP-712 `verifyingContract`). */
  readonly registry: Address;
  /** The provider's address: the voucher signer and the sender of activations and expiries. */
  readonly provider: Address;
  /** The evaluator's address: the outcome signer and the sender of finalizations and withdrawals. */
  readonly evaluator: Address;
  /** The latest block: its number and its timestamp, the chain's clock for every deadline. */
  head(): Promise<ChainHead>;
  /**
   * The registry's logs of the events the indexer keeps, in `[fromBlock,
   * toBlock]`, in chain order, each with its block's timestamp. A range the
   * RPC node refuses (too wide) rejects with its JSON-RPC error, whose numeric
   * `code` the indexer reads to halve the range.
   */
  registryLogs(fromBlock: bigint, toBlock: bigint): Promise<RegistryLog[]>;
  release(releaseDigest: Hex32): Promise<RegistryRelease>;
  /** The resolution and its claim deadline in force, both read at one block. */
  resolution(resolutionId: Hex32): Promise<RegistryResolution>;
  /** The provider's EIP-712 signature over a voucher, under this registry's domain. */
  signVoucher(voucher: WarrantyVoucher): Promise<Hex>;
  /** The evaluator's EIP-712 signature over an outcome, under this registry's domain. */
  signOutcome(outcome: WarrantyOutcome): Promise<Hex>;
  /**
   * Simulates the call from its sender (`SENDER_OF`), then signs and
   * broadcasts it; resolves with the transaction hash once broadcast. A
   * revert is thrown as viem reports it, with the registry's custom error
   * (`registryRevertOf`). Sends from one sender go out one at a time.
   */
  send(call: RegistryCall, options: RegistrySendOptions): Promise<Hex32>;
  /** A transaction's receipt without waiting: success, reverted, or unknown (not mined, or unknown to the node). */
  receiptStatus(txHash: Hex32): Promise<TxStatus>;
  /** Waits a bounded time for a transaction's receipt. */
  waitForReceipt(txHash: Hex32): Promise<TxStatus>;
  /** A sender's transaction counts: `mined` (the latest block's, its next nonce) and `pending` (with unmined ones the node knows of). */
  nonces(sender: WarrantySender): Promise<{ readonly pending: number; readonly mined: number }>;
  /**
   * The registry's own `usdc()`, and its `hashVoucher(voucher)`: the startup
   * check that the address is the registry the server signs for (its
   * EIP-712 domain and layout give the digest core computes) on this token.
   */
  registryIdentity(voucher: WarrantyVoucher): Promise<{ readonly usdc: Address; readonly voucherDigest: Hex32 }>;
}

/** A registry revert, by its custom error: a code for logs and the outbox, the error's name, and its arguments. */
export interface RegistryRevert {
  /** The custom error's name in upper snake case (`INSUFFICIENT_AVAILABLE_BOND`), or `REVERT` for one the ABI does not name. */
  readonly code: string;
  readonly name: string | undefined;
  readonly args: readonly unknown[];
}

/** `InsufficientAvailableBond` as `INSUFFICIENT_AVAILABLE_BOND`. */
export function errorCodeOf(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** The registry revert a viem error carries (a simulation or a mined call), or undefined when the error is not a revert. */
export function registryRevertOf(error: unknown): RegistryRevert | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  const name = revert.data?.errorName;
  return { code: name === undefined ? "REVERT" : errorCodeOf(name), name, args: revert.data?.args ?? [] };
}

/** The indexed events: what the indexer asks the RPC node for, by topic. */
export const INDEXED_EVENTS = ["ResolutionActivated", "OutcomeFinalized", "EngineRecordFailed", "ResolutionExpired", "CreditWithdrawn", "EngineSet", "Paused", "Unpaused"] as const;

const EVENT_TOPICS = INDEXED_EVENTS.map((eventName) => encodeEventTopics({ abi: warrantyRegistryAbi, eventName })[0] as Hex);

/** A raw log as `eth_getLogs` answers it. */
export interface RawLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex | null;
  readonly logIndex: Hex | null;
  readonly transactionHash: Hex | null;
  readonly removed?: boolean;
  readonly blockTimestamp?: Hex | undefined;
}

/**
 * Decodes one registry log into its row, with `blockTime` from its block.
 * Undefined for a log that is not one of the indexed events, or not mined.
 */
export function decodeRegistryLog(log: RawLog, blockTime: Date): RegistryLog | undefined {
  if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) return undefined;
  let decoded: ReturnType<typeof decodeEventLog<typeof warrantyRegistryAbi>>;
  try {
    decoded = decodeEventLog({ abi: warrantyRegistryAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  } catch {
    return undefined;
  }
  const base = {
    blockNumber: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex)),
    txHash: log.transactionHash.toLowerCase() as Hex32,
    blockTime,
    removed: log.removed === true,
    resolutionId: null,
    releaseDigest: null,
    profileIndex: null,
    verdict: null,
    weightBps: null,
    evidenceHash: null,
    amount: null,
    claimDeadline: null,
    engine: null,
  };
  const hex32 = (v: Hex) => v.toLowerCase() as Hex32;
  switch (decoded.eventName) {
    case "ResolutionActivated": {
      const a = decoded.args;
      // The payment reference is deliberately dropped: it is never stored.
      return { ...base, name: "ResolutionActivated", resolutionId: hex32(a.resolutionId), releaseDigest: hex32(a.releaseDigest), profileIndex: a.profileIndex, amount: a.amount.toString(), claimDeadline: a.claimDeadline };
    }
    case "OutcomeFinalized": {
      const a = decoded.args;
      return { ...base, name: "OutcomeFinalized", resolutionId: hex32(a.resolutionId), releaseDigest: hex32(a.releaseDigest), verdict: a.verdict, weightBps: a.weightBps, evidenceHash: hex32(a.evidenceHash) };
    }
    case "EngineRecordFailed":
      return { ...base, name: "EngineRecordFailed", resolutionId: hex32(decoded.args.resolutionId) };
    case "ResolutionExpired": {
      const a = decoded.args;
      return { ...base, name: "ResolutionExpired", resolutionId: hex32(a.resolutionId), releaseDigest: hex32(a.releaseDigest), amount: a.amount.toString() };
    }
    case "CreditWithdrawn":
      return { ...base, name: "CreditWithdrawn", resolutionId: hex32(decoded.args.resolutionId), amount: decoded.args.amount.toString() };
    case "EngineSet":
      return { ...base, name: "EngineSet", engine: toAddress(decoded.args.newEngine) };
    case "Paused":
      return { ...base, name: "Paused" };
    case "Unpaused":
      return { ...base, name: "Unpaused" };
    default:
      return undefined;
  }
}

export interface ViemWarrantyChainOptions {
  readonly publicClient: PublicClient;
  /** The provider's and the evaluator's wallet clients on the same chain, each with a local account whose nonce manager all of its sends share. */
  readonly providerWallet: WalletClient<Transport, Chain, Account>;
  readonly evaluatorWallet: WalletClient<Transport, Chain, Account>;
  readonly registry: Address;
  /** The one chain the pipeline works on; an RPC endpoint of another is refused. */
  readonly chainId: number;
  /** How long `waitForReceipt` waits (default 30 s). */
  readonly receiptTimeoutMs?: number;
  /** Block timestamps read at once while decoding a range's logs (default 8). */
  readonly blockReadConcurrency?: number;
}

/**
 * `WarrantyChain` over viem. Each sender's sends go out one at a time, and
 * take their nonce from the sender account's nonce manager (shared by every
 * job that sends from it) unless a resend names one; a send that fails after
 * a nonce was taken resets the manager, so no gap is left. Gas is the node's
 * estimate plus a fifth: `finalizeOutcome` refuses to start the engine's call
 * without its full budget (`InsufficientGasForEngine`). Errors keep only what
 * viem reports; callers log their names and codes, never messages (which can
 * quote call arguments, a claim secret among them).
 */
export function viemWarrantyChain(options: ViemWarrantyChainOptions): WarrantyChain {
  const { publicClient } = options;
  const registry = toAddress(options.registry);
  const ref: WarrantyRegistryRef = { chainId: options.chainId, registry };
  const contract = { address: registry as Hex, abi: warrantyRegistryAbi } as const;
  const wallets = { provider: options.providerWallet, evaluator: options.evaluatorWallet } as const;
  const accountOf = (sender: WarrantySender) => wallets[sender].account as LocalAccount;
  const concurrency = Math.max(1, options.blockReadConcurrency ?? 8);

  let chainChecked: Promise<void> | undefined;
  const onChain = () => {
    chainChecked ??= publicClient.getChainId().then((id) => {
      if (id !== options.chainId) throw new WrongChainError(`the RPC endpoint serves chain ${id}, not ${options.chainId}`);
    });
    // A failed check (the node was down) is tried again next time; a wrong chain stays refused.
    chainChecked.catch((error: unknown) => {
      if (!(error instanceof WrongChainError)) chainChecked = undefined;
    });
    return chainChecked;
  };

  // One send at a time per sender: a resend's explicit nonce and the nonce manager never race within this process.
  const queues: Record<WarrantySender, Promise<unknown>> = { provider: Promise.resolve(), evaluator: Promise.resolve() };
  const serially = <T>(sender: WarrantySender, task: () => Promise<T>): Promise<T> => {
    const run = queues[sender].then(task, task);
    queues[sender] = run.catch(() => undefined);
    return run;
  };

  const callData = (call: RegistryCall) => {
    switch (call.fn) {
      case "activateResolution":
        return { functionName: call.fn, args: [warrantyVoucherTypedData(call.voucher, ref).message, call.signature] } as const;
      case "finalizeOutcome":
        return { functionName: call.fn, args: [warrantyOutcomeTypedData(call.outcome, ref).message, call.signature] } as const;
      case "expireResolution":
        return { functionName: call.fn, args: [call.resolutionId as Hex] } as const;
      case "withdrawCredit":
        return { functionName: call.fn, args: [call.resolutionId as Hex, call.claimSecret as Hex, call.to as Hex] } as const;
    }
  };

  return {
    chainId: options.chainId,
    registry,
    provider: toAddress(accountOf("provider").address),
    evaluator: toAddress(accountOf("evaluator").address),

    async head() {
      await onChain();
      const latest = await publicClient.getBlock({ blockTag: "latest" });
      return { number: latest.number, timestamp: new Date(Number(latest.timestamp) * 1000) };
    },

    async registryLogs(fromBlock, toBlock) {
      await onChain();
      const raw = (await publicClient.request({
        method: "eth_getLogs",
        params: [{ address: registry as Hex, topics: [EVENT_TOPICS], fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
      })) as unknown as readonly RawLog[];
      // Block timestamps: from the log when the node includes them, else read once per block.
      const times = new Map<bigint, Date>();
      const missing: bigint[] = [];
      for (const log of raw) {
        if (log.blockNumber === null) continue;
        const n = BigInt(log.blockNumber);
        if (log.blockTimestamp !== undefined) times.set(n, new Date(Number(BigInt(log.blockTimestamp)) * 1000));
        else if (!times.has(n) && !missing.includes(n)) missing.push(n);
      }
      for (let i = 0; i < missing.length; i += concurrency) {
        const blocks = await Promise.all(missing.slice(i, i + concurrency).map((blockNumber) => publicClient.getBlock({ blockNumber })));
        for (const block of blocks) times.set(block.number, new Date(Number(block.timestamp) * 1000));
      }
      const logs: RegistryLog[] = [];
      for (const log of raw) {
        if (log.blockNumber === null || log.address.toLowerCase() !== registry) continue;
        const time = times.get(BigInt(log.blockNumber));
        if (time === undefined) continue;
        const decoded = decodeRegistryLog(log, time);
        if (decoded !== undefined) logs.push(decoded);
      }
      return logs.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
    },

    async release(releaseDigest) {
      await onChain();
      const r = await publicClient.readContract({ ...contract, functionName: "release", args: [releaseDigest as Hex] });
      return {
        provider: toAddress(r.provider),
        evaluator: toAddress(r.evaluator),
        claimWindowSeconds: r.claimWindowSeconds,
        active: r.active,
        available: r.available,
        reserved: r.reserved,
      };
    },

    async resolution(resolutionId) {
      await onChain();
      // Both at one block: `claimDeadlineOf` is 0 unless the resolution is active, and two reads at `latest` can reach
      // two nodes of a load-balanced endpoint, pairing an active warranty with no deadline (a finalization would then be
      // closed as past its window for nothing). A node that has not got the block yet fails the read, and the job retries.
      const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
      const [r, deadline] = await Promise.all([
        publicClient.readContract({ ...contract, functionName: "resolution", args: [resolutionId as Hex], blockNumber }),
        publicClient.readContract({ ...contract, functionName: "claimDeadlineOf", args: [resolutionId as Hex], blockNumber }),
      ]);
      const status = REGISTRY_STATUSES[r.status];
      if (status === undefined) throw new RangeError(`unknown registry status ${r.status}`);
      return { status, releaseDigest: r.releaseDigest.toLowerCase() as Hex32, profileIndex: r.profileIndex, amount: r.amount, claimDeadline: deadline };
    },

    signVoucher: (voucher) => accountOf("provider").signTypedData(warrantyVoucherTypedData(voucher, ref)),
    signOutcome: (outcome) => accountOf("evaluator").signTypedData(warrantyOutcomeTypedData(outcome, ref)),

    send(call, { notAfter, clock, nonce }) {
      const sender = SENDER_OF[call.fn];
      return serially(sender, async () => {
        await onChain();
        const wallet = wallets[sender];
        const account = accountOf(sender);
        const { functionName, args } = callData(call);
        // Simulated first, so a revert costs no gas and comes back decoded.
        await publicClient.simulateContract({ ...contract, account, functionName, args } as Parameters<PublicClient["simulateContract"]>[0]);
        const data = encodeFunctionData({ abi: warrantyRegistryAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
        const managed = nonce === undefined && account.nonceManager !== undefined;
        try {
          const prepared = await wallet.prepareTransactionRequest({
            account,
            chain: wallet.chain,
            to: registry as Hex,
            data,
            type: "eip1559",
            ...(nonce === undefined ? { nonceManager: account.nonceManager } : { nonce }),
          } as Parameters<typeof wallet.prepareTransactionRequest>[0]);
          const gas = (prepared.gas as bigint) + (prepared.gas as bigint) / 5n;
          const serializedTransaction = await account.signTransaction({
            type: "eip1559",
            chainId: options.chainId,
            nonce: prepared.nonce as number,
            to: registry as Hex,
            data,
            gas,
            maxFeePerGas: prepared.maxFeePerGas as bigint,
            maxPriorityFeePerGas: prepared.maxPriorityFeePerGas as bigint,
          });
          if (clock().getTime() >= notAfter.getTime()) throw new SendDeadlineError();
          const hash = await wallet.sendRawTransaction({ serializedTransaction });
          return hash.toLowerCase() as Hex32;
        } catch (error) {
          // The manager counted a nonce this send never used: forget it, so the next send reads the node again.
          if (managed) account.nonceManager?.reset({ address: account.address, chainId: options.chainId });
          throw error;
        }
      });
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

    async waitForReceipt(txHash) {
      await onChain();
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: options.receiptTimeoutMs ?? 30_000 });
        return receipt.status === "success" ? "success" : "reverted";
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) return "unknown";
        throw error;
      }
    },

    async registryIdentity(voucher) {
      await onChain();
      const [usdc, digest] = await Promise.all([
        publicClient.readContract({ ...contract, functionName: "usdc" }),
        publicClient.readContract({ ...contract, functionName: "hashVoucher", args: [warrantyVoucherTypedData(voucher, ref).message] }),
      ]);
      return { usdc: toAddress(usdc), voucherDigest: digest.toLowerCase() as Hex32 };
    },

    async nonces(sender) {
      await onChain();
      const address = accountOf(sender).address;
      const [pending, mined] = await Promise.all([
        publicClient.getTransactionCount({ address, blockTag: "pending" }),
        publicClient.getTransactionCount({ address, blockTag: "latest" }),
      ]);
      return { pending, mined };
    },
  };
}
