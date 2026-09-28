import { randomBytes } from "node:crypto";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CATALOG_ROOT, loadCatalog } from "@lemma/catalog";
import { type Hex32, PatchBundle, bundleDigest, fileDigest } from "@lemma/core";

import type { AgentAdapter, AgentKind, AgentRunOutcome, McpStdioServer, ModelSelection } from "./adapter.js";
import { loadAnthropicPrices, pricesDigest } from "./anthropic-usage.js";
import { ClaudeCodeAdapter, claudeCodeVersion, findClaudeCode, readMeteredUsage } from "./claude-code.js";
import { CodexAdapter, codexVersion, findCodex, readCodexMeteredUsage } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { AgentSetup, ExperimentConfig, fixturesDigest } from "./experiment.js";
import { BENCHMARK_ROOT, type LoadedBenchmarkFixture, REPOSITORY_ROOT, loadBenchmarkFixtures } from "./fixture.js";
import { nextAttempt, planMatrix } from "./matrix.js";
import { loadOpenAiPrices, openAiPricesDigest } from "./openai-usage.js";
import { isProbeMeasurement, nextProbeSlot, probeReplacementsLeft, probeVerdict } from "./probe.js";
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
 * The agent's API key (Cursor's, Anthropic's for Claude Code, or OpenAI's for
 * Codex) is read from standard input, which must be a pipe (for example `op read … | npm run
 * benchmark -- run v1`). Agents run unsandboxed as this user and can read the
 * environment this process and its parents started with, so the key is never
 * taken from the environment, and commands that run agents refuse to start
 * while this process's environment, or the one any ancestor started with,
 * holds anything that looks like a credential. Reconciling Claude Code and
 * Codex runs reads their meter records and needs no key.
 *
 * Environment: LEMMA_BENCHMARK_AGENT (freeze, probe: `cursor`, the default,
 * `claude-code` or `codex`; later commands take the agent the version was
 * started with); LEMMA_BENCHMARK_MODEL (freeze, probe); LEMMA_CLAUDE_COMMAND
 * and LEMMA_CODEX_COMMAND (the absolute path of `claude` or `codex`, default:
 * the first on PATH); LEMMA_CODEX_LOGIN=chatgpt (probe only: Codex on the
 * ChatGPT plan `codex login` signed this user in with, no key read, cost from
 * Codex's own token counts); LEMMA_BENCH_DIR for run
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

const KEY_NAME: Readonly<Record<AgentKind, string>> = { cursor: "Cursor API key", "claude-code": "Anthropic API key", codex: "OpenAI API key" };

/** The agent's API key, from a pipe on standard input: never the environment, a terminal, or a file whose path stays visible. */
async function readKey(agent: AgentKind): Promise<string> {
  const stdin = fstatSync(0);
  if (!stdin.isFIFO() && !stdin.isSocket()) {
    throw new Error(`pipe the ${KEY_NAME[agent]} on standard input, for example \`op read op://vault/${agent}/key | npm run benchmark -- run v1\``);
  }
  let key = "";
  for await (const chunk of process.stdin) key += String(chunk);
  key = key.trim();
  if (key === "") throw new Error(`standard input carried no ${KEY_NAME[agent]}`);
  // Another provider's key usually means LEMMA_BENCHMARK_AGENT was left unset or mistyped (Cursor is the default).
  const anthropic = key.startsWith("sk-ant-");
  const openai = !anthropic && key.startsWith("sk-");
  if (anthropic && agent !== "claude-code") throw new Error(`that is an Anthropic API key, and this version runs ${agent}: start a Claude Code version with LEMMA_BENCHMARK_AGENT=claude-code`);
  // Cursor's key format is not documented, so only Claude Code is told about an OpenAI key.
  if (openai && agent === "claude-code") throw new Error(`that looks like an OpenAI API key, and this version runs Claude Code: start a Codex version with LEMMA_BENCHMARK_AGENT=codex`);
  // A pasted ChatGPT sign-in (Codex's auth.json, or its access token) is not an API key; a probe signs in through `codex login` instead.
  if (agent === "codex" && !openai) throw new Error("Codex runs need an OpenAI API key (it starts with sk-), from platform.openai.com; to run a probe on a ChatGPT plan instead, sign in with `codex login --device-auth` and set LEMMA_CODEX_LOGIN=chatgpt, with nothing on standard input");
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

/** The agent `freeze` and `probe` start a version with: LEMMA_BENCHMARK_AGENT, Cursor unless set. */
function chosenAgent(): AgentKind {
  const name = process.env["LEMMA_BENCHMARK_AGENT"] ?? "cursor";
  if (name !== "cursor" && name !== "claude-code" && name !== "codex") throw new Error(`LEMMA_BENCHMARK_AGENT must be cursor, claude-code or codex, not ${name}`);
  return name;
}

/** Whether Codex runs on a ChatGPT plan login (LEMMA_CODEX_LOGIN=chatgpt) instead of an API key. */
function chatgptLogin(): boolean {
  const value = process.env["LEMMA_CODEX_LOGIN"] ?? "";
  if (value !== "" && value !== "chatgpt") throw new Error(`LEMMA_CODEX_LOGIN must be chatgpt or unset, not ${value}`);
  if (value === "chatgpt" && chosenAgent() !== "codex") throw new Error("LEMMA_CODEX_LOGIN=chatgpt needs LEMMA_BENCHMARK_AGENT=codex");
  return value === "chatgpt";
}

/** Where `codex login` keeps this user's login: CODEX_HOME, else ~/.codex. */
function codexLoginHome(): string {
  const home = process.env["CODEX_HOME"];
  if (home !== undefined && home !== "") return resolve(home);
  return join(homedir(), ".codex");
}

/** The installed agent's release: `@cursor/sdk`'s package version, or `claude --version` or `codex --version` with the agent's price table. */
function agentSetup(name: AgentKind, login = false): AgentSetup {
  if (name === "codex") {
    return AgentSetup.parse({ name, version: codexVersion(findCodex()), pricesDigest: openAiPricesDigest(loadOpenAiPrices()), ...(login ? { login: "chatgpt" } : {}) });
  }
  if (name === "claude-code") {
    return AgentSetup.parse({ name, version: claudeCodeVersion(findClaudeCode()), pricesDigest: pricesDigest(loadAnthropicPrices()) });
  }
  const manifest = join(REPOSITORY_ROOT, "node_modules", "@cursor", "sdk", "package.json");
  if (!existsSync(manifest)) throw new Error("@cursor/sdk is not installed; run npm install");
  return AgentSetup.parse({ name, version: (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version, pricesDigest: null });
}

/** Refuses when the installed agent is not the one a version was started with: every run of a version uses one release. */
function assertSameAgent(bound: AgentSetup): void {
  const now = agentSetup(bound.name, bound.login !== undefined);
  if (now.version !== bound.version) throw new Error(`${bound.name} is at ${now.version} now and this version ran ${bound.version}; use a new version`);
  if (now.pricesDigest !== bound.pricesDigest) throw new Error(`prices/${bound.name === "codex" ? "openai" : "anthropic"}.json changed since this version started; use a new version`);
}

interface OpenAgent {
  readonly adapter: AgentAdapter;
  /** Checks, without a benchmark run, that the key can use the model (Claude Code and Codex: with one tiny request; a Codex ChatGPT login: with one short run). */
  checkModel(model: string): Promise<void>;
  close(): Promise<void>;
}

/** Reads the key and starts the agent; Claude Code and Codex keep each run's meter record under `meterDir`. */
async function openAgent(setup: AgentSetup, meterDir: string): Promise<OpenAgent> {
  if (setup.name === "cursor") {
    const cursor = new CursorAdapter(await readKey("cursor"));
    return {
      adapter: cursor,
      checkModel: async (model) => {
        if (!(await cursor.models()).some((m) => m.id === model)) throw new Error(`model ${model} is not available to this key`);
      },
      close: async () => undefined,
    };
  }
  if (setup.name === "codex" && setup.login !== undefined) {
    const codex = new CodexAdapter(null, { command: findCodex(), meterDir, prices: loadOpenAiPrices(), chatgptLogin: codexLoginHome() });
    return { adapter: codex, checkModel: (model) => inScratch((dir) => codex.checkLogin(model, dir)), close: () => codex.close() };
  }
  if (setup.name === "codex") {
    const codex = new CodexAdapter(await readKey("codex"), { command: findCodex(), meterDir, prices: loadOpenAiPrices() });
    return { adapter: codex, checkModel: (model) => codex.checkModel(model), close: () => codex.close() };
  }
  if (process.getuid?.() === 0) throw new Error("Claude Code will not run with permission checks off as root, and a benchmark run cannot stop for prompts: run the harness as a normal user");
  const claude = new ClaudeCodeAdapter(await readKey("claude-code"), { command: findClaudeCode(), meterDir, prices: loadAnthropicPrices() });
  return { adapter: claude, checkModel: (model) => claude.checkModel(model), close: () => claude.close() };
}

/**
 * Runs a check that starts an agent in a fresh directory under the run base,
 * which is outside the repository and below no ambient settings, then kills
 * whatever the agent left running and removes the directory.
 */
async function inScratch(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(prepareRunBase(runBase(), REPOSITORY_ROOT), "check-"));
  const untrack = trackHome(join(dir, "home"));
  try {
    await check(dir);
  } finally {
    killByHome(join(dir, "home"));
    untrack();
    removeTree(dir);
  }
}

/** What `reconcile` reads cost through: Cursor's billing (with the key), or Claude Code's or Codex's meter records (without one). */
async function usageSource(setup: AgentSetup, meterDir: string): Promise<Pick<AgentAdapter, "usage">> {
  if (setup.name === "cursor") return new CursorAdapter(await readKey("cursor"));
  if (setup.name === "codex") return { usage: async (agentId) => readCodexMeteredUsage(meterDir, agentId, setup.pricesDigest ?? "") };
  return { usage: async (agentId) => readMeteredUsage(meterDir, agentId, setup.pricesDigest ?? "") };
}

/** The agent a version was started with: its frozen experiment, or its probe setup. */
function boundAgent(v: string, log: RunLog): AgentSetup {
  if (existsSync(experimentPath(v))) return ExperimentConfig.parse(JSON.parse(readFileSync(experimentPath(v), "utf8"))).agent;
  const probeSetup = join(log.dir, "probe.json");
  if (existsSync(probeSetup)) return AgentSetup.parse((JSON.parse(readFileSync(probeSetup, "utf8")) as { agent?: unknown }).agent);
  throw new Error(`${v} is neither frozen nor a probe with runs`);
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
  if (chatgptLogin()) throw new Error("LEMMA_CODEX_LOGIN=chatgpt is for probes only: a benchmark's cost must be metered, so freeze with an OpenAI API key");
  const agent = agentSetup(chosenAgent());
  // Everything that can be checked for free is checked before the paid smoke run.
  const config = ExperimentConfig.parse({
    schemaVersion: "1",
    benchmarkVersion: v,
    agent,
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

  // Smoke run: the model must be priced per token, or savings cannot be measured in cost.
  const dir = mkdtempSync(join(base, "smoke-"));
  const work = join(dir, "work");
  mkdirSync(join(dir, "home", "tmp"), { recursive: true });
  mkdirSync(work);
  // Tracked, so an interrupted freeze kills what the smoke agent left running too.
  const untrackSmoke = trackHome(join(dir, "home"));
  let opened: OpenAgent | null = null;
  try {
    opened = await openAgent(agent, join(dir, "meter"));
    await opened.checkModel(modelId);
    const outcome = await opened.adapter.run({ cwd: work, home: join(dir, "home"), prompt: "Reply with the single word OK and do nothing else.", model: { id: modelId }, mcpServers: {}, timeoutMs: 120_000 });
    if (outcome.agentId === null) throw new Error(`smoke run did not start: ${outcome.error ?? outcome.status}`);
    const cents = await pollCost(opened.adapter, outcome.agentId);
    if (cents === null) throw new Error("smoke run cost was not reported; retry freeze later");
    if (!(cents > 0)) throw new Error("rawCostCents is 0: the model is request-priced, so savings cannot be measured in cost");
  } finally {
    await opened?.close();
    killByHome(join(dir, "home"));
    untrackSmoke();
    removeTree(dir);
  }

  mkdirSync(join(BENCHMARK_ROOT, "experiments"), { recursive: true });
  writeFileSync(experimentPath(v), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`frozen ${v}: ${tasks.length} tasks (${noMatch.length} no-match) x ${config.repetitions} repetitions, ${agent.name} ${agent.version}, model ${modelId}`);
}

async function pollCost(agent: AgentAdapter, agentId: string): Promise<number | null> {
  for (let i = 0; i < 36; i++) {
    const billed = await agent.usage(agentId);
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
  assertSameAgent(config.agent);
  const log = RunLog.forVersion(RUNS_DIR, v);
  log.lock();
  // Attempts already logged were made under this exact freeze, or `run` refuses.
  log.bind("experiment.json", config, "frozen experiment");
  const model: ModelSelection = { id: config.model.id, params: config.model.params };
  const bridge = bridgeLaunch();
  const agent = await openAgent(config.agent, join(log.dir, "meter"));
  try {
    await runMatrix(v, config, fixtures, model, bridge, agent.adapter, log);
  } finally {
    await agent.close();
  }
}

async function runMatrix(v: string, config: ExperimentConfig, fixtures: readonly LoadedBenchmarkFixture[], model: ModelSelection, bridge: McpStdioServer, adapter: AgentAdapter, log: RunLog): Promise<void> {
  recoverInterrupted(log);
  // Resumes from the attempt log: a slot with a result, or with two startup failures, is not run again.
  for (const slot of planMatrix(config.tasks, config.repetitions)) {
    const fixture = fixtures.find((f) => f.fixture.taskId === slot.taskId);
    if (fixture === undefined) throw new Error(`no fixture for ${slot.taskId}`);
    const ctx = { adapter, fixture, benchmarkVersion: v, model, runBase: runBase(), repositoryRoot: REPOSITORY_ROOT, rulePath: RULE_PATH, bridge, preApply: null, payments: noPayments, adoptions: noAdoptions, newRunId, log, onAgentEnd: warnAgentError };
    for (let n = nextAttempt(log.attempts(), slot); n !== null; n = nextAttempt(log.attempts(), slot)) {
      announce(slot.taskId, slot.arm, slot.repetition, fixture);
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
  // `npm run benchmark` runs in this workspace's directory; a relative path means the one npm was started from.
  const bundle = PatchBundle.parse(JSON.parse(readFileSync(resolve(process.env["INIT_CWD"] ?? process.cwd(), bundlePath), "utf8")));
  const model: ModelSelection = { id: process.env["LEMMA_BENCHMARK_MODEL"] ?? "" };
  if (model.id === "") throw new Error("set LEMMA_BENCHMARK_MODEL");
  const log = RunLog.forVersion(RUNS_DIR, v);

  // A probe version is one experiment: the same task, fixture, bundle, agent release and model on every invocation.
  const setup = { taskId, fixturesDigest: fixturesDigest([{ taskId, dir: fixture.dir }]), bundleDigest: bundleDigest(bundle), agent: agentSetup(chosenAgent(), chatgptLogin()), model: model.id };
  const agent = await openAgent(setup.agent, join(log.dir, "meter"));
  try {
    // Checked before the version is bound and before the first run, so a wrong agent, key or model
    // leaves nothing behind and the corrected command can reuse the version.
    if (setup.agent.name !== "cursor") await agent.checkModel(model.id);
    log.lock();
    log.bind("probe.json", setup, "probe task, fixture, bundle, agent release or model");
    await probeRuns(v, taskId, fixture, bundle, model, agent.adapter, log);
  } finally {
    await agent.close();
  }
}

async function probeRuns(v: string, taskId: string, fixture: LoadedBenchmarkFixture, bundle: PatchBundle, model: ModelSelection, adapter: AgentAdapter, log: RunLog): Promise<void> {
  recoverInterrupted(log, "they measured nothing, so the probe replaces them");
  const base = { adapter, fixture, benchmarkVersion: v, model, runBase: runBase(), repositoryRoot: REPOSITORY_ROOT, rulePath: null, bridge: null, payments: noPayments, adoptions: noAdoptions, newRunId, log, onAgentEnd: warnAgentError };
  // Resumes from the attempt log: running the probe again only fills what is missing.
  for (let slot = nextProbeSlot(log.attempts(), taskId); slot !== null; slot = nextProbeSlot(log.attempts(), taskId)) {
    announce(taskId, slot.arm, slot.repetition, fixture);
    const attempt = await runSlot(slot, 1, { ...base, preApply: slot.arm === "treatment" ? bundle : null });
    log.appendAttempt(attempt);
    const startup = attempt.startupFailure ? ` (startup failure: ${attempt.startupReason})` : "";
    console.log(`${taskId} ${slot.arm} #${slot.repetition}: ${attempt.status}${startup}, acceptance ${attempt.acceptance.passed ? "passed" : "failed"}`);
    // The replacement waits for the next invocation: what failed this run (a plan's usage limit, a
    // lost login, credit that ran out) would fail the replacements too and use them all up at once.
    // With none left, nextProbeSlot gives up instead.
    const left = probeReplacementsLeft(log.attempts(), taskId, slot.arm);
    if (!isProbeMeasurement(attempt) && left >= 0) {
      throw new Error(`${taskId} ${slot.arm} #${slot.repetition} measured nothing, so the probe stopped rather than replace it straight away (${left} ${left === 1 ? "replacement" : "replacements"} left for the ${slot.arm} runs). Once its cause is fixed or has passed, run the same command again: it continues where it stopped.`);
    }
  }
  // Only the runs the verdict can use are waited for: one that measured nothing (an interrupted run
  // has no meter record) may never settle, and the verdict does not read it.
  const unsettled = () => log.pending().filter((a) => a.taskId === taskId && isProbeMeasurement(a)).length;
  const waitUntil = Date.now() + PROBE_SETTLE_WAIT_MS;
  const shown = new Set<string>();
  for (let first = true; ; first = false) {
    const result = await reconcile(log, adapter);
    printErrors(result, shown);
    if (unsettled() === 0) break;
    if (first) console.log("waiting for the runs' cost to settle, about six minutes after the last run ended");
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
    const source = await usageSource(boundAgent(version, log), join(log.dir, "meter"));
    recoverInterrupted(log);
    const result = await reconcile(log, source);
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
function recoverInterrupted(log: RunLog, outcome = "they count and are not run again"): void {
  activeLog = log;
  const recovered = log.recoverInterrupted();
  if (recovered > 0) console.warn(`recorded ${recovered} run(s) an earlier invocation started but did not finish; ${outcome}`);
}

/** Prints failed usage lookups, each run's once when `shown` is given. */
function printErrors(result: ReconcileResult, shown?: Set<string>): void {
  for (const e of result.errors) {
    if (shown?.has(e.agentId) === true) continue;
    shown?.add(e.agentId);
    console.warn(`usage lookup for ${e.agentId} failed: ${e.error}; it stays pending`);
  }
}

/** Says a run is starting: nothing else prints until it ends. */
function announce(taskId: string, arm: string, repetition: number, fixture: LoadedBenchmarkFixture): void {
  console.log(`${taskId} ${arm} #${repetition}: starting; it can take up to ${Math.ceil(fixture.fixture.maxDurationSec / 60)} minutes and prints nothing until it ends`);
}

/** Says why an agent run failed; the attempt log keeps no agent text. */
function warnAgentError(outcome: AgentRunOutcome): void {
  if (outcome.status !== "finished" && outcome.error !== null) console.warn(`the agent run ended with ${outcome.status}: ${outcome.error}`);
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
  // A failed request says only "fetch failed"; its cause says why (no network, a refused connection).
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  console.error(`${error instanceof Error ? error.message : String(error)}${cause}`);
  process.exitCode = 1;
});
