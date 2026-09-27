import {
  type Address,
  type Hex32,
  type WarrantyOutcome,
  type WarrantyOutcomeTypedData,
  type WarrantyVoucher,
  type WarrantyVoucherTypedData,
  toAddress,
  verdictCode,
  warrantyClaimHash,
  warrantyOutcomeTypedData,
  warrantyVoucherTypedData,
} from "@lemma/core";
import { ContractFunctionRevertedError, type Hex, encodeErrorResult, hashTypedData, keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  type ChainHead,
  type RegistryCall,
  type RegistryLog,
  type RegistryRelease,
  type RegistryResolution,
  type RegistrySendOptions,
  type RegistryStatus,
  SENDER_OF,
  SendDeadlineError,
  type TxStatus,
  type WarrantyChain,
  type WarrantySender,
  warrantyRegistryAbi,
} from "../src/index.js";

/** A registry address for tests. */
export const REGISTRY = "0x4c454d4d41000000000000000000000000000001";
/** Where the fake chain's clock starts: 2026-10-01T00:00:00Z. */
export const CHAIN_START = 1_790_812_800n;

const ZERO = "0x0000000000000000000000000000000000000000";

interface ReleaseState {
  provider: Address;
  evaluator: Address;
  claimWindowSeconds: number;
  active: boolean;
  available: bigint;
  reserved: bigint;
}

interface ResolutionState {
  releaseDigest: Hex32;
  claimHash: Hex32;
  amount: bigint;
  claimDeadline: bigint;
  profileIndex: number;
  status: RegistryStatus;
  pausedSecondsAtActivation: bigint;
}

interface Pending {
  readonly sender: Address;
  readonly nonce: number;
  readonly call: RegistryCall;
  readonly txHash: Hex32;
}

type EventFields = Omit<RegistryLog, "blockNumber" | "logIndex" | "txHash" | "blockTime" | "removed">;

