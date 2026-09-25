import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { type PatchBundle, type RunRecord, profileDigest } from "@lemma/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AgentRunOutcome,
  type AgentRunRequest,
  Attempt,
  BENCHMARK_ROOT,
  BenchmarkFixture,
  COST_SETTLE_MS,
  COST_STABLE_GAP_MS,
  CursorAdapter,
  FakeAdapter,
  RunLog,
  UsageError,
  WorkspaceError,
  ZERO_COST_AFTER_MS,
  agentPath,
  buildReport,
  centsToMicroUsd,
  deriveEvidence,
  finalize,
  loadBenchmarkFixtures,
  PLACEHOLDER_ECONOMICS_NOTE,
  ancestorSecretVariables,
  installArgv,
  interruptedAttempt,
  killByHome,
  modelLabel,
  nextAttempt,
  nextProbeSlot,
  observe,
  planMatrix,
  prepareRunBase,
  prepareWorkspace,
  removeTree,
  probeVerdict,
  readTrace,
  reconcile,
  reductionBps,
  runSlot,
  secretVariables,
  settledBilling,
  toRunTokens,
  yarnFlavor,
} from "../src/index.js";

const REPO_ROOT = resolvePath(BENCHMARK_ROOT, "..", "..");
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 20, totalTokens: 1370, reasoningTokens: 100 };
const hex = (b: string) => `0x${b.repeat(32)}`;

const profile = {
  schemaVersion: "1" as const,
  language: "typescript" as const,
  runtime: { name: "node" as const, major: 22 },
  packageManager: { name: "npm" as const, lockfile: "package-lock.json" as const },
  moduleSystem: "esm" as const,
  dependencies: { "@modelcontextprotocol/sdk": "1.30.1" },
  frameworks: [],
};

/** A fixture whose acceptance passes once `done.txt` exists, and which records the environment it saw. */
function makeFixture(root: string, taskId = "add-greeting"): string {
  const dir = join(root, "fixtures", taskId);
  mkdirSync(join(dir, "repo"), { recursive: true });
  writeFileSync(join(dir, "repo", "check.mjs"), `import { existsSync, writeFileSync } from "node:fs";\nwriteFileSync("env-seen.json", JSON.stringify(Object.keys(process.env).sort()));\nprocess.exit(existsSync("done.txt") ? 0 : 1);\n`);
  writeFileSync(join(dir, "repo", "README.md"), "fixture\n");
  const fixture: BenchmarkFixture = {
    schemaVersion: "1",
    taskId,
    kind: "match",
    capability: "mcp-server.add-payment-gating",
    catalogCase: "mcp-server.add-payment-gating/exact-npm-node22",
    profile,
    initialCommit: null,
    prompt: "Create done.txt.",
    network: "open",
    setup: null,
    acceptance: { argv: [process.execPath, "check.mjs"], timeoutSec: 30 },
    expected: { passed: true },
    maxDurationSec: 600,
  };
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  return root;
}

const finished = (agentId: string, edit?: (r: AgentRunRequest) => void) => (r: AgentRunRequest): AgentRunOutcome => {
  edit?.(r);
  return { agentId, status: "finished", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:05:00.000Z", toolCalls: [{ callId: "a", name: "edit", status: "completed" }, { callId: "b", name: "shell", status: "error" }], usage, error: null };
};

let n = 0;
const newRunId = () => `0x${(++n).toString(16).padStart(64, "0")}`;

function attemptOf(over: Partial<Attempt> = {}): Attempt {
  return Attempt.parse({
    schemaVersion: "1",
    runId: newRunId(),
    benchmarkVersion: "bench-1",
    taskId: "add-greeting",
    arm: "control",
    repetition: 1,
    attempt: 1,
    fixtureProfileDigest: hex("13"),
    releaseDigest: null,
    baseReleaseDigest: null,
    model: "example-model-1",
    agentId: "agent-x",
    status: "finished",
    startupFailure: false,
    startupReason: null,
    lemmaCalls: 0,
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:05:00.000Z",
    tokens: null,
    toolCalls: 1,
    retries: 0,
    filesChanged: 1,
    humanInterventions: 0,
    acceptance: { passed: true, exitCode: 0 },
    payment: null,
    ...over,
  });
}

const startupFailure = (over: Partial<Attempt> = {}) => attemptOf({ agentId: null, status: "startup-error", startupFailure: true, startupReason: "agent", ...over });

function context(root: string, adapter: FakeAdapter, over: Record<string, unknown> = {}) {
  const [fixture] = loadBenchmarkFixtures(root);
  if (fixture === undefined) throw new Error("no fixture");
  return {
    adapter,
    fixture,
    benchmarkVersion: "bench-1",
    model: { id: "example-model-1" },
    runBase: temp("lemma-runs-"),
    repositoryRoot: REPO_ROOT,
    rulePath: null,
    bridge: null,
    preApply: null,
    payments: { paymentFor: async () => null },
    adoptions: { adoptedRelease: async () => null },
    newRunId,
    ...over,
  };
}

describe("token and cost mapping", () => {
  it("splits reasoning out of output so the five counts sum to the SDK total", () => {
    expect(toRunTokens(usage)).toEqual({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 20, reasoning: 100 });
    expect(toRunTokens({ ...usage, reasoningTokens: undefined })).toMatchObject({ output: 300, reasoning: 0 });
    expect(() => toRunTokens({ ...usage, reasoningTokens: 301 })).toThrow(UsageError);
    expect(() => toRunTokens({ ...usage, inputTokens: -1 })).toThrow(UsageError);
  });

  it("converts float cents to integer micro-USD", () => {
    expect(centsToMicroUsd(12.34567)).toBe(123_457n);
    expect(centsToMicroUsd(0)).toBe(0n);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => centsToMicroUsd(bad)).toThrow(UsageError);
  });
});

