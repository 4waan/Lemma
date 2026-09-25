import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AdoptionReceipt, adoptionReceiptDigest, fileDigest } from "@lemma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_ACCEPTANCE_OUTPUT, acceptanceEnv, acceptanceScriptMissing, commandDir, minimalPath, offlineArgv, offlineAvailable, offlineTools, receiptFor, runAcceptance } from "../src/index.js";
import { ID, NOW, removeTemps, temp, tree } from "./fixtures.js";

afterEach(removeTemps);

describe("acceptance", () => {
  const recipe = { script: "test", args: [], timeoutSec: 30, env: ["CI" as const, "NODE_ENV" as const] };

  it("passes only the listed variables, with a minimal PATH, a fresh HOME, and the user's corepack cache without downloads", () => {
    const env = acceptanceEnv(recipe, "/tmp/h", { CI: "1", NODE_ENV: undefined, CURSOR_API_KEY: "secret", PATH: "/evil", NO_COLOR: "1", HOME: "/home/u" }, "/usr/bin");
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/tmp/h", COREPACK_HOME: "/home/u/.cache/node/corepack", COREPACK_ENABLE_NETWORK: "0", CI: "1" });
    // Where corepack itself would look: COREPACK_HOME, else under XDG_CACHE_HOME.
    expect(acceptanceEnv(recipe, "/tmp/h", { HOME: "/home/u", XDG_CACHE_HOME: "/cache" })["COREPACK_HOME"]).toBe("/cache/node/corepack");
    expect(acceptanceEnv(recipe, "/tmp/h", { HOME: "/home/u", XDG_CACHE_HOME: "/cache", COREPACK_HOME: "/cp" })["COREPACK_HOME"]).toBe("/cp");
  });

  it("runs without a shell in the scrubbed environment, and digests capped output", async () => {
    const dir = tree({ "check.mjs": 'import { writeFileSync, writeSync } from "node:fs";\nwriteFileSync("env.json", JSON.stringify(Object.keys(process.env).sort()));\nwriteSync(1, "x".repeat(2 * 1024 * 1024));\nprocess.exitCode = 3;\n' });
    const run = await runAcceptance([process.execPath, "check.mjs"], { cwd: dir, recipe, host: { CI: "1", SECRET_TOKEN: "t" } });
    expect(run).toMatchObject({ exitCode: 3, timedOut: false, truncated: true });
    expect(run.outputDigest).toBe(fileDigest(Buffer.alloc(MAX_ACCEPTANCE_OUTPUT, "x")));
    expect(JSON.parse(readFileSync(join(dir, "env.json"), "utf8"))).toEqual(["CI", "COREPACK_ENABLE_NETWORK", "COREPACK_HOME", "HOME", "PATH"]);
  });

  it("reports a command that could not start as not started, never as a failed test", async () => {
    const run = await runAcceptance(["lemma-no-such-command-xyz", "run", "test"], { cwd: temp("lemma-acc-"), recipe });
    expect(run).toMatchObject({ started: false, notStarted: "command-not-found", outputDigest: null });
  });

  it("finds the package manager on the bridge's PATH and runs it from there", async () => {
    const bin = temp("lemma-bin-");
    writeFileSync(join(bin, "fakepm"), '#!/bin/sh\n[ "$1" = --version ] && exit 0\necho "$0 $*" > used.txt\n');
    chmodSync(join(bin, "fakepm"), 0o755);
    expect(commandDir("fakepm", `/nonexistent:${bin}`)).toBe(bin);
    expect(minimalPath("/node", [bin]).split(":")).toEqual(["/node", bin, "/usr/local/bin", "/usr/bin", "/bin"]);
    const dir = temp("lemma-acc-");
    expect(await runAcceptance(["fakepm", "run", "test"], { cwd: dir, recipe, host: { PATH: `/nonexistent:${bin}` } })).toMatchObject({ started: true, exitCode: 0 });
    expect(readFileSync(join(dir, "used.txt"), "utf8").trim()).toBe(`${join(bin, "fakepm")} run test`);
  });

  it("tells a package without the recipe's script, or with only npm's placeholder, from one with it", () => {
    const pkg = (scripts: unknown) => tree({ "package.json": JSON.stringify({ scripts }) });
    expect(acceptanceScriptMissing(pkg({ build: "tsc" }), "test")).toBe(true);
    expect(acceptanceScriptMissing(pkg({ test: 'echo "Error: no test specified" && exit 1' }), "test")).toBe(true);
    expect(acceptanceScriptMissing(pkg({ test: " " }), "test")).toBe(true);
    expect(acceptanceScriptMissing(tree({ "package.json": "{ broken" }), "test")).toBe(true);
    expect(acceptanceScriptMissing(pkg({ test: "vitest run" }), "test")).toBe(false);
    expect(acceptanceScriptMissing(pkg({ "test:lemma": "vitest run lemma" }), "test:lemma")).toBe(false);
  });

  it("runs offline tools by their paths, the argv as arguments, and reports on fd 3 how far the wrapper got", async () => {
    const tools = { unshare: "/usr/bin/unshare", sh: "/bin/sh", ip: "/usr/sbin/ip" };
    const argv = offlineArgv(["npm", "run", "test", "--", "a;b"], tools);
    expect(argv.slice(0, 5)).toEqual(["/usr/bin/unshare", "--map-root-user", "--net", "/bin/sh", "-c"]);
    expect(argv.slice(6)).toEqual(["/usr/sbin/ip", "npm", "run", "test", "--", "a;b"]);
    expect(offlineAvailable({ ...tools, ip: join(temp("lemma-ip-"), "missing-ip") })).toBe(false);
    // Found on the bridge's PATH or where systems keep them; missing ones make offline mode unavailable.
    expect(offlineTools("/nonexistent")?.sh).toMatch(/\/sh$/);
    // The wrapper's shell step, run here without a namespace: "n" once loopback is up, "x" just before the command, and fd 3 closed for it.
    const { spawnSync } = await import("node:child_process");
    const bin = temp("lemma-ip-");
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
      return join(bin, name);
    };
    const wrapper = (ip: string, command: readonly string[]) => {
      const [, , , sh, ...rest] = offlineArgv(command, { ...tools, ip });
      const run = spawnSync(sh as string, rest, { stdio: ["ignore", "pipe", "ignore", "pipe"] });
      return { status: run.status, marks: String(run.output[3]), out: String(run.output[1]) };
    };
    const up = script("ip-up", "exit 0");
    const down = script("ip-down", "exit 1");
    const fds = script("fds", "ls /proc/$$/fd; exit 7");
    const ran = wrapper(up, [fds]);
    expect(ran).toMatchObject({ status: 7, marks: "nx" });
    expect(ran.out.split("\n")).not.toContain("3");
    expect(wrapper(down, [fds])).toMatchObject({ status: 125, marks: "" });
    expect(wrapper(up, ["lemma-no-such-command-xyz"])).toMatchObject({ status: 127, marks: "n" });
  });

  const tools = offlineTools();
  it.skipIf(!offlineAvailable(tools))("runs offline with loopback working and the network gone, and never records the wrapper's own failures as tests", async () => {
    const loopback = 'const n=require("net");const s=n.createServer((c)=>c.end()).listen(0,"127.0.0.1",()=>n.connect(s.address().port,"127.0.0.1",()=>process.exit(0)).on("error",()=>process.exit(3)))';
    expect(await runAcceptance([process.execPath, "-e", loopback], { cwd: temp("lemma-acc-"), recipe, offline: true })).toMatchObject({ started: true, exitCode: 0 });
    const network = 'require("net").connect(443,"1.1.1.1",()=>process.exit(0)).on("error",()=>process.exit(4))';
    expect(await runAcceptance([process.execPath, "-e", network], { cwd: temp("lemma-acc-"), recipe, offline: true })).toMatchObject({ started: true, exitCode: 4 });
    // A manager missing from the namespace's PATH did not start; it is not a manager that fails.
    expect(await runAcceptance(["lemma-no-such-command-xyz", "run", "test"], { cwd: temp("lemma-acc-"), recipe, offline: true })).toMatchObject({ started: false, notStarted: "command-not-found" });
    // ip works for the checks and fails at the run itself: no test ran, so nothing is recorded.
    const bin = temp("lemma-ip-");
    writeFileSync(join(bin, "ip"), `#!/bin/sh\nn=$(cat ${bin}/count 2>/dev/null || echo 0)\necho $((n + 1)) > ${bin}/count\n[ "$n" -ge 2 ] && exit 1\nexec ${tools?.ip} "$@"\n`);
    chmodSync(join(bin, "ip"), 0o755);
    expect(await runAcceptance([process.execPath, "-e", "process.exit(0)"], { cwd: temp("lemma-acc-"), recipe, offline: true, tools: { ...(tools as NonNullable<typeof tools>), ip: join(bin, "ip") } })).toMatchObject({ started: false, notStarted: "offline-unavailable" });
    expect(readFileSync(join(bin, "count"), "utf8")).toBe("3\n");
  });

  it("counts a package manager that does not run in the acceptance environment as not started", async () => {
    const bin = temp("lemma-bin-");
    writeFileSync(join(bin, "fakepm"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(bin, "fakepm"), 0o755);
    const run = await runAcceptance(["fakepm", "run", "test"], { cwd: temp("lemma-acc-"), recipe, host: { PATH: bin } });
    expect(run).toMatchObject({ started: false, notStarted: "manager-unusable" });
  });

  it("stops a run at its timeout and records it as a failure without an exit code", async () => {
    const dir = tree({ "hang.mjs": "setInterval(() => {}, 1000);\n" });
    const run = await runAcceptance([process.execPath, "hang.mjs"], { cwd: dir, recipe: { ...recipe, timeoutSec: 1 } });
    expect(run).toMatchObject({ exitCode: null, timedOut: true });
    const receipt = receiptFor(ID, run, NOW);
    expect(AdoptionReceipt.parse(receipt)).toMatchObject({ outcome: "failed", acceptance: { exitCode: null } });
  });

  it("measures a run on the monotonic clock, so a wall-clock step back never breaks its receipt", async () => {
    const wall = vi.spyOn(Date, "now");
    let now = Date.now();
    wall.mockImplementation(() => (now -= 3_600_000));
    try {
      const run = await runAcceptance([process.execPath, "-e", "setTimeout(() => {}, 50)"], { cwd: temp("lemma-acc-"), recipe });
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(AdoptionReceipt.safeParse(receiptFor(ID, run, NOW)).success).toBe(true);
    } finally {
      wall.mockRestore();
    }
  });

  it("builds a receipt that parses, with a stable digest", async () => {
    const run = { started: true, notStarted: null, exitCode: 0, timedOut: false, durationMs: 1234, outputDigest: fileDigest("ok"), truncated: false };
    const a = receiptFor(ID, run, NOW);
    expect(AdoptionReceipt.parse(a)).toEqual(a);
    expect(adoptionReceiptDigest(a)).toBe(adoptionReceiptDigest(receiptFor(ID, run, NOW)));
    expect(a.outcome).toBe("passed");
  });
});
