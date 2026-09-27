import { resolve } from "@lemma/catalog";
import { type Address, type Hex32, deriveResolutionId } from "@lemma/core";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";

import {
  AGENT_NOT_BUYER,
  ATTEMPT_LEASE_MS,
  Attester,
  type AttesterDeps,
  FILE_MISMATCH,
  type LemmaStore,
  MemoryOutcomeFeed,
  MemoryStore,
  ResolutionService,
  buildEvidence,
  silentLogger,
} from "../src/index.js";
import { ATTESTER, BUYER_AGENT, FakeChain, PROVIDER_AGENT, outcomeFor } from "./fake-reputation-chain.js";
import { BUYER, NOW, PROVIDER, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";

const BASE = "https://lemma.example";
const OTHER_BUYER = "0x00000000000000000000000000000000000000c1";

/** A store holding one settled resolution per buyer, bought from one stored offer. */
async function settled(buyers: readonly Address[] = [BUYER]) {
  const store = new MemoryStore();
  const index = sellableIndex();
  await store.saveCatalog(index, NOW);
  const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
    now: NOW,
    previewId: nextPreviewId(),
    payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
    offerTtlSeconds: 900,
  });
  await store.saveOffer(offer);
  const service = new ResolutionService(store, () => NOW, silentLogger);
  let n = 0;
  for (const buyer of buyers) {
    n++;
    await service.prepare(offer.previewId, { payer: buyer, nonce: `0x0${n}`, validBefore: new Date(NOW.getTime() + 300_000) });
    await service.commit(deriveResolutionId(offer.previewId, buyer), { nonce: `0x0${n}`, settlementRef: `0x${String(n).repeat(64)}` });
  }
  return { store, previewId: offer.previewId };
}

function attester(store: Pick<LemmaStore, "enqueueReputationPosts" | "dueReputationPosts" | "updateReputationPost" | "getResolution">, chain: FakeChain, feed: MemoryOutcomeFeed, clock: { now: Date }, over: Partial<AttesterDeps> = {}) {
  return new Attester({ store, chain, feed, providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => clock.now, logger: silentLogger, ...over });
}

