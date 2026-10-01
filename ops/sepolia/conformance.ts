/**
 * A read-only conformance check of Lemma's deployment on Arbitrum Sepolia
 * (docs/deployment.md, "Checking a deployment"): the contracts the deployment
 * records name, how they are wired, the releases they hold, the outcomes the
 * engine recorded, and, with `--api`, what a running server shows of them.
 *
 *   ARBITRUM_SEPOLIA_RPC_URL=<rpc> npm run sepolia:check -- \
 *     [--catalog <dir>] [--roles <roles.json>] [--api <server url>] [--compare-rpc <second rpc>]
 *
 * It needs no key and sends nothing. It reads the records in
 * contracts/deployments/arbitrum-sepolia/, the releases from `--catalog` (a
 * catalog root, the provisional overlay included) or the packaged catalog, and
 * the role addresses from `--roles` (`npm run sepolia:roles`'s roles.json).
 * Each check prints one line, `ok`, `warn` or `FAIL`; the exit code is 1 when
 * one failed. Block times always come from block headers: the check also
 * reports logs whose own `blockTimestamp` disagrees with the header, as
 * Arbitrum's public endpoint answers it as 0x0.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadCatalog } from "@lemma/catalog";
import { NO_PRIOR, type Outcome, type Prior, type Stats, confidence, fold, priorFromEvidence, unixSeconds } from "@lemma/confidence";
import { ARBITRUM_SEPOLIA_USDC, CatalogView, type Hex32, StatusView, VERDICT_FAILED, VERDICT_PASSED, releaseDigest, toAddress } from "@lemma/core";
import { INDEXED_EVENTS, type RawLog, type RegistryLog, decodeRegistryLog, warrantyRegistryAbi } from "@lemma/server";
import { type Hex, type PublicClient, createPublicClient, encodeEventTopics, http, keccak256, numberToHex, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";

const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));
const RECORDS = join(REPOSITORY, "contracts", "deployments", "arbitrum-sepolia");
const LOG_RANGE = 10_000n;
const ACTIVATION_WARNING_SECONDS = 60n * 86_400n;

const registryReads = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function usdc() view returns (address)",
  "function engine() view returns (address)",
  "function paused() view returns (bool)",
  "function totals() view returns (uint256 available, uint256 reserved, uint256 credits)",
]);
const engineReads = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function registry() view returns (address)",
  "function stats(bytes32 releaseDigest, uint8 profileIndex) view returns (uint128, uint128, uint64, uint32, uint32)",
  "function confidence(bytes32 releaseDigest, uint8 profileIndex) view returns (uint16, uint64)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** ArbOS's ArbWasm precompile: how long an activated Stylus program has before it must be activated again. */
const ARB_WASM = "0x0000000000000000000000000000000000000071";
const arbWasm = parseAbi(["function programTimeLeft(address program) view returns (uint64)", "function programVersion(address program) view returns (uint16)"]);

interface DeploymentRecord {
  readonly address: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly runtimeCodeHash: string;
  readonly constructorArgs?: { readonly usdc?: string; readonly initialOwner?: string; readonly owner?: string; readonly registry?: string };
}

let failed = 0;
const line = (level: "ok" | "warn" | "FAIL", check: string, detail: string) => {
  if (level === "FAIL") failed++;
  console.log(`${level.padEnd(4)} ${check}: ${detail}`);
};
const expectEqual = (check: string, actual: unknown, expected: unknown, detail = "") => {
  if (actual === expected) line("ok", check, `${String(actual)}${detail}`);
  else line("FAIL", check, `${String(actual)}, expected ${String(expected)}${detail}`);
};

function fail(message: string): never {
  console.error(`conformance: ${message}`);
  process.exit(2);
}

