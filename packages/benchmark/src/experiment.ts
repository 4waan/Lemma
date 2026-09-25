import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Hex32, IsoTimestamp, canonicalize, fileDigest } from "@lemma/core";
import { z } from "zod";

import { listFiles } from "./files.js";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/**
 * What is frozen before measured runs (benchmark-protocol.md "Integrity
 * rules"): the benchmark version, the model and its parameters, the tasks and
 * repetitions, and digests of the fixtures and the Lemma rule. `run` refuses to
 * start when a digest no longer matches.
 */
export const ExperimentConfig = z
  .strictObject({
    schemaVersion: z.literal("1"),
    benchmarkVersion: Slug,
    model: z.strictObject({
      id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:/-]+$/),
      params: z.array(z.strictObject({ id: z.string().min(1).max(64), value: z.string().max(64) })).max(16),
    }),
    repetitions: z.int().min(1).max(10),
    tasks: z.array(Slug).min(1).max(20),
    noMatchTasks: z.array(Slug).max(20),
    staleAfterDays: z.int().min(1).max(365),
    fixturesDigest: Hex32,
    ruleDigest: Hex32.nullable(),
    frozenAt: IsoTimestamp,
  })
  .refine((c) => c.noMatchTasks.every((t) => c.tasks.includes(t)), { path: ["noMatchTasks"], message: "no-match tasks must be tasks" });

export type ExperimentConfig = z.infer<typeof ExperimentConfig>;

/** One digest over every file of the given fixture directories: their paths and contents. */
export function fixturesDigest(fixtureDirs: ReadonlyArray<{ taskId: string; dir: string }>): Hex32 {
  const files = [...fixtureDirs]
    .sort((a, b) => (a.taskId < b.taskId ? -1 : 1))
    .flatMap(({ taskId, dir }) => listFiles(dir).map((path) => ({ path: `${taskId}/${path}`, digest: fileDigest(readFileSync(join(dir, path))) })));
  return fileDigest(canonicalize({ files }));
}
