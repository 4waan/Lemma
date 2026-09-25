import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { isInside } from "./files.js";
import { REPOSITORY_ROOT } from "./fixture.js";

/**
 * The PATH a run's processes get: the host PATH without relative entries,
 * without package-local `node_modules/.bin` directories (npm prepends the Lemma
 * repository's when the harness runs under `npm run`) and without anything
 * inside the repository, plus the directory of the Node binary running the
 * harness. Fixture commands then resolve the fixture's own tooling, and the
 * repository's location is not handed to the agent.
 */
export function agentPath(hostPath: string, repositoryRoot: string = REPOSITORY_ROOT, nodeDir: string = dirname(process.execPath)): string {
  const out: string[] = [];
  for (const entry of [...hostPath.split(delimiter), nodeDir]) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const dir = resolve(entry);
    if (dir.split(/[\\/]/).includes("node_modules") || isInside(dir, repositoryRoot) || out.includes(dir)) continue;
    out.push(dir);
  }
  return out.join(delimiter);
}

/**
 * The only environment a run's child processes get: the agent SDK process, the
 * acceptance command and setup. The agent's shell tool inherits its process
 * environment, so no credential, Cursor endpoint override or host setting may
 * be in it; the API key reaches the SDK child through stdin instead.
 */
export function childEnv(home: string, path: string = agentPath(process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")): Record<string, string> {
  return {
    PATH: path,
    HOME: home,
    TMPDIR: join(home, "tmp"),
    LANG: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
  };
}

/** A name segment that marks a credential: `GITHUB_TOKEN`, `BUYER_PRIVATE_KEY`, `BUYER_MNEMONIC`, `GH_PAT`, `ETH_PK`, `BASIC_AUTH`, `CI_JOB_JWT`. */
const SECRET_SEGMENT = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE|PRIVKEY|MNEMONIC|PAT|PK|APIKEY|AUTH|AUTHTOKEN|JWT|COOKIE|WEBHOOK)(_|$)/i;
/**
 * Names that are credentials without a segment boundary or segment word:
 * `PGPASSWORD`, `OPENAI_APIKEY`, npm's `_authToken` settings, `MYSQL_PWD` (but
 * not `PWD` or `OLDPWD`), a wallet seed phrase, a password-manager session
 * (`OP_SESSION_<account>`, `BW_SESSION`; terminal session ids such as
 * `WT_SESSION` are not credentials), and an RPC endpoint, whose URL usually
 * embeds the provider key.
 */
const SECRET_NAME = /PASSWORD|PASSWD|APIKEY|AUTHTOKEN|SECRET|SEED_PHRASE|(PRIVATE|WALLET)_SEED|_PWD$|^OP_SESSION_|^BW_SESSION$|RPC_URL$/i;
/**
 * Names that match the patterns above but hold no credential: git's
 * environment config keys (setting names; their `GIT_CONFIG_VALUE_<n>` is
 * still checked by value), public keys and fingerprints, and the desktop
 * session name.
 */
const BENIGN_NAME = /^(GIT_CONFIG_KEY_\d+|GPG_KEY|DESKTOP_SESSION|SSH_AUTH_SOCK|STARSHIP_SESSION_KEY)$|_PUBLIC_KEY$/i;
/** A name that points at a file or directory: benign when its value is one absolute path (the file itself stays readable either way). */
const PATH_NAME = /_(PATH|FILE|DIR)$/i;
/** A URL carrying a password (with or without a user, as in `redis://:pass@host`), or an http(s) URL carrying any userinfo (a token alone, as in `https://<token>@github.com/...`). */
const CREDENTIAL_URL = /^([a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@|https?:\/\/[^/@\s]+@)/i;
/** An HTTP authorization value, as git's `http.extraheader` carries in `GIT_CONFIG_VALUE_<n>`, or one inside `GIT_CONFIG_PARAMETERS`. */
const AUTH_HEADER = /^\s*(authorization:\s*)?(bearer|basic|token)\s+\S|authorization:\s*(bearer|basic|token)\s+\S/i;

function secretName(name: string, value: string): boolean {
  if (!SECRET_SEGMENT.test(name) && !SECRET_NAME.test(name)) return false;
  if (BENIGN_NAME.test(name)) return false;
  return !(PATH_NAME.test(name) && isAbsolute(value) && !/[\s:;,]/.test(value));
}

/**
 * Names of variables in `env` that look like credentials: a secret-like name,
 * a URL carrying credentials, or an authorization header. Agents run
 * unsandboxed as the operator's user, so they can read the environment the
 * harness and its parents started with from `/proc/<pid>/environ`; the harness
 * refuses to run agents while any of these is set (see
 * `ancestorSecretVariables`).
 */
export function secretVariables(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && value !== "" && (secretName(name, value) || CREDENTIAL_URL.test(value) || AUTH_HEADER.test(value)))
    .map(([name]) => name)
    .sort();
}

