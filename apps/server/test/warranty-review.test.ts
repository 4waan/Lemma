import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolve } from "@lemma/catalog";
import { type AdoptionReceipt, adoptionReceiptDigest, deriveResolutionId } from "@lemma/core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { EVALUATOR_USAGE, MIGRATIONS_FOLDER, PgStore, ResolutionService, formatAge, formatReviewItem, parseEvaluatorArgs, runEvaluatorCommand, silentLogger } from "../src/index.js";
import { BUYER, NOW, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";
import { idOf } from "./warranty-helpers.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("the evaluator command", () => {
  const id = idOf("in review");

  it("takes list, or decide with a resolution id and failed or void, and nothing else", () => {
    expect(parseEvaluatorArgs(["list"])).toEqual({ command: "list" });
    expect(parseEvaluatorArgs(["decide", id, "failed"])).toEqual({ command: "decide", resolutionId: id, verdict: "failed" });
    expect(parseEvaluatorArgs(["decide", id, "void"])).toEqual({ command: "decide", resolutionId: id, verdict: "void" });
    expect(parseEvaluatorArgs([])).toEqual({ error: EVALUATOR_USAGE });
    expect(parseEvaluatorArgs(["list", "--all"])).toEqual({ error: EVALUATOR_USAGE });
    expect(parseEvaluatorArgs(["decide", id])).toEqual({ error: EVALUATOR_USAGE });
    expect(parseEvaluatorArgs(["decide", id, "passed"])).toMatchObject({ error: expect.stringContaining("failed or void") });
    expect(parseEvaluatorArgs(["decide", id.toUpperCase().replace("0X", "0x"), "void"])).toMatchObject({ error: expect.stringContaining("resolution id") });
    // A key never goes in an argument: nothing else is taken.
    expect(parseEvaluatorArgs(["decide", id, "void", "--key"])).toEqual({ error: EVALUATOR_USAGE });
  });

  it("prints one line per outcome in review, with nothing about the buyer", () => {
    const line = formatReviewItem({ resolutionId: id, release: "gating@1.0.0+bench-1", releaseDigest: idOf("release"), profileIndex: 0, receiptOutcome: "failed", exitCode: 1, ageSeconds: 3 * 3600 + 1200 });
    expect(line).toBe(`${id}  gating@1.0.0+bench-1  profile 0  receipt failed (exit 1)  waiting 3h 20m`);
    expect(formatReviewItem({ resolutionId: id, release: "unknown", releaseDigest: id, profileIndex: 2, receiptOutcome: null, exitCode: null, ageSeconds: 5 })).toContain("no receipt  waiting 5s");
    expect([formatAge(59), formatAge(60), formatAge(3600), formatAge(90_000)]).toEqual(["59s", "1m", "1h 0m", "1d 1h"]);
  });
});

describe("the evaluator command over a database", () => {
  it("refuses a schema behind the build, lists a failure in review, and queues the operator's decision once", async () => {
    const pglite = new PGlite();
    const db = drizzle(pglite);
    try {
      expect(await runEvaluatorCommand(db, { command: "list" }, NOW)).toEqual({ lines: [], error: expect.stringContaining("run npm run db:migrate first") });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      expect(await runEvaluatorCommand(db, { command: "list" }, NOW)).toEqual({ lines: ["no failed outcome waits for a decision"], error: null });

      // A settled purchase whose buyer's receipt failed, its finalization held for review by the evaluator job.
      const store = new PgStore(db);
      const index = sellableIndex();
      await store.saveCatalog(index, NOW);
      const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
        now: NOW,
        previewId: nextPreviewId(),
        payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
        offerTtlSeconds: 900,
      });
      await store.saveOffer(offer);
      const service = new ResolutionService(store, () => NOW, silentLogger);
      const id = deriveResolutionId(offer.previewId, BUYER);
      expect((await service.prepare(offer.previewId, { payer: BUYER, nonce: "0x01", validBefore: new Date(NOW.getTime() + 300_000) }, NOW, idOf("claim"))).ok).toBe(true);
      await service.commit(id, { nonce: "0x01", settlementRef: "0xsettlement" });
      const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: id, outcome: "failed", acceptance: { exitCode: 1, durationMs: 1000, outputDigest: null }, recordedAt: NOW.toISOString(), signature: null };
      expect(await service.acceptReceipt({ receipt, previewId: offer.previewId })).toBe("ACCEPTED");
      const outcome = { schemaVersion: "1" as const, resolutionId: id, verdict: "failed" as const, weightBps: 10_000, evidenceHash: adoptionReceiptDigest(receipt), validUntil: 1_790_003_600 };
      await store.insertWarrantyAction({ resolutionId: id, kind: "finalize", payload: outcome, signature: null, state: "review", nextAttemptAt: NOW }, NOW);

      const later = new Date(NOW.getTime() + 3600_000);
      const listed = await runEvaluatorCommand(db, { command: "list" }, later);
      expect(listed).toEqual({ lines: [`${id}  gating@1.0.0+bench-1  profile 0  receipt failed (exit 1)  waiting 1h 0m`], error: null });
      expect(listed.lines.join("\n")).not.toContain(BUYER.slice(2));

      expect(await runEvaluatorCommand(db, { command: "decide", resolutionId: id, verdict: "void" }, later)).toEqual({ lines: [`queued ${id} as void; the evaluator job signs and sends it`], error: null });
      expect(await store.getWarrantyAction(id, "finalize")).toMatchObject({ state: "queued", signature: null, payload: { verdict: "void", weightBps: 0 } });
      expect(await runEvaluatorCommand(db, { command: "list" }, later)).toEqual({ lines: ["no failed outcome waits for a decision"], error: null });
      // Deciding again changes nothing, and says why; so does an id with nothing held.
      expect(await runEvaluatorCommand(db, { command: "decide", resolutionId: id, verdict: "failed" }, later)).toEqual({ lines: [], error: expect.stringContaining("is not waiting for a decision") });
      expect(await store.getWarrantyAction(id, "finalize")).toMatchObject({ state: "queued", payload: { verdict: "void" } });
      expect(await runEvaluatorCommand(db, { command: "decide", resolutionId: idOf("nobody"), verdict: "failed" }, later)).toEqual({ lines: [], error: expect.stringContaining("no finalization is held") });
    } finally {
      await pglite.close();
    }
    // It starts a database and applies every migration: seconds on a loaded machine.
  }, 60_000);

  it("runs as a script that reads DATABASE_URL, never prints it, and fails with exit code 1", () => {
    const run = (env: Record<string, string>, args: string[] = ["list"]) =>
      spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "apps/server/src/scripts/evaluator.ts"), ...args], { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", ...env }, encoding: "utf8", timeout: 60_000 });
    const usage = run({}, ["decide"]);
    expect([usage.status, usage.stderr.trim()]).toEqual([1, `evaluator: ${EVALUATOR_USAGE}`]);
    const unset = run({});
    expect([unset.status, unset.stderr]).toEqual([1, expect.stringContaining("evaluator: DATABASE_URL must be set")]);
    // Nothing listens there: the connection fails, and neither the password nor the URL is printed.
    const password = ["pw", "4", "evaluator", "test"].join("");
    const refused = run({ DATABASE_URL: `postgres://lemma:${password}@127.0.0.1:9/lemma` });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^evaluator: failed \(/);
    expect(`${refused.stdout}${refused.stderr}`).not.toContain(password);
    expect(`${refused.stdout}${refused.stderr}`).not.toContain("127.0.0.1:9");
  }, 120_000);
});
