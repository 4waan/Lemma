import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import { buildIndex, loadCatalog } from "@lemma/catalog";
import type { Hex32 } from "@lemma/core";
import {
  type LemmaStore,
  type Logger,
  PgStore,
  type ReputationRuntime,
  ResolutionService,
  createApp,
  jsonLogger,
  loadConfig,
  safeStore,
  startPaymentPath,
  startReputation,
  startWarrantyPipeline,
  startupProblems,
  viemWarrantyChainFor,
} from "@lemma/server";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";

/** How often each job runs in the run: seconds where main.ts waits a minute. */
export interface JobIntervals {
  readonly indexerMs: number;
  readonly actionsMs: number;
  readonly verifierMs: number;
  readonly reconcilerMs: number;
  readonly attesterMs: number;
}

export const FAST_JOBS: JobIntervals = { indexerMs: 200, actionsMs: 200, verifierMs: 200, reconcilerMs: 1000, attesterMs: 300 };

export interface ServerOptions {
  /** The server's environment, exactly as main.ts reads process.env (keys included): never the test process's own. */
  readonly env: Readonly<Record<string, string>>;
  readonly catalogRoot: string;
  /** The database, which outlives a server: a restart gets the same one. */
  readonly db: ConstructorParameters<typeof PgStore>[0];
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly intervals?: JobIntervals;
  /** Listen on this port (a restart takes over its predecessor's). */
  readonly port: number;
  /** Wraps the store the server uses (the crash scenario's). */
  readonly wrapStore?: (store: LemmaStore) => LemmaStore;
}

export interface RunningServer {
  readonly url: string;
  /** The ERC-8004 jobs and the cached summaries the catalog reads. */
  readonly reputation: ReputationRuntime;
  /** Stops every job and closes the HTTP server, as main.ts does on SIGTERM. */
  stop(): Promise<void>;
}

/**
 * The Lemma server as main.ts assembles it, with the differences a local run
 * needs, and nothing else (besides serving no dashboard files and skipping
 * the hourly demand housekeeping, which the run never reaches):
 *
 * - the store is `PgStore` over an in-process PGlite database migrated with
 *   the server's own migrations (main.ts connects postgres.js to
 *   DATABASE_URL instead; the SQL and the store are the same), so
 *   DATABASE_URL in `env` only satisfies the config gates;
 * - the catalog is the run's own (`loadCatalog({ root })`; main.ts also runs
 *   `checkCatalog()` on the packaged catalog, whose repository rules a
 *   one-release test catalog does not follow);
 * - the jobs run every fraction of a second instead of every 15 s to a
 *   minute: `startPaymentPath` and `startReputation` start theirs on their
 *   fixed schedules, so the run stops those timers and starts the same jobs
 *   again on its short ones.
 *
 * The HTTP app is the real one (`createApp`), served by @hono/node-server on
 * 127.0.0.1, so the bridge reaches it over HTTP as it reaches a deployment.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { env, clock, logger } = options;
  const intervals = options.intervals ?? FAST_JOBS;
  const config = loadConfig(env);
  const catalog = loadCatalog({ root: options.catalogRoot, includeProvisional: config.allowProvisionalEvidence });
  const index = buildIndex(catalog);
  const problems = startupProblems(config, index);
  if (problems.length > 0) throw new Error(`startup refused: ${problems.join("; ")}`);
  if (config.warranty === undefined) throw new Error("the run needs the warranty pipeline configured");

  const base = safeStore(new PgStore(options.db));
  const store = options.wrapStore?.(base) ?? base;
  await store.saveCatalog(index, clock());
  const service = new ResolutionService(store, clock, logger);

  const payments = await startPaymentPath({ config, store, service, clock, logger });
  payments.stop();
  const stops = [payments.reconciler.start(intervals.reconcilerMs), payments.verifier.start(intervals.verifierMs)];

  const chain = await viemWarrantyChainFor(config, logger);
  const warranty = await startWarrantyPipeline({
    config: config.warranty,
    store,
    index,
    chain,
    usdc: config.payment.asset,
    clock,
    logger,
    intervals: { indexerMs: intervals.indexerMs, actionsMs: intervals.actionsMs },
  });
  const reputation = startReputation({
    config: config.reputation,
    store,
    feed: warranty.feed,
    capabilities: [...new Set(index.releases.map((r) => r.release.capability))],
    clock,
    logger,
    attesterIntervalMs: intervals.attesterMs,
  });

  const app = createApp({
    config,
    index,
    store,
    service,
    clock,
    newPreviewId: () => `0x${randomBytes(32).toString("hex")}` as Hex32,
    logger,
    economics: catalog.economics,
    storeKind: "postgres",
    socketAddress: (c) => getConnInfo(c).remote.address,
    registerPaidTools: payments.registerPaidTools,
    reputation: reputation.summaries,
    outcomes: warranty.source,
    reputationBuyers: warranty.feed,
    warranty: warranty.views,
  });
  const stopJobs = () => {
    for (const stop of stops) stop();
    warranty.stop();
    reputation.stop();
  };
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" }, () => resolve(s as Server));
      s.once("error", reject);
    });
  } catch (error) {
    stopJobs();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${options.port}`,
    reputation,
    async stop() {
      stopJobs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A logger like main.ts's (JSON lines through core `redact`), kept in memory for the run's checks. */
export function recordingJsonLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return Object.assign(
    jsonLogger((line) => lines.push(line)),
    { lines },
  );
}

/**
 * A store that dies like its process: once armed, the write that would
 * record the next activation's transaction hash, which the activator makes
 * right after broadcasting it, throws, and from then on every call throws.
 * The transaction is out; the outbox never learns its hash.
 */
export function crashableStore(store: LemmaStore): { readonly store: LemmaStore; arm(): void; readonly dead: () => boolean } {
  let armed = false;
  let dead = false;
  const killed = () => new Error("the server process was killed");
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (dead) throw killed();
        if (armed && property === "updateWarrantyAction" && args[1] === "activate" && typeof args[3] === "object" && args[3] !== null && "txHash" in args[3]) {
          dead = true;
          throw killed();
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    store: proxy,
    arm: () => (armed = true),
    dead: () => dead,
  };
}
