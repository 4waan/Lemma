import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { clean } from "semver";

import { WALLET_SECRET } from "./secrets.js";

/** How the buyer's project installs dependencies. */
export interface InstallTarget {
  readonly packageManager: "npm" | "pnpm" | "yarn";
  /** The package the bundle applies to. */
  readonly packageDir: string;
  /** Where its lockfile is: the package itself, or the root of its monorepo. */
  readonly lockDir: string;
}

export interface InstallCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
}

/** Yarn 2+ (berry) keeps `.yarnrc.yml` and a `__metadata` block; classic yarn has neither. */
export function isYarnBerry(lockDir: string): boolean {
  if (existsSync(join(lockDir, ".yarnrc.yml"))) return true;
  try {
    return /^__metadata:/m.test(readFileSync(join(lockDir, "yarn.lock"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * The commands that apply a bundle's dependency changes, with lifecycle
 * scripts disabled: `--ignore-scripts` for npm, pnpm and classic yarn, and
 * `--mode=skip-build` plus `YARN_ENABLE_SCRIPTS=false` for yarn berry, which
 * has no such flag. pnpm also skips `.pnpmfile.cjs`, which runs code. An exact
 * version (`1.2.3`, `=1.2.3`, `v1.2.3`) is saved exactly on npm too
 * (`--save-exact`), as pnpm and yarn already do. In a monorepo the change lands in the package's own
 * package.json.
 */
export function installCommands(target: InstallTarget, dependencies: Readonly<Record<string, string>>, devDependencies: Readonly<Record<string, string>>): InstallCommand[] {
  const rel = relative(target.lockDir, target.packageDir).split(sep).join("/");
  const commands: InstallCommand[] = [];
  for (const [deps, dev] of [[dependencies, false], [devDependencies, true]] as const) {
    const entries = Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1));
    const specs = entries.map(([name, range]) => `${name}@${range}`);
    if (specs.length === 0) continue;
    if (target.packageManager === "npm") {
      // npm would save an exact version as a caret range; exact ones are installed on their own with --save-exact.
      const exact = entries.filter(([, range]) => clean(range) !== null).map(([name, range]) => `${name}@${range}`);
      const ranged = specs.filter((spec) => !exact.includes(spec));
      for (const [group, pin] of [[ranged, false], [exact, true]] as const) {
        if (group.length === 0) continue;
        commands.push({ cwd: target.lockDir, argv: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", dev ? "--save-dev" : "--save", ...(pin ? ["--save-exact"] : []), ...(rel === "" ? [] : ["--workspace", rel]), ...group] });
      }
    } else if (target.packageManager === "pnpm") {
      const workspaceRoot = existsSync(join(target.packageDir, "pnpm-workspace.yaml"));
      commands.push({ cwd: target.packageDir, argv: ["pnpm", "add", "--ignore-scripts", "--ignore-pnpmfile", ...(dev ? ["--save-dev"] : []), ...(workspaceRoot ? ["--workspace-root"] : []), ...specs] });
    } else if (isYarnBerry(target.lockDir)) {
      commands.push({ cwd: target.packageDir, argv: ["yarn", "add", "--mode=skip-build", ...(dev ? ["--dev"] : []), ...specs] });
    } else {
      const workspaceRoot = rel === "" && hasWorkspaces(target.packageDir);
      commands.push({ cwd: target.packageDir, argv: ["yarn", "add", "--ignore-scripts", ...(dev ? ["--dev"] : []), ...(workspaceRoot ? ["-W"] : []), ...specs] });
    }
  }
  return commands;
}

/** The bridge's and the payment work's own settings: Lemma's, the benchmark's key, and RPC URLs (which can carry an API key). */
const BRIDGE_SETTING = /^LEMMA_|^CURSOR_API_KEY$|RPC_URL$/i;

/**
 * The installs' environment: the bridge's own without wallet secrets
 * (`WALLET_SECRET`, the names verify refuses to run with) or the bridge's
 * settings, with every package manager's script switch turned off. Everything
 * else passes, as it would to the user's own install: registry configuration
 * commonly reads tokens from other variables (`${NPM_TOKEN}` in .npmrc,
 * `${GITHUB_TOKEN}` in .yarnrc.yml). Scripts, pnpmfiles and yarn builds stay
 * off through flags as well, so the package manager itself is the only code
 * that runs; it could still read the bridge's start environment from /proc,
 * which is why the key must not be there.
 */
export function installEnv(host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined || WALLET_SECRET.test(name) || BRIDGE_SETTING.test(name)) continue;
    env[name] = value;
  }
  return { ...env, npm_config_ignore_scripts: "true", YARN_ENABLE_SCRIPTS: "false" };
}

/** Install process groups still running, so the bridge can kill them when it exits. */
const liveGroups = new Set<number>();

/** Kills every install still running; the bridge calls it when it exits or is stopped by a signal (a crash leaves them to the next start's recovery). */
export function killInstalls(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear();
}

/** Runs install commands in order, without a shell; throws on the first that fails or passes `timeoutSec`. `onGroup` hears each install's process group. */
export async function runInstalls(commands: readonly InstallCommand[], options: { env: Record<string, string>; timeoutSec: number; onGroup?: (pgid: number) => void }): Promise<void> {
  for (const command of commands) {
    const code = await run(command, options);
    if (code !== 0) throw new InstallError(`${command.argv.slice(0, 2).join(" ")} ${code === null ? "was stopped" : `exited with ${code}`}`);
  }
}

export class InstallError extends Error {
  override name = "InstallError";
}

function run(command: InstallCommand, options: { env: Record<string, string>; timeoutSec: number; onGroup?: (pgid: number) => void }): Promise<number | null> {
  const [file, ...args] = command.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(file as string, args, { cwd: command.cwd, env: options.env, stdio: "ignore", shell: false, detached: true });
    const pgid = child.pid;
    const kill = () => {
      try {
        if (pgid !== undefined) process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    let failure: unknown;
    const timer = setTimeout(kill, options.timeoutSec * 1000);
    const done = (code: number | null) => {
      clearTimeout(timer);
      // Whatever the install left in its group goes with it.
      kill();
      if (pgid !== undefined) liveGroups.delete(pgid);
      if (failure !== undefined) reject(failure);
      else resolve(code);
    };
    child.on("error", () => done(null));
    child.on("close", (code, signal) => done(signal === null ? code : null));
    // Recorded only once the install is supervised: if recording fails, the install is stopped, and the caller hears of it only once it is gone.
    if (pgid !== undefined) {
      liveGroups.add(pgid);
      try {
        options.onGroup?.(pgid);
      } catch (error) {
        failure = error;
        kill();
      }
    }
  });
}

function hasWorkspaces(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { workspaces?: unknown }).workspaces !== undefined;
  } catch {
    return false;
  }
}
