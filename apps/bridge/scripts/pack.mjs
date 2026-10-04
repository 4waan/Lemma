// Packs the bridge for one-command installs: `npx -y <server>/dl/lemma-mcp-<version>.tgz`.
//
// Bundles the built bridge (dist/main.js and dist/signer/main.js, so run `tsc -b` first) with
// every dependency into two self-contained files, adds the agent rule they install, and packs
// them as a package with no dependencies into apps/bridge/pack/out/, which the server serves
// under /dl/. Nothing here touches signing or payments: the bundle is the same code.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(bridgeDir, "../..");
const stage = join(bridgeDir, "pack", "stage");
const out = join(bridgeDir, "pack", "out");
const { version } = JSON.parse(readFileSync(join(bridgeDir, "package.json"), "utf8"));

// The server the package is served from, when the build knows it (PUBLIC_BASE_URL, an https origin):
// the bridge then reaches that server without LEMMA_API_URL, which an install link cannot always pass.
const publicBase = process.env["PUBLIC_BASE_URL"] ?? "";
const bundledApiUrl = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(publicBase.replace(/\/+$/, "")) ? publicBase.replace(/\/+$/, "") : undefined;
const define = bundledApiUrl === undefined ? {} : { "process.env.LEMMA_BUNDLED_API_URL": JSON.stringify(bundledApiUrl) };

rmSync(join(bridgeDir, "pack"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Each entry keeps its own shebang; the banner gives bundled CommonJS dependencies a require.
for (const [entry, file] of [
  ["dist/main.js", "lemma-mcp.mjs"],
  ["dist/signer/main.js", "lemma-signer.mjs"],
]) {
  await build({
    entryPoints: [join(bridgeDir, entry)],
    outfile: join(stage, "dist", file),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
    define,
    banner: { js: 'import { createRequire as __lemmaCreateRequire } from "node:module"; const require = __lemmaCreateRequire(import.meta.url);' },
  });
}
// rule.ts reads ../rules/lemma.mdc next to its own file, which is dist/ in the package.
cpSync(join(bridgeDir, "rules"), join(stage, "rules"), { recursive: true });

const pkg = {
  name: "lemma-mcp",
  version,
  description: "Lemma's local MCP bridge for coding agents, and its buyer signer.",
  type: "module",
  bin: { "lemma-mcp": "dist/lemma-mcp.mjs", "lemma-signer": "dist/lemma-signer.mjs" },
  files: ["dist", "rules"],
  engines: { node: ">=22" },
  license: "MIT",
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

// --workspaces=false: the stage directory sits inside the monorepo but is not a workspace.
execFileSync("npm", ["pack", "--pack-destination", out, "--workspaces=false"], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
rmSync(stage, { recursive: true, force: true });

const tgz = join(out, `lemma-mcp-${version}.tgz`);
console.log(`packed ${relative(repoRoot, tgz)} (${(statSync(tgz).size / 1024).toFixed(0)} KiB), default server ${bundledApiUrl ?? "http://localhost:3000"}`);