describe("matrix", () => {
  it("interleaves arms and alternates which goes first", () => {
    expect(planMatrix(["b", "a"], 2)).toEqual([
      { taskId: "a", arm: "control", repetition: 1 },
      { taskId: "a", arm: "treatment", repetition: 1 },
      { taskId: "b", arm: "control", repetition: 1 },
      { taskId: "b", arm: "treatment", repetition: 1 },
      { taskId: "a", arm: "treatment", repetition: 2 },
      { taskId: "a", arm: "control", repetition: 2 },
      { taskId: "b", arm: "treatment", repetition: 2 },
      { taskId: "b", arm: "control", repetition: 2 },
    ]);
  });

  it("resumes a slot from the attempt log instead of repeating it", () => {
    const slot = { taskId: "add-greeting", arm: "control" as const, repetition: 1 };
    expect(nextAttempt([], slot)).toBe(1);
    expect(nextAttempt([attemptOf()], slot)).toBeNull();
    expect(nextAttempt([attemptOf({ repetition: 2 }), attemptOf({ arm: "treatment" })], slot)).toBe(1);
    expect(nextAttempt([startupFailure()], slot)).toBe(2);
    expect(nextAttempt([startupFailure(), startupFailure({ attempt: 2 })], slot)).toBeNull();
    expect(nextAttempt([startupFailure(), attemptOf({ attempt: 2 })], slot)).toBeNull();
  });
});

describe("workspace isolation", () => {
  it("refuses run directories inside the repository or under Cursor settings", () => {
    const root = makeFixture(temp("lemma-fx-"));
    const fixtureDir = join(root, "fixtures", "add-greeting");
    expect(() => prepareWorkspace({ base: join(REPO_ROOT, "packages", "benchmark", "runs", "x"), runId: newRunId(), fixtureDir, repositoryRoot: REPO_ROOT, rulePath: null })).toThrow(WorkspaceError);
    const polluted = temp("lemma-polluted-");
    mkdirSync(join(polluted, ".cursor"));
    expect(() => prepareWorkspace({ base: join(polluted, "runs"), runId: newRunId(), fixtureDir, repositoryRoot: REPO_ROOT, rulePath: null })).toThrow(/ambient settings/);
  });

  it("refuses every file the SDK loads from ancestors, and an enclosing repository", () => {
    const root = makeFixture(temp("lemma-fx-"));
    const fixtureDir = join(root, "fixtures", "add-greeting");
    for (const name of ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".cursorrules", ".git"]) {
      const above = temp("lemma-above-");
      writeFileSync(join(above, name), "x\n");
      expect(() => prepareWorkspace({ base: join(above, "a", "runs"), runId: newRunId(), fixtureDir, repositoryRoot: REPO_ROOT, rulePath: null })).toThrow(WorkspaceError);
    }
  });

  it("resolves symlinks, so a linked run directory cannot land inside the repository", () => {
    const root = makeFixture(temp("lemma-fx-"));
    const link = join(temp("lemma-link-"), "runs");
    symlinkSync(join(REPO_ROOT, "packages", "benchmark"), link);
    expect(() => prepareWorkspace({ base: link, runId: newRunId(), fixtureDir: join(root, "fixtures", "add-greeting"), repositoryRoot: REPO_ROOT, rulePath: null })).toThrow(/inside the repository/);
  });

  it("removes a half-made run directory when the copy fails", () => {
    const root = makeFixture(temp("lemma-fx-"));
    const base = temp("lemma-runs-");
    const runId = newRunId();
    expect(() => prepareWorkspace({ base, runId, fixtureDir: join(root, "fixtures", "add-greeting"), repositoryRoot: REPO_ROOT, rulePath: join(base, "missing.mdc") })).toThrow();
    expect(existsSync(join(base, runId.slice(2, 18)))).toBe(false);
  });

  it("gives the treatment the rule and nothing else", () => {
    const root = makeFixture(temp("lemma-fx-"));
    const rule = join(temp("lemma-rule-"), "lemma.mdc");
    writeFileSync(rule, "call lemma_preview first\n");
    const ws = prepareWorkspace({ base: temp("lemma-runs-"), runId: newRunId(), fixtureDir: join(root, "fixtures", "add-greeting"), repositoryRoot: REPO_ROOT, rulePath: rule });
    expect(readFileSync(join(ws.cwd, ".cursor", "rules", "lemma.mdc"), "utf8")).toBe("call lemma_preview first\n");
    expect(readFileSync(join(ws.cwd, "README.md"), "utf8")).toBe("fixture\n");
    ws.dispose();
  });

  it("reads the bridge trace, tolerating a torn last line", () => {
    const dir = temp("lemma-trace-");
    writeFileSync(join(dir, "t.jsonl"), '{"event":"initialize"}\n{"event":"tool","name":"lemma_preview"}\n{"event":"to');
    expect(readTrace(join(dir, "t.jsonl"))).toEqual({ initialized: true, toolCalls: 1 });
    expect(readTrace(join(dir, "missing.jsonl"))).toEqual({ initialized: false, toolCalls: 0 });
  });
});

