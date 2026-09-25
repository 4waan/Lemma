import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DIRECTORY, type Hex32, type PatchBundle, fileDigest, planApply, profileDigest } from "@lemma/core";

import type { AgentAdapter, McpStdioServer, ModelSelection } from "./adapter.js";
import type { LoadedBenchmarkFixture } from "./fixture.js";
import type { Slot } from "./matrix.js";
import { childEnv, killByHome, runCommand, trackHome } from "./process.js";
import { Attempt, type RunLog } from "./records.js";
import { type ReportedUsage, UsageError, toRunTokens } from "./tokens.js";
import { type RunWorkspace, filesChanged, prepareWorkspace, readTrace, snapshot } from "./workspace.js";

/** What the treatment paid, read from the payment work's local spend ledger after a run. */
export interface PaymentSource {
  paymentFor(workspace: RunWorkspace): Promise<Attempt["payment"]>;
}

/** Which release the treatment adopted, read from the bridge's resolution inbox after a run. */
export interface AdoptionSource {
  adoptedRelease(workspace: RunWorkspace): Promise<{ releaseDigest: Hex32; baseReleaseDigest: Hex32 } | null>;
}

/** Until the payment work exports its ledger, runs record no payment. */
export const noPayments: PaymentSource = { paymentFor: async () => null };

/** Until the bridge keeps an inbox, runs record no adopted release. */
export const noAdoptions: AdoptionSource = { adoptedRelease: async () => null };

export interface SlotContext {
  readonly adapter: AgentAdapter;
  readonly fixture: LoadedBenchmarkFixture;
  readonly benchmarkVersion: string;
  readonly model: ModelSelection;
  /** Where run directories are created; must be outside the repository. */
  readonly runBase: string;
  readonly repositoryRoot: string;
  /** The Lemma rule the treatment copy receives. */
  readonly rulePath: string | null;
  /** How to start the Lemma bridge for the treatment; null for a pre-applied probe treatment. */
  readonly bridge: McpStdioServer | null;
  /** A bundle applied to the treatment copy before the agent starts (stage-4 probe). */
  readonly preApply: PatchBundle | null;
  readonly payments: PaymentSource;
  readonly adoptions: AdoptionSource;
  readonly newRunId: () => Hex32;
  readonly keepWorkspace?: boolean;
  /** Where the run's intent and agent id are logged before it ends, so an interrupted run is still recorded. */
  readonly log?: RunLog;
}

/** `id` plus `param:value` pairs, the form RunRecord.model accepts. */
export function modelLabel(model: ModelSelection): string {
  return [model.id, ...(model.params ?? []).map((p) => `${p.id}:${p.value}`)].join("/");
}

/**
 * Runs one attempt of one slot: a fresh fixture copy, identical setup for both
 * arms, the agent, then the fixture's acceptance command. The treatment gets
 * the Lemma rule and the bridge. A pre-applied probe treatment gets the bundle
 * instead. Nothing from the run's output is kept except counts, digests and the
 * acceptance exit code. The run is logged as started before the agent starts
 * (`ctx.log`), so if the harness is interrupted or a later step throws, the next
 * invocation records it instead of running the slot again. When the attempt
 * ends, every process still carrying the run's home is killed.
 */