/** The environment a process started with, or null when it cannot be read (another user's process, or no /proc). */
function startEnvironment(pid: number): Record<string, string> | null {
  try {
    const env: Record<string, string> = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/** The parent of `pid` from /proc, or null. */
function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Credential-like variables in the start environment of `pid` and of every
 * ancestor this user can read. Only ancestors: a shell that started the
 * harness in the background and kept its own copy still holds it, readable by
 * the agent, so run the harness from a session that never had the key. `env -u NAME` removes a variable from the
 * harness only: the shell that ran it keeps it in `/proc/<shell>/environ`,
 * which an agent running as the same user can read. Processes whose
 * environment cannot be read (another user's, or no /proc) are skipped.
 */
export function ancestorSecretVariables(pid: number = process.pid): Array<{ pid: number; names: string[] }> {
  const out: Array<{ pid: number; names: string[] }> = [];
  const seen = new Set<number>();
  for (let current: number | null = pid; current !== null && current > 0 && !seen.has(current); current = parentOf(current)) {
    seen.add(current);
    const env = startEnvironment(current);
    const names = env === null ? [] : secretVariables(env);
    if (names.length > 0) out.push({ pid: current, names });
  }
  return out;
}

/** Process groups that runs started and have not reaped yet. */
const liveGroups = new Set<number>();
/** Home directories of runs in progress. */
const liveHomes = new Set<string>();

/** Kills a process group, ignoring one that is already gone. */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Starts tracking a run's process group; the returned function stops tracking it. */
export function trackGroup(pid: number | undefined): () => void {
  if (pid === undefined) return () => undefined;
  liveGroups.add(pid);
  return () => liveGroups.delete(pid);
}

/** Starts tracking a run's home directory, so an interrupted harness can kill what carries it; the returned function stops tracking it. */
export function trackHome(home: string): () => void {
  liveHomes.add(home);
  return () => liveHomes.delete(home);
}

/** Kills every process tree, group and home-carrying process a run started; the CLI calls it when it is interrupted. */
export function killRunGroups(): void {
  for (const pid of liveGroups) {
    killTree(pid);
    killGroup(pid);
  }
  liveGroups.clear();
  for (const home of liveHomes) killByHome(home);
  liveHomes.clear();
}

/**
 * Kills every process whose start environment has `HOME` set to `home`. Each
 * run gets a home of its own, which everything it starts inherits, so this
 * finds what parent links cannot: a process that was re-parented when the
 * agent's shell or the SDK child exited, or that detached itself (`setsid`,
 * `nohup`, a daemonizing tool). A process that replaced its own environment,
 * or a host without /proc, escapes it.
 */
export function killByHome(home: string): void {
  // Repeated until a pass finds nothing: a process can fork between the scan and its kill.
  for (let pass = 0; pass < 10; pass++) {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return;
    }
    let found = 0;
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      if (startEnvironment(Number(name))?.["HOME"] !== home) continue;
      try {
        process.kill(Number(name), "SIGKILL");
        found++;
      } catch {
        // Already gone.
      }
    }
    if (found === 0) return;
  }
}

/** Parent of every visible process: from /proc where there is one, else from `ps`. */
function parentTable(): Map<number, number> {
  const table = new Map<number, number>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // The command name is parenthesized and may hold spaces; the parent pid is the second field after it.
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (Number.isInteger(ppid)) table.set(Number(name), ppid);
      } catch {
        // The process exited while we looked.
      }
    }
    if (table.size > 0) return table;
  } catch {
    // No /proc: fall back to ps.
  }
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
  }
  return table;
}

/** Every live descendant of `root`, found through parent links. */
export function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentTable()) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      if (out.includes(child)) continue;
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Kills every descendant of `root`, and `root` too unless told otherwise. The
 * agent SDK starts its shells in process groups of their own, so killing the
 * run's group alone would leave a server the agent started running into the
 * next run. Descendants are found while `root` is alive; a process that has
 * already been re-parented away from the tree is out of reach.
 */
export function killTree(root: number, options: { includeRoot?: boolean } = {}): void {
  for (const pid of [...descendants(root), ...(options.includeRoot === false ? [] : [root])]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface CommandResult {
  /** Null when the command was killed (timeout or signal) or could not start. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * Runs argv without a shell, in its own process group so a timeout kills the
 * whole tree; whatever the command leaves running in its group is killed when
 * it ends. Output is discarded: the harness keeps no command output, which
 * could carry paths or credentials.
 */
export function runCommand(argv: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutSec: number }): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (command === undefined) return Promise.reject(new Error("empty argv"));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "ignore", detached: true, shell: false });
    const untrack = trackGroup(child.pid);
    let timedOut = false;
    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      untrack();
      resolve({ exitCode, timedOut, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      killGroup(child.pid);
    }, options.timeoutSec * 1000);
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(timedOut ? null : code));
  });
}