describe("runSlot", () => {
  it("records counts, digests and acceptance from a run in a scrubbed environment", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    process.env["CURSOR_API_KEY"] = "must-never-reach-a-run";
    const adapter = new FakeAdapter([finished("agent-1", (r) => writeFileSync(join(r.cwd, "done.txt"), "ok\n"))]);
    const ctx = context(root, adapter, { keepWorkspace: true });
    const attempt = await runSlot({ taskId: "add-greeting", arm: "control", repetition: 1 }, 1, ctx);
    expect(attempt).toMatchObject({
      arm: "control",
      agentId: "agent-1",
      startupFailure: false,
      toolCalls: 2,
      retries: 1,
      filesChanged: 1,
      acceptance: { passed: true, exitCode: 0 },
      tokens: { input: 1000, output: 200, reasoning: 100 },
      fixtureProfileDigest: profileDigest(profile),
      model: "example-model-1",
      releaseDigest: null,
      payment: null,
    });
    expect(adapter.requests[0]?.mcpServers).toEqual({});
    const seen = JSON.parse(readFileSync(join(adapter.requests[0]?.cwd as string, "env-seen.json"), "utf8")) as string[];
    expect(seen).toEqual(["CI", "HOME", "LANG", "PATH", "TMPDIR", "TZ"]);
    delete process.env["CURSOR_API_KEY"];
  });

  it("records a failed fixture setup as a startup failure instead of aborting", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const path = join(root, "fixtures", "add-greeting", "fixture.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), setup: { argv: [process.execPath, "-e", "process.exit(7)"], timeoutSec: 30 } }));
    const adapter = new FakeAdapter([]);
    const attempt = await runSlot({ taskId: "add-greeting", arm: "control", repetition: 1 }, 1, context(root, adapter));
    expect(attempt).toMatchObject({ status: "startup-error", startupFailure: true, startupReason: "setup", agentId: null });
    expect(adapter.requests).toEqual([]);
  });

  it("marks a treatment whose bridge never initialized as a startup failure", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const bridge = { command: "node", args: ["bridge.js"], env: { LEMMA_API_URL: "http://localhost:3000" } };
    const adapter = new FakeAdapter([finished("agent-2")]);
    const attempt = await runSlot({ taskId: "add-greeting", arm: "treatment", repetition: 1 }, 1, context(root, adapter, { bridge }));
    expect(attempt).toMatchObject({ startupFailure: true, startupReason: "bridge" });
    const server = adapter.requests[0]?.mcpServers["lemma"];
    expect(server?.env["LEMMA_BRIDGE_TRACE"]).toMatch(/bridge-trace\.jsonl$/);
    expect(server?.env["HOME"]).toBe(adapter.requests[0]?.home);
  });

  it("keeps a treatment that never called Lemma as a real result", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const bridge = { command: "node", args: ["bridge.js"], env: {} };
    const adapter = new FakeAdapter([
      finished("agent-3", (r) => writeFileSync(r.mcpServers["lemma"]?.env["LEMMA_BRIDGE_TRACE"] as string, '{"event":"initialize"}\n')),
    ]);
    const attempt = await runSlot({ taskId: "add-greeting", arm: "treatment", repetition: 1 }, 1, context(root, adapter, { bridge }));
    expect(attempt).toMatchObject({ startupFailure: false, lemmaCalls: 0, acceptance: { passed: false, exitCode: 1 } });
  });

  it("pre-applies a probe bundle before the agent starts", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const bundle: PatchBundle = { schemaVersion: "1", files: [{ path: "done.txt", op: "add", baseDigest: null, content: "applied\n" }], dependencies: {}, devDependencies: {} };
    const adapter = new FakeAdapter([finished("agent-4")]);
    const attempt = await runSlot({ taskId: "add-greeting", arm: "treatment", repetition: 1 }, 1, context(root, adapter, { preApply: bundle }));
    expect(attempt).toMatchObject({ startupFailure: false, acceptance: { passed: true }, filesChanged: 0 });
  });

  it("refuses a probe bundle that drifted against the fixture", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const bundle: PatchBundle = { schemaVersion: "1", files: [{ path: "README.md", op: "add", baseDigest: null, content: "x\n" }], dependencies: {}, devDependencies: {} };
    await expect(runSlot({ taskId: "add-greeting", arm: "treatment", repetition: 1 }, 1, context(root, new FakeAdapter([finished("a")]), { preApply: bundle }))).rejects.toThrow(/drifted/);
  });
});

