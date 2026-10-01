/**
 * Writes the testnet demo catalog for a live run on Arbitrum Sepolia
 * (docs/deployment.md, runbook steps 5 to 10):
 *
 *   tsx e2e/live/catalog.ts --dir <new directory outside the repository> --pay-to <provider address>
 *
 * One release of the payment-gating capability, built as the local run's is
 * (e2e/lib/catalog.ts): a marker file, an acceptance recipe that runs the
 * repository's `test` script, a testnet price of 0.25 USDC paid to the
 * provider, a 72-hour warranty window, and made-up benchmark evidence
 * labelled `demo-1`: no measurement stands behind it. It exists because the
 * public catalog has nothing to sell before frozen evidence, and the
 * provisional overlay has nothing before the stage-4 probe has run
 * (docs/economic-gates.md). The operator commands read it with
 * `--catalog <dir>` and the live server with `e2e/live/serve.ts --catalog`.
 *
 * The directory is written once and never overwritten: the registry
 * registers the release's digest, and a rewrite (new dates) would change it.
 * It prints the release as the operator commands name it, and its digest.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { toAddress } from "@lemma/core";

import { type CatalogOptions, writeCatalog } from "../lib/catalog.js";
import { ROOT } from "../lib/tools.js";

function fail(message: string): never {
  console.error(`live-catalog: ${message}`);
  process.exit(1);
}

const USAGE = "usage: tsx e2e/live/catalog.ts --dir <new directory outside the repository> --pay-to <provider address>";

let values: { dir?: string | undefined; "pay-to"?: string | undefined };
try {
  ({ values } = parseArgs({ options: { dir: { type: "string" }, "pay-to": { type: "string" } }, strict: true }));
} catch {
  fail(USAGE);
}
if (values.dir === undefined || values["pay-to"] === undefined) fail(USAGE);
const dir = resolve(values.dir);
const rel = relative(ROOT, dir);
if (!isAbsolute(rel) && !rel.startsWith("..")) fail("--dir is inside the repository; keep run data outside it");
if (existsSync(dir) && readdirSync(dir).length > 0) fail(`${dir} is not empty: a written catalog is never rewritten, since the registry registers its release's digest`);
let payTo;
try {
  payTo = toAddress(values["pay-to"]);
} catch {
  fail("--pay-to must be the provider's address");
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const DEMO: CatalogOptions = {
  releaseId: "payment-gating-demo",
  version: "1.0.0+demo-1",
  title: "Testnet demo: payment gating marker (made-up evidence)",
  benchmarkVersion: "demo-1",
  runSet: "lemma arbitrum sepolia demo",
  model: "demo-model-1",
  claimWindowHours: 72,
  // The release's content is defined by e2e/lib/catalog.ts at this commit.
  provenance: { repository: "https://github.com/4waan/Lemma", commit, spdxLicense: "MIT" },
  economicsSource: "Made-up economics for the Arbitrum Sepolia live run of docs/deployment.md: testnet only, no measurement behind them.",
};
const catalog = writeCatalog(dir, payTo, new Date(), DEMO);
console.log(`demo catalog written to ${dir}`);
console.log(`release ${catalog.ref} ${catalog.releaseDigest}, price 0.25 USDC (testnet) to ${payTo}, made-up evidence ${DEMO.benchmarkVersion}`);
