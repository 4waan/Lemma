import { randomBytes } from "node:crypto";

import { buildIndex, checkCatalog, loadCatalog } from "@lemma/catalog";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createApp } from "./app.js";
import { ConfigError, type ServerConfig, loadConfig } from "./config.js";
import { latestMigration, schemaIsCurrent } from "./db/migrations.js";
import { describeError, isUnparseableUrl, safeStore } from "./errors.js";
import { PgStore } from "./db/store.js";
import { jsonLogger } from "./log.js";
import { type LemmaStore, MemoryStore } from "./persistence.js";
import { ResolutionService } from "./service.js";
import { startupProblems } from "./startup.js";

const logger = jsonLogger();
const HOUR = 3_600_000;
/** Expired offers are kept this long after expiry, for late recovery questions, then purged. */
const OFFER_RETENTION_MS = 24 * HOUR;

function fail(problems: readonly string[]): never {
  logger.log("error", "startup.refused", { problems });
  process.exit(1);
}

let config: ServerConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  fail([error instanceof ConfigError ? error.message : String(error)]);
}

// The payment work's paid-tool registrar is not part of this build yet.
if (config.paidTools) fail(["PAID_TOOLS=on needs the paid-tool registrar from the payment work, which this build does not include"]);

const check = checkCatalog();
if (check.problems.length > 0) fail(check.problems);
const index = buildIndex(loadCatalog({ includeProvisional: config.allowProvisionalEvidence }));
const problems = startupProblems(config, index);
if (problems.length > 0) fail(problems);
if (config.allowProvisionalEvidence) logger.log("warn", "startup.provisional_overlay", { note: "testnet-only provisional evidence is loaded" });

let store: LemmaStore;
if (config.databaseUrl !== undefined) {
  let schema: Awaited<ReturnType<typeof schemaIsCurrent>>;
  let db: ReturnType<typeof drizzle>;
  let expected: number;
  try {
    expected = latestMigration().when;
  } catch (error) {
    fail([`this build's migration journal could not be read (${describeError(error)})`]);
  }
  try {
    // Connecting is bounded, and Postgres cancels a slow request statement; a partitioned database is not bounded
    // by either (docs/deployment.md), but the request timeout still answers 504.
    db = drizzle(
      postgres(config.databaseUrl, {
        max: 10,
        onnotice: () => {},
        connect_timeout: 10,
        connection: { statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 },
      }),
    );
    schema = await schemaIsCurrent(db, undefined, expected);
  } catch (error) {
    // Never the error's message: it can carry the connection string.
    fail([
      isUnparseableUrl(error)
        ? "DATABASE_URL could not be parsed (URL-encode special characters in the password); its value is not shown"
        : `the database could not be reached or read (${describeError(error)})`,
    ]);
  }
  if (!schema.current) fail([`the database schema is behind this build (applied ${schema.applied ?? "none"}, expected ${schema.expected}); run npm run db:migrate first`]);
  store = safeStore(new PgStore(db));
} else {
  logger.log("warn", "startup.memory_store", { note: "no database is configured, so offers, resolutions and demand live in memory only" });
  store = new MemoryStore();
}

const clock = () => new Date();
try {
  await store.saveCatalog(index, clock());
} catch (error) {
  fail([`the catalog could not be saved to the database (${describeError(error)})`]);
}
const service = new ResolutionService(store, clock, logger);

// Housekeeping: close finished demand days (their salts are discarded) and purge long-expired, unbought offers.
// Each step runs on its own, so a failing demand close never blocks the purge.
const housekeeping = async () => {
  const now = clock();
  try {
    await store.closeDemandDaysBefore(now.toISOString().slice(0, 10));
  } catch (error) {
    logger.log("warn", "housekeeping.demand_close_failed", { error: describeError(error) });
  }
  try {
    await store.purgeExpiredOffers(new Date(now.getTime() - OFFER_RETENTION_MS));
  } catch (error) {
    logger.log("warn", "housekeeping.purge_failed", { error: describeError(error) });
  }
};
setInterval(() => void housekeeping(), HOUR).unref();
void housekeeping();

const app = createApp({
  config,
  index,
  store,
  service,
  clock,
  newPreviewId: () => `0x${randomBytes(32).toString("hex")}`,
  logger,
  socketAddress: (c) => getConnInfo(c).remote.address,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.log("info", "startup.listening", { port: info.port, catalogDigest: index.catalogDigest, releases: index.releases.length, store: config.databaseUrl === undefined ? "memory" : "postgres" });
});

// Node runs as PID 1 in the container, where an unhandled SIGTERM is ignored:
// stop accepting connections, let in-flight requests finish, then exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.log("info", "shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
