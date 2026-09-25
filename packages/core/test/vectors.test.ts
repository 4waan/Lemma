import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type DigestKind, adoptionReceiptDigest, baseReleaseDigest, canonicalize, catalogDigest, deriveResolutionId, digest } from "../src/index.js";
import * as ex from "./examples.js";

/**
 * Frozen canonical-form and digest vectors. Other components (the contract
 * tests, the payment path, any non-TypeScript client) check their encoders
 * against this file. Regenerate only for a deliberate schema change:
 *   LEMMA_WRITE_VECTORS=1 npx vitest run packages/core/test/vectors.test.ts
 */
const FILE = fileURLToPath(new URL("./vectors/digests.json", import.meta.url));

const inputs: ReadonlyArray<{ name: string; kind: DigestKind; value: unknown }> = [
  { name: "repository-profile", kind: "repository-profile", value: ex.profile },
  { name: "task-request", kind: "task-request", value: ex.task },
  { name: "capability-release", kind: "capability-release", value: ex.release },
  { name: "preview-offer", kind: "preview", value: ex.offerPreview },
  { name: "preview-decline", kind: "preview", value: ex.declinePreview },
  { name: "resolution", kind: "resolution", value: ex.resolution },
  { name: "resolution-id", kind: "resolution-id", value: { previewId: ex.resolution.previewId, buyer: ex.resolution.buyer } },
  { name: "adoption-receipt", kind: "adoption-receipt", value: ex.receipt },
  { name: "patch-bundle", kind: "patch-bundle", value: ex.bundle },
  { name: "run-record", kind: "run-record", value: ex.runRecord },
];

const computed = inputs.map(({ name, kind, value }) => ({
  name,
  kind,
  value,
  canonical: canonicalize({ kind, value }),
  digest: digest(kind, value),
}));

const derived = {
  resolutionId: deriveResolutionId(ex.resolution.previewId, ex.resolution.buyer),
  adoptionReceiptDigest: adoptionReceiptDigest(ex.receipt),
  catalogDigest: catalogDigest([ex.release]),
  baseReleaseDigest: baseReleaseDigest(ex.release),
};

if (process.env.LEMMA_WRITE_VECTORS === "1") {
  writeFileSync(FILE, `${JSON.stringify({ algorithm: "keccak256(utf8(JCS({kind, value})))", vectors: computed, derived }, null, 2)}\n`);
}

describe("digest vectors", () => {
  const frozen = JSON.parse(readFileSync(FILE, "utf8")) as { vectors: typeof computed; derived: typeof derived };

  it("covers every example", () => {
    expect(frozen.vectors.map((v) => v.name)).toEqual(computed.map((v) => v.name));
  });

  for (const vector of computed) {
    it(`${vector.name} matches the frozen vector`, () => {
      const expected = frozen.vectors.find((v) => v.name === vector.name);
      expect(expected?.value).toEqual(vector.value);
      expect(expected?.canonical).toBe(vector.canonical);
      expect(expected?.digest).toBe(vector.digest);
    });
  }

  it("pins the derived identifiers the payment and contract work sign or store", () => {
    expect(frozen.derived).toEqual(derived);
    expect(derived.resolutionId).toBe(computed.find((v) => v.name === "resolution-id")?.digest);
  });
});
