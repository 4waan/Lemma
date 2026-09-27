import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { confineTools, confinedArgv, confinedNotStarted, confinementAvailable, hiddenDirs, runAcceptance } from "../src/index.js";
import { removeTemps, temp } from "./fixtures.js";

afterEach(removeTemps);

const recipe = { script: "test", args: [], timeoutSec: 30, env: [] };
// Only where Linux user namespaces work (not macOS, not a restricted userns).
const confinable = await confinementAvailable(confineTools());
const tools = { unshare: "/usr/bin/unshare", sh: "/bin/sh", mount: "/usr/bin/mount", ip: "/usr/sbin/ip" };

describe("confinement", () => {
  it("starts the command in new user, mount and PID namespaces, with every path and the argv as arguments", () => {
    const argv = confinedArgv(["npm", "run", "test", "--", "a;b"], tools, { hide: ["/state dir", "/sock"], offline: false });
    expect(argv.slice(0, 9)).toEqual(["/usr/bin/unshare", "--map-root-user", "--mount", "--pid", "--fork", "--kill-child", "--mount-proc", "/bin/sh", "-c"]);
    expect(argv.slice(10)).toEqual(["/usr/bin/mount", "/usr/bin/unshare", "", "2", "/state dir", "/sock", "npm", "run", "test", "--", "a;b"]);
    // Offline adds the network namespace and names ip.
    const offline = confinedArgv(["npm"], tools, { hide: ["/s"], offline: true });
    expect(offline).toContain("--net");
    expect(offline.slice(-4)).toEqual(["/usr/sbin/ip", "1", "/s", "npm"]);
    expect(() => confinedArgv(["npm"], { ...tools, ip: undefined }, { hide: [], offline: true })).toThrow(/ip/);
  });

  it("hides existing directories only, never the one holding the package, and nothing twice", () => {
    const state = temp("lemma-state-");
    mkdirSync(join(state, "signer"));
    const other = temp("lemma-other-");
    const pkg = join(other, "pkg");
    mkdirSync(pkg);
    expect(hiddenDirs([state, join(state, "signer"), state, join(state, "missing")], pkg)).toEqual([state]);
    expect(hiddenDirs([other, state], pkg)).toEqual([state]);
    expect(hiddenDirs([pkg], pkg)).toEqual([]);
  });

  it("tells a wrapper that failed from a command that was not found", () => {
    expect(confinedNotStarted("", false)).toBe("confinement-failed");
    expect(confinedNotStarted("m", true)).toBe("offline-unavailable");
    expect(confinedNotStarted("m", false)).toBe("command-not-found");
    expect(confinedNotStarted("mn", true)).toBe("command-not-found");
  });

  it("runs unconfined, as before, with confinement turned off", async () => {
    const hidden = temp("lemma-hidden-");
    writeFileSync(join(hidden, "claim"), "secret");
    const dir = temp("lemma-pkg-");
    writeFileSync(join(dir, "t.mjs"), `import { existsSync } from "node:fs"; process.exit(existsSync(${JSON.stringify(join(hidden, "claim"))}) ? 0 : 1);`);
    const run = await runAcceptance([process.execPath, "t.mjs"], { cwd: dir, recipe, hide: [hidden], confine: false, checkManager: false });
    expect(run).toMatchObject({ started: true, exitCode: 0, confined: false });
  });

  it.skipIf(!confinable)("keeps a release's tests from the hidden directories, other processes and the machine after they end", async () => {
    const hidden = temp("lemma-hidden-");
    writeFileSync(join(hidden, "claim"), "secret");
    const dir = temp("lemma-pkg-");
    const marker = join(dir, "escaped");
    // What a hostile test tries: read the hidden claim, list the hidden directory, find the bridge among the processes,
    // unmount the cover, and leave a detached process behind to act after the run.
    writeFileSync(
      join(dir, "t.mjs"),
      `import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const seen = [];
if (existsSync(${JSON.stringify(join(hidden, "claim"))})) seen.push("claim");
if (readdirSync(${JSON.stringify(hidden)}).length > 0) seen.push("listing");
if (existsSync("/proc/${process.pid}")) seen.push("bridge");
spawnSync("umount", [${JSON.stringify(hidden)}]);
if (existsSync(${JSON.stringify(join(hidden, "claim"))})) seen.push("unmounted");
spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500)`)}], { detached: true, stdio: "ignore" }).unref();
writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify(seen));
process.exit(seen.length === 0 ? 0 : 1);`,
    );
    const run = await runAcceptance([process.execPath, "t.mjs"], { cwd: dir, recipe, hide: [hidden], checkManager: false });
    expect(run).toMatchObject({ started: true, exitCode: 0, confined: true });
    await new Promise((r) => setTimeout(r, 2500));
    expect(await import("node:fs").then((fs) => fs.existsSync(marker))).toBe(false);
    // The package directory itself stays the tests' own.
    expect(await import("node:fs").then((fs) => JSON.parse(fs.readFileSync(join(dir, "seen.json"), "utf8")))).toEqual([]);
  });
});