export async function runSlot(slot: Slot, attempt: 1 | 2, ctx: SlotContext): Promise<Attempt> {
  const { fixture, dir } = ctx.fixture;
  const treatment = slot.arm === "treatment";
  const runId = ctx.newRunId();
  const workspace = prepareWorkspace({
    base: ctx.runBase,
    runId,
    fixtureDir: dir,
    repositoryRoot: ctx.repositoryRoot,
    rulePath: treatment && ctx.bridge !== null ? ctx.rulePath : null,
  });
  const untrackHome = trackHome(workspace.home);
  const base = {
    schemaVersion: "1",
    runId,
    benchmarkVersion: ctx.benchmarkVersion,
    taskId: slot.taskId,
    arm: slot.arm,
    repetition: slot.repetition,
    attempt,
    fixtureProfileDigest: profileDigest(fixture.profile),
    model: modelLabel(ctx.model),
    humanInterventions: 0,
  } as const;
  try {
    const env = childEnv(workspace.home);
    if (fixture.setup !== null) {
      const startedAt = new Date().toISOString();
      const setup = await runCommand(fixture.setup.argv, { cwd: workspace.cwd, env, timeoutSec: fixture.setup.timeoutSec });
      if (setup.exitCode !== 0) {
        // The agent never started: a startup failure, kept on record and re-run, not a result.
        return Attempt.parse({
          ...base,
          releaseDigest: null,
          baseReleaseDigest: null,
          agentId: null,
          status: "startup-error",
          startupFailure: true,
          startupReason: "setup",
          lemmaCalls: 0,
          startedAt,
          finishedAt: new Date().toISOString(),
          tokens: null,
          toolCalls: 0,
          retries: 0,
          filesChanged: 0,
          acceptance: { passed: false, exitCode: null },
          payment: null,
        });
      }
    }
    if (treatment && ctx.preApply !== null) await preApply(ctx.preApply, workspace.cwd, env, fixture.profile.packageManager.name);

    const before = snapshot(workspace.cwd);
    const mcpServers: Record<string, McpStdioServer> =
      treatment && ctx.bridge !== null
        ? { lemma: { ...ctx.bridge, env: { ...ctx.bridge.env, HOME: workspace.home, LEMMA_BRIDGE_TRACE: workspace.trace } } }
        : {};
    const { schemaVersion: _, humanInterventions: __, ...intent } = base;
    ctx.log?.appendIntent({ type: "intent", ...intent, startedAt: new Date().toISOString() });
    let agentLogged = false;
    const logAgent = (agentId: string) => {
      if (agentLogged) return;
      agentLogged = true;
      ctx.log?.appendIntent({ type: "agent", runId, agentId });
    };
    const outcome = await ctx.adapter.run({
      cwd: workspace.cwd,
      home: workspace.home,
      prompt: fixture.prompt,
      model: ctx.model,
      mcpServers,
      timeoutMs: fixture.maxDurationSec * 1000,
      onStarted: logAgent,
    });
    // An adapter that reported no start (or lost the line) still has its agent id logged before the post-run steps.
    if (outcome.agentId !== null) logAgent(outcome.agentId);
    // Measured before acceptance, whose own output (builds, coverage) is not the agent's work.
    const changed = filesChanged(before, snapshot(workspace.cwd));
    const trace = readTrace(workspace.trace);
    const acceptance = await runCommand(fixture.acceptance.argv, { cwd: workspace.cwd, env, timeoutSec: fixture.acceptance.timeoutSec });
    const adopted = treatment ? await ctx.adoptions.adoptedRelease(workspace) : null;
    const payment = treatment ? await ctx.payments.paymentFor(workspace) : null;

    const startupReason = outcome.status === "startup-error" ? "agent" : treatment && ctx.bridge !== null && !trace.initialized ? "bridge" : null;
    const exitCode = acceptance.exitCode === null ? null : Math.min(255, Math.max(0, acceptance.exitCode));
    return Attempt.parse({
      ...base,
      releaseDigest: adopted?.releaseDigest ?? null,
      baseReleaseDigest: adopted?.baseReleaseDigest ?? null,
      agentId: outcome.agentId,
      status: outcome.status,
      startupFailure: startupReason !== null,
      startupReason,
      lemmaCalls: trace.toolCalls,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      tokens: reportedTokens(outcome.usage),
      toolCalls: outcome.toolCalls.length,
      retries: outcome.toolCalls.filter((c) => c.status === "error").length,
      filesChanged: changed,
      acceptance: { passed: exitCode === 0, exitCode },
      payment,
    });
  } finally {
    // Nothing the run started (setup, agent or acceptance) outlives it.
    killByHome(workspace.home);
    untrackHome();
    // Cleanup never replaces the result: dispose warns instead of throwing.
    if (ctx.keepWorkspace !== true) workspace.dispose();
  }
}

