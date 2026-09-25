import { randomBytes } from "node:crypto";

import { buildIndex, checkCatalog, loadCatalog } from "@lemma/catalog";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { jsonLogger } from "./log.js";
import { startupProblems } from "./startup.js";
import { MemoryPreviewStore, noResolutions } from "./store.js";

const logger = jsonLogger();

function fail(problems: readonly string[]): never {
  logger.log("error", "startup.refused", { problems });
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  fail([error instanceof ConfigError ? error.message : String(error)]);
}

// The protocol lane's paid-tool registrar is not part of this build yet.
if (config.paidTools) fail(["PAID_TOOLS=on needs the paid-tool registrar from the payment work, which this build does not include"]);

const check = checkCatalog();
if (check.problems.length > 0) fail(check.problems);
const index = buildIndex(loadCatalog({ includeProvisional: config.allowProvisionalEvidence }));
const problems = startupProblems(config, index);
if (problems.length > 0) fail(problems);
if (config.allowProvisionalEvidence) logger.log("warn", "startup.provisional_overlay", { note: "testnet-only provisional evidence is loaded" });

const clock = () => new Date();
const app = createApp({
  config,
  index,
  previews: new MemoryPreviewStore(clock),
  resolutions: noResolutions,
  clock,
  newPreviewId: () => `0x${randomBytes(32).toString("hex")}`,
  logger,
  socketAddress: (c) => getConnInfo(c).remote.address,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.log("info", "startup.listening", { port: info.port, catalogDigest: index.catalogDigest, releases: index.releases.length });
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
