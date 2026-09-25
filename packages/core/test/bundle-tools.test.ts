import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DIRECTORY,
  LEMMA_TOOLS,
  MAX_PROFILE_DEPENDENCIES,
  PatchBundle,
  PreviewInput,
  PreviewResult,
  RecoverInput,
  ResolutionDelivery,
  acceptanceArgv,
  baseRelease,
  baseReleaseDigest,
  bundleDigest,
  catalogDigest,
  catalogDigestOf,
  fileDigest,
  planApply,
  profileDigest,
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

describe("planApply", () => {
  const add = { path: "src/add.ts", op: "add" as const, baseDigest: null, content: "export {};\n" };
  const base = "export const a = 1;\n";
  const modify = { path: "src/mod.ts", op: "modify" as const, baseDigest: fileDigest(base), content: "export const a = 2;\n" };
  const del = { path: "src/old.ts", op: "delete" as const, baseDigest: fileDigest("old\n"), content: null };
  const bundle: PatchBundle = { schemaVersion: "1", files: [add, modify, del], dependencies: { "@x402/mcp": "^2.27.0" }, devDependencies: {} };
  const workspace =
    (files: Record<string, string>, dirs: readonly string[] = ["src"]) =>
    (path: string) =>
      path in files ? fileDigest(files[path] as string) : dirs.includes(path) ? DIRECTORY : null;

  it("plans writes and deletes when every file is in its expected state", () => {
    const plan = planApply(bundle, workspace({ "src/mod.ts": base, "src/old.ts": "old\n" }));
    expect(plan).toEqual({
      ok: true,
      writes: [
        { path: "src/add.ts", op: "add", content: "export {};\n" },
        { path: "src/mod.ts", op: "modify", content: "export const a = 2;\n" },
      ],
      deletes: ["src/old.ts"],
      dependencies: { "@x402/mcp": "^2.27.0" },
      devDependencies: {},
    });
  });

  it("reports every drifted path and plans nothing", () => {
    const plan = planApply(bundle, workspace({ "src/add.ts": "already here\n", "src/mod.ts": "edited\n" }));
    expect(plan).toEqual({
      ok: false,
      drift: [
        { path: "src/add.ts", op: "add", expected: null, actual: fileDigest("already here\n") },
        { path: "src/mod.ts", op: "modify", expected: fileDigest(base), actual: fileDigest("edited\n") },
        { path: "src/old.ts", op: "delete", expected: fileDigest("old\n"), actual: null },
      ],
    });
  });

  it("treats a directory at an add or modify path, or a file at a parent path, as drift", () => {
    const plan = planApply(bundle, workspace({ src: "a file where a directory belongs\n", "src/old.ts": "old\n" }, ["src/add.ts"]));
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.drift).toEqual([
      { path: "src", op: "add", expected: DIRECTORY, actual: fileDigest("a file where a directory belongs\n") },
      { path: "src/add.ts", op: "add", expected: null, actual: DIRECTORY },
      { path: "src/mod.ts", op: "modify", expected: fileDigest(base), actual: null },
    ]);
  });

  it("creates missing parent directories without calling that drift", () => {
    const nested: PatchBundle = { ...bundle, files: [{ ...add, path: "lib/deep/new.ts" }] };
    const asked: string[] = [];
    const plan = planApply(nested, (path) => (asked.push(path), null));
    expect(plan.ok).toBe(true);
    expect(asked).toEqual(["lib", "lib/deep", "lib/deep/new.ts"]);
  });

  it("returns dependency maps the caller may change without touching the bundle", () => {
    const plan = planApply(bundle, workspace({ "src/mod.ts": base, "src/old.ts": "old\n" }));
    if (!plan.ok) throw new Error("expected a plan");
    plan.dependencies["evil"] = "1.0.0";
    expect(bundle.dependencies).toEqual({ "@x402/mcp": "^2.27.0" });
  });

  it("refuses an invalid bundle before reading the workspace", () => {
    let reads = 0;
    expect(() => planApply({ ...bundle, files: [{ ...add, path: "../x" }] }, () => (reads++, null))).toThrow();
    expect(reads).toBe(0);
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

  it("catalogDigestOf gives the same digest from precomputed release digests", () => {
    const other = { ...ex.release, version: "0.2.0" };
    expect(catalogDigestOf([releaseDigest(other), releaseDigest(ex.release)])).toBe(catalogDigest([ex.release, other]));
    expect(() => catalogDigestOf([ex.hex32("AB")])).toThrow();
  });

  it("baseRelease keeps what the buyer gets and drops evidence, build metadata, price and dates", () => {
    const unbenchmarked = { ...ex.release, supportedProfiles: ex.release.supportedProfiles.map((p) => ({ ...p, evidence: null })) };
    const { price: _p, publishedAt: _a, expiresAt: _b, ...identity } = unbenchmarked;
    expect(baseRelease({ ...ex.release, version: "0.1.0+bench-1" })).toEqual(identity);
    const same = [
      { ...ex.release, version: "0.1.0+bench-1" },
      { ...ex.release, version: "0.1.0+provisional-1", price: "200000" },
      { ...unbenchmarked, publishedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2027-06-30T00:00:00.000Z" },
    ];
    for (const r of same) expect(baseReleaseDigest(r)).toBe(baseReleaseDigest(unbenchmarked));
    const different = [
      { ...ex.release, version: "0.1.1+bench-1" },
      { ...ex.release, payloadDigest: ex.hex32("12") },
      { ...ex.release, title: "Another integration" },
      { ...ex.release, provider: { payTo: ex.BUYER } },
      { ...ex.release, warranty: { claimWindowHours: 24 } },
      { ...ex.release, acceptanceRecipe: { ...ex.release.acceptanceRecipe, args: [] } },
    ];
    for (const r of different) expect(baseReleaseDigest(r)).not.toBe(baseReleaseDigest(unbenchmarked));
    expect(baseReleaseDigest(unbenchmarked)).not.toBe(releaseDigest(unbenchmarked));
  });

  it("keeps a pre-release tag, which is part of the version, not build metadata", () => {
    expect(baseRelease({ ...ex.release, version: "0.2.0-rc.1+bench.2" }).version).toBe("0.2.0-rc.1");
  });
});

describe("MCP tool seams", () => {
  it("converts the preview schemas exactly as the MCP SDK does", () => {
    // McpServer converts inputs with io "input" and outputs with io "output", draft-7.
    const input = z.toJSONSchema(PreviewInput, { target: "draft-7", io: "input" }) as unknown as { properties: { profile: { properties: { dependencies: Record<string, unknown> } } } };
    expect(input.properties.profile.properties.dependencies.maxProperties).toBe(MAX_PROFILE_DEPENDENCIES);
    expect(() => z.toJSONSchema(PreviewResult, { target: "draft-7", io: "output" })).not.toThrow();
    expect(() => z.toJSONSchema(RecoverInput, { target: "draft-7", io: "input" })).not.toThrow();
    expect(() => z.toJSONSchema(ResolutionDelivery, { target: "draft-7", io: "output" })).not.toThrow();
  });

  it("lists and calls lemma_preview through a real MCP server and client", async () => {
    const server = new McpServer({ name: "lemma-test", version: "0.0.0" });
    server.registerTool(LEMMA_TOOLS.preview, { inputSchema: PreviewInput, outputSchema: PreviewResult }, async (input) => {
      expect(profileDigest(input.profile)).toBe(profileDigest(ex.profile));
      return { content: [{ type: "text", text: "reuse" }], structuredContent: { preview: ex.offerPreview } };
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "lemma-test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([LEMMA_TOOLS.preview]);
      const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: ex.task, profile: ex.profile } });
      expect(PreviewResult.parse(result.structuredContent)).toEqual({ preview: ex.offerPreview });
    } finally {
      await client.close();
      await server.close();
    }
  });

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
    expect(LEMMA_TOOLS.recoverResolution).toBe("lemma_recover_resolution");
    expect(toolResourceUrl(LEMMA_TOOLS.buyResolution)).toBe("mcp://tool/lemma_buy_resolution");
  });

  it("recovers by preview id and buyer, both strict", () => {
    accepts(RecoverInput, { previewId: ex.resolution.previewId, buyer: ex.BUYER });
    rejectsAt(RecoverInput, { previewId: ex.resolution.previewId, buyer: "0x00000000000000000000000000000000000000B1" }, ["buyer"]);
    rejectsAt(RecoverInput, { previewId: ex.resolution.previewId, buyer: ex.BUYER, resolutionId: ex.resolution.resolutionId }, []);
  });

  it("fails validation instead of throwing on text that cannot be digested", () => {
    const resolution = { ...ex.resolution, payloadDigest: bundleDigest(ex.bundle) };
    const lone = { ...ex.bundle, files: [{ ...ex.bundle.files[0], content: "half a pair: \ud800\n" }, ...ex.bundle.files.slice(1)] };
    expect(() => ResolutionDelivery.safeParse({ resolution, bundle: lone })).not.toThrow();
    expect(ResolutionDelivery.safeParse({ resolution, bundle: lone }).success).toBe(false);
    rejectsAt(PatchBundle, lone, ["files", 0, "content"]);
  });

  it("delivers a resolution only with the bundle it names", () => {
    const resolution = { ...ex.resolution, payloadDigest: bundleDigest(ex.bundle) };
    accepts(ResolutionDelivery, { resolution, bundle: ex.bundle });
    rejectsAt(ResolutionDelivery, { resolution: ex.resolution, bundle: ex.bundle }, ["bundle"]);
    rejectsAt(ResolutionDelivery, { resolution, bundle: { ...ex.bundle, files: [] } }, ["bundle", "files"]);
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