describe("records and reconcile", () => {
  const at = (ms: number) => new Date(Date.parse("2026-10-01T00:05:00.000Z") + ms);

  it("records a cost only once billing has settled, and never for a startup failure", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const log = new RunLog(temp("lemma-log-"));
    const adapter = new FakeAdapter([finished("agent-5", (r) => writeFileSync(join(r.cwd, "done.txt"), "ok\n"))], new Map([["agent-5", null]]));
    const attempt = await runSlot({ taskId: "add-greeting", arm: "control", repetition: 1 }, 1, context(root, adapter));
    log.appendAttempt(attempt);
    log.appendAttempt(startupFailure());
    expect(await reconcile(log, adapter, () => at(COST_SETTLE_MS))).toEqual({ reconciled: 0, pending: 1, errors: [] });

    let cents = 10;
    const billing = { usage: async () => ({ usage, rawCostCents: cents }), run: async () => Promise.reject(new Error("unused")) };
    // Too early: the first read after the run is not trusted.
    expect(await reconcile(log, billing, () => at(60_000))).toEqual({ reconciled: 0, pending: 1, errors: [] });
    // Late enough, but a single read, then a changed one: still landing.
    expect(await reconcile(log, billing, () => at(COST_SETTLE_MS))).toMatchObject({ reconciled: 0 });
    cents = 25.5;
    expect(await reconcile(log, billing, () => at(COST_SETTLE_MS + COST_STABLE_GAP_MS))).toMatchObject({ reconciled: 0 });
    expect(await reconcile(log, billing, () => at(COST_SETTLE_MS + 2 * COST_STABLE_GAP_MS))).toEqual({ reconciled: 1, pending: 0, errors: [] });
    // Tokens come from billing, in the same scope as cost.
    expect(log.records()[0]).toMatchObject({ rawModelCostMicroUsd: "255000", tokens: { output: 200, reasoning: 100 } });
    expect(finalize(attempt, { usage, rawCostCents: null })).toBeNull();
    expect(log.pending()).toEqual([]);
  });

  it("waits while billed tokens fall short of what the run reported", () => {
    const attempt = attemptOf({ tokens: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
    const reads = [at(COST_SETTLE_MS), at(COST_SETTLE_MS + COST_STABLE_GAP_MS)].map((t) => observe(attempt.runId, { usage, rawCostCents: 9 }, t));
    expect(settledBilling(attempt, reads, at(COST_SETTLE_MS + COST_STABLE_GAP_MS))).toBeNull();
    expect(settledBilling({ ...attempt, tokens: null }, reads, at(COST_SETTLE_MS + COST_STABLE_GAP_MS))).toEqual({ usage: reads[0]?.usage, rawCostCents: 9 });
  });

  it("records an agent billed nothing at zero cost only after a long wait, and only if it did no work", () => {
    const attempt = attemptOf({ status: "error", toolCalls: 0 });
    const none = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, rawCostCents: null };
    const reads = [at(COST_SETTLE_MS), at(ZERO_COST_AFTER_MS)].map((t) => observe(attempt.runId, none, t));
    expect(settledBilling(attempt, reads.slice(0, 1), at(COST_SETTLE_MS + COST_STABLE_GAP_MS))).toBeNull();
    expect(settledBilling(attempt, reads, at(ZERO_COST_AFTER_MS))).toMatchObject({ rawCostCents: 0 });
    const billedTokens = [at(COST_SETTLE_MS), at(ZERO_COST_AFTER_MS)].map((t) => observe(attempt.runId, { usage, rawCostCents: null }, t));
    expect(settledBilling(attempt, billedTokens, at(ZERO_COST_AFTER_MS))).toBeNull();
    // A run that reported tokens or called tools did work: billing nothing means billing has not landed.
    const worked = attemptOf({ status: "finished", toolCalls: 12, tokens: { input: 50_000, output: 4_000, cacheRead: 200_000, cacheWrite: 0, reasoning: 0 } });
    const unbilled = [at(COST_SETTLE_MS), at(ZERO_COST_AFTER_MS)].map((t) => observe(worked.runId, none, t));
    expect(settledBilling(worked, unbilled, at(ZERO_COST_AFTER_MS))).toBeNull();
    expect(settledBilling({ ...attempt, toolCalls: 3 }, reads, at(ZERO_COST_AFTER_MS))).toBeNull();
  });

  it("keeps reading the other attempts when one usage lookup fails", async () => {
    const log = new RunLog(temp("lemma-log-"));
    const a = attemptOf({ agentId: "agent-a" });
    const b = attemptOf({ agentId: "agent-b" });
    log.appendAttempt(a);
    log.appendAttempt(b);
    const seen: string[] = [];
    const billing = {
      usage: async (id: string) => {
        seen.push(id);
        if (id === "agent-a") throw new Error("lookup failed");
        return { usage, rawCostCents: 10 };
      },
      run: async () => Promise.reject(new Error("unused")),
    };
    await reconcile(log, billing, () => at(COST_SETTLE_MS));
    const result = await reconcile(log, billing, () => at(COST_SETTLE_MS + COST_STABLE_GAP_MS));
    expect(seen).toContain("agent-b");
    expect(result).toEqual({ reconciled: 1, pending: 1, errors: [{ agentId: "agent-a", error: "lookup failed" }] });
    expect(log.records().map((r) => r.runId)).toEqual([b.runId]);
  });

  it("records a run it started but never finished recording, instead of running the slot again", async () => {
    const root = makeFixture(temp("lemma-fx-"));
    const log = new RunLog(temp("lemma-log-"));
    // The agent starts and is billed, then a post-run step throws: no attempt is appended.
    const adapter = new FakeAdapter([
      (r) => {
        r.onStarted?.("agent-started");
        return finished("agent-started")(r);
      },
    ]);
    const payments = { paymentFor: async () => Promise.reject(new Error("ledger unavailable")) };
    await expect(runSlot({ taskId: "add-greeting", arm: "treatment", repetition: 1 }, 1, context(root, adapter, { log, payments }))).rejects.toThrow(/ledger/);
    expect(log.attempts()).toEqual([]);
    expect(log.recoverInterrupted(at(0))).toBe(1);
    expect(log.recoverInterrupted(at(0))).toBe(0);
    const [recovered] = log.attempts();
    expect(recovered).toMatchObject({ agentId: "agent-started", status: "error", startupFailure: false, acceptance: { passed: false } });
    expect(nextAttempt(log.attempts(), { taskId: "add-greeting", arm: "treatment", repetition: 1 })).toBeNull();
    // It is billed, so reconcile reads it by its agent id.
    expect(log.pending().map((p) => p.agentId)).toEqual(["agent-started"]);

    // A run that never reported starting is a startup failure: the slot gets its retry.
    const log2 = new RunLog(temp("lemma-log-"));
    const never = new FakeAdapter([() => Promise.reject(new Error("killed")) as never]);
    await expect(runSlot({ taskId: "add-greeting", arm: "control", repetition: 1 }, 1, context(root, never, { log: log2 }))).rejects.toThrow();
    log2.recoverInterrupted(at(0));
    expect(log2.attempts()[0]).toMatchObject({ agentId: null, startupFailure: true });
    expect(nextAttempt(log2.attempts(), { taskId: "add-greeting", arm: "control", repetition: 1 })).toBe(2);
  });

  it("lets one command at a time use a version's logs, taking over a stale lock", () => {
    const log = new RunLog(temp("lemma-log-"));
    const release = log.lock();
    expect(() => log.lock()).toThrow(/another benchmark command/);
    release();
    writeFileSync(join(log.dir, "lock"), "999999999\n");
    const again = log.lock();
    expect(readFileSync(join(log.dir, "lock"), "utf8").trim()).toBe(String(process.pid));
    again();
    expect(existsSync(join(log.dir, "lock"))).toBe(false);
  });

  it("records one RunRecord per run, even when two reconciles overlap", async () => {
    const log = new RunLog(temp("lemma-log-"));
    log.appendAttempt(attemptOf({ agentId: "agent-c" }));
    const billing = { usage: async () => ({ usage, rawCostCents: 10 }), run: async () => Promise.reject(new Error("unused")) };
    await reconcile(log, billing, () => at(COST_SETTLE_MS));
    await Promise.all([reconcile(log, billing, () => at(COST_SETTLE_MS + COST_STABLE_GAP_MS)), reconcile(log, billing, () => at(COST_SETTLE_MS + COST_STABLE_GAP_MS))]);
    expect(log.records()).toHaveLength(1);
  });

  it("never records an interrupted run that had started at zero cost", () => {
    const intent = { type: "intent" as const, runId: hex("7a"), benchmarkVersion: "bench-1", taskId: "add-greeting", arm: "treatment" as const, repetition: 1, attempt: 1, fixtureProfileDigest: hex("13"), model: "example-model-1", startedAt: "2026-10-01T00:00:00.000Z" };
    const attempt = interruptedAttempt(intent, "agent-z", new Date("2026-10-01T00:05:00.000Z"));
    const none = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, rawCostCents: null };
    const reads = [at(COST_SETTLE_MS), at(ZERO_COST_AFTER_MS)].map((t) => observe(attempt.runId, none, t));
    expect(settledBilling(attempt, reads, at(ZERO_COST_AFTER_MS))).toBeNull();
  });

  it("counts a record once, when two reconciles overlap", async () => {
    const log = new RunLog(temp("lemma-log-"));
    log.appendAttempt(attemptOf({ agentId: "agent-d" }));
    const billing = { usage: async () => ({ usage, rawCostCents: 10 }), run: async () => Promise.reject(new Error("unused")) };
    await reconcile(log, billing, () => at(COST_SETTLE_MS));
    const results = await Promise.all([reconcile(log, billing, () => at(COST_SETTLE_MS + COST_STABLE_GAP_MS)), reconcile(log, billing, () => at(COST_SETTLE_MS + COST_STABLE_GAP_MS))]);
    expect(results.reduce((n, r) => n + r.reconciled, 0)).toBe(1);
  });

  it("treats a lock being written as held, and a version with only a lock as having no runs", () => {
    const log = new RunLog(temp("lemma-log-"));
    writeFileSync(join(log.dir, "lock"), "");
    expect(() => log.lock()).toThrow(/taking the lock/);
    rmSync(join(log.dir, "lock"));
    const release = log.lock();
    expect(log.hasRuns()).toBe(false);
    release();
  });

  it("binds a version to one setup, and refuses a different one", () => {
    const log = new RunLog(temp("lemma-log-"));
    log.bind("probe.json", { taskId: "t", fixturesDigest: hex("01") }, "probe setup");
    expect(() => log.bind("probe.json", { fixturesDigest: hex("01"), taskId: "t" }, "probe setup")).not.toThrow();
    expect(() => log.bind("probe.json", { taskId: "t", fixturesDigest: hex("02") }, "probe setup")).toThrow(/different probe setup/);
  });
});