const USAGE = "usage: conformance [--catalog <dir>] [--roles <roles.json>] [--api <server url>] [--compare-rpc <rpc url>]";
let args: { catalog?: string | undefined; roles?: string | undefined; api?: string | undefined; "compare-rpc"?: string | undefined };
try {
  args = parseArgs({ options: { catalog: { type: "string" }, roles: { type: "string" }, api: { type: "string" }, "compare-rpc": { type: "string" } }, strict: true }).values;
} catch {
  fail(USAGE);
}
const rpcUrl = process.env["ARBITRUM_SEPOLIA_RPC_URL"];
if (rpcUrl === undefined || rpcUrl === "") fail("ARBITRUM_SEPOLIA_RPC_URL is not set");
const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;

const readRecord = (file: string): DeploymentRecord | undefined => {
  const path = join(RECORDS, file);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord) : undefined;
};
const registryRecord = readRecord("ResolutionWarrantyRegistry.json");
if (registryRecord === undefined) fail(`no deployment record at ${join(RECORDS, "ResolutionWarrantyRegistry.json")}`);
const engineRecord = readRecord("ConfidenceEngine.json");
const roles = args.roles === undefined ? undefined : (JSON.parse(readFileSync(resolve(args.roles), "utf8")) as { readonly roles: Readonly<Record<string, string>> }).roles;
const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

// The chain and the registry.
expectEqual("chain", await client.getChainId(), arbitrumSepolia.id);
const registry = toAddress(registryRecord.address) as Hex;
const head = await client.getBlock({ blockTag: "latest" });
const at = { blockNumber: head.number } as const;
const read = <T>(address: Hex, abi: typeof registryReads | typeof engineReads | typeof arbWasm | typeof erc20, functionName: string, fnArgs: readonly unknown[] = []) =>
  client.readContract({ address, abi, functionName, args: fnArgs, ...at } as never) as Promise<T>;
const registryCode = await client.getCode({ address: registry, ...at });
expectEqual("registry.code", registryCode === undefined ? "none" : keccak256(registryCode), registryRecord.runtimeCodeHash, " (the deployment record's runtime code hash)");
const usdc = await read<Hex>(registry, registryReads, "usdc");
expectEqual("registry.usdc", toAddress(usdc), toAddress(ARBITRUM_SEPOLIA_USDC));
const owner = toAddress(await read<Hex>(registry, registryReads, "owner"));
if (roles?.["deployer"] !== undefined && !same(owner, roles["deployer"])) line("warn", "registry.owner", `${owner}, not the deployer ${roles["deployer"]} (ownership moved?)`);
else line("ok", "registry.owner", owner);
const pendingOwner = toAddress(await read<Hex>(registry, registryReads, "pendingOwner"));
line(BigInt(pendingOwner) === 0n ? "ok" : "warn", "registry.pendingOwner", pendingOwner);
line((await read<boolean>(registry, registryReads, "paused")) ? "warn" : "ok", "registry.paused", String(await read<boolean>(registry, registryReads, "paused")));
const [available, reserved, credits] = await read<readonly [bigint, bigint, bigint]>(registry, registryReads, "totals");
const held = await read<bigint>(usdc, erc20, "balanceOf", [registry]);
line(available + reserved + credits <= held ? "ok" : "FAIL", "registry.solvency", `bonds available ${available}, reserved ${reserved}, buyer credits ${credits}, held ${held} (atomic testnet USDC)`);

// The engine the registry records into.
const engine = toAddress(await read<Hex>(registry, registryReads, "engine")) as Hex;
if (BigInt(engine) === 0n) line("warn", "registry.engine", "none set");
else {
  if (engineRecord !== undefined) expectEqual("registry.engine", engine, toAddress(engineRecord.address), " (the engine's deployment record)");
  else line("ok", "registry.engine", `${engine} (no engine deployment record to compare)`);
  const engineCode = await client.getCode({ address: engine, ...at });
  if (engineCode === undefined) line("FAIL", "engine.code", "no code");
  else if (engineRecord !== undefined) expectEqual("engine.code", keccak256(engineCode), engineRecord.runtimeCodeHash, " (the engine's deployment record)");
  else line("ok", "engine.code", `${(engineCode.length - 2) / 2} bytes`);
  expectEqual("engine.registry", toAddress(await read<Hex>(engine, engineReads, "registry")), toAddress(registry));
  const engineOwner = toAddress(await read<Hex>(engine, engineReads, "owner"));
  if (roles?.["deployer"] !== undefined && !same(engineOwner, roles["deployer"])) line("warn", "engine.owner", `${engineOwner}, not the deployer ${roles["deployer"]}`);
  else line("ok", "engine.owner", engineOwner);
  try {
    const left = await read<bigint>(ARB_WASM, arbWasm, "programTimeLeft", [engine]);
    const days = left / 86_400n;
    line(left > ACTIVATION_WARNING_SECONDS ? "ok" : "warn", "engine.activation", `${days} days before the Stylus program must be activated again`);
  } catch {
    line("FAIL", "engine.activation", "ArbWasm does not report the program as active");
  }
}

