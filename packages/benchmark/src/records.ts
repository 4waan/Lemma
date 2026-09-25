import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Hex32, IsoTimestamp, RunArm, RunRecord, canonicalize } from "@lemma/core";
import { z } from "zod";

import type { UsageReport } from "./adapter.js";
import { centsToMicroUsd, toRunTokens } from "./tokens.js";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const Count = z.int().min(0).max(1_000_000_000);

/**
 * One attempt of one slot, as the harness saw it. It becomes a core RunRecord
 * only after `reconcile` has the billed cost, because provider cost is
 * eventually consistent. A startup failure (fixture setup failed, the agent's
 * run never began, or the treatment's bridge never initialized) is kept here on
 * record, but it never becomes a RunRecord: the slot is re-run once instead. A
 * run that began and then failed is not a startup failure; it is billed and
 * counts. `tokens` is the run's own report, kept as a cross-check on billing.
 */
export const Attempt = z.strictObject({
  schemaVersion: z.literal("1"),
  runId: Hex32,
  benchmarkVersion: Slug,
  taskId: Slug,
  arm: RunArm,
  repetition: z.int().min(1).max(100),
  attempt: z.int().min(1).max(2),
  fixtureProfileDigest: Hex32,
  releaseDigest: Hex32.nullable(),
  baseReleaseDigest: Hex32.nullable(),
  model: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:/-]+$/),
  agentId: z.string().min(1).max(200).nullable(),
  status: z.enum(["finished", "error", "cancelled", "timeout", "startup-error"]),
  startupFailure: z.boolean(),
  /** Why the attempt is a startup failure; null when it is not one. */
  startupReason: z.enum(["setup", "agent", "bridge"]).nullable(),
  /** Tool calls the Lemma bridge served, from its trace. */
  lemmaCalls: Count,
  startedAt: IsoTimestamp,
  finishedAt: IsoTimestamp,
  tokens: z.strictObject({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, reasoning: Count }).nullable(),
  toolCalls: Count,
  retries: Count,
  filesChanged: Count,
  humanInterventions: Count,
  acceptance: z.strictObject({ passed: z.boolean(), exitCode: z.int().min(0).max(255).nullable() }),
  payment: z.strictObject({ amountUsdc: z.string(), gasCostMicroUsd: z.string(), transaction: Hex32.nullable() }).nullable(),
  /** Recorded from a run the harness never finished recording: what it did is unknown, so it is never assumed to have cost nothing. */
  interrupted: z.literal(true).optional(),
});

export type Attempt = z.infer<typeof Attempt>;

/** How long after a run ends its billed cost is first trusted. */
export const COST_SETTLE_MS = 5 * 60_000;
/** How far apart two identical billing reads must be before the cost counts as final. */
export const COST_STABLE_GAP_MS = 60_000;
/** After this long, an agent billed no tokens and still showing no cost is recorded at zero cost, if its run showed no sign of work. */
export const ZERO_COST_AFTER_MS = 60 * 60_000;

/** One read of an agent's billed usage, kept so `reconcile` can tell a settled cost from one still landing. */
export const CostObservation = z.strictObject({
  runId: Hex32,
  observedAt: IsoTimestamp,
  rawCostCents: z.number().min(0).nullable(),
  usage: z.strictObject({
    inputTokens: Count,
    outputTokens: Count,
    cacheReadTokens: Count,
    cacheWriteTokens: Count,
    totalTokens: Count,
    reasoningTokens: Count.optional(),
  }),
});

export type CostObservation = z.infer<typeof CostObservation>;

export function observe(runId: Attempt["runId"], billed: UsageReport, at: Date): CostObservation {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens } = billed.usage;
  return CostObservation.parse({
    runId,
    observedAt: at.toISOString(),
    rawCostCents: billed.rawCostCents,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, ...(reasoningTokens === undefined ? {} : { reasoningTokens }) },
  });
}

const sameBilling = (a: CostObservation, b: CostObservation) => a.rawCostCents === b.rawCostCents && JSON.stringify(a.usage) === JSON.stringify(b.usage);

/**
 * The billed usage to record for an attempt, or null while it may still be
 * landing. Provider cost is eventually consistent, so the first number
 * reported can be partial. A cost counts as settled once reads taken at least
 * COST_SETTLE_MS after the run ended have agreed for at least
 * COST_STABLE_GAP_MS, and the billed tokens are no fewer than the run itself
 * reported. An agent that was billed no tokens and still has no cost after
 * ZERO_COST_AFTER_MS cost nothing, but only when the run itself reported no
 * tokens and made no tool calls: a run that did work and bills nothing is
 * billing that has not landed, and stays pending.
 */