const blank: Omit<EventFields, "name"> = {
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

/** The revert the registry answers with, as viem decodes it from the contract's ABI. */
export function registryError(functionName: string, errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  const data = encodeErrorResult({ abi: warrantyRegistryAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  return new ContractFunctionRevertedError({ abi: warrantyRegistryAbi, data, functionName });
}

/**
 * The warranty registry in memory, behind the `WarrantyChain` interface: the
 * contract's rules (contracts/src/ResolutionWarrantyRegistry.sol) in the
 * contract's order of checks, real EIP-712 signatures from keys made at run
 * time and checked against each release's provider and evaluator, the
 * compatibility engine hook, pauses that move claim deadlines, and one log per
 * event. Transactions are mined at once, or held until `mine()`, in nonce
 * order per sender; a transaction whose call reverts when mined is a reverted
 * receipt with no logs. The chain has its own clock (`now`, Unix seconds),
 * moved by `advance`.
 */
export class FakeRegistry implements WarrantyChain {
  readonly chainId = 421614;
  readonly registry: Address = REGISTRY;
  private readonly providerKey = generatePrivateKey();
  private readonly evaluatorKey = generatePrivateKey();
  readonly provider: Address = toAddress(privateKeyToAccount(this.providerKey).address);
  readonly evaluator: Address = toAddress(privateKeyToAccount(this.evaluatorKey).address);

  now = CHAIN_START;
  block = 100n;
  readonly releases = new Map<Hex32, ReleaseState>();
  readonly resolutions = new Map<Hex32, ResolutionState>();
  readonly paymentRefs = new Set<Hex32>();
  readonly logs: RegistryLog[] = [];
  readonly receipts = new Map<Hex32, "success" | "reverted">();
  /** Every broadcast transaction's call, by sender, in order. */
  readonly sent: Array<{ readonly sender: WarrantySender; readonly call: RegistryCall; readonly txHash: Hex32; readonly nonce: number }> = [];
  /** Outcomes the engine recorded: what the Stylus engine would hold. */
  readonly recorded: Array<{ engine: Address; releaseDigest: Hex32; profileIndex: number; passed: boolean; weightBps: number; at: bigint }> = [];
  engine: Address = ZERO;
  /** How the engine behaves: records the outcome, reverts, or has no code (both emit EngineRecordFailed). */
  engineBehavior: "records" | "reverts" | "no-code" = "records";
  paused = false;
  private pausedSettled = 0n;
  private pauseStartedAt = 0n;
  /** Throw a transport error on the next N sends, before anything is broadcast. */
  failSends = 0;
  /** Throw a transport error from every read while set. */
  down = false;
  /** Mine each send at once; otherwise it waits for `mine()`. */
  mineOnSend = true;
  /** Whether the node counts unmined transactions in a sender's pending nonce (Arbitrum's do not). */
  pendingVisible = true;
  /** The widest log range the node serves; wider ones are refused with a JSON-RPC error. */
  maxLogRange = 1_000_000n;
  /** Log ranges asked for, in order. */
  readonly logQueries: Array<readonly [bigint, bigint]> = [];
  /** Logs the node reports as removed (a reorg), returned alongside the live ones. */
  readonly removedLogs: RegistryLog[] = [];
  /**
   * How many blocks behind the head the node answering `eth_getLogs` is, as
   * one backend of a load-balanced endpoint can be: it answers a range past
   * its own head with the logs it has, and no error.
   */
  logsLag = 0n;
  private readonly mined = { provider: 0, evaluator: 0, other: 0 } as Record<WarrantySender | "other", number>;
  private readonly mempool: Pending[] = [];
  private txCounter = 0;
  private held: { readonly reached: () => void; readonly gate: Promise<void> } | undefined;

  // --- The owner's and the provider's setup, and time -------------------------------------------------------------

  registerRelease(releaseDigest: Hex32, over: Partial<Pick<ReleaseState, "provider" | "evaluator" | "claimWindowSeconds" | "active">> = {}): void {
    this.releases.set(releaseDigest, { provider: this.provider, evaluator: this.evaluator, claimWindowSeconds: 72 * 3600, active: true, available: 0n, reserved: 0n, ...over });
  }

  depositBond(releaseDigest: Hex32, amount: bigint): void {
    const r = this.releases.get(releaseDigest);
    if (r === undefined) throw new Error("unknown release");
    r.available += amount;
  }

  /** `setEngine` by the owner: a mined transaction with an `EngineSet` log. */
  setEngine(engine: Address, behavior: FakeRegistry["engineBehavior"] = "records"): void {
    this.engine = engine;
    this.engineBehavior = behavior;
    this.emitBlock([{ ...blank, name: "EngineSet", engine }]);
  }

  pause(): void {
    this.paused = true;
    this.pauseStartedAt = this.now;
    this.emitBlock([{ ...blank, name: "Paused" }]);
  }

  unpause(): void {
    this.paused = false;
    this.pausedSettled += this.now - this.pauseStartedAt;
    this.emitBlock([{ ...blank, name: "Unpaused" }]);
  }

  advance(seconds: number | bigint): void {
    this.now += BigInt(seconds);
  }

  /** Holds the next send before it is broadcast (a slow RPC): `reached` resolves once it waits, `release` lets it go on. */
  holdNextSend(): { readonly reached: Promise<void>; readonly release: () => void } {
    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    this.held = { reached, gate };
    return { reached: reachedPromise, release };
  }

  /** A transaction someone else sent and had mined (a relayer, or the buyer's own): the registry's rules apply as to anyone. */
  async relay(call: RegistryCall): Promise<Hex32> {
    const txHash = this.nextTxHash();
    const logs = await this.execute(call, { dryRun: false });
    this.block++;
    this.receipts.set(txHash, "success");
    this.pushLogs(txHash, logs);
    return txHash;
  }

  /** The provider's signed voucher, as the pipeline's key would sign it. */
  signVoucher(voucher: WarrantyVoucher): Promise<Hex> {
    return privateKeyToAccount(this.providerKey).signTypedData(warrantyVoucherTypedData(voucher, this));
  }

  signOutcome(outcome: WarrantyOutcome): Promise<Hex> {
    return privateKeyToAccount(this.evaluatorKey).signTypedData(warrantyOutcomeTypedData(outcome, this));
  }

  /** Mines the waiting transactions in nonce order per sender, up to each sender's first gap, in one new block. */
  async mine(): Promise<void> {
    this.block++;
    for (;;) {
      const next = this.mempool.find((t) => t.nonce === this.mined[this.senderOf(t.sender)]);
      if (next === undefined) break;
      this.mempool.splice(this.mempool.indexOf(next), 1);
      this.mined[this.senderOf(next.sender)]++;
      try {
        const logs = await this.execute(next.call, { dryRun: false });
        this.receipts.set(next.txHash, "success");
        this.pushLogs(next.txHash, logs);
      } catch {
        this.receipts.set(next.txHash, "reverted");
      }
    }
  }

  // --- WarrantyChain ------------------------------------------------------------------------------------------------

  async head(): Promise<ChainHead> {
    this.up();
    return { number: this.block, timestamp: new Date(Number(this.now) * 1000) };
  }

  async registryLogs(fromBlock: bigint, toBlock: bigint): Promise<RegistryLog[]> {
    this.up();
    this.logQueries.push([fromBlock, toBlock]);
    if (toBlock - fromBlock + 1n > this.maxLogRange) throw Object.assign(new Error("query exceeds max block range"), { code: -32005 });
    const known = this.block - this.logsLag;
    const inRange = (l: RegistryLog) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && l.blockNumber <= known;
    return [...this.logs.filter(inRange), ...this.removedLogs.filter(inRange)].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
  }

  async release(releaseDigest: Hex32): Promise<RegistryRelease> {
    this.up();
    const r = this.releases.get(releaseDigest);
    return r === undefined ? { provider: ZERO, evaluator: ZERO, claimWindowSeconds: 0, active: false, available: 0n, reserved: 0n } : { ...r };
  }

  async resolution(resolutionId: Hex32): Promise<RegistryResolution> {
    this.up();
    const r = this.resolutions.get(resolutionId);
    if (r === undefined) return { status: "none", releaseDigest: `0x${"00".repeat(32)}`, profileIndex: 0, amount: 0n, claimDeadline: 0n };
    return { status: r.status, releaseDigest: r.releaseDigest, profileIndex: r.profileIndex, amount: r.amount, claimDeadline: r.status === "active" ? this.deadlineOf(r) : 0n };
  }

  async send(call: RegistryCall, options: RegistrySendOptions): Promise<Hex32> {
    this.up();
    const sender = SENDER_OF[call.fn];
    if (this.failSends > 0) {
      this.failSends--;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    // The simulation: the registry's own refusals, before anything is sent.
    await this.execute(call, { dryRun: true });
    const held = this.held;
    this.held = undefined;
    if (held !== undefined) {
      held.reached();
      await held.gate;
    }
    if (options.clock().getTime() >= options.notAfter.getTime()) throw new SendDeadlineError();
    const address = sender === "provider" ? this.provider : this.evaluator;
    const nonce = options.nonce ?? this.pendingNonce(sender);
    if (nonce < this.mined[sender]) throw Object.assign(new Error("nonce too low"), { name: "NonceTooLowError" });
    const txHash = this.nextTxHash();
    const replaced = this.mempool.findIndex((t) => t.sender === address && t.nonce === nonce);
    if (replaced >= 0) this.mempool.splice(replaced, 1);
    this.mempool.push({ sender: address, nonce, call, txHash });
    this.sent.push({ sender, call, txHash, nonce });
    if (this.mineOnSend) await this.mine();
    return txHash;
  }

  async receiptStatus(txHash: Hex32): Promise<TxStatus> {
    this.up();
    return this.receipts.get(txHash) ?? "unknown";
  }

  async waitForReceipt(txHash: Hex32): Promise<TxStatus> {
    return this.receiptStatus(txHash);
  }

  async nonces(sender: WarrantySender): Promise<{ pending: number; mined: number }> {
    this.up();
    return { pending: this.pendingNonce(sender), mined: this.mined[sender] };
  }

  /** The token the registry holds, for the startup check; `identityDigestOverride` fakes a registry of another domain. */
  usdc: Address = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d";
  identityDigestOverride: Hex32 | undefined;

  async registryIdentity(voucher: WarrantyVoucher): Promise<{ usdc: Address; voucherDigest: Hex32 }> {
    this.up();
    return { usdc: this.usdc, voucherDigest: this.identityDigestOverride ?? (hashTypedData(warrantyVoucherTypedData(voucher, this)) as Hex32) };
  }

  // --- Helpers for tests ----------------------------------------------------------------------------------------------

  /** Sends of one registry function, in order. */
  sentOf(fn: RegistryCall["fn"]): RegistryCall[] {
    return this.sent.filter((s) => s.call.fn === fn).map((s) => s.call);
  }

  /** The claim deadline in force for an active resolution, as `claimDeadlineOf`. */
  deadlineOf(r: ResolutionState): bigint {
    return r.claimDeadline + (this.pausedSeconds() - r.pausedSecondsAtActivation);
  }

  status(resolutionId: Hex32): RegistryStatus {
    return this.resolutions.get(resolutionId)?.status ?? "none";
  }

  // --- The contract's rules --------------------------------------------------------------------------------------

  private pausedSeconds(): bigint {
    return this.pausedSettled + (this.paused ? this.now - this.pauseStartedAt : 0n);
  }

  /** Runs `call` against the registry's rules; throws its revert. With `dryRun`, changes nothing (a simulation). */
  private async execute(call: RegistryCall, { dryRun }: { readonly dryRun: boolean }): Promise<EventFields[]> {
    switch (call.fn) {
      case "activateResolution":
        return this.activate(call.voucher, call.signature, dryRun);
      case "finalizeOutcome":
        return this.finalize(call.outcome, call.signature, dryRun);
      case "expireResolution":
        return this.expire(call.resolutionId, dryRun);
      case "withdrawCredit":
        return this.withdraw(call.resolutionId, call.claimSecret, call.to, dryRun);
    }
  }

  private async activate(v: WarrantyVoucher, signature: Hex, dryRun: boolean): Promise<EventFields[]> {
    const fn = "activateResolution";
    if (this.paused) throw registryError(fn, "EnforcedPause");
    if (this.now > BigInt(v.activateBy)) throw registryError(fn, "VoucherExpired", [BigInt(v.activateBy)]);
    const r = this.releases.get(v.releaseDigest);
    if (r === undefined) throw registryError(fn, "UnknownRelease", [v.releaseDigest]);
    if (!r.active) throw registryError(fn, "ReleaseNotActive", [v.releaseDigest]);
    if (this.resolutions.has(v.resolutionId)) throw registryError(fn, "ResolutionAlreadyExists", [v.resolutionId]);
    if (this.paymentRefs.has(v.paymentRef)) throw registryError(fn, "PaymentRefAlreadyUsed", [v.paymentRef]);
    if ((await signerOf(warrantyVoucherTypedData(v, this), signature)) !== r.provider) throw registryError(fn, "InvalidProviderSignature");
    const amount = BigInt(v.amount);
    if (r.available < amount) throw registryError(fn, "InsufficientAvailableBond", [r.available, amount]);
    const claimDeadline = this.now + BigInt(r.claimWindowSeconds);
    if (!dryRun) {
      this.paymentRefs.add(v.paymentRef);
      r.available -= amount;
      r.reserved += amount;
      this.resolutions.set(v.resolutionId, {
        releaseDigest: v.releaseDigest,
        claimHash: v.claimHash,
        amount,
        claimDeadline,
        profileIndex: v.profileIndex,
        status: "active",
        pausedSecondsAtActivation: this.pausedSeconds(),
      });
    }
    return [{ ...blank, name: "ResolutionActivated", resolutionId: v.resolutionId, releaseDigest: v.releaseDigest, profileIndex: v.profileIndex, amount: v.amount, claimDeadline }];
  }

  private async finalize(o: WarrantyOutcome, signature: Hex, dryRun: boolean): Promise<EventFields[]> {
    const fn = "finalizeOutcome";
    if (this.paused) throw registryError(fn, "EnforcedPause");
    const res = this.resolutions.get(o.resolutionId);
    if (res === undefined || res.status !== "active") throw registryError(fn, "ResolutionNotActive", [o.resolutionId]);
    if (this.now > BigInt(o.validUntil)) throw registryError(fn, "OutcomeExpired", [BigInt(o.validUntil)]);
    const deadline = this.deadlineOf(res);
    if (this.now > deadline) throw registryError(fn, "ClaimWindowClosed", [deadline]);
    const r = this.releases.get(res.releaseDigest) as ReleaseState;
    if ((await signerOf(warrantyOutcomeTypedData(o, this), signature)) !== r.evaluator) throw registryError(fn, "InvalidEvaluatorSignature");
    const events: EventFields[] = [{ ...blank, name: "OutcomeFinalized", resolutionId: o.resolutionId, releaseDigest: res.releaseDigest, verdict: verdictCode(o.verdict), weightBps: o.weightBps, evidenceHash: o.evidenceHash }];
    if (!dryRun) {
      r.reserved -= res.amount;
      if (o.verdict === "failed") res.status = "failed";
      else {
        res.status = o.verdict === "passed" ? "passed" : "voided";
        r.available += res.amount;
      }
    }
    if (o.verdict !== "void" && o.weightBps !== 0 && this.engine !== ZERO) {
      if (this.engineBehavior === "records") {
        if (!dryRun) this.recorded.push({ engine: this.engine, releaseDigest: res.releaseDigest, profileIndex: res.profileIndex, passed: o.verdict === "passed", weightBps: o.weightBps, at: this.now });
      } else {
        events.push({ ...blank, name: "EngineRecordFailed", resolutionId: o.resolutionId });
      }
    }
    return events;
  }

  private expire(resolutionId: Hex32, dryRun: boolean): EventFields[] {
    const fn = "expireResolution";
    if (this.paused) throw registryError(fn, "EnforcedPause");
    const res = this.resolutions.get(resolutionId);
    if (res === undefined || res.status !== "active") throw registryError(fn, "ResolutionNotActive", [resolutionId]);
    const deadline = this.deadlineOf(res);
    if (this.now <= deadline) throw registryError(fn, "ClaimWindowOpen", [deadline]);
    if (!dryRun) {
      const r = this.releases.get(res.releaseDigest) as ReleaseState;
      res.status = "expired";
      r.reserved -= res.amount;
      r.available += res.amount;
    }
    return [{ ...blank, name: "ResolutionExpired", resolutionId, releaseDigest: res.releaseDigest, amount: res.amount.toString() }];
  }

  private withdraw(resolutionId: Hex32, claimSecret: Hex32, to: Address, dryRun: boolean): EventFields[] {
    const fn = "withdrawCredit";
    const res = this.resolutions.get(resolutionId);
    if (res === undefined || res.status !== "failed") throw registryError(fn, "NoCredit", [resolutionId]);
    if (to === ZERO || to === this.registry) throw registryError(fn, "InvalidRecipient");
    if (warrantyClaimHash(resolutionId, claimSecret, to) !== res.claimHash) throw registryError(fn, "InvalidClaim");
    if (!dryRun) {
      res.status = "refunded";
      this.paid.set(to, (this.paid.get(to) ?? 0n) + res.amount);
    }
    return [{ ...blank, name: "CreditWithdrawn", resolutionId, amount: res.amount.toString() }];
  }

  /** USDC paid out as credits, by refund address. */
  readonly paid = new Map<Address, bigint>();

  private emitBlock(events: EventFields[]): void {
    this.block++;
    const txHash = this.nextTxHash();
    this.receipts.set(txHash, "success");
    this.pushLogs(txHash, events);
  }

  private pushLogs(txHash: Hex32, events: readonly EventFields[]): void {
    const inBlock = this.logs.filter((l) => l.blockNumber === this.block).length;
    events.forEach((event, i) => {
      this.logs.push({ ...event, blockNumber: this.block, logIndex: inBlock + i, txHash, blockTime: new Date(Number(this.now) * 1000), removed: false });
    });
  }

  private nextTxHash(): Hex32 {
    return keccak256(stringToHex(`fake-registry-tx-${++this.txCounter}`));
  }

  private pendingNonce(sender: WarrantySender): number {
    const address = sender === "provider" ? this.provider : this.evaluator;
    return this.pendingVisible ? this.mined[sender] + this.mempool.filter((t) => t.sender === address).length : this.mined[sender];
  }

  private senderOf(address: Address): WarrantySender | "other" {
    return address === this.provider ? "provider" : address === this.evaluator ? "evaluator" : "other";
  }

  private up(): void {
    if (this.down) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
  }
}

/** Who signed typed data, as the registry's `SignatureChecker` sees it for an EOA; undefined for a signature that recovers nobody. */
async function signerOf(typedData: WarrantyVoucherTypedData | WarrantyOutcomeTypedData, signature: Hex): Promise<Address | undefined> {
  try {
    return toAddress(await recoverTypedDataAddress({ ...typedData, signature } as Parameters<typeof recoverTypedDataAddress>[0]));
  } catch {
    return undefined;
  }
}