function record(over: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: "1",
    runId: newRunId(),
    benchmarkVersion: "bench-1",
    taskId: "add-greeting",
    arm: "control",
    repetition: 1,
    fixtureProfileDigest: hex("13"),
    releaseDigest: null,
    model: "example-model-1",
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:05:00.000Z",
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    rawModelCostMicroUsd: "2500000",
    toolCalls: 10,
    retries: 0,
    filesChanged: 2,
    humanInterventions: 0,
    acceptance: { passed: true, exitCode: 0 },
    payment: null,
    ...over,
  };
}

describe("probe verdict", () => {
  const economics = { status: "measured" as "measured" | "placeholder", chainCostAtomic: 10_000n, priceFloorAtomic: 100_000n };
  const run = (arm: "control" | "treatment", i: number, cost: number, over: Partial<Attempt> = {}, recordOver: Partial<RunRecord> = {}) => {
    const a = attemptOf({ arm, repetition: i, startedAt: `2026-10-01T0${i}:00:00.000Z`, finishedAt: `2026-10-01T0${i}:05:00.000Z`, ...over });
    return { attempt: a, record: record({ runId: a.runId, arm, repetition: i, rawModelCostMicroUsd: String(cost), ...recordOver }) };
  };
  const controls = [2_400_000, 2_500_000, 2_600_000].map((cost, i) => run("control", i + 1, cost));
  const verdict = (runs: ReturnType<typeof run>[], e = economics) =>
    probeVerdict(
      runs.map((r) => r.record),
      runs.map((r) => r.attempt),
      "add-greeting",
      e,
    );

  it("goes on when some price clears the sale rule, the target after gas, and the floor", () => {
    // S = 1.00, C = 2.50: min(0.30, 1.00 - 0.01 - 0.625) = 0.30
    expect(verdict([...controls, run("treatment", 4, 1_500_000)])).toMatchObject({ controlMedianMicroUsd: 2_500_000n, savingMicroUsd: 1_000_000n, maxPriceAtomic: 300_000n, verdict: "go" });
  });

  it("marks a verdict on placeholder economics as provisional", () => {
    const v = verdict([...controls, run("treatment", 4, 1_500_000)], { ...economics, status: "placeholder" });
    expect(v).toMatchObject({ economicsStatus: "placeholder", chainCostAtomic: 10_000n });
    expect(v.notes).toContain(PLACEHOLDER_ECONOMICS_NOTE);
    expect(verdict([...controls, run("treatment", 4, 1_500_000)]).notes).not.toContain(PLACEHOLDER_ECONOMICS_NOTE);
  });

  it("kills a family whose saving cannot carry the target and the floor", () => {
    // S = 0.70: min(0.21, 0.70 - 0.01 - 0.625) = 0.065 < floor 0.10
    expect(verdict([...controls, run("treatment", 4, 1_800_000)])).toMatchObject({ maxPriceAtomic: 65_000n, verdict: "kill" });
  });

  it("kills when the pre-applied treatment does not reach green or did not finish, and needs the full run set", () => {
    expect(verdict([...controls, run("treatment", 4, 100_000, {}, { acceptance: { passed: false, exitCode: 1 } })], { status: "measured" as const, chainCostAtomic: 0n, priceFloorAtomic: 0n }).verdict).toBe("kill");
    expect(verdict([...controls, run("treatment", 4, 100_000, { status: "timeout" })], { status: "measured" as const, chainCostAtomic: 0n, priceFloorAtomic: 0n }).verdict).toBe("kill");
    expect(() => verdict(controls)).toThrow(/treatment/);
  });

  it("does not count an errored run: a treatment that failed at once would fake a saving", () => {
    const errored = run("treatment", 4, 10_000, { status: "error" });
    expect(() => verdict([...controls, errored])).toThrow(/no measured treatment/);
    const v = verdict([...controls, errored, run("treatment", 5, 1_500_000)]);
    expect(v).toMatchObject({ treatmentMicroUsd: 1_500_000n, verdict: "go" });
    expect(v.notes).toContain("1 attempts measured nothing (startup failure, agent error or cancel) and were replaced");
  });

  it("uses the earliest measured runs, so running again cannot pick a better result", () => {
    const v = verdict([...controls, run("treatment", 4, 1_500_000), run("treatment", 5, 100_000)]);
    expect(v.treatmentMicroUsd).toBe(1_500_000n);
    expect(v.notes).toContain("later runs beyond the first three controls and first treatment were ignored");
  });

  it("refuses to decide while a chosen run's cost has not settled", () => {
    const pending = run("treatment", 4, 1_500_000);
    expect(() => probeVerdict([...controls, pending].map((r) => r.record).slice(0, 3), [...controls, pending].map((r) => r.attempt), "add-greeting", economics)).toThrow(/no settled cost/);
  });

  it("plans only the runs still missing, and gives up rather than spend without end", () => {
    expect(nextProbeSlot([], "add-greeting")).toEqual({ taskId: "add-greeting", arm: "control", repetition: 1 });
    const three = controls.map((r) => r.attempt);
    expect(nextProbeSlot(three, "add-greeting")).toEqual({ taskId: "add-greeting", arm: "treatment", repetition: 1 });
    expect(nextProbeSlot([...three, attemptOf({ arm: "treatment" })], "add-greeting")).toBeNull();
    const failing = [1, 2, 3].map((i) => attemptOf({ arm: "treatment", repetition: i, status: "error" }));
    expect(nextProbeSlot([...three, ...failing.slice(0, 2)], "add-greeting")).toEqual({ taskId: "add-greeting", arm: "treatment", repetition: 3 });
    expect(() => nextProbeSlot([...three, ...failing], "add-greeting")).toThrow(/giving up/);
  });
});

