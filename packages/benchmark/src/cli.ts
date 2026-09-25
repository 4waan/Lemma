import { randomBytes } from "node:crypto";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CATALOG_ROOT, loadCatalog } from "@lemma/catalog";
import { type Hex32, PatchBundle, bundleDigest, fileDigest } from "@lemma/core";

import type { AgentAdapter, McpStdioServer, ModelSelection } from "./adapter.js";
import { CursorAdapter } from "./cursor.js";
import { ExperimentConfig, fixturesDigest } from "./experiment.js";
import { BENCHMARK_ROOT, REPOSITORY_ROOT, loadBenchmarkFixtures } from "./fixture.js";
import { nextAttempt, planMatrix } from "./matrix.js";
import { nextProbeSlot, probeVerdict } from "./probe.js";
import { ancestorSecretVariables, killByHome, killRunGroups, secretVariables, trackHome } from "./process.js";
import { type ReconcileResult, reconcile } from "./reconcile.js";
import { RunLog } from "./records.js";
import { buildReport } from "./report.js";
import { noAdoptions, noPayments, runSlot } from "./runner.js";
import { prepareRunBase, removeTree } from "./workspace.js";

/**
 * The benchmark harness (benchmark-protocol.md):
 *
 *   benchmark freeze <version> --tasks a,b,c --no-match d [--repetitions 3] [--stale-after-days 90]
 *   benchmark run <version>
 *   benchmark reconcile <version>
 *   benchmark probe <probe-version> --task <taskId> --bundle <bundle.json>
 *   benchmark report <version>
 *
 * The Cursor API key is read from standard input, which must be a pipe (for
 * example `op read … | npm run benchmark -- run v1`). Agents run unsandboxed as
 * this user and can read the environment this process and its parents started
 * with, so the key is never taken from the environment, and commands that run
 * agents refuse to start while this process's environment, or the one any
 * ancestor started with, holds anything that looks like a credential.
 *
 * Environment: LEMMA_BENCHMARK_MODEL (freeze, probe); LEMMA_BENCH_DIR for run
 * directories (default: the OS temp directory, outside the repository);
 * LEMMA_BRIDGE_COMMAND and LEMMA_API_URL for the treatment's bridge.
 */
const RUNS_DIR = join(BENCHMARK_ROOT, "runs");
const RULE_PATH = join(REPOSITORY_ROOT, "apps", "bridge", "rules", "lemma.mdc");
/** How long `probe` waits for billed cost to settle before asking to be run again. */
const PROBE_SETTLE_WAIT_MS = 15 * 60_000;

