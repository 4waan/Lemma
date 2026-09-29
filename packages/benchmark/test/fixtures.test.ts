import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type CapabilityId, DIRECTORY, PatchBundle, type RepositoryProfile, fileDigest, planApply } from "@lemma/core";
import { CATALOG_ROOT, FixtureCase, buildIndex, loadCatalog, resolve } from "@lemma/catalog";
import { describe, expect, it } from "vitest";

import { loadBenchmarkFixtures } from "../src/index.js";

// The committed tasks, checked against the catalog they measure. A task's own
// tests run only inside a benchmark workspace (the root vitest config never
// collects fixtures), so these checks keep a task honest without running it.
const fixtures = loadBenchmarkFixtures();
const index = buildIndex(loadCatalog({ includeProvisional: false }));

function preview(capability: CapabilityId, profile: RepositoryProfile, now: string) {
  const payment = { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 } as const;
  return resolve({ task: { schemaVersion: "1", capability }, profile }, index, { now: new Date(now), previewId: `0x${"00".repeat(32)}`, payment, offerTtlSeconds: 900 });
}

describe("committed benchmark tasks", () => {
  it("include the probe tasks", () => {
    expect(fixtures.map((f) => f.fixture.taskId)).toEqual(expect.arrayContaining(["weather-mcp-paid-forecast", "market-brief-paid-tools"]));
  });

  for (const { fixture, dir } of fixtures) {
    describe(fixture.taskId, () => {
      it("measures its catalog case: the same capability and profile, and the release the resolver picks", () => {
        if (fixture.catalogCase === null) return;
        const catalogCase = FixtureCase.parse(JSON.parse(readFileSync(join(CATALOG_ROOT, "fixtures", `${fixture.catalogCase}.json`), "utf8")));
        expect(catalogCase.capability).toBe(fixture.capability);
        expect(catalogCase.profile).toEqual(fixture.profile);
        expect(catalogCase.expected.decision).toBe("reuse");
        const answer = preview(fixture.capability, fixture.profile, catalogCase.now);
        expect("release" in answer ? { releaseId: answer.release.releaseId, version: answer.release.version, profileIndex: answer.release.profileIndex } : null).toEqual(catalogCase.expected.match);
      });

      it("checks that its test files are unchanged before it runs them", () => {
        // An acceptance argument <path>=<sha256> pins a file the agent must not edit.
        const pins = fixture.acceptance.argv.flatMap((arg) => {
          const pin = /^([\w./-]+)=([0-9a-f]{64})$/.exec(arg);
          return pin === null ? [] : [{ path: pin[1] as string, digest: pin[2] as string }];
        });
        for (const { path, digest } of pins) {
          expect(createHash("sha256").update(readFileSync(join(dir, "repo", path))).digest("hex"), path).toBe(digest);
        }
      });
    });
  }
});

// Each task, the release its treatment gets, and what that release's bundle does to the task's repository.
const TASKS = [
  {
    taskId: "weather-mcp-paid-forecast",
    tests: ["test/paid-forecast.test.ts", "test/weather.test.ts"],
    release: ["mcp-server-payment-gating", "0.1.0"],
    writes: ["src/x402-payment-gating.ts"],
    dependencies: { "@x402/core": "~2.27.0", "@x402/evm": "~2.27.0", "@x402/mcp": "~2.27.0" },
  },
  {
    taskId: "market-brief-paid-tools",
    tests: ["test/brief.test.ts", "test/paying-agent.test.ts"],
    release: ["mcp-client-paying-client", "0.1.0"],
    writes: ["src/x402-paying-client.ts"],
    dependencies: { "@x402/core": "~2.27.0", "@x402/evm": "~2.27.0", "@x402/mcp": "~2.27.0", viem: "^2.48.11" },
  },
] as const;

for (const expected of TASKS) {
  describe(expected.taskId, () => {
    const task = fixtures.find((f) => f.fixture.taskId === expected.taskId);
    const repo = join(task?.dir ?? "", "repo");

    it("pins all of its test files", () => {
      expect(task?.fixture.acceptance.argv.filter((arg) => /=[0-9a-f]{64}$/.test(arg)).map((arg) => arg.split("=")[0])).toEqual(expected.tests);
    });

    it(`takes the ${expected.release.join("@")} bundle without drift, as the probe's pre-apply does`, () => {
      const bundle = PatchBundle.parse(JSON.parse(readFileSync(join(CATALOG_ROOT, "releases", ...expected.release, "bundle.json"), "utf8")));
      const plan = planApply(bundle, (path) => {
        const full = join(repo, path);
        if (!existsSync(full)) return null;
        return statSync(full).isDirectory() ? DIRECTORY : fileDigest(readFileSync(full));
      });
      expect(plan.ok ? [] : plan.drift).toEqual([]);
      if (!plan.ok) return;
      expect(plan.writes.map((w) => w.path)).toEqual(expected.writes);
      expect(plan.deletes).toEqual([]);
      expect(plan.dependencies).toEqual(expected.dependencies);
      // The control arm starts without x402: the buyer's repository has none of it yet.
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
      expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith("@x402/"))).toEqual([]);
    });
  });
}