describe("evidence rules", () => {
  const pairs = (version: string) =>
    [1, 2, 3].flatMap((rep) => [
      record({ benchmarkVersion: version, repetition: rep, rawModelCostMicroUsd: "2500000" }),
      record({ benchmarkVersion: version, repetition: rep, arm: "treatment", releaseDigest: hex("aa"), rawModelCostMicroUsd: "1500000" }),
    ]);

  it("never turns probe or provisional runs into evidence", () => {
    for (const version of ["probe-1", "provisional-1"]) {
      expect(() => deriveEvidence(pairs(version), { taskId: "add-greeting", staleAfterDays: 90 })).toThrow(/reserved/);
    }
    expect(deriveEvidence(pairs("bench-1"), { taskId: "add-greeting", staleAfterDays: 90 }).expectedRawSavingUsdc).toBe("1000000");
  });

  it("rounds a reduction down, so a small increase never reads as zero", () => {
    expect(reductionBps(10_001n, 10_002n)).toBe(-1n);
    expect(reductionBps(10_000n, 7_500n)).toBe(2500n);
  });

  const frozen = { benchmarkVersion: "bench-1", tasks: ["add-greeting"], repetitions: 3, noMatchTaskIds: [], staleAfterDays: 90 };
  /** The attempt behind each record, with the treatment's release base. */
  const attemptsFor = (records: readonly RunRecord[], base = hex("bb")) =>
    records.map((r) => attemptOf({ runId: r.runId, arm: r.arm, repetition: r.repetition, taskId: r.taskId, releaseDigest: r.releaseDigest, baseReleaseDigest: r.releaseDigest === null ? null : base }));

  it("reports evidence against the adopted release's base, and says why when it cannot", () => {
    const records = pairs("bench-1");
    const report = buildReport(records, attemptsFor(records), frozen);
    expect(report.evidence).toEqual([expect.objectContaining({ taskId: "add-greeting", adoptedReleaseDigest: hex("aa"), baseReleaseDigest: hex("bb") })]);
    expect(report.tasks[0]).toMatchObject({ allInReductionBps: "4000", pairs: 3 });
    // Every frozen slot has a result; only the measured token target decides this task.
    expect(report.tasks[0]?.failures).toEqual(["token reduction 0 bps is below 2500"]);
    expect(buildReport(records, [], frozen).evidenceErrors).toEqual([{ taskId: "add-greeting", error: "the treatment's release and its base are unknown" }]);
  });

  it("names the release the paired treatments adopted, not an unpaired one", () => {
    const four = [1, 2, 3, 4].flatMap((rep) => [
      record({ repetition: rep, rawModelCostMicroUsd: "2500000" }),
      record({ repetition: rep, arm: "treatment", releaseDigest: hex("aa"), rawModelCostMicroUsd: "1500000" }),
    ]);
    const records = four.filter((r) => !(r.arm === "control" && r.repetition === 1));
    const unpaired = records.find((r) => r.arm === "treatment" && r.repetition === 1) as RunRecord;
    const mixed = records.map((r) => (r === unpaired ? { ...r, releaseDigest: hex("cc") } : r));
    const attempts = attemptsFor(mixed).map((a) => (a.releaseDigest === hex("cc") ? { ...a, baseReleaseDigest: hex("dd") } : a));
    const report = buildReport(mixed, attempts, { ...frozen, repetitions: 4 });
    expect(report.evidenceErrors).toEqual([]);
    expect(report.evidence).toEqual([expect.objectContaining({ adoptedReleaseDigest: hex("aa"), baseReleaseDigest: hex("bb") })]);
  });

  it("fails a report with a frozen task or repetition missing", () => {
    const records = pairs("bench-1");
    const noRep3 = records.filter((r) => r.repetition !== 3);
    expect(buildReport(noRep3, attemptsFor(noRep3), frozen)).toMatchObject({ passes: false });
    expect(buildReport(noRep3, attemptsFor(noRep3), frozen).tasks[0]?.failures).toEqual(expect.arrayContaining(["control #3 has no result", "treatment #3 has no result"]));
    const missingTask = buildReport(records, attemptsFor(records), { ...frozen, tasks: ["add-greeting", "other-task"] });
    expect(missingTask.passes).toBe(false);
    expect(missingTask.tasks.find((t) => t.taskId === "other-task")?.failures).toContain("no runs");
    // A no-match task alone measures no saving.
    expect(buildReport([], [], { ...frozen, tasks: ["nm"], noMatchTaskIds: ["nm"] }).passes).toBe(false);
    // A slot closed by two startup failures is not missing.
    const closed = [1, 2].map((attempt) => startupFailure({ arm: "control", repetition: 3, attempt }));
    const treatment3 = [...noRep3, ...records.filter((r) => r.repetition === 3 && r.arm === "treatment")];
    expect(buildReport(treatment3, [...attemptsFor(treatment3), ...closed], frozen).tasks[0]?.failures).not.toContain("control #3 has no result");
  });
});

