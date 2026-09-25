import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ScanCache, ScanError, npmVersion, pnpmVersion, scanWorkspace, yarnVersion } from "../src/index.js";

const REPO = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const SDK = "@modelcontextprotocol/sdk";
const INTEREST = [SDK, "hono", "zod"];
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes a small repository from a map of relative paths to contents. */
function repo(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), "lemma-scan-"));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const scan = (root: string, cwd = root, interest = INTEREST) => scanWorkspace({ root, cwd, interest, runningNodeMajor: 22 });

describe("lockfile lookups", () => {
  it("npm: resolves like Node, from the workspace's own node_modules up to the root", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "packages/api": {},
        "packages/web": {},
        "node_modules/zod": { version: "3.25.76" },
        "packages/api/node_modules/zod": { version: "4.6.5" },
        "node_modules/@acme/shared": { link: true, resolved: "packages/shared" },
      },
    };
    expect(npmVersion(lock, "packages/api", "zod")).toBe("4.6.5");
    expect(npmVersion(lock, "packages/web", "zod")).toBe("3.25.76");
    expect(npmVersion(lock, "", "zod")).toBe("3.25.76");
    expect(npmVersion(lock, "", "@acme/shared")).toBeUndefined();
    expect(npmVersion(lock, "", "hono")).toBeUndefined();
    expect(npmVersion({ lockfileVersion: 1, dependencies: { zod: { version: "3.22.0" } } }, "", "zod")).toBe("3.22.0");
  });

  it("npm: answers only for package directories the lockfile records, and never for aliases, git or file installs", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/zod": { version: "3.22.4", resolved: "https://registry.npmjs.org/zod/-/zod-3.22.4.tgz" },
        "node_modules/hono": { name: "@acme/hono-fork", version: "4.13.9" },
        [`node_modules/${SDK}`]: { version: "1.30.1", resolved: "git+ssh://git@github.com/me/typescript-sdk.git#0123abc" },
        "node_modules/local": { version: "1.0.0", resolved: "file:../local" },
      },
    };
    expect(npmVersion(lock, "", "zod")).toBe("3.22.4");
    expect(npmVersion(lock, "examples/server", "zod")).toBeUndefined();
    expect(npmVersion(lock, "", "hono")).toBeUndefined();
    expect(npmVersion(lock, "", SDK)).toBeUndefined();
    expect(npmVersion(lock, "", "local")).toBeUndefined();
    expect(npmVersion({ lockfileVersion: 1, dependencies: { zod: { version: "3.22.4" } } }, "packages/api", "zod")).toBeUndefined();
  });

  it("pnpm: reads the top-level blocks of a single-project v6 or v5.4 lockfile", () => {
    const v6 = ["lockfileVersion: '6.0'", "", "settings:", "  autoInstallPeers: true", "", "dependencies:", "  zod:", "    specifier: ^3.22.4", "    version: 3.25.76", "", "devDependencies:", "  hono:", "    specifier: ^4.0.0", "    version: 4.13.9", "", "packages:", "", "  /zod@3.25.76:", "    dependencies:", "      hono: 4.0.0"].join("\n");
    expect(pnpmVersion(v6, "", "zod")).toBe("3.25.76");
    expect(pnpmVersion(v6, "", "hono")).toBe("4.13.9");
    expect(pnpmVersion(v6, "packages/api", "zod")).toBeUndefined();
    const v54 = ["lockfileVersion: 5.4", "", "specifiers:", "  zod: ^3.22.4", "", "dependencies:", "  zod: 3.22.4", "", "packages:", "", "  /zod/3.22.4:", "    resolution: {integrity: sha512-x}"].join("\n");
    expect(pnpmVersion(v54, "", "zod")).toBe("3.22.4");
    // v5.4 writes a peer-dependent version with an underscore suffix.
    const peers = ["lockfileVersion: 5.4", "", "dependencies:", "  '@modelcontextprotocol/sdk': 1.30.1_zod@3.22.4", "  zod: 3.22.4"].join("\n");
    expect(pnpmVersion(peers, "", "@modelcontextprotocol/sdk")).toBe("1.30.1");
  });

  it("pnpm: reads only the importer's block and drops peer suffixes and links", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      typescript:",
      "        specifier: 7.0.2",
      "        version: 7.0.2",
      "",
      "  packages/api:",
      "    dependencies:",
      "      '@modelcontextprotocol/sdk':",
      "        specifier: ^1.30.0",
      "        version: 1.30.1(zod@4.6.5)",
      "      '@acme/shared':",
      "        specifier: workspace:*",
      "        version: link:../shared",
      "",
      "packages:",
      "",
      "  '@modelcontextprotocol/sdk@1.30.1':",
      "    resolution: {integrity: sha512-x}",
    ].join("\n");
    expect(pnpmVersion(text, "packages/api", SDK)).toBe("1.30.1");
    expect(pnpmVersion(text, "packages/api", "@acme/shared")).toBeUndefined();
    expect(pnpmVersion(text, "", "typescript")).toBe("7.0.2");
    expect(pnpmVersion(text, "", SDK)).toBeUndefined();
    expect(pnpmVersion("importers:\n  .:\n    dependencies:\n      zod: 3.22.4\n", "", "zod")).toBe("3.22.4");
  });

  it("yarn: finds the block whose header names the declared specifier, classic and berry", () => {
    const classic = `# yarn lockfile v1\n\n"${SDK}@^1.30.0", "${SDK}@^1.30.1":\n  version "1.30.1"\n  resolved "https://registry.yarnpkg.com/x"\n\nzod@^4.0.0:\n  version "4.6.5"\n`;
    expect(yarnVersion(classic, SDK, "^1.30.0")).toBe("1.30.1");
    expect(yarnVersion(classic, "zod", "^4.0.0")).toBe("4.6.5");
    expect(yarnVersion(classic, "zod", "^3.0.0")).toBeUndefined();
    const berry = `__metadata:\n  version: 8\n\n"${SDK}@npm:^1.30.0":\n  version: 1.30.2\n  resolution: "${SDK}@npm:1.30.2"\n`;
    expect(yarnVersion(berry, SDK, "^1.30.0")).toBe("1.30.2");
  });
});

