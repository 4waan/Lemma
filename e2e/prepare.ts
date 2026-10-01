/**
 * The first step of `npm run e2e`, before any test starts:
 *
 * 1. anvil and forge answer on PATH (Foundry; CI pins 1.7.1);
 * 2. every third-party bytecode fixture matches its sha256 in
 *    e2e/fixtures/provenance.json, and nothing unrecorded sits beside them;
 * 3. `tsc -b` builds the workspaces: the operator scripts the run starts
 *    (warranty-admin, register-agent, setup-roles) import them built;
 * 4. `forge build` compiles the warranty registry (contracts/) and the Stylus
 *    engine's stand-in (e2e/contracts/). FOUNDRY_OFFLINE is passed through, so
 *    a machine without network uses the compilers it has.
 *
 * `--fixtures` runs step 2 alone.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFixtures, readProvenance } from "./fixtures/fixtures.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function fail(message: string): never {
  console.error(`e2e: ${message}`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error !== undefined) fail(`${command} could not start (${(result.error as NodeJS.ErrnoException).code ?? result.error.name})`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}`);
}

const problems = checkFixtures(readProvenance());
if (problems.length > 0) fail(`the bytecode fixtures do not match e2e/fixtures/provenance.json:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
console.log(`e2e: ${readProvenance().files.length} bytecode fixtures match their recorded sha256`);
if (process.argv.includes("--fixtures")) process.exit(0);

for (const tool of ["anvil", "forge"]) {
  const version = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (version.error !== undefined || version.status !== 0) fail(`${tool} is not on PATH: install Foundry (https://getfoundry.sh; CI uses v1.7.1)`);
  console.log(`e2e: ${version.stdout.split("\n")[0]}`);
}

run(join(ROOT, "node_modules", ".bin", "tsc"), ["-b"], ROOT);
run("forge", ["build"], join(ROOT, "contracts"));
run("forge", ["build"], join(ROOT, "e2e", "contracts"));
