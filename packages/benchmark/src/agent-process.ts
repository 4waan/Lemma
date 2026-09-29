import { spawn } from "node:child_process";

import { killByHome, killGroup, killTree, trackGroup } from "./process.js";

/** Time after the deadline for an agent CLI to stop on SIGTERM before it is killed. */
export const STOP_GRACE_MS = 10_000;
/** Time after its result for an agent CLI to exit on its own. */
export const EXIT_GRACE_MS = 30_000;
/** How much of an agent CLI's stderr is kept to explain a run that never started. */
const STDERR_TAIL = 2000;

export interface AgentProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The run's home: every process still carrying it is killed when the run settles. */
  readonly home: string;
  /** Written to the agent's standard input, which is then closed; without it, stdin is empty. */
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly graceMs?: { readonly stop: number; readonly exit: number };
  /**
   * Each line the agent prints on stdout. `ended` says the agent printed its
   * result: it then has the exit grace to exit on its own.
   */
  onLine(line: string, ended: () => void): void;
}

export interface AgentProcessResult {
  readonly killedAtDeadline: boolean;
  readonly spawnError: string | null;
  /** The end of what the agent printed on stderr. */
  readonly stderr: string;
}

/**
 * Runs a headless agent CLI (Claude Code, Codex) to its end in its own process
 * group. The harness owns the deadline: SIGTERM at the run's limit, then
 * SIGKILL for the group after the stop grace; after the agent prints its
 * result it has the exit grace to exit. When it settles, the group and every
 * process still carrying the run's home are killed, so nothing the agent
 * started outlives the run.
 */
export function superviseAgent(options: AgentProcessOptions): Promise<AgentProcessResult> {
  let killedAtDeadline = false;
  let spawnError: string | null = null;
  let stderr = "";
  return new Promise<AgentProcessResult>((resolve) => {
    const child = spawn(options.command, [...options.args], { cwd: options.cwd, env: { ...options.env }, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
    const untrack = trackGroup(child.pid);
    const timers: NodeJS.Timeout[] = [];
    const reap = () => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killTree(child.pid);
      killGroup(child.pid);
    };
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      reap();
      killByHome(options.home);
      untrack();
      resolve({ killedAtDeadline, spawnError, stderr });
    };
    let ended = false;
    const onEnded = () => {
      if (ended) return;
      ended = true;
      timers.push(setTimeout(reap, options.graceMs?.exit ?? EXIT_GRACE_MS));
    };

    if (options.stdin !== undefined && child.stdin !== null) {
      // An agent that exits before reading its input must not fail the harness with EPIPE.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
        options.onLine(buffer.slice(0, i), onEnded);
        buffer = buffer.slice(i + 1);
      }
    });
    child.stdout?.on("end", () => {
      if (buffer.trim() !== "") options.onLine(buffer, onEnded);
      buffer = "";
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    timers.push(
      setTimeout(() => {
        killedAtDeadline = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
        timers.push(setTimeout(reap, options.graceMs?.stop ?? STOP_GRACE_MS));
      }, options.timeoutMs),
    );
    child.on("error", (error) => {
      spawnError = error.message;
      settle();
    });
    child.on("close", settle);
  });
}
