import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CAPABILITY_IDS, type CapabilityRelease, bundleDigest, catalogDigestOf, releaseDigest } from "@lemma/core";
import { describe, expect, it } from "vitest";

import { Range } from "semver";

import { CatalogError, FixtureCase, boundedAbove, buildIndex, checkCatalog, formatBundle, loadCatalog, packPayload } from "../src/index.js";
import { writeText } from "../src/files.js";
import { CLIENT, EVIDENCE, SERVER, catalogCopy, readJsonFile, writeJsonFile } from "./helpers.js";

const PROVIDER = "0x00000000000000000000000000000000000000a1";

/** Turns the copy into a sellable setup: measured economics and a real provider on the base release. */
function measured(root: string): void {
  writeJsonFile(root, "economics.json", { ...readJsonFile(root, "economics.json"), status: "measured", source: "test economics" });
  const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
  writeJsonFile(root, `${SERVER}/manifest.json`, { ...manifest, price: "250000", provider: { payTo: PROVIDER } });
}

/** Copies the server release to `<dir>/mcp-server-payment-gating/<version>` with evidence attached. */
function evidenced(root: string, dir: string, version: string, benchmarkVersion: string, overrides: Partial<CapabilityRelease> = {}): string {
  const target = `${dir}/mcp-server-payment-gating/${version}`;
  mkdirSync(join(root, target), { recursive: true });
  cpSync(join(root, SERVER), join(root, target), { recursive: true });
  const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
  writeJsonFile(root, `${target}/manifest.json`, {
    ...manifest,
    version,
    supportedProfiles: manifest.supportedProfiles.map((p) => ({ ...p, evidence: { ...EVIDENCE, benchmarkVersion } })),
    ...overrides,
  });
  return target;
}

const problems = (root: string) => checkCatalog({ root }).problems;