describe("workspaces and installs", () => {
  it("removes a run directory it cannot write to, and never throws", () => {
    const root = temp("lemma-rm-");
    mkdirSync(join(root, "cache", "mod"), { recursive: true });
    writeFileSync(join(root, "cache", "mod", "f"), "x");
    chmodSync(join(root, "cache", "mod"), 0o555);
    chmodSync(join(root, "cache"), 0o555);
    removeTree(root);
    expect(existsSync(root)).toBe(false);
    expect(() => removeTree(join(root, "gone"))).not.toThrow();
  });

  it("runs even the freeze smoke run outside the repository and below no ambient settings", () => {
    expect(() => prepareRunBase(join(REPO_ROOT, "tmp-bench", "deeper"), REPO_ROOT)).toThrow(WorkspaceError);
    // Refused before anything was created in the checkout.
    expect(existsSync(join(REPO_ROOT, "tmp-bench"))).toBe(false);
    const outside = temp("lemma-base-");
    writeFileSync(join(outside, "CLAUDE.md"), "x");
    expect(() => prepareRunBase(join(outside, "runs"), REPO_ROOT)).toThrow(WorkspaceError);
    const clean = temp("lemma-base-");
    expect(prepareRunBase(join(clean, "runs"), REPO_ROOT)).toBe(join(realpathSync(clean), "runs"));
  });

  it("installs without lifecycle scripts on every package manager, yarn classic and berry alike", () => {
    expect(installArgv("yarn", ["a@1"], false, "classic")).toEqual(["yarn", "add", "--ignore-scripts", "a@1"]);
    expect(installArgv("yarn", ["a@1"], true, "berry")).toEqual(["yarn", "add", "--mode=skip-build", "-D", "a@1"]);
    expect(installArgv("npm", ["a@1"], false)).toContain("--ignore-scripts");
    expect(installArgv("pnpm", ["a@1"], false)).toContain("--ignore-scripts");
    const env = { PATH: "/nonexistent" };
    const berry = temp("lemma-yarn-");
    writeFileSync(join(berry, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    expect(yarnFlavor(berry, env)).toBe("berry");
    const pinned = (manager: string) => {
      const dir = temp("lemma-yarn-");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: manager }));
      return yarnFlavor(dir, env);
    };
    expect(pinned("yarn@1.22.22")).toBe("classic");
    expect(pinned("yarn@4.5.0")).toBe("berry");
    // No yarn to ask: classic, whose flag a berry yarn would refuse rather than run scripts.
    expect(yarnFlavor(temp("lemma-yarn-"), env)).toBe("classic");
  });
});

describe("fixtures and models", () => {
  it("requires match tasks to name their catalog case", () => {
    const root = makeFixture(temp("lemma-fx-"));
    const fixture = loadBenchmarkFixtures(root)[0]?.fixture;
    expect(BenchmarkFixture.safeParse({ ...fixture, catalogCase: null }).success).toBe(false);
    expect(BenchmarkFixture.safeParse({ ...fixture, kind: "no-match" }).success).toBe(false);
  });

  it("labels a model with its parameters in RunRecord form", () => {
    expect(modelLabel({ id: "m-1", params: [{ id: "thinking", value: "high" }] })).toBe("m-1/thinking:high");
  });
});

describe("process environment", () => {
  it("drops package-local tool directories and the repository from PATH", () => {
    const host = ["/repo/packages/benchmark/node_modules/.bin", "/repo/node_modules/.bin", "/node_modules/.bin", "relative/bin", "", "/usr/local/bin", "/usr/bin", "/usr/bin", `${REPO_ROOT}/scripts`].join(":");
    expect(agentPath(host, REPO_ROOT, "/opt/node/bin")).toBe("/usr/local/bin:/usr/bin:/opt/node/bin");
  });

  it("names variables that look like credentials", () => {
    expect(
      secretVariables({
        CURSOR_API_KEY: "k",
        BUYER_PRIVATE_KEY: "0x1",
        GITHUB_TOKEN: "t",
        DATABASE_URL: "postgres://lemma:lemma_local_only@db/x",
        LEMMA_TEST_DATABASE_URL: "postgres://lemma@127.0.0.1/x",
        SSH_AUTH_SOCK: "/tmp/ssh/agent",
        MONKEYS: "1",
        EMPTY_SECRET: "",
        PATH: "/usr/bin",
      }),
    ).toEqual(["BUYER_PRIVATE_KEY", "CURSOR_API_KEY", "DATABASE_URL", "GITHUB_TOKEN"]);
  });

  it("names credentials that hide behind other names, and leaves harmless names alone", () => {
    // Values built from pieces, so secret scanners do not flag the test.
    const token = ["ghp", "Example0123456789"].join("_");
    const secrets = {
      PGPASSWORD: "p",
      MYSQL_PWD: "p",
      OPENAI_APIKEY: "k",
      OP_SESSION_team: "s",
      BW_SESSION: "s",
      VAULT_TOKEN: "t",
      BUYER_MNEMONIC: "words",
      WALLET_SEED: "s",
      GH_PAT: "p",
      ARBITRUM_SEPOLIA_RPC_URL: "https://arb.example/v2/abc",
      CLONE_URL: `https://${token}@github.com/o/r.git`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
      GIT_CONFIG_PARAMETERS: `'http.extraheader'='AUTHORIZATION: basic ${token}'`,
      REDIS_URL: `redis://:${token}@cache:6379`,
      npm_config__auth: "dXNlcjpwYXNz",
      "npm_config_//registry.npmjs.org/:_authToken": token,
      SLACK_WEBHOOK_URL: "https://hooks.example/services/T/B/x",
      BASIC_AUTH: "u:p",
      BUYER_PRIVKEY: "0x1",
      ETH_PK: "0x1",
      CI_JOB_JWT: "j",
      SESSION_COOKIE: "c",
      WALLET_SEED_PHRASE: "words",
    };
    const harmless = {
      PWD: "/home/u",
      OLDPWD: "/home",
      XDG_SESSION_ID: "3",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DESKTOP_SESSION: "gnome",
      GIT_CONFIG_KEY_0: "http.extraheader",
      SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
      GPG_KEY: "ABCDEF",
      NODE_EXTRA_CA_CERTS_FILE: "/etc/ssl/ca.pem",
      KUBE_TOKEN_PATH: "/var/run/token",
      SEEDING: "1",
      RANDOM_SEED: "42",
      WT_SESSION: "0b1f7d3c-0000-4000-8000-000000000000",
      KONSOLE_DBUS_SESSION: "/Sessions/1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      STARSHIP_SESSION_KEY: "123",
      SSH_AUTH_SOCK: "/tmp/ssh/agent",
      PATH: "/usr/bin",
    };
    expect(secretVariables({ ...secrets, ...harmless })).toEqual(Object.keys(secrets).sort());
  });

  it("finds credentials in the environment an ancestor started with, which env -u leaves behind", async () => {
    const { spawn } = await import("node:child_process");
    const sh = spawn("sh", ["-c", "env -u DEMO_TOKEN sleep 5; true"], { env: { ...process.env, DEMO_TOKEN: "x" }, stdio: "ignore" });
    try {
      let sleeper: number | undefined;
      for (let i = 0; i < 50 && sleeper === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const children = readFileSync(`/proc/${sh.pid}/task/${sh.pid}/children`, "utf8").trim();
        if (children !== "") sleeper = Number(children.split(" ")[0]);
      }
      expect(sleeper).toBeDefined();
      const found = ancestorSecretVariables(sleeper as number);
      expect(found.find((f) => f.pid === sleeper)?.names ?? []).not.toContain("DEMO_TOKEN");
      expect(found.find((f) => f.pid === sh.pid)?.names).toContain("DEMO_TOKEN");
    } finally {
      sh.kill("SIGKILL");
    }
  });
});