// The releases the catalog sells, as the registry holds them.
const catalog = loadCatalog(args.catalog === undefined ? { includeProvisional: true } : { root: resolve(args.catalog), includeProvisional: true });
const releaseAbi = warrantyRegistryAbi;
for (const { release } of catalog.releases) {
  const digest = releaseDigest(release) as Hex;
  const ref = `${release.releaseId}@${release.version}`;
  const r = (await client.readContract({ address: registry, abi: releaseAbi, functionName: "release", args: [digest], ...at })) as {
    readonly provider: Hex;
    readonly claimWindowSeconds: number;
    readonly active: boolean;
    readonly evaluator: Hex;
    readonly available: bigint;
    readonly reserved: bigint;
  };
  if (BigInt(r.provider) === 0n) {
    line("ok", `release ${ref}`, "not registered");
    continue;
  }
  expectEqual(`release ${ref} provider`, toAddress(r.provider), toAddress(release.provider.payTo), " (the manifest's payTo)");
  expectEqual(`release ${ref} claim window`, r.claimWindowSeconds, release.warranty.claimWindowHours * 3600, " s");
  if (roles?.["evaluator"] !== undefined) expectEqual(`release ${ref} evaluator`, toAddress(r.evaluator), toAddress(roles["evaluator"]));
  line(r.active ? "ok" : "warn", `release ${ref} active`, String(r.active));
  line(r.available >= BigInt(release.price) ? "ok" : "warn", `release ${ref} bond`, `available ${r.available}, reserved ${r.reserved}, price ${release.price} (atomic testnet USDC)`);
}

// Every registry event since the deployment, dated by its block header.
const topics = INDEXED_EVENTS.map((eventName) => encodeEventTopics({ abi: warrantyRegistryAbi, eventName })[0] as Hex);
const getLogs = async (c: PublicClient, from: bigint, to: bigint) =>
  (await c.request({ method: "eth_getLogs", params: [{ address: registry, topics: [topics], fromBlock: numberToHex(from), toBlock: numberToHex(to) }] } as never)) as unknown as (RawLog & { readonly blockTimestamp?: Hex })[];
const raw: (RawLog & { readonly blockTimestamp?: Hex })[] = [];
for (let from = BigInt(registryRecord.blockNumber); from <= head.number; from += LOG_RANGE) {
  const to = from + LOG_RANGE - 1n < head.number ? from + LOG_RANGE - 1n : head.number;
  raw.push(...(await getLogs(client, from, to)));
}
const headerTimes = new Map<bigint, bigint>();
for (const n of new Set(raw.flatMap((log) => (log.blockNumber === null ? [] : [BigInt(log.blockNumber)])))) headerTimes.set(n, (await client.getBlock({ blockNumber: n })).timestamp);
const quirks = raw.filter((log) => log.blockNumber !== null && log.blockTimestamp !== undefined && BigInt(log.blockTimestamp) !== headerTimes.get(BigInt(log.blockNumber)));
line(quirks.length === 0 ? "ok" : "warn", "rpc.log-timestamps", quirks.length === 0 ? "every log's blockTimestamp, where given, equals its header" : `${quirks.length} of ${raw.length} logs carry a blockTimestamp that is not their header's (e.g. ${quirks[0]?.blockTimestamp}); block times must come from headers`);
const events = raw
  .flatMap((log) => {
    if (log.blockNumber === null) return [];
    const time = headerTimes.get(BigInt(log.blockNumber));
    const decoded = time === undefined ? undefined : decodeRegistryLog(log, new Date(Number(time) * 1000));
    return decoded === undefined ? [] : [decoded];
  })
  .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