describe("the committed catalog", () => {
  it("passes every check", () => {
    const result = checkCatalog();
    expect(result.problems).toEqual([]);
    expect(result.catalog?.releases.map((r) => r.dir)).toHaveLength(2);
    expect(result.fixtureCount).toBeGreaterThanOrEqual(19);
  });

  it("indexes releases once, with interest sets for every capability", () => {
    const catalog = loadCatalog({ includeProvisional: false });
    const index = buildIndex(catalog);
    expect(index.catalogDigest).toBe(catalogDigestOf(catalog.releases.map((r) => releaseDigest(r.release))));
    expect(Object.keys(index.interest).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(index.interest["mcp-server.add-payment-gating"]).toEqual(["@modelcontextprotocol/sdk"]);
    expect(index.interest["node-service.add-payment-facilitator"]).toEqual([]);
    expect(index.byCapability.get("node-service.add-payment-facilitator")).toEqual([]);
    for (const r of index.releases) {
      expect(index.byDigest.get(r.releaseDigest)).toBe(r);
      expect(index.bundlesByPayloadDigest.get(r.release.payloadDigest)).toBe(r.bundle);
      expect(r.baseProbe).toEqual(r.bundle.files.map((f) => ({ path: f.path, baseDigest: f.baseDigest })));
      expect(r.baseProbe.length).toBeGreaterThan(0);
      expect(r.profiles[0]?.ranges.map(([name, range]) => [name, range.test("1.30.1")])).toEqual([["@modelcontextprotocol/sdk", true]]);
    }
  });

  it("sorts releases by digest, independent of directory order", () => {
    const digests = loadCatalog({ includeProvisional: false }).releases.map((r) => r.releaseDigest);
    expect(digests).toEqual([...digests].sort());
  });
});

describe("integrity", () => {
  it("refuses a bundle whose digest is not the manifest's payloadDigest", () => {
    const root = catalogCopy();
    const bundle = readJsonFile<{ files: Array<{ content: string }> }>(root, `${SERVER}/bundle.json`);
    bundle.files[0]!.content += "tampered\n";
    writeJsonFile(root, `${SERVER}/bundle.json`, bundle);
    expect(problems(root)).toContainEqual(expect.stringMatching(/payloadDigest .* does not match bundle\.json/));
    expect(() => loadCatalog({ root, includeProvisional: false })).toThrow(CatalogError);
  });

  it("refuses a payload that no longer packs to the committed bundle", () => {
    const root = catalogCopy();
    writeFileSync(join(root, SERVER, "payload/files/lemma/payment-gating/README.md"), "changed\n");
    expect(problems(root)).toContainEqual(expect.stringContaining("bundle.json is not what payload/ packs to"));
  });

  it("refuses payload files that no op names, and ops without files", () => {
    const root = catalogCopy();
    writeFileSync(join(root, SERVER, "payload/files/extra.ts"), "export {};\n");
    expect(problems(root)).toContainEqual(expect.stringContaining("not named in ops.json: extra.ts"));
    rmSync(join(root, CLIENT, "payload/files"), { recursive: true });
    expect(problems(root)).toContainEqual(expect.stringContaining("payload/files: missing lemma/paying-client/README.md"));
  });

  it("refuses symbolic links anywhere in a release", () => {
    const root = catalogCopy();
    symlinkSync("/etc/hostname", join(root, SERVER, "payload/files/link.ts"));
    expect(problems(root)).toContainEqual(expect.stringContaining("symbolic links are not allowed"));
  });

  it("requires <releaseId>/<version> directories and unique versions", () => {
    const root = catalogCopy();
    cpSync(join(root, SERVER), join(root, "releases/mcp-server-payment-gating/9.9.9"), { recursive: true });
    expect(problems(root)).toContainEqual(expect.stringContaining("the directory must be <releaseId>/<version>"));

    const dup = catalogCopy();
    mkdirSync(join(dup, "releases.provisional/mcp-server-payment-gating"), { recursive: true });
    cpSync(join(dup, SERVER), join(dup, "releases.provisional/mcp-server-payment-gating/0.1.0-skeleton"), { recursive: true });
    expect(problems(dup)).toContainEqual(expect.stringContaining("is already defined in"));
  });

  it("refuses a range the semver library cannot parse", () => {
    const root = catalogCopy();
    const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
    manifest.supportedProfiles[0]!.dependencies = { "@modelcontextprotocol/sdk": ">=1.30.0 <<2" };
    writeJsonFile(root, `${SERVER}/manifest.json`, manifest);
    expect(problems(root)).toContainEqual(expect.stringContaining("does not parse"));
  });

  it("refuses open or unparseable ranges in profiles and bundle dependency changes", () => {
    const root = catalogCopy();
    const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
    manifest.supportedProfiles[0]!.dependencies = { "@modelcontextprotocol/sdk": ">=1.30.0" };
    writeJsonFile(root, `${SERVER}/manifest.json`, manifest);
    writeJsonFile(root, `${CLIENT}/payload/ops.json`, { dependencies: { "@x402/mcp": "latest" }, devDependencies: { vitest: "*" }, files: [{ path: "lemma/paying-client/README.md", op: "add" }] });
    const bundle = packPayload(join(root, CLIENT));
    writeFileSync(join(root, CLIENT, "bundle.json"), formatBundle(bundle));
    const client = readJsonFile<CapabilityRelease>(root, `${CLIENT}/manifest.json`);
    writeJsonFile(root, `${CLIENT}/manifest.json`, { ...client, payloadDigest: bundleDigest(bundle) });
    const found = problems(root);
    expect(found).toContainEqual(expect.stringContaining("profile 0 range for @modelcontextprotocol/sdk has no upper bound"));
    expect(found).toContainEqual(expect.stringContaining("bundle dependency range for @x402/mcp does not parse: latest"));
    expect(found).toContainEqual(expect.stringContaining("bundle devDependency range for vitest has no upper bound"));
  });

  it("scans the whole tree, not only the files it reads", () => {
    const root = catalogCopy();
    symlinkSync("/etc", join(root, SERVER, "notes"));
    writeFileSync(join(root, SERVER, "payload", "extra.txt"), Buffer.from([0xff, 0xfe, 0x00]));
    writeFileSync(join(root, "fixtures", "README.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const found = problems(root);
    expect(found).toContainEqual(expect.stringContaining(`${SERVER}/notes: symbolic links are not allowed`));
    expect(found).toContainEqual(expect.stringContaining("payload: holds only ops.json, files/ and base/, not extra.txt"));
    expect(found).toContainEqual("fixtures/README.md: not valid UTF-8");
  });

  it("refuses anything in a release directory besides its manifest, bundle and payload", () => {
    const root = catalogCopy();
    writeFileSync(join(root, SERVER, ".bundle.json.123.tmp"), "{}\n");
    expect(problems(root)).toContainEqual(`${SERVER}: holds only manifest.json, bundle.json and payload/, not .bundle.json.123.tmp`);
  });

  it("hashes base files as bytes, so a binary file can be modified or deleted", () => {
    const root = catalogCopy();
    const ops = readJsonFile<{ files: Array<{ path: string; op: string }> }>(root, `${SERVER}/payload/ops.json`);
    writeJsonFile(root, `${SERVER}/payload/ops.json`, { ...ops, files: [...ops.files, { path: "assets/logo.png", op: "delete" }] });
    mkdirSync(join(root, SERVER, "payload", "base", "assets"), { recursive: true });
    writeFileSync(join(root, SERVER, "payload", "base", "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]));
    const bundle = packPayload(join(root, SERVER));
    writeFileSync(join(root, SERVER, "bundle.json"), formatBundle(bundle));
    writeJsonFile(root, `${SERVER}/manifest.json`, { ...readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`), payloadDigest: bundleDigest(bundle) });
    expect(problems(root)).toEqual([]);
  });

  it("reads bounds from the parsed range, so no single probe version can be out-ranged", () => {
    for (const bounded of ["1.2.3", "^1.2.3", "~1.2", "1.x", ">=1.0.0 <20250101.0.0", "<20250101.0.0", "<=2", "1.2.3 || ^2.0.0"]) expect(boundedAbove(new Range(bounded))).toBe(true);
    for (const open of ["*", "", "x", ">=1000000.0.0", ">999999.999999.999999", "<2 || >=1000000", ">=1.0.0"]) expect(boundedAbove(new Range(open))).toBe(false);
  });

  it("fails on a missing releases/ directory instead of serving an empty catalog", () => {
    const root = catalogCopy();
    rmSync(join(root, "releases"), { recursive: true });
    expect(problems(root)).toContainEqual("releases: missing");
  });

  it("keeps loading the other releases when a directory holds a link", () => {
    const root = catalogCopy();
    symlinkSync(join(root, SERVER), join(root, "releases", "mcp-server-payment-gating", "0.0.9-link"));
    symlinkSync("/etc/hostname", join(root, "releases", "NOTES.md"));
    const result = checkCatalog({ root });
    expect(result.catalog?.releases).toHaveLength(2);
    expect([...result.problems].sort()).toEqual([
      "releases/NOTES.md: symbolic links are not allowed in the catalog",
      "releases/mcp-server-payment-gating/0.0.9-link: symbolic links are not allowed in the catalog",
    ]);
  });

  it("keeps checking every other release when one fails to load", () => {
    const root = catalogCopy();
    writeFileSync(join(root, SERVER, "manifest.json"), "{ not json");
    const manifest = readJsonFile<CapabilityRelease>(root, `${CLIENT}/manifest.json`);
    manifest.supportedProfiles[0]!.dependencies = { "@modelcontextprotocol/sdk": "*" };
    writeJsonFile(root, `${CLIENT}/manifest.json`, manifest);
    const found = problems(root);
    expect(found).toContainEqual(expect.stringContaining(`${SERVER}/manifest.json: not valid JSON`));
    expect(found).toContainEqual(expect.stringContaining(`${CLIENT}: profile 0 range for @modelcontextprotocol/sdk has no upper bound`));
  });

  it("keeps a byte-order mark, so the bundle carries exactly the reviewed bytes", () => {
    const root = catalogCopy();
    const file = join(root, SERVER, "payload/files/lemma/payment-gating/README.md");
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(file)]));
    expect(packPayload(join(root, SERVER)).files[0]?.content?.startsWith("\ufeff")).toBe(true);
  });

  it("leaves no temporary copy behind when a write fails", () => {
    const root = catalogCopy();
    rmSync(join(root, SERVER, "bundle.json"));
    mkdirSync(join(root, SERVER, "bundle.json", "inside"), { recursive: true });
    expect(() => writeText(root, `${SERVER}/bundle.json`, "{}\n")).toThrow();
    expect(readdirSync(join(root, SERVER)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes bundle.json by replacing a link, never through it", () => {
    const root = catalogCopy();
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "untouched\n");
    rmSync(join(root, SERVER, "bundle.json"));
    symlinkSync(victim, join(root, SERVER, "bundle.json"));
    writeText(root, `${SERVER}/bundle.json`, "{}\n");
    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(readFileSync(join(root, SERVER, "bundle.json"), "utf8")).toBe("{}\n");
  });

  it("packs deterministically", () => {
    const a = packPayload(join(catalogCopy(), SERVER));
    const b = packPayload(join(catalogCopy(), SERVER));
    expect(bundleDigest(a)).toBe(bundleDigest(b));
    expect(JSON.parse(formatBundle(a))).toEqual(a);
  });
});

describe("evidence and versions", () => {
  it("never lets a base version carry evidence", () => {
    const root = catalogCopy();
    const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
    writeJsonFile(root, `${SERVER}/manifest.json`, { ...manifest, supportedProfiles: manifest.supportedProfiles.map((p) => ({ ...p, evidence: EVIDENCE })) });
    expect(problems(root)).toContainEqual(expect.stringContaining("a version without build metadata carries no evidence"));
  });

  it("accepts a provisional overlay that differs from its base only in version and evidence", () => {
    const root = catalogCopy();
    measured(root);
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1");
    expect(problems(root)).toEqual([]);
    const provisional = loadCatalog({ root, includeProvisional: true }).releases.filter((r) => r.source === "provisional");
    expect(provisional.map((r) => r.release.version)).toEqual(["0.1.0-skeleton+provisional-1"]);
    expect(loadCatalog({ root, includeProvisional: false }).releases.every((r) => r.source === "public")).toBe(true);
  });

  it("lets a later version change only its price and dates", () => {
    const root = catalogCopy();
    measured(root);
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1", {
      price: "200000",
      publishedAt: "2026-10-02T00:00:00.000Z",
      expiresAt: "2027-06-30T00:00:00.000Z",
    });
    expect(problems(root)).toEqual([]);
  });

  it("refuses an overlay that changes anything but version, evidence, price and dates", () => {
    const root = catalogCopy();
    measured(root);
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1", { title: "Something else" });
    expect(problems(root)).toContainEqual(expect.stringContaining("differs from mcp-server-payment-gating@0.1.0-skeleton in more than build metadata, evidence, price and dates"));
  });

  it("keeps reserved evidence out of releases/ and only provisional versions in the overlay", () => {
    const root = catalogCopy();
    measured(root);
    evidenced(root, "releases", "0.1.0-skeleton+provisional-1", "provisional-1");
    evidenced(root, "releases", "0.1.0-skeleton+probe-1", "probe-1");
    evidenced(root, "releases.provisional", "0.1.0-skeleton+bench-1", "bench-1");
    const found = problems(root);
    expect(found).toContainEqual(expect.stringContaining("provisional- evidence is never served from releases/"));
    expect(found).toContainEqual(expect.stringContaining("probe- evidence is never served from releases/"));
    expect(found).toContainEqual(expect.stringContaining("releases.provisional/ holds only X+provisional-N versions"));
  });

  it("refuses public evidence until a verified benchmark report backs it", () => {
    const root = catalogCopy();
    measured(root);
    evidenced(root, "releases", "0.1.0-skeleton+bench-1", "bench-1");
    expect(problems(root)).toEqual([`releases/mcp-server-payment-gating/0.1.0-skeleton+bench-1: no verified benchmark report backs evidence bench-1`]);
  });

  it("requires evidence to name the version's build metadata", () => {
    const root = catalogCopy();
    measured(root);
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-2");
    expect(problems(root)).toContainEqual(expect.stringContaining("evidence provisional-2 must equal the version's build metadata (provisional-1)"));
  });
});

describe("prices", () => {
  it("refuses evidence while the economics are a placeholder", () => {
    const root = catalogCopy();
    const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
    writeJsonFile(root, `${SERVER}/manifest.json`, { ...manifest, price: "250000", provider: { payTo: PROVIDER } });
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1");
    expect(problems(root)).toContainEqual(expect.stringContaining("economics.json is still a placeholder"));
  });

  it("bounds an evidenced price by maxPriceFor and the price floor", () => {
    const root = catalogCopy();
    measured(root);
    writeJsonFile(root, "economics.json", { ...readJsonFile(root, "economics.json"), chainCostAtomic: "100000", priceFloorAtomic: "260000" });
    const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
    writeJsonFile(root, `${SERVER}/manifest.json`, { ...manifest, price: "280000" });
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1");
    // maxPriceFor: min(300000, 1000000 - 100000 - 625000) = 275000
    expect(problems(root)).toContainEqual(expect.stringContaining("price 280000 exceeds maxPriceFor 275000"));
    writeJsonFile(root, `${SERVER}/manifest.json`, { ...manifest, price: "250000" });
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1");
    expect(problems(root)).toContainEqual(expect.stringContaining("price 250000 is below the price floor 260000"));
  });

  it("never lets evidence price a release that pays the zero address", () => {
    const root = catalogCopy();
    measured(root);
    const manifest = readJsonFile<CapabilityRelease>(root, `${SERVER}/manifest.json`);
    writeJsonFile(root, `${SERVER}/manifest.json`, { ...manifest, provider: { payTo: `0x${"0".repeat(40)}` } });
    evidenced(root, "releases.provisional", "0.1.0-skeleton+provisional-1", "provisional-1");
    expect(problems(root)).toContainEqual(expect.stringContaining("pays to the zero address"));
  });
});

describe("fixtures", () => {
  it("requires an exact case per release and near-miss and unsupported cases per capability", () => {
    const root = catalogCopy();
    rmSync(join(root, "fixtures/mcp-client.add-paying-client"), { recursive: true });
    const found = problems(root);
    expect(found).toContainEqual(`${CLIENT}: no exact fixture matches this release or another version of it`);
    expect(found).toContainEqual("fixtures/mcp-client.add-paying-client: needs a near-miss case");
    expect(found).toContainEqual("fixtures/mcp-client.add-paying-client: needs an unsupported-language or unsupported-runtime case");
  });

  it("refuses a case that matches a release that does not exist", () => {
    const root = catalogCopy();
    const path = "fixtures/mcp-server.add-payment-gating/exact-npm-node22.json";
    const fixture = readJsonFile<{ expected: { match: { version: string } } }>(root, path);
    fixture.expected.match.version = "9.9.9";
    writeJsonFile(root, path, fixture);
    expect(problems(root)).toContainEqual(expect.stringContaining("matches mcp-server-payment-gating@9.9.9, which is not in releases/"));
  });

  it("keeps each case's class, decision, reasons and match consistent", () => {
    const base = readJsonFile(catalogCopy(), "fixtures/mcp-server.add-payment-gating/exact-npm-node22.json");
    expect(FixtureCase.safeParse(base).success).toBe(true);
    const bad = [
      { ...base, class: "unsupported" },
      { ...base, expected: { decision: "build", reasons: ["MISSING_DEPENDENCY"], match: { releaseId: "x", version: "1.0.0", profileIndex: 0 }, offer: false } },
      { ...base, expected: { decision: "reuse", reasons: [], match: { releaseId: "x", version: "1.0.0", profileIndex: 0 }, offer: false } },
      { ...base, expected: { decision: "reuse", reasons: ["PROFILE_NOT_BENCHMARKED"], match: { releaseId: "x", version: "1.0.0", profileIndex: 0 }, offer: true } },
      { ...base, class: "no-release", expected: { decision: "build", reasons: ["MISSING_DEPENDENCY"], match: null, offer: false } },
    ];
    for (const value of bad) expect(FixtureCase.safeParse(value).success).toBe(false);
  });

  it("keeps no-release cases to capabilities without releases, and only those", () => {
    const root = catalogCopy();
    const fixture = readJsonFile(root, "fixtures/node-service.add-payment-facilitator/no-release.json");
    writeJsonFile(root, "fixtures/mcp-server.add-payment-gating/no-release.json", { ...fixture, capability: "mcp-server.add-payment-gating" });
    const nearMiss = readJsonFile(root, "fixtures/mcp-server.add-payment-gating/near-miss-no-sdk.json");
    writeJsonFile(root, "fixtures/node-service.add-payment-facilitator/near-miss.json", { ...nearMiss, capability: "node-service.add-payment-facilitator" });
    const found = problems(root);
    expect(found).toContainEqual("fixtures/mcp-server.add-payment-gating/no-release.json: a no-release case for a capability that has releases");
    expect(found).toContainEqual("fixtures/node-service.add-payment-facilitator/near-miss.json: node-service.add-payment-facilitator has no releases, so its only case is no-release");
    expect(FixtureCase.safeParse({ ...nearMiss, expected: { decision: "build", reasons: ["NO_RELEASE_FOR_CAPABILITY"], match: null, offer: false } }).success).toBe(false);
  });

  it("keeps a capability's other cases when one entry is a link, and reports each fault once", () => {
    const root = catalogCopy();
    symlinkSync("/etc/hostname", join(root, "fixtures", "mcp-server.add-payment-gating", "link.json"));
    const result = checkCatalog({ root });
    expect(result.problems).toEqual(["fixtures/mcp-server.add-payment-gating/link.json: symbolic links are not allowed in the catalog"]);
    rmSync(join(root, "fixtures"), { recursive: true });
    expect(problems(root).filter((p) => p === "fixtures: missing")).toHaveLength(1);
  });

  it("only accepts answers the resolver can give", () => {
    const base = readJsonFile(catalogCopy(), "fixtures/mcp-server.add-payment-gating/near-miss-no-sdk.json");
    const expected = (decision: string, reasons: string[]) => ({ ...base, class: decision === "decline" ? "unsupported" : "near-miss", expected: { decision, reasons, match: null, offer: false } });
    expect(FixtureCase.safeParse(expected("build", ["MISSING_DEPENDENCY"])).success).toBe(true);
    expect(FixtureCase.safeParse(expected("decline", ["MISSING_DEPENDENCY"])).success).toBe(false);
    expect(FixtureCase.safeParse(expected("build", ["UNSUPPORTED_LANGUAGE"])).success).toBe(false);
    expect(FixtureCase.safeParse(expected("build", ["PROFILE_NOT_BENCHMARKED"])).success).toBe(false);
    expect(FixtureCase.safeParse(expected("build", ["MISSING_DEPENDENCY", "NO_RELEASE_FOR_CAPABILITY"])).success).toBe(false);
  });

  it("refuses files outside the naming scheme and unknown capability directories", () => {
    const root = catalogCopy();
    writeFileSync(join(root, "fixtures/mcp-server.add-payment-gating/Bad Name.json"), "{}");
    mkdirSync(join(root, "fixtures/unknown.capability"));
    const found = problems(root);
    expect(found).toContainEqual(expect.stringContaining("Bad Name.json: expected <kebab-case-name>.json"));
    expect(found).toContainEqual("fixtures/unknown.capability: not a capability id");
  });
});
