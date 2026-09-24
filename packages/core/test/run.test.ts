import { describe, expect, it } from "vitest";

import { RunRecord, runRecordDigest, runSetDigest } from "../src/index.js";
import * as ex from "./examples.js";
import { accepts, rejectsAt } from "./helpers.js";

describe("RunRecord", () => {
  it("accepts its example and rejects unknown fields at every level", () => {
    accepts(RunRecord, ex.runRecord);
    rejectsAt(RunRecord, { ...ex.runRecord, extra: 1 }, []);
    rejectsAt(RunRecord, { ...ex.runRecord, tokens: { ...ex.runRecord.tokens, extra: 1 } }, ["tokens"]);
  });

  it("keeps control runs free of releases and payments", () => {
    rejectsAt(RunRecord, { ...ex.runRecord, arm: "control" }, ["arm"]);
    accepts(RunRecord, { ...ex.runRecord, arm: "control", releaseDigest: null, payment: null });
    rejectsAt(RunRecord, { ...ex.runRecord, releaseDigest: null }, ["payment"]);
    accepts(RunRecord, { ...ex.runRecord, releaseDigest: null, payment: null });
  });

  it("keeps outcomes and times consistent", () => {
    rejectsAt(RunRecord, { ...ex.runRecord, acceptance: { passed: true, exitCode: 1 } }, ["acceptance", "exitCode"]);
    accepts(RunRecord, { ...ex.runRecord, acceptance: { passed: false, exitCode: null } });
    rejectsAt(RunRecord, { ...ex.runRecord, finishedAt: "2026-09-21T09:59:59.999Z" }, ["finishedAt"]);
  });

  it("stores money and token counts exactly", () => {
    rejectsAt(RunRecord, { ...ex.runRecord, rawModelCostMicroUsd: "0.9" }, ["rawModelCostMicroUsd"]);
    rejectsAt(RunRecord, { ...ex.runRecord, tokens: { ...ex.runRecord.tokens, input: 1.5 } }, ["tokens", "input"]);
    rejectsAt(RunRecord, { ...ex.runRecord, model: "free text model" }, ["model"]);
  });

  it("digests runs and run sets independently of order and duplicates", () => {
    const other = { ...ex.runRecord, runId: ex.hex32("c2"), repetition: 2 };
    expect(runSetDigest("bench-1", [ex.runRecord, other])).toBe(runSetDigest("bench-1", [other, ex.runRecord, ex.runRecord]));
    expect(runSetDigest("bench-1", [ex.runRecord])).not.toBe(runSetDigest("bench-2", [ex.runRecord]));
    expect(runRecordDigest(ex.runRecord)).not.toBe(runRecordDigest(other));
  });
});
