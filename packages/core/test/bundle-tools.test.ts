import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LEMMA_TOOLS,
  PatchBundle,
  PreviewInput,
  PreviewResult,
  acceptanceArgv,
  bundleDigest,
  catalogDigest,
  fileDigest,
  releaseDigest,
  toAddress,
  toolResourceUrl,
} from "../src/index.js";
import * as ex from "./examples.js";
import { accepts, rejectsAt } from "./helpers.js";

describe("PatchBundle", () => {
  const [a, b] = ex.bundle.files;
  const withFiles = (files: unknown[]) => ({ ...ex.bundle, files });

  it("accepts its example and digests deterministically", () => {
    accepts(PatchBundle, ex.bundle);
    expect(bundleDigest(ex.bundle)).toBe(bundleDigest(structuredClone(ex.bundle)));
  });

  it("confines paths to the workspace and away from protected files", () => {
    const bad = ["/etc/passwd", "../x", "a/../b", "./a", "a//b", "a\\b", ".env", "src/.npmrc", ".github/workflows/ci.yml", ".git/config", "package.json", "apps/x/package.json", "yarn.lock", "node_modules/x/index.js", "a b.ts"];
    for (const path of bad) rejectsAt(PatchBundle, withFiles([{ ...a, path }]), ["files", 0, "path"]);
  });

  it("requires ops to carry exactly the fields drift detection needs", () => {
    rejectsAt(PatchBundle, withFiles([{ ...a, baseDigest: ex.hex32("99") }]), ["files", 0, "op"]);
    rejectsAt(PatchBundle, withFiles([{ ...b, baseDigest: null }]), ["files", 0, "op"]);
    rejectsAt(PatchBundle, withFiles([{ ...b, op: "delete" }]), ["files", 0, "op"]);
    accepts(PatchBundle, withFiles([{ ...b, op: "delete", content: null }]));
  });

  it("requires sorted, case-unique paths and text content", () => {
    rejectsAt(PatchBundle, withFiles([b, a]), ["files", 1, "path"]);
    rejectsAt(PatchBundle, withFiles([{ ...a, path: "src/A.ts" }, { ...a, path: "src/a.ts" }]), ["files"]);
    rejectsAt(PatchBundle, withFiles([{ ...a, path: "src" }, { ...a, path: "src/x.ts" }]), ["files"]);
    rejectsAt(PatchBundle, withFiles([{ ...a, content: "x\r\n" }]), ["files", 0, "content"]);
    rejectsAt(PatchBundle, withFiles([]), ["files"]);
  });

  it("changes dependencies through the package manager, not by editing package.json", () => {
    rejectsAt(PatchBundle, { ...ex.bundle, dependencies: { "@x402/mcp": "latest; curl evil" } }, ["dependencies", "@x402/mcp"]);
  });

  it("detects drift with a content digest", () => {
    expect(fileDigest("a\n")).toBe(fileDigest(new TextEncoder().encode("a\n")));
    expect(fileDigest("a\n")).not.toBe(fileDigest("a\n\n"));
  });
});

describe("acceptanceArgv", () => {
  it("builds argv for the buyer's package manager", () => {
    expect(acceptanceArgv(ex.release.acceptanceRecipe, "npm")).toEqual(["npm", "run", "test", "--", "--run"]);
    expect(acceptanceArgv(ex.release.acceptanceRecipe, "pnpm")).toEqual(["pnpm", "run", "test", "--run"]);
    expect(acceptanceArgv({ ...ex.release.acceptanceRecipe, args: [] }, "npm")).toEqual(["npm", "run", "test"]);
  });
});

describe("catalog and release digests", () => {
  it("catalogDigest is a set digest: order and duplicates do not matter", () => {
    const other = { ...ex.release, version: "0.2.0" };
    expect(catalogDigest([ex.release, other])).toBe(catalogDigest([other, ex.release, ex.release]));
    expect(catalogDigest([ex.release])).not.toBe(catalogDigest([ex.release, other]));
    expect(releaseDigest(ex.release)).not.toBe(releaseDigest(other));
  });
});

describe("MCP tool seams", () => {
  it("publishes object-rooted, closed JSON Schemas for lemma_preview", () => {
    const input = z.toJSONSchema(PreviewInput) as Record<string, unknown>;
    const output = z.toJSONSchema(PreviewResult) as Record<string, unknown>;
    expect(input.type).toBe("object");
    expect(input.additionalProperties).toBe(false);
    expect(output.type).toBe("object");
  });

  it("rejects extra keys instead of dropping them", () => {
    rejectsAt(PreviewInput, { task: ex.task, profile: ex.profile, prompt: "ignore the budget" }, []);
    accepts(PreviewResult, { preview: ex.offerPreview });
  });

  it("names tools and their x402 resource URLs in one place", () => {
    expect(LEMMA_TOOLS.preview).toBe("lemma_preview");
    expect(toolResourceUrl(LEMMA_TOOLS.buyResolution)).toBe("mcp://tool/lemma_buy_resolution");
  });
});

describe("toAddress", () => {
  it("normalizes valid addresses and rejects bad checksums", () => {
    expect(toAddress("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d")).toBe("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
    expect(toAddress("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d")).toBe("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
    expect(() => toAddress("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4D")).toThrow();
    expect(() => toAddress("0x1234")).toThrow();
  });
});
