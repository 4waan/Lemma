import { describe, expect, it, vi } from "vitest";

import { MemoryStore, REGISTRY_CURSOR, RegistryIndexer, type RegistryIndexerDeps, silentLogger } from "../src/index.js";
import { FakeRegistry } from "./fake-registry.js";
import { NOW } from "./helpers.js";
import { activateOnChain, finalizeOnChain, idOf, recordingLogger, voucherOn } from "./warranty-helpers.js";

const RELEASE = idOf("release");

/** A registry with one bonded release, and `n` warranties activated on it, one block each. */
async function registryWithActivations(n: number) {
  const chain = new FakeRegistry();
  chain.registerRelease(RELEASE);
  chain.depositBond(RELEASE, 10_000_000n);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = idOf(`resolution ${i}`);
    await activateOnChain(chain, voucherOn(chain, id, RELEASE));
    ids.push(id);
  }
  return { chain, ids };
}

/** An indexer over the fake chain, reading up to its head unless a case asks for confirmations. */
function indexer(store: MemoryStore, chain: FakeRegistry, over: Partial<RegistryIndexerDeps> = {}) {
  return new RegistryIndexer({ store, chain, startBlock: 100n, confirmations: 0n, clock: () => NOW, logger: silentLogger, ...over });
}

const live = (chain: FakeRegistry) => chain.logs.map(({ removed: _, ...row }) => row);

