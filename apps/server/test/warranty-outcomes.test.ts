import { NO_PRIOR, fold, unixSeconds } from "@lemma/confidence";
import { type Hex32, acceptanceRecipeDigest, adoptionReceiptDigest } from "@lemma/core";
import { describe, expect, it } from "vitest";

import {
  Attester,
  CompatibilityReader,
  FinalizedOutcome,
  MemoryStore,
  RegistryIndexer,
  RegistryOutcomeFeed,
  RegistryOutcomeSource,
  RegistrySnapshot,
  ResolutionService,
  parseFeedCursor,
  silentLogger,
} from "../src/index.js";
import { FakeChain } from "./fake-reputation-chain.js";
import { FakeRegistry, REGISTRY } from "./fake-registry.js";
import { BUYER, NOW, sellableIndex } from "./helpers.js";
import { activateOnChain, finalizeOnChain, idOf, recordingLogger, voucherOn, warrantyWorld } from "./warranty-helpers.js";

const OTHER_BUYER = "0x00000000000000000000000000000000000000c1";
const THIRD_BUYER = "0x00000000000000000000000000000000000000c2";
const ENGINE_A = "0x00000000000000000000000000000000000000e1";
const ENGINE_B = "0x00000000000000000000000000000000000000e2";

/** A bare registry (release D, profiles 0 and 1), a store and its indexer, and the snapshot over them. */
function registry() {
  const chain = new FakeRegistry();
  const D = idOf("release D");
  chain.registerRelease(D);
  chain.depositBond(D, 1_000_000_000n);
  const store = new MemoryStore();
  const indexer = new RegistryIndexer({ store, chain, startBlock: 0n, confirmations: 0n, clock: () => NOW, logger: silentLogger });
  const snapshot = new RegistrySnapshot({ store, index: sellableIndex(), logger: silentLogger });
  let n = 0;
  /** Activates a warranty on profile `profileIndex` and finalizes it with this verdict and weight. */
  const outcome = async (verdict: "passed" | "failed" | "void", weightBps: number, profileIndex = 0) => {
    const id = idOf(`resolution ${++n}`);
    await activateOnChain(chain, voucherOn(chain, id, D, { profileIndex }));
    chain.advance(3600);
    await finalizeOnChain(chain, { resolutionId: id, verdict, weightBps });
    chain.advance(1800);
    return id;
  };
  const sync = async () => {
    await indexer.runOnce();
    await snapshot.refresh();
  };
  return { chain, D, store, snapshot, source: new RegistryOutcomeSource(snapshot), outcome, sync };
}

/** What the engine holds for (release, profile): the fake registry's own engine calls, into `engine`. */
const heldBy = (chain: FakeRegistry, engine: string, releaseDigest: Hex32, profileIndex: number) =>
  chain.recorded.filter((r) => r.engine === engine && r.releaseDigest === releaseDigest && r.profileIndex === profileIndex).map(({ passed, weightBps, at }) => ({ passed, weightBps, at }));

