import { resolve } from "@lemma/catalog";
import {
  type Address,
  type AdoptionReceipt,
  type Hex32,
  type Preview,
  ResolutionDelivery,
  type WarrantyOutcome,
  type WarrantyVoucher,
  adoptionReceiptDigest,
  deriveResolutionId,
} from "@lemma/core";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type LemmaStore,
  MIGRATIONS_FOLDER,
  MemoryStore,
  PgStore,
  type RegistryEventRow,
  ResolutionService,
  demandBucket,
  schemaIsCurrent,
  silentLogger,
} from "../src/index.js";
import { BUYER, NOW, PROVIDER, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";

const OTHER_BUYER = "0x00000000000000000000000000000000000000c1";
const LATER = new Date(NOW.getTime() + 60_000);
/** After every test payment's authorization window, when the reconciler may expire it. */
const AFTER_WINDOW = new Date(NOW.getTime() + 600_000);
const payment = (payer = BUYER, nonce = "0x01") => ({ payer, nonce, validBefore: new Date(NOW.getTime() + 300_000) });
const settled = (nonce = "0x01", settlementRef = "0xsettlement") => ({ nonce, settlementRef });

let pglite: PGlite;
let pgDb: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pglite = new PGlite();
  pgDb = drizzle(pglite);
  expect((await schemaIsCurrent(pgDb)).current).toBe(false);
  await migrate(pgDb, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

const stores: Array<[string, () => Promise<LemmaStore>]> = [
  ["memory", async () => new MemoryStore()],
  [
    "postgres (PGlite)",
    async () => {
      await pgDb.execute(sql`truncate releases, bundles, catalog_snapshots, previews, resolutions, adoption_receipts, demand_salts, demand_seen, demand_daily, reputation_posts, warranty_actions, registry_events, chain_cursors`);
      return new PgStore(pgDb);
    },
  ],
];

describe("migrations", () => {
  it("brings an empty database to the schema this build expects", async () => {
    expect(await schemaIsCurrent(pgDb)).toMatchObject({ current: true });
  });
});

describe.each(stores)("ResolutionService on the %s store", (_name, makeStore) => {
  let store: LemmaStore;
  let service: ResolutionService;
  let offer: Preview;

  beforeEach(async () => {
    store = await makeStore();
    service = new ResolutionService(store, () => LATER, silentLogger);
    const index = sellableIndex();
    await store.saveCatalog(index, NOW);
    await store.saveCatalog(index, NOW);
    offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(offer);
  });

  it("quotes exactly the stored offer terms, and refuses unknown or expired quotes", async () => {
    const quote = await service.quote(offer.previewId);
    expect(quote.ok && quote.terms).toEqual("offer" in offer && offer.offer?.terms);
    expect(await service.quote(`0x${"99".repeat(32)}`)).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await service.quote(offer.previewId, new Date("2026-10-01T00:15:00.000Z"))).toEqual({ ok: false, reason: "QUOTE_EXPIRED" });
  });

  it("prepares once per preview and payer; a second payment is refused while one is in flight", async () => {
    const first = await service.prepare(offer.previewId, payment());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.resolution.resolutionId).toBe(deriveResolutionId(offer.previewId, BUYER));
    expect(first.resolution.buyer).toBe(BUYER);
    expect(await service.prepare(offer.previewId, payment(BUYER, "0x02"))).toEqual({ ok: false, reason: "IN_FLIGHT" });
    const other = await service.prepare(offer.previewId, payment(OTHER_BUYER));
    expect(other.ok && other.resolution.resolutionId).toBe(deriveResolutionId(offer.previewId, OTHER_BUYER));
  });

  it("recovers only after settlement, and refuses to sell a settled resolution again", async () => {
    await service.prepare(offer.previewId, payment());
    expect(await service.recover(offer.previewId, BUYER)).toBe("IN_FLIGHT");
    await service.commit(deriveResolutionId(offer.previewId, BUYER), settled());
    const delivered = await service.recover(offer.previewId, BUYER);
    expect(ResolutionDelivery.safeParse(delivered).success).toBe(true);
    expect(await service.prepare(offer.previewId, payment())).toEqual({ ok: false, reason: "ALREADY_SETTLED" });
    expect(await service.recover(offer.previewId, OTHER_BUYER)).toBe("NOT_FOUND");
  });

  it("lets the reconciler expire an authorization, after which a new payment re-arms the resolution", async () => {
    await service.prepare(offer.previewId, payment());
    const id = deriveResolutionId(offer.previewId, BUYER);
    const reconciler = new ResolutionService(store, () => AFTER_WINDOW, silentLogger);
    expect((await service.listUnsettled(AFTER_WINDOW)).map((r) => r.resolutionId)).toEqual([id]);
    expect(await service.listUnsettled(NOW)).toEqual([]);
    // Not while the authorization's window is open, and not for another authorization.
    expect(await service.expire(id, "0x01")).toBe(false);
    expect(await reconciler.expire(id, "0x09")).toBe(false);
    expect(await reconciler.expire(id, "0x01")).toBe(true);
    expect(await reconciler.expire(id, "0x01")).toBe(false);
    expect(await service.recover(offer.previewId, BUYER)).toBe("NOT_FOUND");
    const again = await service.prepare(offer.previewId, payment(BUYER, "0x03"));
    expect(again.ok).toBe(true);
    expect((await store.getResolution(id))?.nonce).toBe("0x03");
  });

  it("never lets a stale reconciler decision or settlement land on a re-armed resolution", async () => {
    const id = deriveResolutionId(offer.previewId, BUYER);
    const reconciler = new ResolutionService(store, () => AFTER_WINDOW, silentLogger);
    await service.prepare(offer.previewId, payment(BUYER, "0x01"));
    await reconciler.expire(id, "0x01");
    await service.prepare(offer.previewId, { ...payment(BUYER, "0x02"), validBefore: new Date(AFTER_WINDOW.getTime() + 300_000) });
    // A second reconciler that judged 0x01 earlier finishes now: the row holds 0x02, whose window is open.
    expect(await reconciler.expire(id, "0x01")).toBe(false);
    expect(await reconciler.expire(id, "0x02")).toBe(false);
    await service.commit(id, settled("0x01"));
    expect((await store.getResolution(id))?.state).toBe("prepared");
    await service.commit(id, settled("0x02"));
    expect((await store.getResolution(id))?.state).toBe("settled");
  });

  it("lets one authorization back one resolution only, whatever the nonce's case", async () => {
    const index = sellableIndex();
    const second = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(second);
    expect((await service.prepare(offer.previewId, payment(BUYER, "0xab"))).ok).toBe(true);
    expect(await service.prepare(second.previewId, payment(BUYER, "0xAB"))).toEqual({ ok: false, reason: "PAYMENT_REUSED" });
    expect(await store.getResolution(deriveResolutionId(second.previewId, BUYER))).toBeUndefined();
    // Another payer may use the same nonce: nonces are per authorizer.
    expect((await service.prepare(second.previewId, payment(OTHER_BUYER, "0xab"))).ok).toBe(true);
    // Re-arming an expired resolution with an authorization that backs another one is refused too.
    const reconciler = new ResolutionService(store, () => AFTER_WINDOW, silentLogger);
    await reconciler.expire(deriveResolutionId(second.previewId, OTHER_BUYER), "0xab");
    expect(await service.prepare(second.previewId, payment(OTHER_BUYER, "0xab"))).toMatchObject({ ok: true });
    await reconciler.expire(deriveResolutionId(second.previewId, OTHER_BUYER), "0xab");
    await service.prepare(offer.previewId, payment(OTHER_BUYER, "0xcd"));
    expect(await service.prepare(second.previewId, payment(OTHER_BUYER, "0xcd"))).toEqual({ ok: false, reason: "PAYMENT_REUSED" });
  });

  it("settles each resolution by its own authorization, once, even when one transaction used several", async () => {
    const index = sellableIndex();
    const second = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(second);
    const first = deriveResolutionId(offer.previewId, BUYER);
    const other = deriveResolutionId(second.previewId, BUYER);
    await service.prepare(offer.previewId, payment(BUYER, "0x01"));
    await service.prepare(second.previewId, payment(BUYER, "0x02"));
    // A transaction settles only the row whose authorization it names.
    expect(await service.commit(other, settled("0x01", "0xtx"))).toBe("UNCHANGED");
    // Anyone may submit EIP-3009 authorizations: one transaction (a multicall, say) used both, and each was a payment.
    expect(await service.commit(first, settled("0x01", "0xtx"))).toBe("COMMITTED");
    expect(await service.commit(other, settled("0x02", "0xtx"))).toBe("COMMITTED");
    for (const id of [first, other]) expect(await store.getResolution(id)).toMatchObject({ state: "settled", settlementRef: "0xtx" });
    // Each authorization settles once: a later settlement never replaces the recorded one.
    expect(await service.commit(first, settled("0x01", "0xlater"))).toBe("UNCHANGED");
    expect((await store.getResolution(first))?.settlementRef).toBe("0xtx");
  });

  it("commits without ever throwing, and says whether the row changed", async () => {
    await expect(service.commit(`0x${"77".repeat(32)}`, settled("0x01", "0xnothing"))).resolves.toBe("UNCHANGED");
    const failing = new ResolutionService(
      Object.assign(Object.create(store) as LemmaStore, { markSettled: async () => { throw new Error("database down"); } }),
      () => LATER,
      silentLogger,
    );
    await expect(failing.commit(deriveResolutionId(offer.previewId, BUYER), settled())).resolves.toBe("FAILED");
    await service.prepare(offer.previewId, payment());
    await expect(service.commit(deriveResolutionId(offer.previewId, BUYER), settled())).resolves.toBe("COMMITTED");
    await expect(service.commit(deriveResolutionId(offer.previewId, BUYER), settled())).resolves.toBe("UNCHANGED");
  });

  it("lists unsettled rows oldest window first, in pages that resume after a cursor", async () => {
    const index = sellableIndex();
    const payers = ["0x00000000000000000000000000000000000000d1", "0x00000000000000000000000000000000000000d2", "0x00000000000000000000000000000000000000d3", "0x00000000000000000000000000000000000000d4"] as const;
    // Two rows share a window end, so the resolution id orders them.
    const windows = [NOW.getTime() + 300_000, NOW.getTime() + 200_000, NOW.getTime() + 300_000, NOW.getTime() + 100_000];
    for (const [i, payer] of payers.entries()) {
      const preview = resolve({ task: gatingTask, profile: matchingProfile }, index, {
        now: NOW,
        previewId: nextPreviewId(),
        payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
        offerTtlSeconds: 900,
      });
      await store.saveOffer(preview);
      expect((await service.prepare(preview.previewId, { payer, nonce: `0x0${i + 1}`, validBefore: new Date(windows[i] as number) })).ok).toBe(true);
    }
    const all = await service.listUnsettled(AFTER_WINDOW, 10);
    expect(all).toHaveLength(4);
    const order = all.map((r) => [r.validBefore.getTime(), r.resolutionId] as const);
    expect(order).toEqual([...order].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)));
    const pages: string[] = [];
    let after: { validBefore: Date; resolutionId: Hex32 } | undefined;
    for (;;) {
      const page = await service.listUnsettled(AFTER_WINDOW, 1, after);
      const last = page[0];
      if (last === undefined) break;
      pages.push(last.resolutionId);
      after = { validBefore: last.validBefore, resolutionId: last.resolutionId };
    }
    expect(pages).toEqual(all.map((r) => r.resolutionId));
  });

  it("accepts one receipt per settled resolution, only from the buyer, unverified until its signature is checked", async () => {
    const id = deriveResolutionId(offer.previewId, BUYER);
    const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: id, outcome: "passed", acceptance: { exitCode: 0, durationMs: 1000, outputDigest: null }, recordedAt: "2026-10-01T00:02:00.000Z", signature: null };
    const submit = (r: AdoptionReceipt, previewId: Hex32 = offer.previewId) => service.acceptReceipt({ receipt: r, previewId });
    expect(await submit(receipt)).toBe("UNKNOWN_RESOLUTION");
    await service.prepare(offer.previewId, payment());
    expect(await submit(receipt)).toBe("NOT_SETTLED");
    await service.commit(id, settled());
    // Whoever knows only the public resolution id cannot take the receipt slot.
    expect(await submit({ ...receipt, outcome: "abandoned", acceptance: { exitCode: null, durationMs: 1, outputDigest: null } }, `0x${"99".repeat(32)}`)).toBe("UNKNOWN_RESOLUTION");
    expect(await submit({ ...receipt, recordedAt: "2026-09-30T00:00:00.000Z" })).toBe("MISMATCH");
    expect(await submit({ ...receipt, recordedAt: "2030-01-01T00:00:00.000Z" })).toBe("TOO_EARLY");
    // A buyer clock a minute slow dates the receipt before the resolution; that is skew, not a mismatch.
    expect(await submit({ ...receipt, recordedAt: "2026-10-01T00:00:00.000Z" })).toBe("ACCEPTED");
    expect(await submit({ ...receipt, outcome: "failed", acceptance: { exitCode: 1, durationMs: 1, outputDigest: null } })).toBe("DUPLICATE");
    await expect(submit({ ...receipt, outcome: "passed", acceptance: { exitCode: 3, durationMs: 1, outputDigest: null } })).rejects.toThrow();
    expect(await service.publicResolution(id)).toEqual({
      resolutionId: id,
      state: "settled",
      release: "release" in offer ? offer.release : undefined,
      payloadDigest: expect.any(String),
      terms: "offer" in offer ? offer.offer?.terms : undefined,
      createdAt: LATER.toISOString(),
      receipt: { outcome: "passed", verified: false },
    });
    const view = JSON.stringify(await service.publicResolution(id));
    expect(view).not.toContain(offer.previewId.slice(2));
    expect(view).not.toContain(BUYER.slice(2));
  });

  it("stores the ERC-8004 agent id a buyer opted in with, next to its receipt", async () => {
    const id = deriveResolutionId(offer.previewId, BUYER);
    const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: id, outcome: "passed", acceptance: { exitCode: 0, durationMs: 1000, outputDigest: null }, recordedAt: "2026-10-01T00:02:00.000Z", signature: null };
    await service.prepare(offer.previewId, payment());
    await service.commit(id, settled());
    await expect(service.acceptReceipt({ receipt, previewId: offer.previewId, agentId: "01" })).rejects.toThrow();
    expect(await service.acceptReceipt({ receipt, previewId: offer.previewId, agentId: "42" })).toBe("ACCEPTED");
    expect(await store.getReceipt(id)).toMatchObject({ verified: false, buyerAgentId: "42" });
    // The first write wins, agent id included.
    expect(await service.acceptReceipt({ receipt, previewId: offer.previewId, agentId: "43" })).toBe("DUPLICATE");
    expect((await store.getReceipt(id))?.buyerAgentId).toBe("42");
    const other = deriveResolutionId(offer.previewId, OTHER_BUYER);
    await service.prepare(offer.previewId, payment(OTHER_BUYER, "0x07"));
    await service.commit(other, settled("0x07", "0xother"));
    expect(await service.acceptReceipt({ receipt: { ...receipt, resolutionId: other }, previewId: offer.previewId })).toBe("ACCEPTED");
    expect((await store.getReceipt(other))?.buyerAgentId).toBeNull();
  });

  it("keeps one reputation post per resolution and target, changed only by the attester that read it", async () => {
    const a = `0x${"a1".repeat(32)}` as Hex32;
    const b = `0x${"b2".repeat(32)}` as Hex32;
    // Each target has its own file (it names the agent), and so its own hash.
    const post = (resolutionId: Hex32, target: "provider" | "buyer", evidence = `{"r":"${resolutionId}","t":"${target}"}`) => ({
      resolutionId,
      target,
      agentId: target === "provider" ? "7" : "42",
      capability: "mcp-server.add-payment-gating" as const,
      value: 100 as const,
      feedbackHash: `0x${(target === "provider" ? "cc" : "cd").repeat(32)}` as Hex32,
      evidence,
    });
    expect(await store.enqueueReputationPosts([], NOW)).toBe(0);
    expect(await store.enqueueReputationPosts([post(a, "provider"), post(a, "buyer")], NOW)).toBe(2);
    // Queued again (a restart re-reads the feed): nothing changes, and the first file stays.
    expect(await store.enqueueReputationPosts([post(a, "provider", "{}"), post(b, "provider")], LATER)).toBe(1);
    expect(await store.getReputationPost(a, "provider")).toMatchObject({ evidence: `{"r":"${a}","t":"provider"}`, feedbackHash: `0x${"cc".repeat(32)}` });
    expect(await store.getReputationPost(a, "buyer")).toMatchObject({ evidence: `{"r":"${a}","t":"buyer"}`, feedbackHash: `0x${"cd".repeat(32)}` });
    expect(await store.getReputationPost(`0x${"dd".repeat(32)}`, "provider")).toBeUndefined();
    expect(await store.getReputationPost(b, "buyer")).toBeUndefined();

    // Both rows of `a` were queued at NOW, before `b`; their order between themselves is not fixed.
    expect((await store.dueReputationPosts(NOW, 10)).map((p) => `${p.resolutionId}/${p.target}`).sort()).toEqual([`${a}/buyer`, `${a}/provider`]);
    expect(await store.dueReputationPosts(LATER, 10)).toHaveLength(3);
    expect(await store.dueReputationPosts(LATER, 1)).toHaveLength(1);

    // Begin an attempt: only for the attempts it read, so two attesters never both send it.
    const retryAt = new Date(LATER.getTime() + 60_000);
    expect(await store.updateReputationPost(a, "provider", 0, { attempts: 1, fromBlock: "12345", nextAttemptAt: retryAt }, LATER)).toBe(true);
    expect(await store.updateReputationPost(a, "provider", 0, { attempts: 1, fromBlock: "99999", nextAttemptAt: retryAt }, LATER)).toBe(false);
    expect(await store.getReputationPost(a, "provider")).toMatchObject({ state: "pending", attempts: 1, fromBlock: "12345", nextAttemptAt: retryAt, txHash: null, note: null });
    expect((await store.dueReputationPosts(LATER, 10)).map((p) => `${p.resolutionId}/${p.target}`)).not.toContain(`${a}/provider`);
    expect((await store.dueReputationPosts(retryAt, 10)).some((p) => p.resolutionId === a && p.target === "provider")).toBe(true);

    const tx = `0x${"ee".repeat(32)}` as Hex32;
    expect(await store.updateReputationPost(a, "provider", 1, { txHash: tx, note: "sent" }, LATER)).toBe(true);
    expect(await store.updateReputationPost(a, "provider", 1, { state: "posted", note: null }, LATER)).toBe(true);
    expect(await store.getReputationPost(a, "provider")).toMatchObject({ state: "posted", attempts: 1, txHash: tx, note: null, fromBlock: "12345" });
    // Final: never due, never changed again.
    expect(await store.updateReputationPost(a, "provider", 1, { state: "pending" }, LATER)).toBe(false);
    expect(await store.dueReputationPosts(retryAt, 10)).not.toContainEqual(expect.objectContaining({ resolutionId: a, target: "provider" }));
    expect(await store.updateReputationPost(a, "buyer", 0, { state: "skipped", note: "AGENT_NOT_BUYER" }, LATER)).toBe(true);
    expect(await store.getReputationPost(a, "buyer")).toMatchObject({ state: "skipped", note: "AGENT_NOT_BUYER", agentId: "42", value: 100 });
    expect((await store.dueReputationPosts(retryAt, 10)).map((p) => [p.resolutionId, p.target])).toEqual([[b, "provider"]]);
  });

  it("counts distinct profiles and sources per bucket and day, and publishes only buckets with at least five of each", async () => {
    const bucket = demandBucket(offer, gatingTask.capability, matchingProfile);
    const digest = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex32;
    for (const i of [1, 1, 2, 3, 4]) await store.recordDemand("2026-09-30", bucket, digest(i), `10.0.0.${i}`);
    for (const i of [1, 2, 3, 4, 5]) await store.recordDemand("2026-09-30", "other", digest(i), `10.0.0.${i}`);
    // One caller making up five profiles is still one source.
    for (const i of [1, 2, 3, 4, 5]) await store.recordDemand("2026-09-30", "sybil", digest(i), "10.9.9.9");
    await store.recordDemand("2026-10-01", bucket, digest(9), "10.0.0.9");
    expect(await store.closeDemandDaysBefore("2026-10-01")).toBe(1);
    expect(await store.demandBuckets(5)).toEqual([{ day: "2026-09-30", bucket: "other", profiles: 5, sources: 5 }]);
    expect(await store.demandBuckets(1)).toContainEqual({ day: "2026-09-30", bucket, profiles: 4, sources: 4 });
    expect(await store.demandBuckets(1)).toContainEqual({ day: "2026-09-30", bucket: "sybil", profiles: 5, sources: 1 });
    expect(await store.closeDemandDaysBefore("2026-10-01")).toBe(0);
    // A late write for a closed day does not reopen it.
    await store.recordDemand("2026-09-30", "other", digest(6), "10.0.0.6");
    await store.closeDemandDaysBefore("2026-10-01");
    expect(await store.demandBuckets(5)).toEqual([{ day: "2026-09-30", bucket: "other", profiles: 5, sources: 5 }]);
  });

  it("purges long-expired offers unless a settled resolution needs them, and expired resolutions with them", async () => {
    await service.prepare(offer.previewId, payment());
    await service.commit(deriveResolutionId(offer.previewId, BUYER), settled());
    const index = sellableIndex();
    const unbought = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(unbought);
    // Prepared, then expired unpaid: neither the row nor its preview is kept past retention.
    await service.prepare(unbought.previewId, payment(OTHER_BUYER, "0x05"));
    await new ResolutionService(store, () => AFTER_WINDOW, silentLogger).expire(deriveResolutionId(unbought.previewId, OTHER_BUYER), "0x05");
    expect(await store.purgeExpiredOffers(new Date("2026-10-02T00:00:00.000Z"))).toBe(1);
    expect(await store.getPreview(unbought.previewId)).toBeUndefined();
    expect(await store.getResolution(deriveResolutionId(unbought.previewId, OTHER_BUYER))).toBeUndefined();
    expect(await store.getPreview(offer.previewId)).toBeDefined();
    expect((await store.getResolution(deriveResolutionId(offer.previewId, BUYER)))?.state).toBe("settled");
  });

  it("keeps the claim hash with the resolution, and takes the new payment's on a re-arm", async () => {
    const id = deriveResolutionId(offer.previewId, BUYER);
    const first = `0x${"c1".repeat(32)}`;
    const second = `0x${"c2".repeat(32)}`;
    await service.prepare(offer.previewId, payment(BUYER, "0x01"), LATER, first);
    expect((await store.getResolution(id))?.claimHash).toBe(first);
    // A payment still in flight does not replace it.
    await service.prepare(offer.previewId, payment(BUYER, "0x02"), LATER, second);
    expect((await store.getResolution(id))?.claimHash).toBe(first);
    await new ResolutionService(store, () => AFTER_WINDOW, silentLogger).expire(id, "0x01");
    await service.prepare(offer.previewId, { ...payment(BUYER, "0x03"), validBefore: new Date(AFTER_WINDOW.getTime() + 300_000) }, LATER, second);
    expect((await store.getResolution(id))?.claimHash).toBe(second);
    // Without one, it is null.
    await service.prepare(offer.previewId, payment(OTHER_BUYER, "0x04"));
    expect((await store.getResolution(deriveResolutionId(offer.previewId, OTHER_BUYER)))?.claimHash).toBeNull();
  });

  it("lists receipts until the signature check reaches a verdict, and records each verdict once for the stored receipt", async () => {
    const id = deriveResolutionId(offer.previewId, BUYER);
    await service.prepare(offer.previewId, payment());
    await service.commit(id, settled());
    const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: id, outcome: "passed", acceptance: { exitCode: 0, durationMs: 1000, outputDigest: null }, recordedAt: "2026-10-01T00:02:00.000Z", signature: `0x${"ab".repeat(65)}` };
    expect(await service.acceptReceipt({ receipt, previewId: offer.previewId })).toBe("ACCEPTED");
    const unchecked = await store.listUncheckedReceipts(10);
    expect(unchecked).toEqual([{ receipt, receiptDigest: adoptionReceiptDigest(receipt) }]);
    // Never for another receipt's digest.
    expect(await store.markReceiptVerified(id, `0x${"99".repeat(32)}`, LATER)).toBe(false);
    expect(await store.markReceiptVerified(id, adoptionReceiptDigest(receipt), LATER)).toBe(true);
    expect(await store.markReceiptVerified(id, adoptionReceiptDigest(receipt), LATER)).toBe(false);
    expect(await store.markReceiptChecked(id, adoptionReceiptDigest(receipt), LATER)).toBe(false);
    expect(await store.listUncheckedReceipts(10)).toEqual([]);
    expect(await store.getReceipt(id)).toEqual({ receipt, verified: true, buyerAgentId: null });
    expect((await service.publicResolution(id))?.receipt).toEqual({ outcome: "passed", verified: true });

    // A verdict that leaves the receipt unverified also ends the checks.
    const otherId = deriveResolutionId(offer.previewId, OTHER_BUYER);
    await service.prepare(offer.previewId, payment(OTHER_BUYER, "0x07"));
    await service.commit(otherId, settled("0x07", "0xother"));
    const unsigned: AdoptionReceipt = { ...receipt, resolutionId: otherId, signature: null };
    expect(await service.acceptReceipt({ receipt: unsigned, previewId: offer.previewId })).toBe("ACCEPTED");
    expect(await store.markReceiptChecked(otherId, adoptionReceiptDigest(unsigned), LATER)).toBe(true);
    expect(await store.listUncheckedReceipts(10)).toEqual([]);
    expect(await store.getReceipt(otherId)).toEqual({ receipt: unsigned, verified: false, buyerAgentId: null });
  });
});