const [command, version, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const list = (name: string): string[] => (flag(name) ?? "").split(",").filter(Boolean);
const newRunId = (): Hex32 => `0x${randomBytes(32).toString("hex")}`;
const runBase = () => process.env["LEMMA_BENCH_DIR"] ?? join(tmpdir(), "lemma-bench");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Cursor API key, from a pipe on standard input: never the environment, a terminal, or a file whose path stays visible. */
async function readKey(): Promise<string> {
  const stdin = fstatSync(0);
  if (!stdin.isFIFO() && !stdin.isSocket()) {
    throw new Error("pipe the Cursor API key on standard input, for example `op read op://vault/cursor/key | npm run benchmark -- run v1`");
  }
  let key = "";
  for await (const chunk of process.stdin) key += String(chunk);
  key = key.trim();
  if (key === "") throw new Error("standard input carried no Cursor API key");
  return key;
}

/**
 * Refuses to run agents while this process's environment, or the environment
 * any readable ancestor started with, holds credential-like variables. `env -u`
 * is not enough: the shell that ran it keeps its copy in /proc.
 */
function assertCleanEnvironment(): void {
  const found = new Set(secretVariables(process.env));
  for (const { names } of ancestorSecretVariables()) for (const name of names) found.add(name);
  if (found.size > 0) {
    throw new Error(
      `the environment of this process or of the shell that started it holds ${[...found].sort().join(", ")}; agents run unsandboxed as this user and can read every ancestor's environment from /proc. Start the harness from a session that never had them: under "env -u" or "env -i", the shell that ran it keeps its copy, and the agent can read that too.`,
    );
  }
}

async function adapter(): Promise<CursorAdapter> {
  return new CursorAdapter(await readKey());
}

function experimentPath(v: string): string {
  return join(BENCHMARK_ROOT, "experiments", `${v}.json`);
}

async function freeze(v: string): Promise<void> {
  // A version is frozen once: re-freezing would let `run` resume attempts made under another fixture set.
  if (existsSync(experimentPath(v)) || RunLog.forVersion(RUNS_DIR, v).hasRuns()) throw new Error(`${v} is already frozen or has runs; freeze a new benchmark version`);
  assertCleanEnvironment();
  const noMatch = [...new Set(list("no-match"))].sort();
  // The no-match tasks are tasks too: `--tasks a,b,c --no-match d` freezes four.
  const tasks = [...new Set([...list("tasks"), ...noMatch])].sort();
  if (tasks.length === noMatch.length) throw new Error("freeze at least one matched task (--tasks); a benchmark of no-match tasks alone measures no saving");
  const modelId = process.env["LEMMA_BENCHMARK_MODEL"] ?? "";
  if (modelId === "") throw new Error("set LEMMA_BENCHMARK_MODEL to the model to freeze");
  const fixtures = loadBenchmarkFixtures().filter((f) => tasks.includes(f.fixture.taskId));
  if (fixtures.length !== tasks.length) throw new Error("every task needs a fixture under fixtures/<taskId>");
  for (const f of fixtures) {
    const listedNoMatch = noMatch.includes(f.fixture.taskId);
    if (listedNoMatch !== (f.fixture.kind === "no-match")) throw new Error(`${f.fixture.taskId} is a ${f.fixture.kind} fixture; list it under ${listedNoMatch ? "--tasks" : "--no-match"}`);
  }
  if (!existsSync(RULE_PATH)) throw new Error(`the Lemma rule ${RULE_PATH} is missing; the treatment cannot run without it`);
  // Everything that can be checked for free is checked before the paid smoke run.
  const config = ExperimentConfig.parse({
    schemaVersion: "1",
    benchmarkVersion: v,
    model: { id: modelId, params: [] },
    repetitions: Number(flag("repetitions") ?? "3"),
    tasks,
    noMatchTasks: noMatch,
    staleAfterDays: Number(flag("stale-after-days") ?? "90"),
    fixturesDigest: fixturesDigest(fixtures.map((f) => ({ taskId: f.fixture.taskId, dir: f.dir }))),
    ruleDigest: fileDigest(readFileSync(RULE_PATH)),
    frozenAt: new Date().toISOString(),
  });

  // The smoke agent runs under the same checks as every run: outside the repository, below no ambient settings.
  const base = prepareRunBase(runBase(), REPOSITORY_ROOT);

  const cursor = await adapter();
  const models = await cursor.models();
  if (!models.some((m) => m.id === modelId)) throw new Error(`model ${modelId} is not available to this key`);
  // Smoke run: the model must be priced per token, or savings cannot be measured in cost.
  const dir = mkdtempSync(join(base, "smoke-"));
  mkdirSync(join(dir, "home", "tmp"), { recursive: true });
  // Tracked, so an interrupted freeze kills what the smoke agent left running too.
  const untrackSmoke = trackHome(join(dir, "home"));
  try {
    const outcome = await cursor.run({ cwd: dir, home: join(dir, "home"), prompt: "Reply with the single word OK and do nothing else.", model: { id: modelId }, mcpServers: {}, timeoutMs: 120_000 });
    if (outcome.agentId === null) throw new Error(`smoke run did not start: ${outcome.error ?? outcome.status}`);
    const cents = await pollCost(cursor, outcome.agentId);
    if (cents === null) throw new Error("smoke run cost was not reported; retry freeze later");
    if (!(cents > 0)) throw new Error("rawCostCents is 0: the model is request-priced, so savings cannot be measured in cost");
  } finally {
    killByHome(join(dir, "home"));
    untrackSmoke();
    removeTree(dir);
  }

  mkdirSync(join(BENCHMARK_ROOT, "experiments"), { recursive: true });
  writeFileSync(experimentPath(v), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`frozen ${v}: ${tasks.length} tasks (${noMatch.length} no-match) x ${config.repetitions} repetitions, model ${modelId}`);
}

async function pollCost(cursor: AgentAdapter, agentId: string): Promise<number | null> {
  for (let i = 0; i < 36; i++) {
    const billed = await cursor.usage(agentId);
    if (billed !== null && billed.rawCostCents !== null) return billed.rawCostCents;
    await sleep(5000);
  }
  return null;
}

function bridgeLaunch(): McpStdioServer {
  const command = process.env["LEMMA_BRIDGE_COMMAND"] ?? join(REPOSITORY_ROOT, "apps", "bridge", "dist", "main.js");
  if (!existsSync(command)) throw new Error(`bridge not built: ${command}`);
  return { command: process.execPath, args: [command], env: { LEMMA_API_URL: process.env["LEMMA_API_URL"] ?? "http://localhost:3000" } };
}

async function run(v: string): Promise<void> {
  assertCleanEnvironment();
  const config = ExperimentConfig.parse(JSON.parse(readFileSync(experimentPath(v), "utf8")));
  const fixtures = loadBenchmarkFixtures().filter((f) => config.tasks.includes(f.fixture.taskId));
  if (fixturesDigest(fixtures.map((f) => ({ taskId: f.fixture.taskId, dir: f.dir }))) !== config.fixturesDigest) {
    throw new Error("fixtures changed since freeze; freeze a new benchmark version");
  }
  if (!existsSync(RULE_PATH) || fileDigest(readFileSync(RULE_PATH)) !== config.ruleDigest) throw new Error("the Lemma rule changed since freeze");
  const log = RunLog.forVersion(RUNS_DIR, v);
  log.lock();
  // Attempts already logged were made under this exact freeze, or `run` refuses.
  log.bind("experiment.json", config, "frozen experiment");
  const model: ModelSelection = { id: config.model.id, params: config.model.params };
  const bridge = bridgeLaunch();
  const cursor = await adapter();
  recoverInterrupted(log);
  // Resumes from the attempt log: a slot with a result, or with two startup failures, is not run again.
  for (const slot of planMatrix(config.tasks, config.repetitions)) {
    const fixture = fixtures.find((f) => f.fixture.taskId === slot.taskId);
    if (fixture === undefined) throw new Error(`no fixture for ${slot.taskId}`);
    const ctx = { adapter: cursor, fixture, benchmarkVersion: v, model, runBase: runBase(), repositoryRoot: REPOSITORY_ROOT, rulePath: RULE_PATH, bridge, preApply: null, payments: noPayments, adoptions: noAdoptions, newRunId, log };
    for (let n = nextAttempt(log.attempts(), slot); n !== null; n = nextAttempt(log.attempts(), slot)) {
      const attempt = await runSlot(slot, n, ctx);
      log.appendAttempt(attempt);
      const startup = attempt.startupFailure ? ` (startup failure: ${attempt.startupReason})` : "";
      console.log(`${slot.taskId} ${slot.arm} #${slot.repetition}: ${attempt.status}${startup}, acceptance ${attempt.acceptance.passed ? "passed" : "failed"}`);
    }
  }
}

async function probe(v: string): Promise<void> {
  if (!v.startsWith("probe-")) throw new Error("probe versions start with probe-, so they can never become evidence");
  assertCleanEnvironment();
  const taskId = flag("task");
  const bundlePath = flag("bundle");
  if (taskId === undefined || bundlePath === undefined) throw new Error("usage: benchmark probe <probe-version> --task <taskId> --bundle <bundle.json>");
  const fixture = loadBenchmarkFixtures().find((f) => f.fixture.taskId === taskId);
  if (fixture === undefined) throw new Error(`no fixture for ${taskId}`);
  const bundle = PatchBundle.parse(JSON.parse(readFileSync(bundlePath, "utf8")));
  const model: ModelSelection = { id: process.env["LEMMA_BENCHMARK_MODEL"] ?? "" };
  if (model.id === "") throw new Error("set LEMMA_BENCHMARK_MODEL");
  const log = RunLog.forVersion(RUNS_DIR, v);
  log.lock();

  // A probe version is one experiment: the same task, fixture, bundle and model on every invocation.
  const setup = { taskId, fixturesDigest: fixturesDigest([{ taskId, dir: fixture.dir }]), bundleDigest: bundleDigest(bundle), model: model.id };
  log.bind("probe.json", setup, "probe task, fixture, bundle or model");

  const cursor = await adapter();
  recoverInterrupted(log);
  const base = { adapter: cursor, fixture, benchmarkVersion: v, model, runBase: runBase(), repositoryRoot: REPOSITORY_ROOT, rulePath: null, bridge: null, payments: noPayments, adoptions: noAdoptions, newRunId, log };
  // Resumes from the attempt log: running the probe again only fills what is missing.
  for (let slot = nextProbeSlot(log.attempts(), taskId); slot !== null; slot = nextProbeSlot(log.attempts(), taskId)) {
    const attempt = await runSlot(slot, 1, { ...base, preApply: slot.arm === "treatment" ? bundle : null });
    log.appendAttempt(attempt);
    console.log(`${taskId} ${slot.arm} #${slot.repetition}: ${attempt.status}, acceptance ${attempt.acceptance.passed ? "passed" : "failed"}`);
  }
  const waitUntil = Date.now() + PROBE_SETTLE_WAIT_MS;
  for (let result = await reconcile(log, cursor); result.pending > 0; result = await reconcile(log, cursor)) {
    printErrors(result);
    if (Date.now() >= waitUntil) {
      throw new Error("billed cost has not settled yet; run the same `benchmark probe` command again later: it runs nothing new, it only reconciles and decides");
    }
    await sleep(30_000);
  }
  const economics = loadCatalog({ root: CATALOG_ROOT, includeProvisional: false }).economics;
  if (economics.status !== "measured") console.warn("economics.json is a placeholder: the verdict uses its placeholder chain cost and price floor and is provisional");
  const verdict = probeVerdict(log.records(), log.attempts(), taskId, { status: economics.status, chainCostAtomic: BigInt(economics.chainCostAtomic), priceFloorAtomic: BigInt(economics.priceFloorAtomic) });
  const text = JSON.stringify(verdict, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2);
  writeFileSync(join(log.dir, `probe-${taskId}.json`), `${text}\n`);
  console.log(text);
}

async function main(): Promise<void> {
  if (version === undefined) throw new Error("usage: benchmark <freeze|run|reconcile|probe|report> <version> ...");
  if (command === "freeze") return freeze(version);
  if (command === "run") return run(version);
  if (command === "probe") return probe(version);
  if (command === "reconcile") {
    const log = RunLog.forVersion(RUNS_DIR, version);
    log.lock();
    const cursor = await adapter();
    recoverInterrupted(log);
    const result = await reconcile(log, cursor);
    printErrors(result);
    console.log(`reconciled ${result.reconciled}; ${result.pending} still pending (a cost is final only once it has settled, several minutes after a run)`);
    return;
  }
  if (command === "report") {
    const config = ExperimentConfig.parse(JSON.parse(readFileSync(experimentPath(version), "utf8")));
    const log = RunLog.forVersion(RUNS_DIR, version);
    log.lock();
    log.bind("experiment.json", config, "frozen experiment");
    recoverInterrupted(log);
    const pending = log.pending().length;
    if (pending > 0) throw new Error(`${pending} attempts have no settled cost yet; run \`benchmark reconcile ${version}\` until none are pending`);
    const report = buildReport(log.records(), log.attempts(), {
      benchmarkVersion: version,
      tasks: config.tasks,
      repetitions: config.repetitions,
      noMatchTaskIds: config.noMatchTasks,
      staleAfterDays: config.staleAfterDays,
    });
    mkdirSync(join(BENCHMARK_ROOT, "reports"), { recursive: true });
    writeFileSync(join(BENCHMARK_ROOT, "reports", `${version}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report ${version}: ${report.passes ? "passes" : "does not pass"}; ${report.evidence.length} evidence entries`);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

/** The log of the command in progress, so an interrupted harness can record the run it was in. */
let activeLog: RunLog | null = null;

/** Records runs an earlier invocation started but never recorded, and makes this log the one an interruption records into. */
function recoverInterrupted(log: RunLog): void {
  activeLog = log;
  const recovered = log.recoverInterrupted();
  if (recovered > 0) console.warn(`recorded ${recovered} run(s) an earlier invocation started but did not finish; they count and are not run again`);
}

function printErrors(result: ReconcileResult): void {
  for (const e of result.errors) console.warn(`usage lookup for ${e.agentId} failed: ${e.error}; it stays pending`);
}

// An interrupted harness takes the runs it started down with it, and records the one it was in.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    killRunGroups();
    try {
      activeLog?.recoverInterrupted();
    } catch (error) {
      console.error(`could not record the interrupted run: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(130);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