describe("RegistryOutcomeSource", () => {
  it("holds exactly the outcomes the engine recorded, at their block times, and folds to the engine's confidence", async () => {
    const r = registry();
    await r.outcome("passed", 10_000); // No engine yet: not recorded.
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 10_000);
    await r.outcome("failed", 5_000);
    await r.outcome("void", 10_000); // VOID: never recorded.
    await r.outcome("passed", 0); // Weight zero: never sent to the engine.
    await r.outcome("failed", 10_000, 1);
    r.chain.engineBehavior = "reverts";
    await r.outcome("passed", 10_000); // EngineRecordFailed in the same transaction.
    r.chain.engineBehavior = "records";
    await r.outcome("passed", 2_500);
    r.chain.setEngine("0x0000000000000000000000000000000000000000");
    await r.outcome("failed", 10_000); // Disabled: not recorded.
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 7_500);
    await r.sync();

    const now = r.chain.now + 7n * 86_400n;
    for (const profile of [0, 1]) {
      const expected = heldBy(r.chain, ENGINE_A, r.D, profile);
      expect(expected.length).toBeGreaterThan(0);
      const held = r.source.outcomesFor(r.D, profile);
      expect(held).toEqual(expected);
      // What track E's engine computes from the same outcomes and block times, from any prior.
      for (const prior of [NO_PRIOR, { passes: 3, failures: 1 }]) expect(fold(prior, held, now)).toEqual(fold(prior, expected, now));
    }
    expect(r.source.outcomesFor(r.D, 0).map((o) => [o.passed, o.weightBps])).toEqual([
      [true, 10_000],
      [false, 5_000],
      [true, 2_500],
      [true, 7_500],
    ]);
    expect(r.source.outcomesFor(idOf("another release"), 0)).toEqual([]);
  });

  it("holds only what the current engine recorded after a new engine replaces the old one", async () => {
    const r = registry();
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 10_000);
    await r.outcome("failed", 10_000);
    r.chain.setEngine(ENGINE_B);
    await r.outcome("passed", 10_000);
    await r.sync();
    expect(r.source.outcomesFor(r.D, 0)).toEqual(heldBy(r.chain, ENGINE_B, r.D, 0));
    expect(r.source.outcomesFor(r.D, 0)).toHaveLength(1);
    expect(r.snapshot.engine()).toBe(ENGINE_B);
  });

  it("holds only the first engine's own outcomes after it replaces the engine that replaced it", async () => {
    const r = registry();
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 10_000);
    await r.outcome("failed", 5_000);
    r.chain.setEngine(ENGINE_B);
    await r.outcome("failed", 10_000); // B's, never A's.
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 2_500);
    await r.sync();
    const held = r.source.outcomesFor(r.D, 0);
    expect(held).toEqual(heldBy(r.chain, ENGINE_A, r.D, 0));
    expect(held.map((o) => [o.passed, o.weightBps])).toEqual([
      [true, 10_000],
      [false, 5_000],
      [true, 2_500],
    ]);
    expect(r.snapshot.engine()).toBe(ENGINE_A);
  });

  it("answers the same frozen array of frozen outcomes while nothing changes, and a new one when an outcome arrives", async () => {
    const r = registry();
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 10_000);
    await r.outcome("passed", 10_000, 1);
    await r.sync();
    const first = r.source.outcomesFor(r.D, 0);
    const other = r.source.outcomesFor(r.D, 1);
    expect(Object.isFrozen(first) && first.every((o) => Object.isFrozen(o))).toBe(true);
    expect(await r.snapshot.refresh()).toBe(false);
    expect(r.source.outcomesFor(r.D, 0)).toBe(first);
    await r.outcome("failed", 10_000);
    await r.sync();
    expect(r.source.outcomesFor(r.D, 0)).not.toBe(first);
    expect(r.source.outcomesFor(r.D, 0)).toHaveLength(2);
    // Another key that did not change keeps its array, so the catalog does not fold it again.
    expect(r.source.outcomesFor(r.D, 1)).toBe(other);
  });

  it("skips a finalization whose activation came before the indexer's start block, and says so once", async () => {
    const r = registry();
    r.chain.setEngine(ENGINE_A);
    const id = idOf("early");
    await activateOnChain(r.chain, voucherOn(r.chain, id, r.D));
    const start = r.chain.block + 1n;
    await finalizeOnChain(r.chain, { resolutionId: id, verdict: "passed", weightBps: 10_000 });
    const store = new MemoryStore();
    const logger = recordingLogger();
    const snapshot = new RegistrySnapshot({ store, index: sellableIndex(), logger });
    await new RegistryIndexer({ store, chain: r.chain, startBlock: start, confirmations: 0n, clock: () => NOW, logger: silentLogger }).runOnce();
    await snapshot.refresh();
    expect(new RegistryOutcomeSource(snapshot).outcomesFor(r.D, 0)).toEqual([]);
    expect(logger.lines).toEqual([{ level: "warn", event: "warranty.outcome_unkeyed", fields: { resolutionId: id, code: "NO_ACTIVATION" } }]);
  });

  it("changes nothing when a refresh fails, and applies the same rows on the next one", async () => {
    const r = registry();
    r.chain.setEngine(ENGINE_A);
    await r.outcome("passed", 10_000);
    let failing = true;
    const store = Object.assign(Object.create(r.store) as MemoryStore, {
      getResolution: async (...args: Parameters<MemoryStore["getResolution"]>) => {
        if (failing) throw new Error("database down");
        return r.store.getResolution(...args);
      },
    });
    const snapshot = new RegistrySnapshot({ store, index: sellableIndex(), logger: silentLogger });
    await new RegistryIndexer({ store: r.store, chain: r.chain, startBlock: 0n, confirmations: 0n, clock: () => NOW, logger: silentLogger }).runOnce();
    await expect(snapshot.refresh()).rejects.toThrow("database down");
    expect(new RegistryOutcomeSource(snapshot).outcomesFor(r.D, 0)).toEqual([]);
    failing = false;
    expect(await snapshot.refresh()).toBe(true);
    expect(new RegistryOutcomeSource(snapshot).outcomesFor(r.D, 0)).toHaveLength(1);
  });
});