export function settledBilling(attempt: Attempt, observations: readonly CostObservation[], now: Date): UsageReport | null {
  const settleFrom = Date.parse(attempt.finishedAt) + COST_SETTLE_MS;
  const late = observations.filter((o) => o.runId === attempt.runId && Date.parse(o.observedAt) >= settleFrom).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const last = late.at(-1);
  if (last === undefined) return null;
  let first = late.length - 1;
  while (first > 0 && sameBilling(late[first - 1] as CostObservation, last)) first--;
  const stableFor = Date.parse(last.observedAt) - Date.parse((late[first] as CostObservation).observedAt);
  if (stableFor < COST_STABLE_GAP_MS) return null;
  const reported = attempt.tokens === null ? 0 : attempt.tokens.input + attempt.tokens.output + attempt.tokens.cacheRead + attempt.tokens.cacheWrite + attempt.tokens.reasoning;
  if (last.usage.totalTokens < reported) return null;
  if (last.rawCostCents === null) {
    const unbilled = attempt.interrupted !== true && last.usage.totalTokens === 0 && reported === 0 && attempt.toolCalls === 0 && now.getTime() - Date.parse(attempt.finishedAt) >= ZERO_COST_AFTER_MS;
    return unbilled ? { usage: last.usage, rawCostCents: 0 } : null;
  }
  return { usage: last.usage, rawCostCents: last.rawCostCents };
}

/**
 * The RunRecord for a completed attempt, once billed usage has settled. Tokens
 * and cost both come from the agent's billed usage, so every record measures
 * the same scope whether the run finished, failed or timed out. Billed usage
 * does not split out reasoning, so reasoning stays inside output there.
 */
export function finalize(attempt: Attempt, billed: UsageReport): RunRecord | null {
  if (attempt.startupFailure || billed.rawCostCents === null) return null;
  return RunRecord.parse({
    schemaVersion: "1",
    runId: attempt.runId,
    benchmarkVersion: attempt.benchmarkVersion,
    taskId: attempt.taskId,
    arm: attempt.arm,
    repetition: attempt.repetition,
    fixtureProfileDigest: attempt.fixtureProfileDigest,
    releaseDigest: attempt.releaseDigest,
    model: attempt.model,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    tokens: toRunTokens(billed.usage),
    rawModelCostMicroUsd: centsToMicroUsd(billed.rawCostCents).toString(),
    toolCalls: attempt.toolCalls,
    retries: attempt.retries,
    filesChanged: attempt.filesChanged,
    humanInterventions: attempt.humanInterventions,
    acceptance: attempt.acceptance,
    payment: attempt.payment,
  });
}

/**
 * Written before an agent starts, and again with its agent id once its run has
 * begun. An intent with no attempt is a run the harness did not finish
 * recording (interrupted, crashed, or a post-run step threw); `recoverInterrupted`
 * turns it into an attempt, so the slot is not run again.
 */
export const RunIntent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("intent"),
    runId: Hex32,
    benchmarkVersion: Slug,
    taskId: Slug,
    arm: RunArm,
    repetition: z.int().min(1).max(100),
    attempt: z.int().min(1).max(2),
    fixtureProfileDigest: Hex32,
    model: Attempt.shape.model,
    startedAt: IsoTimestamp,
  }),
  z.strictObject({ type: z.literal("agent"), runId: Hex32, agentId: z.string().min(1).max(200) }),
]);

export type RunIntent = z.infer<typeof RunIntent>;

/**
 * The attempt for a run that started but was never recorded. With an agent id
 * the run began and was billed: it is a failed result (reconciled through that
 * id), not a free retry. Without one the agent never reported starting, so it
 * is a startup failure, which still counts toward the slot's retries.
 */
export function interruptedAttempt(intent: Extract<RunIntent, { type: "intent" }>, agentId: string | null, now: Date): Attempt {
  const { type: _, ...base } = intent;
  return Attempt.parse({
    schemaVersion: "1",
    ...base,
    releaseDigest: null,
    baseReleaseDigest: null,
    agentId,
    status: agentId === null ? "startup-error" : "error",
    startupFailure: agentId === null,
    startupReason: agentId === null ? "agent" : null,
    lemmaCalls: 0,
    finishedAt: now.toISOString(),
    tokens: null,
    toolCalls: 0,
    retries: 0,
    filesChanged: 0,
    humanInterventions: 0,
    acceptance: { passed: false, exitCode: null },
    payment: null,
    ...(agentId === null ? {} : { interrupted: true }),
  });
}

/** Whether a process exists (one owned by another user counts). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Append-only logs for one benchmark version under `runs/<version>/`, which is
 * git-ignored (benchmark-protocol.md "Output"): every run started, every
 * attempt, every billing read, and the RunRecords reconciled from them, plus
 * the setup the version is bound to and a lock held by the command using it.
 */
export class RunLog {
  constructor(readonly dir: string) {}

