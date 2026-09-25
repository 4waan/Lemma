import { resolve } from "@lemma/catalog";
import { type AdoptionReceipt, type Hex32, type Preview, ResolutionDelivery, deriveResolutionId } from "@lemma/core";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type LemmaStore, MIGRATIONS_FOLDER, MemoryStore, PgStore, ResolutionService, demandBucket, schemaIsCurrent, silentLogger } from "../src/index.js";
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
      await pgDb.execute(sql`truncate releases, bundles, catalog_snapshots, previews, resolutions, adoption_receipts, demand_salts, demand_seen, demand_daily`);
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

  it("settles one resolution per settlement", async () => {
    const index = sellableIndex();
    const second = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(second);
    await service.prepare(offer.previewId, payment(BUYER, "0x01"));
    await service.prepare(second.previewId, payment(BUYER, "0x02"));
    await service.commit(deriveResolutionId(offer.previewId, BUYER), settled("0x01", "0xtx"));
    await service.commit(deriveResolutionId(second.previewId, BUYER), settled("0x02", "0xtx"));
    expect((await store.getResolution(deriveResolutionId(second.previewId, BUYER)))?.state).toBe("prepared");
  });

  it("commits without ever throwing", async () => {
    await expect(service.commit(`0x${"77".repeat(32)}`, settled("0x01", "0xnothing"))).resolves.toBeUndefined();
    const failing = new ResolutionService(
      Object.assign(Object.create(store) as LemmaStore, { markSettled: async () => { throw new Error("database down"); } }),
      () => LATER,
      silentLogger,
    );
    await expect(failing.commit(deriveResolutionId(offer.previewId, BUYER), settled())).resolves.toBeUndefined();
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
});