describe("distinct buyers", () => {
  it("publishes the counts from a daily snapshot: a new outcome moves no count before the next day", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    w.chain.setEngine(ENGINE_A);
    const day = 86_400_000;
    const snapshot = new RegistrySnapshot({ store: w.store, index: w.index, logger: silentLogger, clock: () => w.clock.now, buyersRefreshMs: day });
    const source = new RegistryOutcomeSource(snapshot);
    const feed = new RegistryOutcomeFeed(snapshot, { store: w.store, index: w.index, registry: { chainId: 421614, address: REGISTRY }, logger: silentLogger });
    const finalize = async (payer: string) => {
      const b = await w.activeWarranty(payer);
      await w.receipt(b, "passed");
      await w.jobs.evaluator.runOnce();
      await w.jobs.indexer.runOnce();
      await snapshot.refresh();
    };
    const digest = w.entry.releaseDigest;
    const capability = w.entry.release.capability;
    await finalize(BUYER);
    await finalize(OTHER_BUYER);
    const counts = () => [source.outcomesFor(digest, 0).length, source.buyersFor(digest, 0), feed.buyersFor(capability)];
    expect(counts()).toEqual([2, 2, 2]);
    // Later the same day: a repeat buyer and a new one. The outcomes show at once; the buyer counts hold.
    await finalize(BUYER);
    await finalize(THIRD_BUYER);
    expect(counts()).toEqual([4, 2, 2]);
    // The next day, the counts catch up.
    w.clock.now = new Date((Math.floor(w.clock.now.getTime() / day) + 1) * day);
    expect(counts()).toEqual([4, 3, 3]);
    // A new engine starts empty: the held count never exceeds the outcomes it is published with.
    w.chain.setEngine(ENGINE_B);
    await w.jobs.indexer.runOnce();
    await snapshot.refresh();
    expect(counts()).toEqual([0, 0, 3]);
  });

  it("counts the payers behind the recorded outcomes per release and profile, and behind the fed ones per capability", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    w.chain.setEngine(ENGINE_A);
    const snapshot = new RegistrySnapshot({ store: w.store, index: w.index, logger: silentLogger });
    const source = new RegistryOutcomeSource(snapshot);
    const feed = new RegistryOutcomeFeed(snapshot, { store: w.store, index: w.index, registry: { chainId: 421614, address: REGISTRY }, logger: silentLogger });
    const finalize = async (payer: string, outcome: "passed" | "failed") => {
      const b = await w.activeWarranty(payer);
      await w.receipt(b, outcome);
      await w.jobs.evaluator.runOnce();
      await w.jobs.indexer.runOnce();
      await snapshot.refresh();
    };
    await finalize(BUYER, "passed");
    await finalize(BUYER, "failed");
    await finalize(OTHER_BUYER, "passed");
    const digest = w.entry.releaseDigest;
    const capability = w.entry.release.capability;
    expect([source.outcomesFor(digest, 0).length, source.buyersFor(digest, 0), feed.buyersFor(capability)]).toEqual([3, 2, 2]);
    // The catalog publishes a count from three buyers up.
    const reader = new CompatibilityReader(source);
    expect(reader.forRelease(w.entry.release, digest, w.clock.now).get(0)?.buyers).toBeNull();
    await finalize(THIRD_BUYER, "passed");
    expect([source.buyersFor(digest, 0), feed.buyersFor(capability)]).toEqual([3, 3]);
    expect(reader.forRelease(w.entry.release, digest, w.clock.now).get(0)).toMatchObject({ outcomes: 4, buyers: 3, source: "benchmark+outcomes" });
    // An outcome the engine could not record is fed but not recorded: it counts for the capability only.
    w.chain.engineBehavior = "reverts";
    await finalize("0x00000000000000000000000000000000000000c3", "passed");
    expect([source.outcomesFor(digest, 0).length, source.buyersFor(digest, 0), feed.buyersFor(capability)]).toEqual([4, 3, 4]);
    expect(feed.buyersFor("node-service.add-payment-facilitator")).toBe(0);
  });
});