  static forVersion(runsDir: string, benchmarkVersion: string): RunLog {
    return new RunLog(join(runsDir, benchmarkVersion));
  }

  appendAttempt(attempt: Attempt): void {
    this.append("attempts.jsonl", Attempt.parse(attempt));
  }

  /** Appends a record, skipping a run that already has one (two reconciles that overlapped); true when it appended. */
  appendRecord(record: RunRecord): boolean {
    const parsed = RunRecord.parse(record);
    if (this.records().some((r) => r.runId === parsed.runId)) return false;
    this.append("records.jsonl", parsed);
    return true;
  }

  /** Whether this version has logged any run: a directory made by a lock or a bind alone does not count. */
  hasRuns(): boolean {
    return existsSync(join(this.dir, "attempts.jsonl")) || existsSync(join(this.dir, "started.jsonl"));
  }

  appendIntent(intent: RunIntent): void {
    this.append("started.jsonl", RunIntent.parse(intent));
  }

  intents(): RunIntent[] {
    return this.read("started.jsonl").map((v) => RunIntent.parse(v));
  }

  /**
   * Records every started run that has no attempt yet (see `interruptedAttempt`)
   * and returns how many. `run`, `probe` and `report` call it first, and an
   * interrupted harness calls it before it exits.
   */
  recoverInterrupted(now: Date = new Date()): number {
    const recorded = new Set(this.attempts().map((a) => a.runId));
    const intents = this.intents();
    let recovered = 0;
    for (const intent of intents) {
      if (intent.type !== "intent" || recorded.has(intent.runId)) continue;
      const agent = intents.find((i): i is Extract<RunIntent, { type: "agent" }> => i.type === "agent" && i.runId === intent.runId);
      this.appendAttempt(interruptedAttempt(intent, agent?.agentId ?? null, now));
      recorded.add(intent.runId);
      recovered++;
    }
    return recovered;
  }

  /**
   * Takes the version's lock, so two commands never append to the same logs
   * at once (two runs would both run a slot; two reconciles would both record
   * it). A lock whose process is gone is taken over. Released on exit.
   */
  lock(): () => void {
    const path = join(this.dir, "lock");
    mkdirSync(this.dir, { recursive: true });
    for (let tries = 0; ; tries++) {
      try {
        writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || tries > 3) throw error;
        let holder = Number.NaN;
        let age = 0;
        try {
          holder = Number(readFileSync(path, "utf8").trim());
          age = Date.now() - statSync(path).mtimeMs;
        } catch {
          continue;
        }
        // An empty lock is one being written right now: held, unless it is old.
        if (!(Number.isInteger(holder) && holder > 0) && age < 5_000) throw new Error(`another benchmark command is taking the lock on ${this.dir}`);
        if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another benchmark command (pid ${holder}) is using ${this.dir}`);
        // Taking over a stale lock is a rename, which only one of several racing commands wins.
        try {
          renameSync(path, `${path}.stale.${process.pid}`);
          rmSync(`${path}.stale.${process.pid}`, { force: true });
        } catch {
          // Another command took it over first; try again.
        }
      }
    }
    const release = () => {
      process.off("exit", release);
      try {
        if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
      } catch {
        // Already gone.
      }
    };
    process.on("exit", release);
    return release;
  }

  /**
   * Binds the version to `value` under `file`: writes it on first use, and
   * refuses when a later invocation brings a different one. Attempts made
   * under one freeze, or one probe setup, are then never resumed under another.
   */
  bind(file: string, value: unknown, what: string): void {
    const path = join(this.dir, file);
    const text = canonicalize(value);
    if (!existsSync(path)) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, `${text}\n`, { flag: "wx" });
      return;
    }
    let recorded: string;
    try {
      recorded = canonicalize(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      recorded = "";
    }
    if (recorded !== text) throw new Error(`${this.dir} was started with a different ${what}; use a new version`);
  }

  attempts(): Attempt[] {
    return this.read("attempts.jsonl").map((v) => Attempt.parse(v));
  }

  records(): RunRecord[] {
    return this.read("records.jsonl").map((v) => RunRecord.parse(v));
  }

  appendObservation(observation: CostObservation): void {
    this.append("costs.jsonl", CostObservation.parse(observation));
  }

  observations(): CostObservation[] {
    return this.read("costs.jsonl").map((v) => CostObservation.parse(v));
  }

  /** Completed attempts whose cost has not been reconciled yet. */
  pending(): Attempt[] {
    const done = new Set(this.records().map((r) => r.runId));
    return this.attempts().filter((a) => !a.startupFailure && !done.has(a.runId));
  }

  private append(file: string, value: unknown): void {
    const path = join(this.dir, file);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(value)}\n`);
  }

  private read(file: string): unknown[] {
    const path = join(this.dir, file);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown);
  }
}