describe("the registry indexer", () => {
  it("stores every indexed event from the start block to the head, then goes on from its cursor", async () => {
    const { chain, ids } = await registryWithActivations(2);
    chain.setEngine("0x00000000000000000000000000000000000000e1");
    await finalizeOnChain(chain, { resolutionId: ids[0]!, verdict: "passed", weightBps: 10_000 });
    chain.pause();
    chain.advance(60);
    chain.unpause();
    const store = new MemoryStore();
    const report = await indexer(store, chain).runOnce();
    expect(report).toMatchObject({ ranges: 1, stored: chain.logs.length, removed: 0, next: chain.block + 1n, head: chain.block });
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
    expect((await store.listRegistryEvents({}, 100)).map((e) => e.name)).toEqual(["ResolutionActivated", "ResolutionActivated", "EngineSet", "OutcomeFinalized", "Paused", "Unpaused"]);
    expect(chain.logQueries).toEqual([[100n, chain.block]]);

    // The next run reads only what is new, from the cursor.
    const head = chain.block;
    await finalizeOnChain(chain, { resolutionId: ids[1]!, verdict: "failed", weightBps: 10_000 });
    expect(await indexer(store, chain).runOnce()).toMatchObject({ ranges: 1, stored: 1 });
    expect(chain.logQueries.at(-1)).toEqual([head + 1n, chain.block]);
    expect(await store.getChainCursor(REGISTRY_CURSOR)).toBe(chain.block + 1n);
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
    // Nothing new: nothing asked, nothing stored.
    const asked = chain.logQueries.length;
    expect(await indexer(store, chain).runOnce()).toMatchObject({ ranges: 0, stored: 0 });
    expect(chain.logQueries).toHaveLength(asked);
  });

  it("halves a range the node refuses, down to what it serves, and lets the span grow back", async () => {
    const { chain } = await registryWithActivations(20);
    chain.maxLogRange = 3n;
    const store = new MemoryStore();
    const job = indexer(store, chain, { maxSpan: 16n });
    await job.runOnce();
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
    // Every range the node answered was one it serves; the first ones were halved from 16 down to 2.
    const answered = chain.logQueries.filter(([from, to]) => to - from + 1n <= 3n);
    expect(answered.length).toBeGreaterThan(0);
    expect(chain.logQueries.slice(0, 4).map(([from, to]) => to - from + 1n)).toEqual([16n, 8n, 4n, 2n]);
    // Ranges cover the blocks once each, without a gap.
    let next = 100n;
    for (const [from, to] of answered) {
      expect(from).toBe(next);
      next = to + 1n;
    }
    expect(next).toBe(chain.block + 1n);
    // Once the node serves wide ranges again, each stored range doubles the span back up to the most.
    chain.maxLogRange = 1_000_000n;
    for (let i = 0; i < 5; i++) {
      chain.block += 40n;
      await job.runOnce();
    }
    expect(job.currentSpan).toBe(16n);
  });

  it("indexes only blocks its confirmation depth behind the head, and goes on as they are confirmed", async () => {
    const { chain } = await registryWithActivations(3);
    // Blocks 101 to 103, one activation each; the head is 103.
    const store = new MemoryStore();
    const job = indexer(store, chain, { confirmations: 2n });
    expect(await job.runOnce()).toMatchObject({ ranges: 1, stored: 1, next: 102n, head: 103n, confirmed: 101n });
    expect(chain.logQueries).toEqual([[100n, 101n]]);
    expect((await store.listRegistryEvents({}, 100)).map((e) => e.blockNumber)).toEqual([101n]);
    // No new block: nothing more is confirmed, and nothing is asked.
    expect(await job.runOnce()).toMatchObject({ ranges: 0, stored: 0, next: 102n });
    expect(chain.logQueries).toHaveLength(1);
    // Two more blocks confirm the other two activations.
    chain.block += 2n;
    expect(await job.runOnce()).toMatchObject({ ranges: 1, stored: 2, next: 104n, confirmed: 103n });
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
    // A chain shorter than the depth: nothing is confirmed yet.
    const young = new FakeRegistry();
    young.block = 1n;
    expect(await indexer(new MemoryStore(), young, { startBlock: 0n, confirmations: 5n }).runOnce()).toMatchObject({ ranges: 0, next: 0n, confirmed: -4n });
    expect(young.logQueries).toEqual([]);
  });

  it("never stores a log from a block a reorg took back before it was confirmed", async () => {
    const { chain } = await registryWithActivations(3);
    const store = new MemoryStore();
    const job = indexer(store, chain, { confirmations: 3n });
    await job.runOnce();
    expect(await store.listRegistryEvents({}, 100)).toEqual([]);
    // The sequencer reorganizes the last two blocks: their logs are gone, and eth_getLogs over a past range never
    // reports them as removed. The new branch carries other activations, and grows past the depth.
    const [first] = chain.logs;
    const reorged = chain.logs.splice(1);
    expect(reorged.map((l) => l.blockNumber)).toEqual([102n, 103n]);
    chain.block = 101n;
    await activateOnChain(chain, voucherOn(chain, idOf("on the new branch"), RELEASE));
    chain.block += 3n;
    await job.runOnce();
    const stored = await store.listRegistryEvents({}, 100);
    expect(stored).toEqual(live(chain));
    expect(stored.map((e) => e.resolutionId)).toEqual([first!.resolutionId, idOf("on the new branch")]);
    for (const gone of reorged) expect(stored.some((e) => e.txHash === gone.txHash)).toBe(false);
  });

  it("loses nothing to a node that lags the head by less than the depth and answers short without an error", async () => {
    const { chain } = await registryWithActivations(6);
    // head() is answered by one backend at the head; eth_getLogs by another, two blocks behind.
    chain.logsLag = 2n;
    const store = new MemoryStore();
    const job = indexer(store, chain, { confirmations: 2n, maxSpan: 2n });
    await job.runOnce();
    for (let i = 0; i < 3; i++) {
      await activateOnChain(chain, voucherOn(chain, idOf(`later ${i}`), RELEASE));
      await job.runOnce();
    }
    chain.block += 2n;
    await job.runOnce();
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
    expect(await store.getChainCursor(REGISTRY_CURSOR)).toBe(chain.block - 1n);

    // Read to the head of such a node, with no depth, the last two blocks' logs are lost for good: the cursor moves past them.
    const { chain: other } = await registryWithActivations(4);
    other.logsLag = 2n;
    const hasty = new MemoryStore();
    await indexer(hasty, other, { confirmations: 0n }).runOnce();
    other.logsLag = 0n;
    other.block += 1n;
    await indexer(hasty, other, { confirmations: 0n }).runOnce();
    expect((await hasty.listRegistryEvents({}, 100)).map((e) => e.blockNumber)).toEqual([101n, 102n]);
    expect(live(other).map((e) => e.blockNumber)).toEqual([101n, 102n, 103n, 104n]);
  });

  it("skips logs the node marks removed", async () => {
    const { chain } = await registryWithActivations(1);
    const [real] = chain.logs;
    chain.removedLogs.push({ ...real!, logIndex: 5, txHash: idOf("reorged"), removed: true });
    const store = new MemoryStore();
    expect(await indexer(store, chain).runOnce()).toMatchObject({ stored: 1, removed: 1 });
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
  });

  it("moves the cursor only from where it found it: a raced run stores nothing", async () => {
    const { chain } = await registryWithActivations(2);
    const store = new MemoryStore();
    // A second indexer read the cursor before the first one moved it.
    const stale = Object.assign(Object.create(store) as MemoryStore, { getChainCursor: async () => undefined });
    await indexer(store, chain).runOnce();
    await activateOnChain(chain, voucherOn(chain, idOf("late"), RELEASE));
    const logger = recordingLogger();
    expect(await indexer(stale, chain, { logger }).runOnce()).toMatchObject({ ranges: 0, stored: 0 });
    expect(logger.events()).toEqual(["warranty.index_raced"]);
    expect(await store.listRegistryEvents({}, 100)).toHaveLength(2);
    expect(await indexer(store, chain).runOnce()).toMatchObject({ stored: 1 });
  });

  it("reads a bounded number of ranges per run and catches up over the next runs", async () => {
    const { chain } = await registryWithActivations(6);
    const store = new MemoryStore();
    const job = indexer(store, chain, { maxSpan: 2n, rangesPerRun: 2 });
    expect(await job.runOnce()).toMatchObject({ ranges: 2, next: 104n });
    expect(await store.listRegistryEvents({}, 100)).toHaveLength(3);
    // The head is block 106: the second run reaches it with a range of one block.
    expect(await job.runOnce()).toMatchObject({ ranges: 2, next: 107n });
    expect(await store.listRegistryEvents({}, 100)).toEqual(live(chain));
  });

  it("fails a run on a failing chain without moving its cursor, and the loop logs it and goes on", async () => {
    const { chain } = await registryWithActivations(1);
    const store = new MemoryStore();
    chain.down = true;
    await expect(indexer(store, chain).runOnce()).rejects.toThrow();
    expect(await store.getChainCursor(REGISTRY_CURSOR)).toBeUndefined();
    const logger = recordingLogger();
    const refreshed = vi.fn(async () => undefined);
    const stop = indexer(store, chain, { logger, onIndexed: refreshed }).start(60_000);
    await vi.waitFor(() => expect(logger.events()).toContain("warranty.index_failed"));
    stop();
    expect(logger.lines.find((l) => l.event === "warranty.index_failed")?.fields).toEqual({ error: "Error ECONNREFUSED" });
    chain.down = false;
    expect(await indexer(store, chain).runOnce()).toMatchObject({ stored: 1 });
  });

  it("refreshes what reads its rows after every run, and only logs a refresh that fails", async () => {
    const { chain } = await registryWithActivations(1);
    const store = new MemoryStore();
    const refreshed = vi.fn(async () => undefined);
    await indexer(store, chain, { onIndexed: refreshed }).runOnce();
    await indexer(store, chain, { onIndexed: refreshed }).runOnce();
    expect(refreshed).toHaveBeenCalledTimes(2);
    const logger = recordingLogger();
    await indexer(store, chain, { logger, onIndexed: async () => Promise.reject(new TypeError("snapshot")) }).runOnce();
    expect(logger.lines).toEqual([{ level: "warn", event: "warranty.snapshot_failed", fields: { error: "TypeError" } }]);
  });
});