describe("scanWorkspace", () => {
  it("builds an npm profile with only interest-set dependencies at exact versions", () => {
    const root = repo({
      "package.json": { type: "module", dependencies: { [SDK]: "^1.30.0", hono: "^4", "internal-secret-thing": "1.0.0" }, devDependencies: { typescript: "7.0.2" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, [`node_modules/${SDK}`]: { version: "1.30.1" }, "node_modules/hono": { version: "4.13.9" }, "node_modules/internal-secret-thing": { version: "1.0.0" } } },
      ".nvmrc": "v24.1.0\n",
      "tsconfig.json": "{}",
    });
    const { profile, notes } = scan(root);
    expect(profile).toEqual({
      schemaVersion: "1",
      language: "typescript",
      runtime: { name: "node", major: 24 },
      packageManager: { name: "npm", lockfile: "package-lock.json" },
      moduleSystem: "esm",
      dependencies: { [SDK]: "1.30.1", hono: "4.13.9" },
      frameworks: ["hono"],
    });
    expect(notes).toEqual([]);
    expect(JSON.stringify(profile)).not.toContain("internal-secret-thing");
  });

  it("scans the package being changed inside an npm, pnpm or yarn monorepo", () => {
    const npmRoot = repo({
      "package.json": { workspaces: ["packages/*"] },
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "packages/api": {}, [`packages/api/node_modules/${SDK}`]: { version: "1.31.0" }, [`node_modules/${SDK}`]: { version: "1.30.1" } } },
      "packages/api/package.json": { dependencies: { [SDK]: "^1.31.0" } },
      "packages/api/src/index.js": "",
    });
    expect(scan(npmRoot, join(npmRoot, "packages/api/src")).profile).toMatchObject({ language: "javascript", moduleSystem: "cjs", dependencies: { [SDK]: "1.31.0" } });

    const pnpmRoot = repo({
      "package.json": { packageManager: "pnpm@9.12.0" },
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/api:\n    dependencies:\n      '${SDK}':\n        specifier: ^1.30.0\n        version: 1.30.1(zod@4.6.5)\n`,
      "packages/api/package.json": { type: "module", dependencies: { [SDK]: "^1.30.0" } },
    });
    expect(scan(pnpmRoot, join(pnpmRoot, "packages/api")).profile).toMatchObject({ packageManager: { name: "pnpm", lockfile: "pnpm-lock.yaml" }, dependencies: { [SDK]: "1.30.1" } });

    const yarnRoot = repo({
      "package.json": { private: true },
      "yarn.lock": `"${SDK}@^1.30.0":\n  version "1.30.3"\n`,
      "packages/api/package.json": { devDependencies: { [SDK]: "^1.30.0" } },
    });
    expect(scan(yarnRoot, join(yarnRoot, "packages/api")).profile).toMatchObject({ packageManager: { name: "yarn" }, dependencies: { [SDK]: "1.30.3" } });
  });

  it("lets packageManager choose between several lockfiles", () => {
    const root = repo({
      "package.json": { packageManager: "yarn@4.5.0", dependencies: { zod: "^4.0.0" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "node_modules/zod": { version: "4.0.0" } } },
      "yarn.lock": `"zod@npm:^4.0.0":\n  version: 4.6.5\n`,
    });
    expect(scan(root).profile).toMatchObject({ packageManager: { name: "yarn", lockfile: "yarn.lock" }, dependencies: { zod: "4.6.5" } });
  });

  it("resolves nothing, and says so, when lockfiles disagree and packageManager does not choose", () => {
    const zod = (v: string) => ({ lockfileVersion: 3, packages: { "": {}, "node_modules/zod": { version: v } } });
    const both = scan(repo({ "package.json": { dependencies: { zod: "^3.22.0" } }, "package-lock.json": zod("3.25.76"), "yarn.lock": `zod@^3.22.0:\n  version "3.22.0"\n` }));
    expect(both.profile.dependencies).toEqual({});
    expect(both.notes).toContainEqual(expect.stringContaining("lockfiles of yarn, npm are all present"));
    const shrinkwrap = scan(repo({ "package.json": { dependencies: { zod: "^3.22.0" } }, "package-lock.json": zod("3.22.0"), "npm-shrinkwrap.json": zod("3.25.76") }));
    expect(shrinkwrap.profile.dependencies).toEqual({ zod: "3.25.76" });
    expect(shrinkwrap.notes.filter((n) => !n.startsWith("no .nvmrc"))).toEqual([]);
    for (const packageManager of ["pnpm@9.0.0", "bun@1.1.0"]) {
      const named = scan(repo({ "package.json": { packageManager, dependencies: { zod: "^3.22.0" } }, "package-lock.json": zod("3.22.0") }));
      expect(named.profile.dependencies).toEqual({});
      expect(named.notes).toContainEqual(expect.stringContaining("packageManager names a manager whose lockfile is not there"));
    }
  });

  it("looks up only registry ranges, and drops a locked version outside the declared range", () => {
    const root = repo({
      "package.json": { dependencies: { zod: "npm:@acme/zod-fork@^9.0.0", [SDK]: "github:me/typescript-sdk#fix-branch", hono: "^4.0.0" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/zod": { version: "9.1.0" }, [`node_modules/${SDK}`]: { version: "1.30.1" }, "node_modules/hono": { version: "3.12.0" } } },
    });
    const { profile, notes } = scan(root);
    expect(profile.dependencies).toEqual({});
    expect(notes.filter((n) => n.endsWith("does not resolve it to an exact version"))).toHaveLength(3);
    const classic = `zod@file:../zod-local:\n  version "3.22.4"\n\nhono@^4.0.0:\n  version "4.13.9"\n`;
    const yarn = scan(repo({ "package.json": { dependencies: { zod: "file:../zod-local", hono: "^4.0.0" } }, "yarn.lock": classic }));
    expect(yarn.profile.dependencies).toEqual({ hono: "4.13.9" });
    const berry = scan(repo({ "package.json": { dependencies: { hono: "workspace:^" } }, "yarn.lock": `"hono@workspace:^":\n  version: 0.0.0-use.local\n` }));
    expect(berry.profile.dependencies).toEqual({});
  });

  it("never lets the root's install stand in for a package the npm lockfile does not describe", () => {
    const root = repo({
      "package.json": { devDependencies: { zod: "^3.22.0" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/zod": { version: "3.22.4" } } },
      "examples/server/package.json": { dependencies: { zod: "^4.0.0" } },
    });
    const { profile, notes } = scan(root, join(root, "examples/server"));
    expect(profile.dependencies).toEqual({});
    expect(notes).toContainEqual("zod is declared but package-lock.json does not resolve it to an exact version");
  });

  it("reads LTS codenames from .nvmrc, and notes a pin that names no major", () => {
    const pinned = scan(repo({ "package.json": {}, ".nvmrc": "lts/iron\n" }));
    expect(pinned.profile.runtime.major).toBe(20);
    expect(pinned.notes.filter((n) => n.includes("Node"))).toEqual([]);
    const floating = scan(repo({ "package.json": {}, ".nvmrc": "lts/*\n" }));
    expect(floating.profile.runtime.major).toBe(22);
    expect(floating.notes).toContainEqual(".nvmrc or .node-version does not name a Node major, so the running Node 22 is assumed");
    // The nearest pin decides, as nvm does: a package's floating pin is not replaced by the root's number.
    const mono = repo({ "package.json": { workspaces: ["packages/*"] }, ".nvmrc": "18\n", "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "packages/api": {} } }, "packages/api/package.json": {}, "packages/api/.nvmrc": "lts/*\n" });
    const nested = scan(mono, join(mono, "packages/api"));
    expect(nested.profile.runtime.major).toBe(22);
    expect(nested.notes).toContainEqual(expect.stringContaining("does not name a Node major"));
  });

  it("counts a linked tsconfig.json as TypeScript, since it is never read", () => {
    const shared = repo({ "tsconfig.base.json": "{}" });
    const root = repo({ "package.json": {} });
    symlinkSync(join(shared, "tsconfig.base.json"), join(root, "tsconfig.json"));
    expect(scan(root).profile.language).toBe("typescript");
  });

  it("leaves out and notes what it cannot resolve exactly, and never guesses", () => {
    const noLock = repo({ "package.json": { dependencies: { zod: "^4" } } });
    const a = scan(noLock);
    expect(a.profile.dependencies).toEqual({});
    expect(a.notes).toContainEqual(expect.stringContaining("no lockfile"));
    expect(a.notes).toContainEqual(expect.stringContaining("running Node 22"));
    const unresolved = repo({ "package.json": { dependencies: { zod: "^4" } }, "package-lock.json": { lockfileVersion: 3, packages: {} } });
    expect(scan(unresolved).notes).toContainEqual("zod is declared but package-lock.json does not resolve it to an exact version");
  });

  it("refuses symlinks and working directories outside the workspace", () => {
    const outside = repo({ "package.json": { dependencies: {} } });
    const root = repo({ "real.json": "{}" });
    symlinkSync(join(outside, "package.json"), join(root, "package.json"));
    expect(() => scan(root)).toThrow(ScanError);
    const ok = repo({ "package.json": {} });
    expect(() => scan(ok, outside)).toThrow(/outside the workspace/);
  });

  it("refuses a linked package directory, workspace root or lockfile instead of using a parent's", () => {
    const other = repo({ "package.json": { dependencies: { zod: "^4.0.0" } }, "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/zod": { version: "4.6.5" } } } });
    const root = repo({
      "package.json": { dependencies: { zod: "^3.22.0" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "tools/gen": {}, "node_modules/zod": { version: "3.22.4" } } },
      "tools/gen/package.json": { dependencies: { zod: "^4.0.0" } },
    });
    mkdirSync(join(root, "apps"));
    symlinkSync(other, join(root, "apps/api"));
    expect(() => scan(root, join(root, "apps/api"))).toThrow(/apps\/api is a symbolic link/);
    symlinkSync(join(other, "package-lock.json"), join(root, "tools/gen/package-lock.json"));
    expect(() => scan(root, join(root, "tools/gen"))).toThrow(/package-lock.json is a symbolic link/);
    const linkedRoot = join(repo({}), "workspace");
    symlinkSync(other, linkedRoot);
    expect(() => scan(linkedRoot)).toThrow(/the workspace root is a symbolic link/);
  });

  it("reads this repository's own npm lockfile (v3, workspaces)", () => {
    const { profile } = scan(REPO, join(REPO, "apps/server/src"));
    expect(profile.packageManager).toEqual({ name: "npm", lockfile: "package-lock.json" });
    expect(profile.dependencies).toEqual({ [SDK]: "1.30.1", hono: "4.13.9", zod: "4.6.5" });
    expect(profile.frameworks).toEqual(["hono"]);
  });
});

describe("ScanCache", () => {
  it("rescans only when a scanned file changes", () => {
    const root = repo({ "package.json": { dependencies: { zod: "^4.0.0" } }, "package-lock.json": { lockfileVersion: 3, packages: { "node_modules/zod": { version: "4.6.5" } } } });
    const cache = new ScanCache();
    const options = { root, cwd: root, interest: ["zod"], runningNodeMajor: 22 };
    const first = cache.scan(options);
    expect(cache.scan(options)).toBe(first);
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/zod": { version: "4.7.0" } } }));
    utimesSync(join(root, "package-lock.json"), new Date(), new Date(Date.now() + 5000));
    expect(cache.scan(options).profile.dependencies).toEqual({ zod: "4.7.0" });
    expect(cache.scan({ ...options, interest: [] }).profile.dependencies).toEqual({});
  });
});