describe.each(stores)("the warranty outbox and registry index on the %s store", (_name, makeStore) => {
  let store: LemmaStore;
  let service: ResolutionService;
  const index = sellableIndex();
  const releaseDigest = index.releases[0]!.releaseDigest;
  const DAY = 86_400_000;

  beforeEach(async () => {
    store = await makeStore();
    service = new ResolutionService(store, () => LATER, silentLogger);
    await store.saveCatalog(index, NOW);
  });

  let nonce = 0;
  /** A settled resolution of `payer`, bought from a fresh offer, with a claim hash unless `claimHash` is null. */
  async function settledResolution(payer: Address = BUYER, claimHash: Hex32 | null = `0x${"c1".repeat(32)}`): Promise<{ id: Hex32; previewId: Hex32 }> {
    const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(offer);
    const n = `0x${(++nonce).toString(16).padStart(4, "0")}`;
    const prepared = await service.prepare(offer.previewId, payment(payer, n), LATER, claimHash);
    if (!prepared.ok) throw new Error(prepared.reason);
    const id = deriveResolutionId(offer.previewId, payer);
    expect(await service.commit(id, settled(n, `0x${"5e".repeat(32)}`))).toBe("COMMITTED");
    return { id, previewId: offer.previewId };
  }

  const voucher = (resolutionId: Hex32, over: Partial<WarrantyVoucher> = {}): WarrantyVoucher => ({
    schemaVersion: "1",
    resolutionId,
    releaseDigest,
    profileIndex: 0,
    amount: "250000",
    paymentRef: `0x${"7e".repeat(32)}`,
    claimHash: `0x${"c1".repeat(32)}`,
    activateBy: 1_790_000_000,
    ...over,
  });
  const outcome = (resolutionId: Hex32, over: Partial<WarrantyOutcome> = {}): WarrantyOutcome => ({
    schemaVersion: "1",
    resolutionId,
    verdict: "passed",
    weightBps: 10_000,
    evidenceHash: `0x${"ee".repeat(32)}`,
    validUntil: 1_790_003_600,
    ...over,
  });
  const txOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
  const event = (over: Partial<RegistryEventRow> & Pick<RegistryEventRow, "name" | "blockNumber" | "logIndex">): RegistryEventRow => ({
    txHash: txOf(Number(over.blockNumber) * 100 + over.logIndex),
    blockTime: new Date(NOW.getTime() + Number(over.blockNumber) * 1000),
    resolutionId: null,
    releaseDigest: null,
    profileIndex: null,
    verdict: null,
    weightBps: null,
    evidenceHash: null,
    amount: null,
    claimDeadline: null,
    engine: null,
    ...over,
  });
  const activated = (resolutionId: Hex32, blockNumber: bigint, claimDeadline: bigint, profileIndex = 0) =>
    event({ name: "ResolutionActivated", blockNumber, logIndex: 0, resolutionId, releaseDigest, profileIndex, amount: "250000", claimDeadline });
  const finalized = (resolutionId: Hex32, blockNumber: bigint, verdict: number, weightBps = 10_000, blockTime?: Date) =>
    event({ name: "OutcomeFinalized", blockNumber, logIndex: 1, resolutionId, releaseDigest, verdict, weightBps, evidenceHash: `0x${"ee".repeat(32)}`, ...(blockTime === undefined ? {} : { blockTime }) });
  let cursor: bigint | undefined;
  /** Stores events as the indexer does, moving the cursor on. */
  async function index_(events: RegistryEventRow[]): Promise<void> {
    const next = (cursor ?? 0n) + 100n;
    expect(await store.advanceChainCursor("warranty-registry", cursor, next, events, NOW)).toBe(true);
    cursor = next;
  }
  beforeEach(() => {
    cursor = undefined;
  });

  it("keeps one action per resolution and kind, changed only by the job that read its state and attempts", async () => {
    const id = `0x${"a1".repeat(32)}` as Hex32;
    const due = new Date(NOW.getTime() + 60_000);
    expect(await store.insertWarrantyAction({ resolutionId: id, kind: "activate", payload: voucher(id), signature: null, state: "queued", nextAttemptAt: due }, NOW)).toBe(true);
    // The same kind again keeps the first; another kind is its own row.
    expect(await store.insertWarrantyAction({ resolutionId: id, kind: "activate", payload: voucher(id, { amount: "1" }), signature: null, state: "queued", nextAttemptAt: NOW }, NOW)).toBe(false);
    expect(await store.insertWarrantyAction({ resolutionId: id, kind: "finalize", payload: outcome(id), signature: null, state: "review", nextAttemptAt: NOW }, NOW)).toBe(true);
    expect(await store.getWarrantyAction(id, "activate")).toEqual({
      resolutionId: id,
      kind: "activate",
      payload: voucher(id),
      signature: null,
      state: "queued",
      attempts: 0,
      nextAttemptAt: due,
      txHash: null,
      sentAt: null,
      lastCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await store.getWarrantyAction(id, "expire")).toBeUndefined();

    // Due only once its time has come, by kind; an action in review never is.
    expect(await store.dueWarrantyActions("activate", NOW, 10)).toEqual([]);
    expect((await store.dueWarrantyActions("activate", due, 10)).map((a) => a.resolutionId)).toEqual([id]);
    expect(await store.dueWarrantyActions("finalize", due, 10)).toEqual([]);
    expect((await store.listWarrantyActions({ state: "review" }, 10)).map((a) => [a.resolutionId, a.kind])).toEqual([[id, "finalize"]]);
    expect(await store.listWarrantyActions({ kind: "activate", state: "review" }, 10)).toEqual([]);

    // Claiming an attempt: only for the state and attempts read, so two jobs never both send it.
    const signature = `0x${"ab".repeat(65)}`;
    const lease = new Date(NOW.getTime() + 300_000);
    const claim = { state: "sent" as const, attempts: 1, payload: voucher(id, { activateBy: 1_790_000_900 }), signature, nextAttemptAt: lease };
    expect(await store.updateWarrantyAction(id, "activate", { state: "queued", attempts: 1 }, claim, LATER)).toBe(false);
    expect(await store.updateWarrantyAction(id, "activate", { state: "sent", attempts: 0 }, claim, LATER)).toBe(false);
    expect(await store.updateWarrantyAction(id, "activate", { state: "queued", attempts: 0 }, claim, LATER)).toBe(true);
    expect(await store.updateWarrantyAction(id, "activate", { state: "queued", attempts: 0 }, claim, LATER)).toBe(false);
    const tx = txOf(7);
    expect(await store.updateWarrantyAction(id, "activate", { state: "sent", attempts: 1 }, { txHash: tx, sentAt: LATER }, LATER)).toBe(true);
    expect(await store.getWarrantyAction(id, "activate")).toMatchObject({ state: "sent", attempts: 1, payload: voucher(id, { activateBy: 1_790_000_900 }), signature, txHash: tx, sentAt: LATER, nextAttemptAt: lease, updatedAt: LATER });
    // A sent action is due again at its lease's end, for the checks before any resend.
    expect((await store.dueWarrantyActions("activate", lease, 10)).map((a) => a.state)).toEqual(["sent"]);

    // Final states never change.
    expect(await store.updateWarrantyAction(id, "activate", { state: "sent", attempts: 1 }, { state: "done", lastCode: null }, LATER)).toBe(true);
    expect(await store.updateWarrantyAction(id, "activate", { state: "done", attempts: 1 }, { state: "queued" }, LATER)).toBe(false);
    expect(await store.dueWarrantyActions("activate", new Date(lease.getTime() + DAY), 10)).toEqual([]);
    expect((await store.getWarrantyAction(id, "activate"))?.state).toBe("done");
  });

  it("refuses a payload that does not fit its action, and keeps a withdrawal's claim only until it is over", async () => {
    const id = `0x${"a2".repeat(32)}` as Hex32;
    const other = `0x${"a3".repeat(32)}` as Hex32;
    await expect(store.insertWarrantyAction({ resolutionId: id, kind: "activate", payload: voucher(other), signature: null, state: "queued", nextAttemptAt: NOW }, NOW)).rejects.toThrow();
    await expect(store.insertWarrantyAction({ resolutionId: id, kind: "expire", payload: voucher(id), signature: null, state: "queued", nextAttemptAt: NOW }, NOW)).rejects.toThrow();
    await expect(store.insertWarrantyAction({ resolutionId: id, kind: "finalize", payload: outcome(id), signature: "0x12", state: "queued", nextAttemptAt: NOW }, NOW)).rejects.toThrow();
    expect(await store.getWarrantyAction(id, "activate")).toBeUndefined();

    const claim = { schemaVersion: "1" as const, resolutionId: id, claimSecret: `0x${"5c".repeat(32)}` as Hex32, to: "0x00000000000000000000000000000000000000d9" };
    expect(await store.insertWarrantyAction({ resolutionId: id, kind: "withdraw", payload: claim, signature: null, state: "queued", nextAttemptAt: NOW }, NOW)).toBe(true);
    expect((await store.getWarrantyAction(id, "withdraw"))?.payload).toEqual(claim);
    expect(await store.updateWarrantyAction(id, "withdraw", { state: "queued", attempts: 0 }, { state: "done", payload: { schemaVersion: "1", resolutionId: id } }, LATER)).toBe(true);
    const done = await store.getWarrantyAction(id, "withdraw");
    expect(done?.payload).toEqual({ schemaVersion: "1", resolutionId: id });
    expect(JSON.stringify(done)).not.toContain("5c5c5c");
  });

  it("stores each registry log once, and moves the cursor only with the rows, only from where it was", async () => {
    const a = `0x${"b1".repeat(32)}` as Hex32;
    expect(await store.getChainCursor("warranty-registry")).toBeUndefined();
    const first = [activated(a, 10n, 1_790_100_000n), event({ name: "EngineSet", blockNumber: 5n, logIndex: 3, engine: "0x00000000000000000000000000000000000000e9" })];
    expect(await store.advanceChainCursor("warranty-registry", undefined, 11n, first, NOW)).toBe(true);
    expect(await store.getChainCursor("warranty-registry")).toBe(11n);
    // A second reader that read the same range: its cursor is stale, so nothing changes.
    expect(await store.advanceChainCursor("warranty-registry", undefined, 12n, [finalized(a, 11n, 1)], NOW)).toBe(false);
    expect(await store.advanceChainCursor("warranty-registry", 5n, 12n, [finalized(a, 11n, 1)], NOW)).toBe(false);
    expect(await store.listRegistryEvents({}, 10)).toHaveLength(2);
    // The same log again (a re-read after a crash) is kept once.
    expect(await store.advanceChainCursor("warranty-registry", 11n, 21n, [first[0]!, finalized(a, 11n, 1), event({ name: "Paused", blockNumber: 20n, logIndex: 0 })], NOW)).toBe(true);
    const all = await store.listRegistryEvents({}, 10);
    expect(all.map((e) => [e.name, e.blockNumber, e.logIndex])).toEqual([
      ["EngineSet", 5n, 3],
      ["ResolutionActivated", 10n, 0],
      ["OutcomeFinalized", 11n, 1],
      ["Paused", 20n, 0],
    ]);
    expect(all[1]).toEqual(first[0]);
    expect(all[0]?.engine).toBe("0x00000000000000000000000000000000000000e9");
    expect(await store.listRegistryEvents({ after: { blockNumber: 10n, logIndex: 0 } }, 10)).toEqual(all.slice(2));
    expect(await store.listRegistryEvents({ after: { blockNumber: 10n, logIndex: 0 } }, 1)).toEqual(all.slice(2, 3));
    expect((await store.listRegistryEvents({ resolutionId: a }, 10)).map((e) => e.name)).toEqual(["ResolutionActivated", "OutcomeFinalized"]);
    expect((await store.listRegistryEvents({ names: ["Paused", "EngineSet"] }, 10)).map((e) => e.name)).toEqual(["EngineSet", "Paused"]);
    expect(await store.listRegistryEvents({ names: [] }, 10)).toEqual([]);
    // A row that could never be read back is refused, and nothing moves.
    await expect(store.advanceChainCursor("warranty-registry", 21n, 31n, [{ ...finalized(a, 25n, 1), txHash: "0xAB" as Hex32 }], NOW)).rejects.toThrow();
    expect(await store.getChainCursor("warranty-registry")).toBe(21n);
    expect(await store.listRegistryEvents({}, 10)).toHaveLength(4);
  });

  it("lists settled resolutions bought with a claim until an activation covers them", async () => {
    const withClaim = await settledResolution(BUYER);
    const second = await settledResolution(OTHER_BUYER);
    await settledResolution(BUYER, null);
    // Prepared but never paid: no warranty.
    const unpaid = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(unpaid);
    await service.prepare(unpaid.previewId, payment(BUYER, "0x7777"), LATER, `0x${"c2".repeat(32)}`);
    expect((await store.listResolutionsToActivate(10)).map((r) => r.resolutionId).sort()).toEqual([withClaim.id, second.id].sort());
    expect(await store.listResolutionsToActivate(1)).toHaveLength(1);
    await store.insertWarrantyAction({ resolutionId: withClaim.id, kind: "activate", payload: voucher(withClaim.id), signature: null, state: "skipped", nextAttemptAt: NOW, lastCode: "RELEASE_NOT_REGISTERED" }, NOW);
    expect((await store.listResolutionsToActivate(10)).map((r) => r.resolutionId)).toEqual([second.id]);
    expect((await store.getWarrantyAction(withClaim.id, "activate"))?.lastCode).toBe("RELEASE_NOT_REGISTERED");
  });

  it("lists active warranties with a verified receipt to evaluate, and ones past their deadline to expire", async () => {
    const [verified, unverified, silent, passed, expired] = await Promise.all([1, 2, 3, 4, 5].map((i) => settledResolution(`0x00000000000000000000000000000000000000${(0xd0 + i).toString(16)}`)));
    const receipt = (id: Hex32): AdoptionReceipt => ({ schemaVersion: "1", resolutionId: id, outcome: "passed", acceptance: { exitCode: 0, durationMs: 1000, outputDigest: null }, recordedAt: "2026-10-01T00:02:00.000Z", signature: null });
    for (const r of [verified!, unverified!, passed!]) expect(await service.acceptReceipt({ receipt: receipt(r.id), previewId: r.previewId })).toBe("ACCEPTED");
    for (const r of [verified!, passed!]) expect(await store.markReceiptVerified(r.id, adoptionReceiptDigest(receipt(r.id)), LATER)).toBe(true);
    await index_([
      activated(verified!.id, 10n, 1_000n),
      activated(unverified!.id, 11n, 1_000n),
      activated(silent!.id, 12n, 2_000n),
      activated(passed!.id, 13n, 1_000n),
      activated(expired!.id, 14n, 500n),
      finalized(passed!.id, 20n, 1),
      event({ name: "ResolutionExpired", blockNumber: 21n, logIndex: 0, resolutionId: expired!.id, releaseDigest, amount: "250000" }),
    ]);
    expect((await store.listWarrantiesToEvaluate(10)).map((e) => e.resolutionId)).toEqual([verified!.id]);
    await store.insertWarrantyAction({ resolutionId: verified!.id, kind: "finalize", payload: outcome(verified!.id), signature: null, state: "review", nextAttemptAt: NOW }, NOW);
    expect(await store.listWarrantiesToEvaluate(10)).toEqual([]);

    // Before 1500 only the deadlines at 1000 are past; an action in review does not hold an expiry back.
    expect((await store.listWarrantiesToExpire(1_500n, 10)).map((e) => e.resolutionId).sort()).toEqual([verified!.id, unverified!.id].sort());
    expect((await store.listWarrantiesToExpire(1_000n, 10)).map((e) => e.resolutionId)).toEqual([]);
    expect((await store.listWarrantiesToExpire(3_000n, 10)).map((e) => e.resolutionId)).toContain(silent!.id);
    expect(await store.listWarrantiesToExpire(3_000n, 1)).toHaveLength(1);
    // A finalization queued (or sent) does; so does an expiry action already there.
    expect(await store.updateWarrantyAction(verified!.id, "finalize", { state: "review", attempts: 0 }, { state: "queued" }, NOW)).toBe(true);
    await store.insertWarrantyAction({ resolutionId: silent!.id, kind: "expire", payload: { schemaVersion: "1", resolutionId: silent!.id }, signature: null, state: "queued", nextAttemptAt: NOW }, NOW);
    expect((await store.listWarrantiesToExpire(3_000n, 10)).map((e) => e.resolutionId)).toEqual([unverified!.id]);
  });

  it("counts a payer's weighted outcomes per release and profile for the damper: finalized or in flight, in the window, once each", async () => {
    const since = new Date(NOW.getTime() - 30 * DAY);
    const ids = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => settledResolution(BUYER)));
    const [a, b, c, d, e, f, g, h] = ids.map((r) => r.id) as [Hex32, Hex32, Hex32, Hex32, Hex32, Hex32, Hex32, Hex32];
    const theirs = (await settledResolution(OTHER_BUYER)).id;
    await index_([
      ...[a, b, c, d, e, f, g, h, theirs].map((id, i) => activated(id, BigInt(10 + i), 9_000_000_000n, id === h ? 1 : 0)),
      finalized(a, 30n, 1, 10_000, NOW),
      finalized(b, 31n, 2, 5_000, NOW),
      // Not counted: a VOID, a zero weight, one older than the window, another profile, another payer.
      finalized(c, 32n, 3, 10_000, NOW),
      finalized(d, 33n, 1, 0, NOW),
      finalized(e, 34n, 1, 10_000, new Date(NOW.getTime() - 31 * DAY)),
      finalized(h, 35n, 1, 10_000, NOW),
      finalized(theirs, 36n, 1, 10_000, NOW),
    ]);
    const query = { payer: BUYER, releaseDigest, profileIndex: 0, since, exclude: `0x${"ff".repeat(32)}` as Hex32 };
    expect(await store.countDamperOutcomes(query)).toBe(2);
    // In flight: a queued finalization with weight counts, once even when it also finalized; one in review counts; a VOID one or an abandoned one does not.
    await store.insertWarrantyAction({ resolutionId: a, kind: "finalize", payload: outcome(a), signature: null, state: "done", nextAttemptAt: NOW }, NOW);
    await store.insertWarrantyAction({ resolutionId: f, kind: "finalize", payload: outcome(f), signature: null, state: "review", nextAttemptAt: NOW }, NOW);
    await store.insertWarrantyAction({ resolutionId: g, kind: "finalize", payload: outcome(g, { verdict: "void", weightBps: 0 }), signature: null, state: "queued", nextAttemptAt: NOW }, NOW);
    expect(await store.countDamperOutcomes(query)).toBe(3);
    await store.updateWarrantyAction(f, "finalize", { state: "review", attempts: 0 }, { state: "abandoned" }, NOW);
    expect(await store.countDamperOutcomes(query)).toBe(2);
    await store.insertWarrantyAction({ resolutionId: e, kind: "finalize", payload: outcome(e), signature: null, state: "queued", nextAttemptAt: NOW }, new Date(NOW.getTime() - 31 * DAY));
    expect(await store.countDamperOutcomes(query)).toBe(2);
    // The resolution asked about never counts itself.
    expect(await store.countDamperOutcomes({ ...query, exclude: a })).toBe(1);
    expect(await store.countDamperOutcomes({ ...query, profileIndex: 1 })).toBe(1);
    expect(await store.countDamperOutcomes({ ...query, payer: OTHER_BUYER })).toBe(1);
  });

  it("counts for the damper an outcome finalized, or an action written, exactly at the window's start, and not a second before", async () => {
    const since = new Date(NOW.getTime() - 30 * DAY);
    const before = new Date(since.getTime() - 1000);
    const [a, b, c, d] = (await Promise.all([1, 2, 3, 4].map(() => settledResolution(BUYER)))).map((r) => r.id) as [Hex32, Hex32, Hex32, Hex32];
    await index_([...[a, b, c, d].map((id, i) => activated(id, BigInt(10 + i), 9_000_000_000n)), finalized(a, 30n, 1, 10_000, since), finalized(b, 31n, 1, 10_000, before)]);
    const query = { payer: BUYER, releaseDigest, profileIndex: 0, since, exclude: `0x${"ff".repeat(32)}` as Hex32 };
    expect(await store.countDamperOutcomes(query)).toBe(1);
    await store.insertWarrantyAction({ resolutionId: c, kind: "finalize", payload: outcome(c), signature: null, state: "queued", nextAttemptAt: NOW }, since);
    await store.insertWarrantyAction({ resolutionId: d, kind: "finalize", payload: outcome(d), signature: null, state: "queued", nextAttemptAt: NOW }, before);
    expect(await store.countDamperOutcomes(query)).toBe(2);
  });
});