/** Whether a process is still running; a zombie (killed, not yet reaped by its new parent) is not. */
function running(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

describe("CursorAdapter process boundary", () => {
  const child = (body: string) => {
    const dir = temp("lemma-child-");
    const script = join(dir, "child.mjs");
    writeFileSync(script, `import { writeSync } from "node:fs";\nconst emit = (e) => writeSync(3, JSON.stringify(e) + "\\n");\nlet input = "";\nfor await (const c of process.stdin) input += c;\nconst { apiKey, request } = JSON.parse(input);\n${body}\n`);
    mkdirSync(join(dir, "home", "tmp"), { recursive: true });
    return { dir, script, request: { cwd: dir, home: join(dir, "home"), prompt: "p", model: { id: "m" }, mcpServers: {}, timeoutMs: 1000 } };
  };
  const quick = { child: 1000, dispose: 500 };
  const outcomeLine = (fields: string) => `emit({ type: "outcome", outcome: { agentId: "child", status: "finished", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:01.000Z", toolCalls: [], usage: null, error: ${fields} } });`;

  it("passes the API key through stdin, never the environment, and reads the result from fd 3", async () => {
    const { script, request, dir } = child(outcomeLine(`JSON.stringify({ keyInEnv: Object.values(process.env).includes(apiKey), keyReceived: apiKey === "secret-key", envKeys: Object.keys(process.env).sort(), cwdOk: process.cwd() === request.cwd })`));
    const outcome = await new CursorAdapter("secret-key", script, quick).run(request);
    expect(JSON.parse(outcome.error as string)).toEqual({ keyInEnv: false, keyReceived: true, envKeys: ["CI", "HOME", "LANG", "PATH", "TMPDIR", "TZ"], cwdOk: true });
    expect(existsSync(join(dir, "home"))).toBe(true);
  });

  it("reports a child that dies before the run started as a startup error", async () => {
    const { script, request } = child("process.exit(3);");
    expect(await new CursorAdapter("k", script, quick).run(request)).toMatchObject({ status: "startup-error", agentId: null });
  });

  it("keeps a run that died after it started as a billed failure, with the tool calls it made", async () => {
    const { script, request } = child(`emit({ type: "started", agentId: "agent-9" });\nemit({ type: "tool", callId: "c1", name: "shell", status: "running" });\nemit({ type: "tool", callId: "c1", name: "shell", status: "error" });\nprocess.kill(process.pid, "SIGKILL");`);
    const outcome = await new CursorAdapter("k", script, quick).run(request);
    expect(outcome).toMatchObject({ status: "error", agentId: "agent-9", toolCalls: [{ callId: "c1", name: "shell", status: "error" }] });
  });

  it("kills a child that outlives its deadline, with everything it started", async () => {
    const { script, request, dir } = child(`import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });\nwriteFileSync("grandchild.pid", String(grandchild.pid));\nemit({ type: "started", agentId: "agent-10" });\nsetInterval(() => {}, 1000);`);
    const started = Date.now();
    const outcome = await new CursorAdapter("k", script, { child: 300, dispose: 300 }).run({ ...request, timeoutMs: 200 });
    expect(outcome).toMatchObject({ status: "timeout", agentId: "agent-10" });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
    expect(running(pid)).toBe(false);
  });

  it("kills what the agent detached, even after the child that started it exited", async () => {
    const { script, request, dir } = child(`import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });\norphan.unref();\nwriteFileSync("orphan.pid", String(orphan.pid));\nemit({ type: "started", agentId: "agent-11" });\nprocess.exit(1);`);
    const outcome = await new CursorAdapter("k", script, quick).run(request);
    expect(outcome).toMatchObject({ agentId: "agent-11" });
    const pid = Number(readFileSync(join(dir, "orphan.pid"), "utf8"));
    for (let i = 0; i < 20 && running(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(running(pid)).toBe(false);
  });

  it("reports the SDK child's own fatal error without the key", async () => {
    const { spawnSync } = await import("node:child_process");
    const key = ["crsr", "Example", "0123456789"].join("_");
    // Loaded in this node process (not through the tsx CLI, which does not pass fd 3 on).
    const result = spawnSync(process.execPath, ["--import", "tsx", join(BENCHMARK_ROOT, "src", "cursor-child.ts")], { input: `{"apiKey":"${key}", broken`, stdio: ["pipe", "pipe", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("malformed request");
    expect(result.stderr).not.toContain(key);
    expect(String(result.output[3] ?? "")).toContain("startup-error");
  });

  it("kills every process carrying a run's home", async () => {
    const { spawn } = await import("node:child_process");
    const home = temp("lemma-home-");
    const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, HOME: home }, detached: true, stdio: "ignore" });
    p.unref();
    killByHome(home);
    for (let i = 0; i < 20 && running(p.pid as number); i++) await new Promise((r) => setTimeout(r, 50));
    expect(running(p.pid as number)).toBe(false);
  });

  it("reaps what a finished child leaves running and does not wait for it", async () => {
    const { script, request, dir } = child(`import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", 3] });\nwriteFileSync("server.pid", String(server.pid));\n${outcomeLine("null")}\nsetInterval(() => {}, 1000);`);
    const started = Date.now();
    const outcome = await new CursorAdapter("k", script, { child: 10_000, dispose: 300 }).run({ ...request, timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ status: "finished", agentId: "child" });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(join(dir, "server.pid"), "utf8"));
    expect(running(pid)).toBe(false);
  });
});
