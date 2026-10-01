import { resolve } from "@lemma/catalog";
import { type Address, type AdoptionReceipt, type Hex32, type WarrantyOutcome, type WarrantyVoucher, adoptionReceiptDigest, deriveResolutionId, warrantyClaimHash } from "@lemma/core";
import { keccak256, stringToHex } from "viem";

import {
  CreditRelay,
  type EvaluatorFailures,
  type Logger,
  MemoryStore,
  RegistryIndexer,
  ResolutionService,
  WarrantyActivator,
  WarrantyEvaluator,
  WarrantyExpirer,
  silentLogger,
} from "../src/index.js";
import { FakeRegistry } from "./fake-registry.js";
import { BUYER, NOW, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";

/** A 32-byte id made from a label, for resolutions and digests in tests. */
export const idOf = (label: string) => keccak256(stringToHex(label)) as Hex32;

/** A logger that keeps every line, to check codes and that nothing secret is logged. */
export function recordingLogger(): Logger & { readonly lines: Array<{ level: string; event: string; fields: Record<string, unknown> }>; events(): string[] } {
  const lines: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  return {
    lines,
    log(level, event, fields = {}) {
      lines.push({ level, event, fields });
    },
    events() {
      return lines.map((l) => l.event);
    },
  };
}

/** A voucher for `resolutionId` on `releaseDigest`, valid for an hour of the fake chain's time. */
export function voucherOn(chain: FakeRegistry, resolutionId: Hex32, releaseDigest: Hex32, over: Partial<WarrantyVoucher> = {}): WarrantyVoucher {
  return {
    schemaVersion: "1",
    resolutionId,
    releaseDigest,
    profileIndex: 0,
    amount: "250000",
    paymentRef: idOf(`payment-ref ${resolutionId}`),
    claimHash: idOf(`claim ${resolutionId}`),
    activateBy: Number(chain.now) + 3600,
    ...over,
  };
}

/** Activates a warranty on the fake registry as a relayer would, with the provider's real signature. */
export async function activateOnChain(chain: FakeRegistry, voucher: WarrantyVoucher): Promise<Hex32> {
  return chain.relay({ fn: "activateResolution", voucher, signature: await chain.signVoucher(voucher) });
}

/** Finalizes a warranty on the fake registry as a relayer would, with the evaluator's real signature. */
export async function finalizeOnChain(chain: FakeRegistry, outcome: Omit<WarrantyOutcome, "schemaVersion" | "validUntil" | "evidenceHash"> & Partial<WarrantyOutcome>): Promise<Hex32> {
  const full: WarrantyOutcome = { schemaVersion: "1", evidenceHash: idOf(`evidence ${outcome.resolutionId}`), validUntil: Number(chain.now) + 3600, ...outcome };
  return chain.relay({ fn: "finalizeOutcome", outcome: full, signature: await chain.signOutcome(full) });
}

/** A paid resolution with the buyer's claim: what the bridge keeps (`WarrantyClaim`) and the server's ids. */
export interface Bought {
  readonly id: Hex32;
  readonly previewId: Hex32;
  readonly payer: Address;
  readonly secret: Hex32;
  readonly refundTo: Address;
}

/**
 * The outcome pipeline against a fake registry: the sellable test release
 * registered with the fake's provider and evaluator and bonded, a memory
 * store with the catalog, the five jobs on one server clock (the chain has
 * its own, moved together by `advance`), no jitter, and helpers to buy and
 * to post a receipt.
 */
export async function warrantyWorld(options: { readonly failures?: EvaluatorFailures; readonly jitterSeconds?: number; readonly bond?: bigint; readonly store?: MemoryStore } = {}) {
  const index = sellableIndex();
  const entry = index.releases[0]!;
  const store = options.store ?? new MemoryStore();
  await store.saveCatalog(index, NOW);
  const chain = new FakeRegistry();
  chain.now = BigInt(NOW.getTime() / 1000);
  chain.registerRelease(entry.releaseDigest);
  chain.depositBond(entry.releaseDigest, options.bond ?? 100_000_000n);
  const clock = { now: NOW };
  const logger = recordingLogger();
  const common = { store, chain, clock: () => clock.now, logger, jitter: () => 0 };
  const jobs = {
    indexer: new RegistryIndexer({ store, chain, startBlock: 0n, confirmations: 0n, clock: common.clock, logger }),
    activator: new WarrantyActivator({ ...common, jitterSeconds: options.jitterSeconds ?? 0 }),
    evaluator: new WarrantyEvaluator({ ...common, failures: options.failures ?? "review" }),
    expirer: new WarrantyExpirer(common),
    relay: new CreditRelay(common),
  };
  const service = () => new ResolutionService(store, () => clock.now, silentLogger);
  let bought = 0;

  /** Moves the server's clock and the chain's by the same number of seconds. */
  const advance = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
    chain.advance(seconds);
  };

  /** A settled resolution bought from a fresh offer, with a claim hash from a fresh secret and refund address. */
  const buy = async (payer: Address = BUYER, settlementRef = idOf(`settlement ${bought + 1}`)): Promise<Bought> => {
    bought++;
    const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: clock.now,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(offer);
    const id = deriveResolutionId(offer.previewId, payer);
    const secret = idOf(`claim secret ${bought}`);
    const refundTo = `0x${(0xd000 + bought).toString(16).padStart(40, "0")}`;
    const nonce = idOf(`nonce ${bought}`);
    const prepared = await service().prepare(offer.previewId, { payer, nonce, validBefore: new Date(clock.now.getTime() + 300_000) }, clock.now, warrantyClaimHash(id, secret, refundTo));
    if (!prepared.ok) throw new Error(prepared.reason);
    if ((await service().commit(id, { nonce, settlementRef })) !== "COMMITTED") throw new Error("not settled");
    return { id, previewId: offer.previewId, payer, secret, refundTo };
  };

  /** The buyer's receipt, accepted and (unless `verified` is false) verified as the receipt verifier would. */
  const receipt = async (b: Bought, outcome: AdoptionReceipt["outcome"], verified = true): Promise<AdoptionReceipt> => {
    const r: AdoptionReceipt = {
      schemaVersion: "1",
      resolutionId: b.id,
      outcome,
      acceptance: { exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null, durationMs: 41_250, outputDigest: idOf(`output ${b.id}`) },
      recordedAt: clock.now.toISOString(),
      signature: null,
    };
    if ((await service().acceptReceipt({ receipt: r, previewId: b.previewId })) !== "ACCEPTED") throw new Error("receipt refused");
    if (verified && !(await store.markReceiptVerified(b.id, adoptionReceiptDigest(r), clock.now))) throw new Error("not verified");
    return r;
  };

  /** Buys, activates and indexes: an active warranty. */
  const activeWarranty = async (payer: Address = BUYER): Promise<Bought> => {
    const b = await buy(payer);
    await jobs.activator.runOnce();
    await jobs.indexer.runOnce();
    if (chain.status(b.id) !== "active") throw new Error("not activated");
    return b;
  };

  return { index, entry, store, chain, clock, logger, jobs, advance, buy, receipt, activeWarranty };
}
