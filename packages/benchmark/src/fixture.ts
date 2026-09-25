import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CapabilityId, RepositoryProfile, SafeText } from "@lemma/core";
import { z } from "zod";

/** Root of the benchmark package, from `src/` in tests and `dist/` at runtime. */
export const BENCHMARK_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Root of the Lemma repository the harness runs from. */
export const REPOSITORY_ROOT = resolve(BENCHMARK_ROOT, "..", "..");

const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "expected a lowercase slug");
const Arg = z.string().min(1).max(256).regex(/^[^\0\n\r]*$/, "no NUL or newlines");

/**
 * One frozen benchmark task (fixtures/README.md). Both arms start from an
 * identical copy of `repo/` with the same prompt, network policy, acceptance
 * command and time limit. `profile` is the RepositoryProfile the bridge would
 * send for `repo/`; `catalogCase` names the catalog fixture it corresponds to.
 */
export const BenchmarkFixture = z
  .strictObject({
    schemaVersion: z.literal("1"),
    taskId: Slug,
    kind: z.enum(["match", "no-match"]),
    capability: CapabilityId,
    catalogCase: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9-]+$/).nullable(),
    profile: RepositoryProfile,
    /** Commit of the upstream state `repo/` was taken from, when there is one. */
    initialCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    prompt: z.string().min(1).max(4000).refine((s) => !s.includes("\0"), "no NUL"),
    /** Both arms get the same network; the MVP benchmark runs with open network (see benchmark-protocol.md). */
    network: z.literal("open"),
    /** Runs in the fresh copy before the agent starts, identically for both arms (for example `npm ci --ignore-scripts`). */
    setup: z.strictObject({ argv: z.array(Arg).min(1).max(16), timeoutSec: z.int().min(1).max(1800) }).nullable(),
    acceptance: z.strictObject({ argv: z.array(Arg).min(1).max(16), timeoutSec: z.int().min(1).max(1800) }),
    expected: z.strictObject({ passed: z.literal(true) }),
    maxDurationSec: z.int().min(60).max(7200),
    notes: SafeText(400).optional(),
  })
  .refine((f) => (f.kind === "match") === (f.catalogCase !== null), { path: ["catalogCase"], message: "a match task names its catalog case, and a no-match task has none" });

export type BenchmarkFixture = z.infer<typeof BenchmarkFixture>;

export interface LoadedBenchmarkFixture {
  readonly fixture: BenchmarkFixture;
  /** Absolute directory holding `fixture.json` and `repo/`. */
  readonly dir: string;
}

/** Loads `fixtures/<taskId>/fixture.json` for every task directory. */
export function loadBenchmarkFixtures(root: string = BENCHMARK_ROOT): LoadedBenchmarkFixture[] {
  const base = join(root, "fixtures");
  const out: LoadedBenchmarkFixture[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    const fixture = BenchmarkFixture.parse(JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")));
    if (fixture.taskId !== entry.name) throw new Error(`fixtures/${entry.name}: taskId ${fixture.taskId} is not its directory`);
    out.push({ fixture, dir });
  }
  return out.sort((a, b) => (a.fixture.taskId < b.fixture.taskId ? -1 : 1));
}