const count = (name: RegistryLog["name"]) => events.filter((e) => e.name === name).length;
line("ok", "registry.events", `${events.length} since block ${registryRecord.blockNumber}: ${INDEXED_EVENTS.map((n) => `${n} ${count(n)}`).join(", ")}`);
line(count("EngineRecordFailed") === 0 ? "ok" : "FAIL", "engine.records", count("EngineRecordFailed") === 0 ? "no EngineRecordFailed" : `${count("EngineRecordFailed")} outcomes never reached the engine`);

// The outcomes the engine should hold, folded locally at the header times, against what it holds.
const profileOf = new Map<string, number>();
for (const e of events) if (e.name === "ResolutionActivated" && e.resolutionId !== null && e.profileIndex !== null) profileOf.set(e.resolutionId, e.profileIndex);
const outcomesByKey = new Map<string, { readonly releaseDigest: Hex32; readonly profileIndex: number; readonly outcomes: Outcome[] }>();
for (const e of events) {
  if (e.name !== "OutcomeFinalized" || e.resolutionId === null || e.releaseDigest === null || e.verdict === null || e.weightBps === null) continue;
  if ((e.verdict !== VERDICT_PASSED && e.verdict !== VERDICT_FAILED) || e.weightBps === 0) continue;
  const profileIndex = profileOf.get(e.resolutionId);
  if (profileIndex === undefined) {
    line("FAIL", "registry.outcomes", `finalization of ${e.resolutionId} has no activation`);
    continue;
  }
  const key = `${e.releaseDigest}:${profileIndex}`;
  const entry = outcomesByKey.get(key) ?? { releaseDigest: e.releaseDigest, profileIndex, outcomes: [] };
  entry.outcomes.push({ passed: e.verdict === VERDICT_PASSED, weightBps: e.weightBps, at: unixSeconds(e.blockTime) });
  outcomesByKey.set(key, entry);
}
const engineFolds = new Map<string, { readonly stats: Stats; readonly prior: Prior }>();
for (const [key, { releaseDigest: digest, profileIndex, outcomes }] of outcomesByKey) {
  const local = fold(NO_PRIOR, outcomes, 0n).stats;
  if (BigInt(engine) === 0n) continue;
  const [passWad, failWad, last, priorPasses, priorFailures] = await read<readonly [bigint, bigint, bigint, number, number]>(engine, engineReads, "stats", [digest, profileIndex]);
  const prior = { passes: priorPasses, failures: priorFailures };
  engineFolds.set(key, { stats: local, prior });
  const label = `engine.stats ${digest.slice(0, 10)}… profile ${profileIndex}`;
  if (passWad === local.passWad && failWad === local.failWad && last === local.last) line("ok", label, `${outcomes.length} outcomes, pass ${passWad} fail ${failWad} (WAD), last ${last}`);
  else line("FAIL", label, `engine holds pass ${passWad} fail ${failWad} last ${last}; the registry's events fold to pass ${local.passWad} fail ${local.failWad} last ${local.last}`);
  const [bps, nMilli] = await read<readonly [number, bigint]>(engine, engineReads, "confidence", [digest, profileIndex]);
  const expected = confidence(prior, local, head.timestamp);
  if (bps === expected.confidenceBps && nMilli === expected.effectiveNMilli) line("ok", `engine.confidence ${digest.slice(0, 10)}… profile ${profileIndex}`, `${bps} bps, effective n ${nMilli} milli, at block ${head.number}`);
  else line("FAIL", `engine.confidence ${digest.slice(0, 10)}… profile ${profileIndex}`, `engine ${bps} bps / ${nMilli}; local fold ${expected.confidenceBps} / ${expected.effectiveNMilli} at block ${head.number}`);
}

