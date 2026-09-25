import { resolve } from "@lemma/catalog";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER, PgStore, ResolutionService, schemaIsCurrent, silentLogger } from "../src/index.js";
import { BUYER, NOW, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";

/**
 * Real Postgres: the race that PGlite's single connection cannot show. Runs
 * when LEMMA_TEST_DATABASE_URL points at a disposable database (the CI
 * `postgres` job); skipped otherwise.
 */
const url = process.env["LEMMA_TEST_DATABASE_URL"];

describe.skipIf(url === undefined || url === "")("Postgres", () => {
  const client = postgres(url as string, { max: 20 });
  const db = drizzle(client);
  afterAll(async () => {
    await client.end();
  });

  it("migrates an empty database and then reports it current", async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    expect((await schemaIsCurrent(db)).current).toBe(true);
  });

  it("lets exactly one of many concurrent payments for one resolution prepare", async () => {
    await db.execute(sql`truncate releases, bundles, catalog_snapshots, previews, resolutions, adoption_receipts, demand_salts, demand_seen, demand_daily`);
    const store = new PgStore(db);
    const index = sellableIndex();
    await store.saveCatalog(index, NOW);
    const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(offer);
    const service = new ResolutionService(store, () => new Date(NOW.getTime() + 1000), silentLogger);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => service.prepare(offer.previewId, { payer: BUYER, nonce: `0x${i}`, validBefore: new Date(NOW.getTime() + 300_000) })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(Array(19).fill("IN_FLIGHT"));
  });

  it("lets one authorization back exactly one of many concurrently prepared resolutions", async () => {
    await db.execute(sql`truncate releases, bundles, catalog_snapshots, previews, resolutions, adoption_receipts, demand_salts, demand_seen, demand_daily`);
    const store = new PgStore(db);
    const index = sellableIndex();
    await store.saveCatalog(index, NOW);
    const offers = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
          now: NOW,
          previewId: nextPreviewId(),
          payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
          offerTtlSeconds: 900,
        });
        await store.saveOffer(offer);
        return offer;
      }),
    );
    const service = new ResolutionService(store, () => new Date(NOW.getTime() + 1000), silentLogger);
    const results = await Promise.all(offers.map((o) => service.prepare(o.previewId, { payer: BUYER, nonce: "0xfeed", validBefore: new Date(NOW.getTime() + 300_000) })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(Array(9).fill("PAYMENT_REUSED"));
  });

  it("counts a demand day exactly once, however many closes and late writes race it", async () => {
    const stores = Array.from({ length: 4 }, () => new PgStore(drizzle(postgres(url as string, { max: 3, onnotice: () => {} }))));
    const digest = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as const;
    for (let trial = 0; trial < 10; trial++) {
      await db.execute(sql`truncate demand_salts, demand_seen, demand_daily`);
      for (const i of [1, 2, 3, 4, 5]) await stores[0]?.recordDemand("2026-09-30", "bucket", digest(i), `10.0.0.${i}`);
      // Closes race writes of pairs that are already counted: before the per-day lock, a write that
      // landed after a close's snapshot was added by a later close (5 became 6).
      await Promise.all([
        ...stores.map((s) => s.closeDemandDaysBefore("2026-10-01")),
        ...[1, 2, 3, 4, 5].map((i) => stores[i % 4]?.recordDemand("2026-09-30", "bucket", digest(i), `10.0.0.${i}`)),
      ]);
      await Promise.all(stores.map((s) => s.closeDemandDaysBefore("2026-10-01")));
      expect(await stores[0]?.demandBuckets(1), `trial ${trial}`).toEqual([{ day: "2026-09-30", bucket: "bucket", profiles: 5, sources: 5 }]);
      // No salt survives a closed day: a late write never re-creates one.
      await stores[1]?.recordDemand("2026-09-30", "bucket", digest(6), "10.0.0.6");
      expect(await db.execute(sql`select day from demand_salts where day = '2026-09-30'`)).toHaveLength(0);
      expect(await db.execute(sql`select day from demand_seen`)).toHaveLength(0);
    }
  });

  it("keeps every concurrent first write of a day, and counts a profile once after a write rolls back", async () => {
    const digest = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as const;
    const pool = new PgStore(drizzle(postgres(url as string, { max: 20, onnotice: () => {} })));
    for (let round = 0; round < 10; round++) {
      await db.execute(sql`truncate demand_salts, demand_seen, demand_daily`);
      await Promise.all(Array.from({ length: 16 }, (_, i) => pool.recordDemand("2026-09-30", "bucket", digest(i + 1), `10.0.0.${i + 1}`)));
      expect(await db.execute(sql`select 1 from demand_seen`), `round ${round}`).toHaveLength(16);
    }
    // A first write that rolls back (here: an invalid bucket) must leave nothing a later write would reuse.
    await db.execute(sql`truncate demand_salts, demand_seen, demand_daily`);
    const a = new PgStore(db, () => "salt-a");
    const b = new PgStore(db, () => "salt-b");
    await expect(a.recordDemand("2026-09-30", "bad\u0000bucket", digest(1), "10.0.0.1")).rejects.toThrow();
    await b.recordDemand("2026-09-30", "bucket", digest(1), "10.0.0.1");
    await a.recordDemand("2026-09-30", "bucket", digest(1), "10.0.0.1");
    await a.closeDemandDaysBefore("2026-10-01");
    expect(await a.demandBuckets(1)).toEqual([{ day: "2026-09-30", bucket: "bucket", profiles: 1, sources: 1 }]);
  });
});
