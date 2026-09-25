import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";

import { type AcceptanceRecipe, type AdoptionReceipt, type Hex32, fileDigest } from "@lemma/core";

/** Acceptance output kept for its digest; beyond this, output is drained and dropped. */
export const MAX_ACCEPTANCE_OUTPUT = 1024 * 1024;
const MAX_DURATION_MS = 24 * 3600 * 1000;
/** How long `<manager> --version` may take before the manager counts as unusable. */
const MANAGER_CHECK_MS = 20_000;

/** Why an acceptance run did not start: no test ran, so there is no result and no receipt. */
export type NotStarted = "command-not-found" | "manager-unusable" | "offline-unavailable";

export interface AcceptanceRun {
  /** False when the command never ran: that is no test result, and no receipt. */
  readonly started: boolean;
  readonly notStarted: NotStarted | null;
  /** Null when the run did not finish: a timeout or a signal. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Digest of the first MAX_ACCEPTANCE_OUTPUT bytes of stdout and stderr as they arrived; null if nothing ran. */
  readonly outputDigest: Hex32 | null;
  readonly truncated: boolean;
}

/** The PATH an acceptance run gets: the Node running the bridge, the package manager's own directory, then the usual system directories. */
export function minimalPath(nodeDir: string = dirname(process.execPath), extra: readonly string[] = []): string {
  return [...new Set([nodeDir, ...extra, "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
}

/** The directory holding an executable `name` on `searchPath` (the bridge's PATH), so pnpm or yarn installed elsewhere is found. */
export function commandDir(name: string, searchPath: string = process.env["PATH"] ?? ""): string | undefined {
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return dir;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/**
 * The whole environment of an acceptance run: a minimal PATH, a fresh HOME,
 * the user's corepack cache with corepack's downloads off (so a corepack shim
 * runs a package manager the user already has, and fails fast rather than
 * downloading one), and only the variables the recipe lists (core
 * ACCEPTANCE_ENV), passed through from the bridge's environment when set
 * there. No credential, proxy or registry setting reaches the tests.
 */
export function acceptanceEnv(recipe: AcceptanceRecipe, home: string, host: NodeJS.ProcessEnv = process.env, path: string = minimalPath()): Record<string, string> {
  const env: Record<string, string> = { PATH: path, HOME: home, COREPACK_HOME: corepackHome(host), COREPACK_ENABLE_NETWORK: "0" };
  for (const name of recipe.env) {
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Where corepack keeps this user's package managers: COREPACK_HOME, else its default under the user's cache directory. */
function corepackHome(host: NodeJS.ProcessEnv): string {
  const absolute = (value: string | undefined) => (value !== undefined && isAbsolute(value) ? value : undefined);
  return absolute(host["COREPACK_HOME"]) ?? join(absolute(host["XDG_CACHE_HOME"]) ?? join(absolute(host["HOME"]) ?? homedir(), ".cache"), "node", "corepack");
}

/**
 * Whether a package lacks the script its acceptance recipe runs, or has only
 * the placeholder `npm init` writes: the package manager would then fail
 * before any test ran, which is no result about the resolution.
 */
export function acceptanceScriptMissing(packageDir: string, script: string): boolean {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { scripts?: unknown }).scripts;
  } catch {
    return true;
  }
  const command = typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>)[script] : undefined;
  return typeof command !== "string" || command.trim() === "" || command.trim() === 'echo "Error: no test specified" && exit 1';
}

/** The tools offline mode runs by absolute path, found once on the bridge's PATH and where systems keep them, never on the acceptance PATH. */
export interface OfflineTools {
  readonly unshare: string;
  readonly sh: string;
  /** Often in /usr/sbin or /sbin, outside any user's PATH. */
  readonly ip: string;
}

/** The offline tools on this system, or undefined when one is missing. */
export function offlineTools(searchPath: string = process.env["PATH"] ?? ""): OfflineTools | undefined {
  const find = (name: string) => {
    const dir = commandDir(name, [searchPath, "/usr/sbin", "/sbin", "/usr/bin", "/bin"].join(delimiter));
    return dir === undefined ? undefined : join(dir, name);
  };
  const [unshare, sh, ip] = [find("unshare"), find("sh"), find("ip")];
  return unshare === undefined || sh === undefined || ip === undefined ? undefined : { unshare, sh, ip };
}

/**
 * The shell step offline mode runs inside the new namespace: loopback up (by
 * the absolute `ip` path, so tests that listen on localhost still work), then
 * the command looked up. Each is reported on fd 3, "n" once the network is
 * ready and "x" just before the tests start, and fd 3 is closed before they
 * do. A run that never reported "x" never started: its exit code is the
 * wrapper's (unshare's, 125 for loopback, 127 for the command), not a test
 * result.
 */
const OFFLINE_SCRIPT = '"$0" link set lo up || exit 125; printf n >&3; command -v "$1" >/dev/null || exit 127; printf x >&3; exec 3>&-; exec "$@"';

/** The argv offline mode runs: a new network namespace and `OFFLINE_SCRIPT`, every tool by absolute path. The recipe's argv is passed as arguments (`"$@"`), never interpolated into the shell text. */
export function offlineArgv(argv: readonly string[], tools: OfflineTools): string[] {
  return [tools.unshare, "--map-root-user", "--net", tools.sh, "-c", OFFLINE_SCRIPT, tools.ip, ...argv];
}

/** Why an offline wrapper that never reported "x" did not start the command. */
function offlineNotStarted(marks: string): NotStarted {
  return marks.includes("n") ? "command-not-found" : "offline-unavailable";
}

/** A connection to itself over loopback: exits 0 only when 127.0.0.1 carries traffic (a listen alone succeeds with loopback down). */
const LOOPBACK_PROBE = 'const n=require("net");const s=n.createServer((c)=>c.end()).on("error",()=>process.exit(1)).listen(0,"127.0.0.1",()=>n.connect(s.address().port,"127.0.0.1",()=>process.exit(0)).on("error",()=>process.exit(1)))';

/**
 * Whether offline mode can run here: Linux, the tools, an unprivileged
 * network namespace, and loopback that comes up inside it (checked by a
 * connection over 127.0.0.1 there).
 */
export function offlineAvailable(tools: OfflineTools | undefined = offlineTools()): boolean {
  if (process.platform !== "linux" || tools === undefined) return false;
  const [file, ...args] = offlineArgv([process.execPath, "-e", LOOPBACK_PROBE], tools);
  const probe = spawnSync(file as string, args, { stdio: ["ignore", "ignore", "ignore", "pipe"], timeout: 10_000 });
  return probe.status === 0 && String(probe.output[3] ?? "") === "nx";
}

/**
 * Whether the package manager runs at all in the acceptance environment
 * (`<manager> --version`, inside the namespace too when the tests will be). A
 * corepack shim for a version corepack has not downloaded, for example, fails
 * here rather than as a failed test.
 */
function managerRuns(manager: string, cwd: string, env: Record<string, string>, tools: OfflineTools | undefined): Promise<"ok" | NotStarted> {
  const [file, ...args] = tools === undefined ? [manager, "--version"] : offlineArgv([manager, "--version"], tools);
  return new Promise((resolve) => {
    const child = spawn(file as string, args, { cwd, env, shell: false, detached: true, stdio: tools === undefined ? "ignore" : ["ignore", "ignore", "ignore", "pipe"] });
    let marks = "";
    (child.stdio[3] as Readable | null | undefined)?.on("data", (chunk: Buffer) => (marks += chunk.toString()));
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, MANAGER_CHECK_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve("command-not-found");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (tools !== undefined && !marks.includes("x")) resolve(offlineNotStarted(marks));
      else resolve(code === 0 ? "ok" : "manager-unusable");
    });
  });
}

/**
 * Runs an acceptance argv (core `acceptanceArgv`) without a shell, in its own
 * process group, with a fresh temporary HOME that is removed afterwards. Past
 * `timeoutSec` the whole group is killed; anything it leaves running is killed
 * when it ends. Output is only digested, never shown to the agent.
 *
 * The package manager is checked first (`checkManager`): one that is missing,
 * or does not run in this environment, means the run did not start, which is
 * never recorded as a failed test.
 *
 * `offline` (Linux, opt-in) runs it in a new network namespace through
 * `unshare`, with loopback up, so tests cannot reach the network; where that
 * is not available, or the namespace or loopback fails at the run itself,
 * the run did not start rather than fail. Without it the
 * network stays reachable: dependencies are installed by then, but a test
 * could still call out. Either way the tests run as this user and can read
 * what this user can, including the bridge's environment in /proc: keep
 * wallet keys out of it.
 */
export async function runAcceptance(
  argv: readonly string[],
  /** `tools`: the offline tools to use, found on this system by default. */
  options: { cwd: string; recipe: AcceptanceRecipe; offline?: boolean; host?: NodeJS.ProcessEnv; checkManager?: boolean; tools?: OfflineTools },
): Promise<AcceptanceRun> {
  const notStarted = (reason: NotStarted): AcceptanceRun => ({ started: false, notStarted: reason, exitCode: null, timedOut: false, durationMs: 0, outputDigest: null, truncated: false });
  const tools = options.offline === true ? (options.tools ?? offlineTools(options.host?.["PATH"])) : undefined;
  if (options.offline === true && (tools === undefined || !offlineAvailable(tools))) return notStarted("offline-unavailable");
  // The package manager is run by the absolute path found on the bridge's PATH, so nothing earlier on the acceptance PATH (the Node directory) can stand in for it.
  const managerDir = argv[0] === undefined || argv[0].includes("/") ? undefined : commandDir(argv[0], options.host?.["PATH"] ?? process.env["PATH"]);
  const command = managerDir === undefined ? [...argv] : [join(managerDir, argv[0] as string), ...argv.slice(1)];
  const home = mkdtempSync(join(tmpdir(), "lemma-acceptance-"));
  const env = acceptanceEnv(options.recipe, home, options.host, minimalPath(undefined, managerDir === undefined ? [] : [managerDir]));
  if (options.checkManager !== false && command[0] !== undefined) {
    const runs = await managerRuns(command[0], options.cwd, env, tools);
    if (runs !== "ok") {
      removeQuietly(home);
      return notStarted(runs);
    }
  }
  const [file, ...args] = tools === undefined ? command : offlineArgv(command, tools);
  const started = performance.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let marks = "";
    const child = spawn(file as string, args, { cwd: options.cwd, env, shell: false, detached: true, stdio: tools === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe"] });
    (child.stdio[3] as Readable | null | undefined)?.on("data", (chunk: Buffer) => (marks += chunk.toString()));
    const keep = (chunk: Buffer) => {
      const room = MAX_ACCEPTANCE_OUTPUT - kept;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) truncated = true;
      const part = chunk.subarray(0, room);
      chunks.push(part);
      kept += part.length;
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.recipe.timeoutSec * 1000);
    const finish = (exitCode: number | null, ran: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      // Offline, the tests ran only if the wrapper reported starting them; an exit before that is the wrapper's, not a test result.
      if (!ran) resolve(notStarted("command-not-found"));
      else if (tools !== undefined && !marks.includes("x")) resolve(notStarted(offlineNotStarted(marks)));
      else {
        // Measured on the monotonic clock: a wall-clock step never makes a duration negative.
        const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, Math.round(performance.now() - started)));
        resolve({ started: true, notStarted: null, exitCode: timedOut ? null : exitCode, timedOut, durationMs, outputDigest: fileDigest(Buffer.concat(chunks)), truncated });
      }
      removeQuietly(home);
    };
    let exited: number | null = null;
    child.on("error", () => finish(null, false));
    // Something the tests started may keep the output pipes open after they exit: kill the group, then stop waiting.
    child.on("exit", (code, signal) => {
      exited = signal === null ? code : null;
      killGroup();
      setTimeout(() => finish(exited, true), 2000).unref();
    });
    child.on("close", (code, signal) => finish(signal === null ? code : null, true));
  });
}

/** Removes the temporary HOME. Never throws: it may run in a child handler, where a throw would take the bridge down, and a leftover temp dir is harmless. */
function removeQuietly(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Left for the OS temp cleanup.
  }
}

/** The unsigned receipt for an acceptance run that started. A run that did not finish is a failure with no exit code. */
export function receiptFor(resolutionId: Hex32, run: AcceptanceRun, now: Date): AdoptionReceipt {
  return {
    schemaVersion: "1",
    resolutionId,
    outcome: run.exitCode === 0 ? "passed" : "failed",
    acceptance: { exitCode: run.exitCode === null ? null : Math.min(255, Math.max(0, run.exitCode)), durationMs: run.durationMs, outputDigest: run.outputDigest },
    recordedAt: now.toISOString(),
    signature: null,
  };
}