// A second endpoint must agree on every header the events sit in.
if (args["compare-rpc"] !== undefined) {
  const other = createPublicClient({ chain: arbitrumSepolia, transport: http(args["compare-rpc"], { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  expectEqual("compare-rpc.chain", await other.getChainId(), arbitrumSepolia.id);
  let differing = 0;
  for (const [n, time] of headerTimes) if ((await other.getBlock({ blockNumber: n })).timestamp !== time) differing++;
  line(differing === 0 ? "ok" : "FAIL", "compare-rpc.headers", differing === 0 ? `${headerTimes.size} event blocks have the same header time on both endpoints` : `${differing} of ${headerTimes.size} event blocks differ`);
  const otherLogs: RawLog[] = [];
  for (let from = BigInt(registryRecord.blockNumber); from <= head.number; from += LOG_RANGE) {
    const to = from + LOG_RANGE - 1n < head.number ? from + LOG_RANGE - 1n : head.number;
    otherLogs.push(...(await getLogs(other, from, to)));
  }
  line(otherLogs.length === raw.length ? "ok" : "warn", "compare-rpc.logs", `${otherLogs.length} logs there, ${raw.length} here up to block ${head.number}`);
}

// What a running server shows.
if (args.api !== undefined) {
  const api = args.api.replace(/\/+$/, "");
  const get = async (path: string) => {
    const res = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return (await res.json()) as unknown;
  };
  const status = StatusView.parse(await get("/api/v1/status"));
  expectEqual("server.registry", status.chain.registry === null ? null : toAddress(status.chain.registry), toAddress(registry));
  expectEqual("server.engine", status.chain.engine === null ? null : toAddress(status.chain.engine), BigInt(engine) === 0n ? null : toAddress(engine));
  expectEqual("server.usdc", status.chain.usdc === null ? null : toAddress(status.chain.usdc), toAddress(usdc));
  const view = CatalogView.parse(await get("/api/v1/catalog"));
  const scoredAt = unixSeconds(new Date(view.generatedAt));
  for (const release of view.releases) {
    for (const profile of release.profiles) {
      if (profile.compatibility === null) continue;
      const folded = engineFolds.get(`${release.releaseDigest}:${profile.profileIndex}`);
      const outcomes = outcomesByKey.get(`${release.releaseDigest}:${profile.profileIndex}`)?.outcomes.length ?? 0;
      const prior = profile.evidence === null ? NO_PRIOR : priorFromEvidence(profile.evidence);
      const expected = confidence(prior, folded?.stats ?? fold(NO_PRIOR, [], 0n).stats, scoredAt);
      const label = `server.confidence ${release.releaseDigest.slice(0, 10)}… profile ${profile.profileIndex}`;
      const shown = profile.compatibility;
      if (shown.confidenceBps === expected.confidenceBps && shown.effectiveNMilli === expected.effectiveNMilli.toString() && shown.outcomes === outcomes) {
        line("ok", label, `${shown.confidenceBps} bps, effective n ${shown.effectiveNMilli} milli, ${shown.outcomes} outcomes, as the chain's events fold at ${view.generatedAt}`);
      } else {
        line("FAIL", label, `server ${shown.confidenceBps} bps / ${shown.effectiveNMilli} / ${shown.outcomes} outcomes; the chain's events fold to ${expected.confidenceBps} / ${expected.effectiveNMilli} / ${outcomes} at ${view.generatedAt}`);
      }
      if (folded !== undefined && (folded.prior.passes !== prior.passes || folded.prior.failures !== prior.failures)) {
        line("warn", `${label} prior`, `the engine's prior ${folded.prior.passes}/${folded.prior.failures} differs from the catalog's ${prior.passes}/${prior.failures} (run warranty:admin set-priors)`);
      }
    }
  }
}

console.log(failed === 0 ? "conformance: every check passed" : `conformance: ${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
