/**
 * The Lemma server for a live run on Arbitrum Sepolia without a hosted
 * deployment (docs/deployment.md, runbook steps 9 and 10): the HTTP app and
 * every job main.ts runs (settlement, reconciler, receipt verifier, warranty
 * indexer and outbox, ERC-8004 attester), on the demo catalog that
 * e2e/live/catalog.ts wrote, with Postgres at DATABASE_URL:
 *
 *   <the runbook's server settings in the environment> tsx e2e/live/serve.ts --catalog <dir>
 *
 * It is assembled as the local run's server is (e2e/lib/server.ts), which
 * differs from main.ts only in that the catalog is `--catalog`'s, no
 * dashboard is served, and there is no hourly demand housekeeping. Its jobs
 * run every few seconds, not main.ts's 15 s to a minute, and no faster, so a
 * public RPC is not pressed. It applies the server's migrations first (the
 * database is the run's own), listens on 127.0.0.1:$PORT (default 3000),
 * logs JSON lines on stdout as main.ts does, and stops on SIGINT or SIGTERM.
 */
import { parseArgs } from "node:util";

import { MIGRATIONS_FOLDER, describeError, jsonLogger } from "@lemma/server";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { type JobIntervals, startServer } from "../lib/server.js";

function fail(message: string): never {
  console.error(`live-serve: ${message}`);
  process.exit(1);
}

/** Every few seconds: each run of a job is a handful of RPC reads at most. */
export const LIVE_JOBS: JobIntervals = { indexerMs: 3000, actionsMs: 3000, verifierMs: 5000, reconcilerMs: 15_000, attesterMs: 5000 };

let catalogRoot: string | undefined;
try {
  catalogRoot = parseArgs({ options: { catalog: { type: "string" } }, strict: true }).values.catalog;
} catch {
  catalogRoot = undefined;
}
if (catalogRoot === undefined) fail("usage: tsx e2e/live/serve.ts --catalog <dir written by e2e/live/catalog.ts>");
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const url = env["DATABASE_URL"];
// Never the value: it usually holds a password.
if (url === undefined || !/^postgres(ql)?:\/\//.test(url)) fail("DATABASE_URL must be set to a postgres:// URL");

const sql = postgres(url, { max: 10, onnotice: () => {}, connect_timeout: 10 });
const db = drizzle(sql);
try {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
} catch (error) {
  fail(`the database could not be migrated (${describeError(error)})`);
}
const logger = jsonLogger();
let server: Awaited<ReturnType<typeof startServer>>;
try {
  server = await startServer({ env, catalogRoot, db, clock: () => new Date(), logger, intervals: LIVE_JOBS, port: Number(env["PORT"] ?? "3000") });
} catch (error) {
  await sql.end();
  fail(error instanceof Error ? error.message : "the server did not start");
}
logger.log("info", "live.listening", { url: server.url });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server
      .stop()
      .then(() => sql.end())
      .then(() => process.exit(0));
  });
}