describe("RegistryOutcomeFeed", () => {
  it("feeds every weighted PASSED and FAILED outcome in chain order as a FinalizedOutcome, a page at a time", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const snapshot = new RegistrySnapshot({ store: w.store, index: w.index, logger: silentLogger });
    const logger = recordingLogger();
    const feed = new RegistryOutcomeFeed(snapshot, { store: w.store, index: w.index, registry: { chainId: 421614, address: REGISTRY }, logger });
    const passed = await w.activeWarranty();
    const failed = await w.activeWarranty(OTHER_BUYER);
    const voided = await w.activeWarranty(THIRD_BUYER);
    // The buyer of the passed one opted in with its ERC-8004 agent.
    const receipt = { schemaVersion: "1" as const, resolutionId: passed.id, outcome: "passed" as const, acceptance: { exitCode: 0, durationMs: 1234, outputDigest: idOf("out") }, recordedAt: w.clock.now.toISOString(), signature: null };
    await new ResolutionService(w.store, () => w.clock.now, silentLogger).acceptReceipt({ receipt, previewId: passed.previewId, agentId: "42" });
    await w.store.markReceiptVerified(passed.id, adoptionReceiptDigest(receipt), w.clock.now);
    await w.receipt(failed, "failed");
    await w.receipt(voided, "abandoned");
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    await snapshot.refresh();

    const all = await feed.read(null, 10);
    expect(all.outcomes.map((o) => FinalizedOutcome.parse(o))).toEqual([
      {
        resolutionId: passed.id,
        releaseDigest: w.entry.releaseDigest,
        releaseId: "gating",
        version: "1.0.0+bench-1",
        profileIndex: 0,
        capability: "mcp-server.add-payment-gating",
        verdict: "passed",
        acceptanceRecipeDigest: acceptanceRecipeDigest(w.entry.release.acceptanceRecipe),
        acceptance: receipt.acceptance,
        registry: { chainId: 421614, address: REGISTRY },
        buyerAgentId: "42",
        finalizedAt: w.clock.now.toISOString(),
      },
      expect.objectContaining({ resolutionId: failed.id, verdict: "failed", acceptance: expect.objectContaining({ exitCode: 1 }), buyerAgentId: null }),
    ]);
    const finalizedEvents = await w.store.listRegistryEvents({ names: ["OutcomeFinalized"] }, 10);
    const lastFed = finalizedEvents.find((e) => e.resolutionId === failed.id)!;
    expect(all.cursor).toBe(`${lastFed.blockNumber}:${lastFed.logIndex}`);
    // A page at a time, from the cursor; nothing new answers the same cursor.
    const first = await feed.read(null, 1);
    expect(first.outcomes.map((o) => (o as { resolutionId: string }).resolutionId)).toEqual([passed.id]);
    expect((await feed.read(first.cursor, 1)).outcomes.map((o) => (o as { resolutionId: string }).resolutionId)).toEqual([failed.id]);
    expect(await feed.read(all.cursor, 10)).toEqual({ outcomes: [], cursor: all.cursor });
    expect(await feed.read("not a cursor", 10)).toMatchObject({ outcomes: [{}, {}] });
    expect(parseFeedCursor("12:3")).toEqual({ blockNumber: 12n, logIndex: 3 });
    expect(logger.lines).toEqual([]);
  });

  it("passes over an outcome whose release left the catalog, or whose receipt it does not hold, with a code, and fills the page past them", async () => {
    const r = registry();
    await r.outcome("passed", 10_000);
    await r.sync();
    const w = await warrantyWorld({ failures: "auto" });
    const b = await w.activeWarranty();
    await w.receipt(b, "passed");
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    // Release D is not in the catalog; the world's store holds no receipt for anything but its own.
    const logger = recordingLogger();
    const feed = new RegistryOutcomeFeed(r.snapshot, { store: r.store, index: sellableIndex(), registry: { chainId: 421614, address: REGISTRY }, logger });
    expect(await feed.read(null, 10)).toMatchObject({ outcomes: [] });
    expect(logger.lines.map((l) => l.fields["code"])).toEqual(["RELEASE_NOT_IN_CATALOG"]);
    const snapshot = new RegistrySnapshot({ store: w.store, index: w.index, logger: silentLogger });
    await snapshot.refresh();
    const noReceipts = new RegistryOutcomeFeed(snapshot, { store: new MemoryStore(), index: w.index, registry: { chainId: 421614, address: REGISTRY }, logger });
    expect((await noReceipts.read(null, 10)).outcomes).toEqual([]);
    expect(logger.lines.map((l) => l.fields["code"])).toEqual(["RELEASE_NOT_IN_CATALOG", "NO_RECEIPT"]);
  });

  it("is what the ERC-8004 attester reads: each fed outcome becomes feedback to the provider's agent", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const snapshot = new RegistrySnapshot({ store: w.store, index: w.index, logger: silentLogger });
    const feed = new RegistryOutcomeFeed(snapshot, { store: w.store, index: w.index, registry: { chainId: 421614, address: REGISTRY }, logger: silentLogger });
    for (const [payer, outcome] of [[BUYER, "passed"], [OTHER_BUYER, "failed"]] as const) {
      const b = await w.activeWarranty(payer);
      await w.receipt(b, outcome);
    }
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    await snapshot.refresh();
    const reputation = new FakeChain();
    const attester = new Attester({ store: w.store, chain: reputation, feed, providerAgentId: "7", publicBaseUrl: "https://lemma.example", clock: () => w.clock.now, logger: silentLogger });
    expect(await attester.tick()).toEqual({ queued: 2, posted: 2, skipped: 0, failed: 0 });
    expect(reputation.sends.map((s) => [s.agentId, s.value, s.tag2])).toEqual([
      [7n, 100n, "mcp-server.add-payment-gating"],
      [7n, 0n, "mcp-server.add-payment-gating"],
    ]);
  });
});

describe("the snapshot's pause and engine facts", () => {
  it("adds up the time paused after a position, an ongoing pause up to now", async () => {
    const r = registry();
    const id = idOf("paused one");
    await activateOnChain(r.chain, voucherOn(r.chain, id, r.D));
    r.chain.advance(100);
    r.chain.pause();
    r.chain.advance(600);
    r.chain.unpause();
    r.chain.advance(50);
    r.chain.pause();
    r.chain.advance(30);
    await r.sync();
    const [activation] = await r.store.listRegistryEvents({ resolutionId: id }, 1);
    expect(r.snapshot.pausedSecondsAfter(activation!, r.chain.now)).toBe(630n);
    expect(r.snapshot.pausedSecondsAfter(activation!, r.chain.now + 10n)).toBe(640n);
    // Nothing paused after the last event.
    const events = await r.store.listRegistryEvents({}, 100);
    expect(r.snapshot.pausedSecondsAfter(events.at(-1)!, r.chain.now)).toBe(0n);
    expect(r.snapshot.engine()).toBeNull();
    expect(unixSeconds(new Date(Number(r.chain.now) * 1000))).toBe(r.chain.now);
  });
});