/** The run's own token report, or null when it gave none or one that does not map (billing is authoritative). */
function reportedTokens(usage: ReportedUsage | null): Attempt["tokens"] {
  if (usage === null) return null;
  try {
    return toRunTokens(usage);
  } catch (error) {
    if (error instanceof UsageError) return null;
    throw error;
  }
}

/**
 * Applies a bundle the way the bridge will: `planApply` first (drift is an
 * error here, because the probe's fixture is the base the bundle was built
 * against), then the declared dependency changes through the fixture's package
 * manager with install scripts disabled.
 */
export async function preApply(bundle: PatchBundle, cwd: string, env: Record<string, string>, packageManager: "npm" | "pnpm" | "yarn"): Promise<void> {
  const plan = planApply(bundle, (path) => {
    const full = join(cwd, path);
    if (!existsSync(full)) return null;
    return statSync(full).isDirectory() ? DIRECTORY : fileDigest(readFileSync(full));
  });
  if (!plan.ok) throw new Error(`bundle drifted against the fixture: ${plan.drift.map((d) => d.path).join(", ")}`);
  for (const w of plan.writes) {
    mkdirSync(dirname(join(cwd, w.path)), { recursive: true });
    writeFileSync(join(cwd, w.path), w.content);
  }
  for (const path of plan.deletes) rmSync(join(cwd, path));
  const yarn = packageManager === "yarn" ? yarnFlavor(cwd, env) : "classic";
  for (const [deps, dev] of [[plan.dependencies, false], [plan.devDependencies, true]] as const) {
    const specs = Object.entries(deps).map(([name, range]) => `${name}@${range}`);
    if (specs.length === 0) continue;
    const argv = installArgv(packageManager, specs, dev, yarn);
    const result = await runCommand(argv, { cwd, env: { ...env, YARN_ENABLE_SCRIPTS: "false" }, timeoutSec: 600 });
    if (result.exitCode !== 0) throw new Error(`installing ${specs.join(" ")} failed (exit ${result.exitCode ?? "killed"})`);
  }
}

/**
 * Which yarn a project uses. Yarn 2+ ("berry") is set up by `.yarnrc.yml` or
 * a `packageManager` of `yarn@2` or later; `yarn@1` is classic. Otherwise the
 * `yarn` on the run's PATH is asked for its version. When that fails too, the
 * answer is classic: a berry yarn then rejects classic's `--ignore-scripts`
 * and the install fails loudly instead of running scripts.
 */
export function yarnFlavor(cwd: string, env: Record<string, string>): "classic" | "berry" {
  if (existsSync(join(cwd, ".yarnrc.yml"))) return "berry";
  try {
    const manager = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager;
    const major = typeof manager === "string" ? /^yarn@(\d+)\./.exec(manager)?.[1] : undefined;
    if (major !== undefined) return Number(major) >= 2 ? "berry" : "classic";
  } catch {
    // No readable package.json: ask yarn itself.
  }
  const version = spawnSync("yarn", ["--version"], { cwd, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  const major = /^(\d+)\./.exec((version.stdout ?? "").trim())?.[1];
  return major !== undefined && Number(major) >= 2 ? "berry" : "classic";
}

/**
 * Install argv with lifecycle scripts disabled, per package manager. Yarn
 * classic needs `--ignore-scripts` (it does not read `YARN_ENABLE_SCRIPTS`);
 * berry rejects that flag and takes `--mode=skip-build`, next to the
 * `YARN_ENABLE_SCRIPTS=false` that preApply sets.
 */
export function installArgv(packageManager: "npm" | "pnpm" | "yarn", specs: readonly string[], dev: boolean, yarn: "classic" | "berry" = "classic"): string[] {
  if (packageManager === "npm") return ["npm", "install", "--ignore-scripts", ...(dev ? ["--save-dev"] : ["--save"]), ...specs];
  if (packageManager === "pnpm") return ["pnpm", "add", "--ignore-scripts", ...(dev ? ["-D"] : []), ...specs];
  return ["yarn", "add", yarn === "berry" ? "--mode=skip-build" : "--ignore-scripts", ...(dev ? ["-D"] : []), ...specs];
}