const later = (clock: { now: Date }, ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

describe("the ERC-8004 attester", () => {
  it("gives the provider's agent one feedback per finalized outcome, with the evidence file's hash", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome, outcomeFor(nextPreviewId(), OTHER_BUYER, { verdict: "failed", acceptance: { exitCode: 1, durationMs: 9, outputDigest: null } }));
    const clock = { now: NOW };
    expect(await attester(store, chain, feed, clock).tick()).toEqual({ queued: 2, posted: 2, skipped: 0, failed: 0 });
    const [pass, fail] = chain.sends;
    expect(pass).toEqual({
      agentId: 7n,
      value: 100n,
      valueDecimals: 0,
      tag1: "lemma.adoption",
      tag2: "mcp-server.add-payment-gating",
      endpoint: "",
      feedbackURI: `${BASE}/api/v1/evidence/${outcome.resolutionId}/provider`,
      feedbackHash: buildEvidence(outcome, PROVIDER_AGENT, chain).feedbackHash,
    });
    expect(fail).toMatchObject({ agentId: 7n, value: 0n, valueDecimals: 0 });
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "posted", attempts: 1, txHash: chain.logs[0]?.txHash });
    // Nothing is due any more, and a second tick sends nothing.
    later(clock, 3_600_000);
    expect(await attester(store, chain, feed, clock).tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
    expect(chain.sends).toHaveLength(2);
  });

  it("gives an opted-in buyer agent the same feedback, only when the address that paid controls it", async () => {
    const { store, previewId } = await settled([BUYER, OTHER_BUYER]);
    const chain = new FakeChain();
    chain.owners.set(42n, BUYER);
    chain.wallets.set(43n, OTHER_BUYER);
    const feed = new MemoryOutcomeFeed();
    const owned = outcomeFor(previewId, BUYER, { buyerAgentId: BUYER_AGENT });
    const viaWallet = outcomeFor(previewId, OTHER_BUYER, { buyerAgentId: "43" });
    const { store: other, previewId: otherPreview } = await settled([BUYER]);
    feed.add(owned, viaWallet);
    const clock = { now: NOW };
    expect(await attester(store, chain, feed, clock).tick()).toEqual({ queued: 4, posted: 4, skipped: 0, failed: 0 });
    // The buyer agent's feedback points at its own file, which names its agent: another URI and another hash than the provider's.
    expect(chain.postedTo(BUYER_AGENT).map((l) => [l.request.feedbackURI, l.request.feedbackHash])).toEqual([
      [`${BASE}/api/v1/evidence/${owned.resolutionId}/buyer-agent`, buildEvidence(owned, BUYER_AGENT, chain).feedbackHash],
    ]);
    expect(buildEvidence(owned, BUYER_AGENT, chain).feedbackHash).not.toBe(buildEvidence(owned, PROVIDER_AGENT, chain).feedbackHash);
    expect(chain.postedTo("43")).toHaveLength(1);
    expect(chain.postedTo(PROVIDER_AGENT)).toHaveLength(2);

    // Naming an agent the payer neither owns nor wired as its agent wallet: skipped, never posted.
    const stranger = outcomeFor(otherPreview, BUYER, { buyerAgentId: "99" });
    const selfNamed = outcomeFor(nextPreviewId(), BUYER, { buyerAgentId: PROVIDER_AGENT });
    const feed2 = new MemoryOutcomeFeed();
    feed2.add(stranger, selfNamed);
    const chain2 = new FakeChain();
    chain2.owners.set(99n, OTHER_BUYER);
    expect(await attester(other, chain2, feed2, clock).tick()).toEqual({ queued: 3, posted: 2, skipped: 1, failed: 0 });
    expect(chain2.postedTo("99")).toEqual([]);
    expect(await other.getReputationPost(stranger.resolutionId, "buyer")).toMatchObject({ state: "skipped", note: AGENT_NOT_BUYER });
    // A buyer naming the provider's own agent adds no second feedback to it.
    expect(await other.getReputationPost(selfNamed.resolutionId, "buyer")).toBeUndefined();
    expect(chain2.postedTo(PROVIDER_AGENT)).toHaveLength(2);
  });

  it("never double-posts across a crash between sending and the ledger write", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const clock = { now: NOW };
    // The process dies right after the transaction is broadcast: no ledger write after the send lands.
    let crashed = false;
    const dying: typeof store = Object.assign(Object.create(store) as MemoryStore, {
      updateReputationPost: async (...args: Parameters<MemoryStore["updateReputationPost"]>) => {
        if (chain.sends.length > 0) {
          crashed = true;
          throw new Error("process killed");
        }
        return store.updateReputationPost(...args);
      },
    });
    await attester(dying, chain, feed, clock).tick();
    expect(crashed).toBe(true);
    expect(chain.sends).toHaveLength(1);
    const left = await store.getReputationPost(outcome.resolutionId, "provider");
    expect(left).toMatchObject({ state: "pending", attempts: 1, txHash: null, fromBlock: "1000" });

    // Nothing happens while the dead process's claim holds the post.
    later(clock, 30_000);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 0, failed: 0 });
    // A new process, once the claim has lapsed: it finds the NewFeedback log and records it instead of sending.
    later(clock, ATTEMPT_LEASE_MS - 30_000);
    const restarted = attester(store, chain, feed, clock);
    expect(await restarted.tick()).toMatchObject({ posted: 1, failed: 0 });
    expect(chain.sends).toHaveLength(1);
    expect(chain.logs).toHaveLength(1);
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "posted", txHash: chain.logs[0]?.txHash });
  });

  it("gives each feedback its own file, whose ERC-8004 fields equal its call, and looks for a crashed send by that file's hash", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.owners.set(42n, BUYER);
    const searches: Array<{ agentId: bigint; feedbackHash: Hex32 }> = [];
    const find = chain.findFeedback.bind(chain);
    chain.findFeedback = async (query) => (searches.push({ agentId: query.agentId, feedbackHash: query.feedbackHash }), find(query));
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER, { buyerAgentId: BUYER_AGENT });
    feed.add(outcome);
    const clock = { now: NOW };
    // The process dies right after the buyer agent's feedback is broadcast, before the ledger records it.
    const dying: typeof store = Object.assign(Object.create(store) as MemoryStore, {
      updateReputationPost: async (...args: Parameters<MemoryStore["updateReputationPost"]>) => {
        if (chain.sends.some((s) => s.agentId === 42n)) throw new Error("process killed");
        return store.updateReputationPost(...args);
      },
    });
    await attester(dying, chain, feed, clock).tick();
    expect(chain.sends.map((s) => s.agentId)).toEqual([7n, 42n]);
    later(clock, ATTEMPT_LEASE_MS);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 1, failed: 0 });
    expect(chain.sends).toHaveLength(2);

    const files = { provider: buildEvidence(outcome, PROVIDER_AGENT, chain), buyer: buildEvidence(outcome, BUYER_AGENT, chain) };
    expect(files.provider.feedbackHash).not.toBe(files.buyer.feedbackHash);
    // The restarted attester found the buyer agent's feedback by that agent and its own file's hash, and sent nothing again.
    expect(searches).toEqual([{ agentId: 42n, feedbackHash: files.buyer.feedbackHash }]);
    for (const target of ["provider", "buyer"] as const) {
      const { file, bytes, feedbackHash } = files[target];
      expect(await store.getReputationPost(outcome.resolutionId, target)).toMatchObject({ state: "posted", evidence: bytes, feedbackHash });
      // The file's fields are exactly the call that points at it: from the attester, to an agent of the identity registry.
      expect(file).toMatchObject({ agentRegistry: `eip155:421614:${chain.identityRegistry}`, clientAddress: `eip155:421614:${ATTESTER}`, createdAt: outcome.finalizedAt });
      expect(chain.sends.find((s) => s.feedbackHash === feedbackHash)).toEqual({
        agentId: BigInt(file.agentId),
        value: BigInt(file.value),
        valueDecimals: file.valueDecimals,
        tag1: file.tag1,
        tag2: file.tag2,
        endpoint: file.endpoint,
        feedbackURI: `${BASE}/api/v1/evidence/${outcome.resolutionId}/${target === "provider" ? "provider" : "buyer-agent"}`,
        feedbackHash: keccak256(stringToBytes(bytes)),
      });
    }
  });

  it("trusts a recorded transaction's receipt even when the log search lags", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.mineOnSend = false;
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const clock = { now: NOW };
    await attester(store, chain, feed, clock).tick();
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ note: "UNCONFIRMED", txHash: chain.mempool[0]?.txHash });
    chain.mine();
    chain.logsLag = true;
    later(clock, 30_000);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 1 });
    expect(chain.sends).toHaveLength(1);
  });

  it("waits for its own unmined transaction instead of sending again", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.mineOnSend = false;
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const clock = { now: NOW };
    await attester(store, chain, feed, clock).tick();
    expect(chain.sends).toHaveLength(1);
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "pending", note: "UNCONFIRMED", attempts: 1 });
    later(clock, 30_000);
    await attester(store, chain, feed, clock).tick();
    expect(chain.sends).toHaveLength(1);
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "pending", note: "PENDING_TX", attempts: 1 });
    chain.mine();
    later(clock, 15_000);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 1 });
    expect(chain.sends).toHaveLength(1);
  });

  it("never sends twice when its earlier transaction is mined just after the search missed it, even where no pending transaction shows", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    // An Arbitrum node: it forwards transactions to the sequencer and counts no pending ones.
    chain.pendingVisible = false;
    chain.mineOnSend = false;
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const clock = { now: NOW };
    await attester(store, chain, feed, clock).tick();
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ note: "UNCONFIRMED", attempts: 1 });
    // The next attempt finds nothing on chain, and the first transaction is mined right after its search.
    chain.afterSearch = () => chain.mine();
    chain.mineOnSend = true;
    later(clock, 30_000);
    await attester(store, chain, feed, clock).tick();
    chain.afterSearch = undefined;
    // The resend carried the nonce read before the search, which the first transaction then took: it was refused.
    expect(chain.logs).toHaveLength(1);
    later(clock, 60_000);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 1 });
    expect(chain.logs).toHaveLength(1);
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "posted", txHash: chain.logs[0]?.txHash });
  });

  it("retries a failed send with exponential backoff, searching the chain before each resend", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.failSends = 2;
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const clock = { now: NOW };
    const a = attester(store, chain, feed, clock);
    const post = () => store.getReputationPost(outcome.resolutionId, "provider");
    expect(await a.tick()).toMatchObject({ posted: 0, failed: 1 });
    expect(await post()).toMatchObject({ state: "pending", attempts: 1, note: "ECONNRESET", nextAttemptAt: new Date(NOW.getTime() + 30_000) });
    later(clock, 29_999);
    expect(await a.tick()).toMatchObject({ posted: 0, failed: 0 });
    later(clock, 1);
    expect(await a.tick()).toMatchObject({ posted: 0, failed: 1 });
    expect(await post()).toMatchObject({ attempts: 2, nextAttemptAt: new Date(NOW.getTime() + 30_000 + 60_000) });
    later(clock, 59_999);
    expect(await a.tick()).toMatchObject({ posted: 0, failed: 0 });
    later(clock, 1);
    expect(await a.tick()).toMatchObject({ posted: 1, failed: 0 });
    expect(await post()).toMatchObject({ state: "posted", attempts: 3, note: null });
    expect(chain.sends).toHaveLength(1);
    // The delay doubles up to an hour.
    expect([1, 2, 3, 8, 20].map((n) => a.delayAfter(n))).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
  });

  it("backs off when the chain is down before anything is sent, and leaves the rest of the tick for later", async () => {
    const { store, previewId } = await settled([BUYER, OTHER_BUYER]);
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const clock = { now: NOW };
    const a = attester(store, chain, feed, clock);
    // The first tick checks the owner while the chain is up; then the chain goes down.
    await a.tick();
    const first = outcomeFor(previewId, BUYER);
    const second = outcomeFor(previewId, OTHER_BUYER);
    feed.add(first, second);
    chain.down = true;
    expect(await a.tick()).toEqual({ queued: 2, posted: 0, skipped: 0, failed: 1 });
    const posts = await Promise.all([first, second].map((o) => store.getReputationPost(o.resolutionId, "provider")));
    const failed = posts.find((p) => p?.note !== null);
    const untouched = posts.find((p) => p?.note === null);
    expect(failed).toMatchObject({ attempts: 0, note: "ECONNREFUSED", nextAttemptAt: new Date(NOW.getTime() + 30_000) });
    expect(untouched).toMatchObject({ attempts: 0, nextAttemptAt: NOW });
    expect(chain.sends).toEqual([]);
    chain.down = false;
    later(clock, 30_000);
    expect(await a.tick()).toMatchObject({ posted: 2, failed: 0 });
  });

  it("sends again after a reverted transaction, which posted nothing", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.revertSends = 1;
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const clock = { now: NOW };
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 0, failed: 1 });
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ note: "REVERTED", attempts: 1 });
    later(clock, 30_000);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 1 });
    expect(chain.sends).toHaveLength(2);
    expect(chain.logs).toHaveLength(1);
  });

  it("lets only one of two attesters send an attempt", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    feed.add(outcomeFor(previewId, BUYER));
    const clock = { now: NOW };
    await Promise.all([attester(store, chain, feed, clock).tick(), attester(store, chain, feed, clock).tick()]);
    expect(chain.sends).toHaveLength(1);
  });

  it("holds a claimed post while its send is slow, so a second attester never sends it too", async () => {
    const { store, previewId } = await settled();
    const clock = { now: NOW };
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    // The first attester's send stalls before its broadcast (a degraded RPC), past the first retry delay.
    const held = chain.holdNextSend();
    const first = attester(store, chain, feed, clock).tick();
    await held.reached;
    later(clock, 31_000);
    // Another replica (or the next container in a rolling deploy) ticks meanwhile: the post is still claimed.
    expect(await attester(store, chain, feed, clock).tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
    held.release();
    expect(await first).toMatchObject({ posted: 1 });
    expect(chain.sends).toHaveLength(1);
    expect(chain.logs).toHaveLength(1);
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "posted", attempts: 1 });
  });

  it("gives up a send that outlived its claim before broadcasting it, so the attester that took over sends alone", async () => {
    const { store, previewId } = await settled();
    const clock = { now: NOW };
    // The fake, like the viem client, reads each send's deadline on the clock the attester passes with it.
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const outcome = outcomeFor(previewId, BUYER);
    feed.add(outcome);
    const held = chain.holdNextSend();
    const first = attester(store, chain, feed, clock).tick();
    await held.reached;
    // The claim lapses while the send is still stalled; a second attester takes the post over and posts it.
    later(clock, ATTEMPT_LEASE_MS + 1_000);
    expect(await attester(store, chain, feed, clock).tick()).toMatchObject({ posted: 1 });
    held.release();
    // The stalled send wakes up past its deadline and gives up without broadcasting.
    expect(await first).toMatchObject({ posted: 0, failed: 1 });
    expect(chain.sends).toHaveLength(1);
    expect(chain.logs).toHaveLength(1);
    expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "posted", attempts: 2, txHash: chain.logs[0]?.txHash });
  });

  it("queues each outcome once, even when a restarted attester reads the feed from the start", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    feed.add(outcomeFor(previewId, BUYER));
    const clock = { now: NOW };
    await attester(store, chain, feed, clock, { batch: 1 }).tick();
    feed.add(outcomeFor(nextPreviewId(), BUYER));
    expect(await attester(store, chain, feed, clock, { batch: 1 }).tick()).toMatchObject({ queued: 1, posted: 1 });
    expect(chain.sends).toHaveLength(2);
  });

  it("stops reading a feed whose cursor does not move", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    let reads = 0;
    const stuck = { read: async (cursor: string | null) => (reads++, { outcomes: [outcomeFor(previewId, BUYER)], cursor }) };
    expect(await new Attester({ store, chain, feed: stuck, providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => NOW, logger: silentLogger, batch: 1 }).tick()).toMatchObject({ queued: 1, posted: 1 });
    expect(reads).toBe(1);
  });

  it("publishes nothing for a malformed or void outcome", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const good = outcomeFor(previewId, BUYER);
    feed.add({ ...good, verdict: "void" }, { ...good, verdict: "failed" }, { ...good, buyerAgentId: "not-a-number" }, { resolutionId: 5 }, null);
    const lines: string[] = [];
    const logger = { log: (_l: string, event: string, fields?: Record<string, unknown>) => void lines.push(JSON.stringify({ event, ...fields })) };
    expect(await attester(store, chain, feed, { now: NOW }, { logger }).tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
    expect(chain.sends).toEqual([]);
    expect(lines.filter((l) => l.includes("reputation.outcome_invalid"))).toHaveLength(5);
  });

  it("never sends a post whose file names another attester or identity registry, as after a key rotation: it is skipped", async () => {
    const rotations = [new FakeChain("0x00000000000000000000000000000000000000f2"), new FakeChain(ATTESTER, "0x00000000000000000000000000000000000000e2")];
    for (const next of rotations) {
      const { store, previewId } = await settled();
      const before = new FakeChain();
      const feed = new MemoryOutcomeFeed();
      const outcome = outcomeFor(previewId, BUYER);
      const clock = { now: NOW };
      // Queued by the attester as it was configured before, which never got to send it.
      const old = attester(store, before, feed, clock);
      await old.tick();
      feed.add(outcome);
      before.down = true;
      expect(await old.tick()).toMatchObject({ queued: 1, posted: 0 });
      // Restarted with another key (or registry): the stored file names the old one, so this attester never points at it.
      later(clock, 60_000);
      const lines: string[] = [];
      const logger = { log: (_l: string, event: string, fields?: Record<string, unknown>) => void lines.push(`${event} ${String(fields?.["reason"])}`) };
      expect(await attester(store, next, feed, clock, { logger }).tick()).toEqual({ queued: 0, posted: 0, skipped: 1, failed: 0 });
      expect(next.sends).toEqual([]);
      expect(await store.getReputationPost(outcome.resolutionId, "provider")).toMatchObject({ state: "skipped", attempts: 0, note: FILE_MISMATCH });
      expect(lines).toContain(`reputation.skipped ${FILE_MISMATCH}`);
    }
  });

  it("never sends a post whose stored file is not its own: other bytes than its hash, another agent or another resolution", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    const outcome = outcomeFor(previewId, BUYER);
    const own = buildEvidence(outcome, PROVIDER_AGENT, chain);
    const otherAgent = buildEvidence(outcome, "8", chain);
    const otherResolution = outcomeFor(nextPreviewId(), BUYER).resolutionId;
    const post = { resolutionId: outcome.resolutionId, target: "provider" as const, agentId: PROVIDER_AGENT, capability: outcome.capability, value: 100 as const };
    await store.enqueueReputationPosts(
      [
        { ...post, feedbackHash: own.feedbackHash, evidence: `${own.bytes} ` },
        { ...post, target: "buyer", agentId: BUYER_AGENT, feedbackHash: otherAgent.feedbackHash, evidence: otherAgent.bytes },
        { ...post, resolutionId: otherResolution, feedbackHash: own.feedbackHash, evidence: own.bytes },
      ],
      NOW,
    );
    expect(await attester(store, chain, new MemoryOutcomeFeed(), { now: NOW }).tick()).toEqual({ queued: 0, posted: 0, skipped: 3, failed: 0 });
    expect(chain.sends).toEqual([]);
    for (const [resolutionId, target] of [[outcome.resolutionId, "provider"], [outcome.resolutionId, "buyer"], [otherResolution, "provider"]] as const) {
      expect(await store.getReputationPost(resolutionId, target)).toMatchObject({ state: "skipped", note: FILE_MISMATCH });
    }
  });

  it("stops, and says why, when the registry would take its feedback as self-feedback: it owns the provider's agent or was approved for it", async () => {
    const setups: Array<(chain: FakeChain) => void> = [
      (chain) => chain.owners.set(7n, ATTESTER),
      (chain) => chain.approvals.set(7n, ATTESTER),
      (chain) => chain.operators.set(PROVIDER, new Set([ATTESTER])),
    ];
    for (const setup of setups) {
      const { store, previewId } = await settled();
      const chain = new FakeChain();
      chain.owners.set(7n, PROVIDER);
      setup(chain);
      const feed = new MemoryOutcomeFeed();
      feed.add(outcomeFor(previewId, BUYER));
      const lines: string[] = [];
      const logger = { log: (_l: string, event: string) => void lines.push(event) };
      const a = attester(store, chain, feed, { now: NOW }, { logger });
      expect(await a.tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
      expect(await a.tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
      expect(lines).toEqual(["reputation.self_feedback"]);
      expect(chain.sends).toEqual([]);
    }
  });

  it("stops, and says why, when LEMMA_AGENT_ID names no agent", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.missingAgents.add(7n);
    const feed = new MemoryOutcomeFeed();
    feed.add(outcomeFor(previewId, BUYER));
    const lines: string[] = [];
    const logger = { log: (_l: string, event: string) => void lines.push(event) };
    const a = attester(store, chain, feed, { now: NOW }, { logger });
    expect(await a.tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
    expect(await a.tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
    expect(lines).toEqual(["reputation.no_such_agent"]);
    expect(chain.sends).toEqual([]);
  });

  it("keeps posting when the attester is only the provider agent's wallet, which the registry accepts", async () => {
    const { store, previewId } = await settled();
    const chain = new FakeChain();
    chain.owners.set(7n, PROVIDER);
    chain.wallets.set(7n, ATTESTER);
    const feed = new MemoryOutcomeFeed();
    feed.add(outcomeFor(previewId, BUYER));
    expect(await attester(store, chain, feed, { now: NOW }).tick()).toMatchObject({ posted: 1, failed: 0 });
    expect(chain.postedTo(PROVIDER_AGENT)).toHaveLength(1);
  });

  it("takes a refusal met while sending as final: it stops for the provider's agent, and skips a buyer agent's post", async () => {
    const { store, previewId } = await settled([BUYER, OTHER_BUYER]);
    const chain = new FakeChain();
    const feed = new MemoryOutcomeFeed();
    const lines: string[] = [];
    const logger = { log: (_l: string, event: string) => void lines.push(event) };
    const clock = { now: NOW };
    const a = attester(store, chain, feed, clock, { logger });
    // The buyer's agent is its own, but its owner has approved Lemma's attester for it: the registry refuses that feedback.
    chain.owners.set(42n, BUYER);
    chain.approvals.set(42n, ATTESTER);
    const opted = outcomeFor(previewId, BUYER, { buyerAgentId: BUYER_AGENT });
    feed.add(opted);
    expect(await a.tick()).toEqual({ queued: 2, posted: 1, skipped: 1, failed: 0 });
    expect(await store.getReputationPost(opted.resolutionId, "buyer")).toMatchObject({ state: "skipped", note: "SELF_FEEDBACK" });
    expect(chain.postedTo(BUYER_AGENT)).toEqual([]);

    // Later the provider agent's owner approves the attester: the next send is refused, and the attester stops.
    chain.approvals.set(7n, ATTESTER);
    const next = outcomeFor(previewId, OTHER_BUYER);
    feed.add(next);
    later(clock, 60_000);
    expect(await a.tick()).toMatchObject({ queued: 1, posted: 0, failed: 1 });
    expect(lines.filter((l) => l === "reputation.self_feedback")).toHaveLength(1);
    const left = await store.getReputationPost(next.resolutionId, "provider");
    expect(left).toMatchObject({ state: "pending", attempts: 1, note: "SELF_FEEDBACK" });
    // It is not retried: the attester has stopped until it is restarted with a key the registry accepts.
    later(clock, 3_600_000);
    expect(await a.tick()).toEqual({ queued: 0, posted: 0, skipped: 0, failed: 0 });
    expect(await store.getReputationPost(next.resolutionId, "provider")).toMatchObject({ attempts: 1 });
  });

  it("never throws, whatever fails", async () => {
    const chain = new FakeChain();
    chain.down = true;
    const feed = { read: async () => Promise.reject(new Error("feed down")) };
    const store = new MemoryStore();
    await expect(new Attester({ store, chain, feed, providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => NOW, logger: silentLogger }).tick()).resolves.toMatchObject({ posted: 0 });
    chain.down = false;
    await expect(new Attester({ store, chain, feed, providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => NOW, logger: silentLogger }).tick()).resolves.toMatchObject({ posted: 0 });
    const broken = Object.assign(Object.create(store) as MemoryStore, { dueReputationPosts: async () => Promise.reject(new Error("db down")) });
    await expect(new Attester({ store: broken, chain, feed: new MemoryOutcomeFeed(), providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => NOW, logger: silentLogger }).tick()).resolves.toMatchObject({ posted: 0 });
  });
});

