import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AgentAdapter, AgentRunOutcome, AgentRunRequest, ToolCallSummary, UsageReport } from "./adapter.js";
import { childEnv, killByHome, killGroup, killTree, trackGroup } from "./process.js";

/** What the harness sends `cursor-child.js` on stdin. */
export interface ChildRequest {
  readonly apiKey: string;
  readonly request: Omit<AgentRunRequest, "onStarted">;
}

/**
 * What `cursor-child.js` writes to fd 3, one JSON document per line: `started`
 * once the agent's run has begun, `tool` as tool calls start and finish, and
 * `outcome` at the end. The early lines let the harness tell a run that died
 * midway (billed, a real failure) from one that never started.
 */
export type ChildEvent = { readonly type: "started"; readonly agentId: string } | ({ readonly type: "tool" } & ToolCallSummary) | { readonly type: "outcome"; readonly outcome: AgentRunOutcome };

/** Time beyond a run's own limit for the SDK to start, cancel and dispose before the harness kills the child. */
export const CHILD_GRACE_MS = 120_000;
/** Time after the outcome for the child to dispose the agent and exit on its own. */
export const DISPOSE_GRACE_MS = 30_000;
/** Time after the child exits to drain its last lines, in case something it started still holds fd 3. */
const DRAIN_MS = 2_000;

/**
 * `@cursor/sdk` behind the AgentAdapter seam.
 *
 * Each run happens in a child process whose environment is only `childEnv`:
 * the SDK's shell tool inherits its process environment, so the API key goes
 * to the child through stdin, never through the environment. The child uses
 * an explicit local runtime with project settings from the fixture copy only,
 * the sandbox off for both arms (MCP tool calls fail closed under it), and MCP
 * servers passed explicitly.
 *
 * The harness, not the child, owns the deadline: past the run's limit plus a
 * grace period, or once the child has reported and had time to dispose, the
 * child and everything it started are killed. When the run settles, every
 * process still carrying the run's home is killed too, which reaches what the
 * agent detached and what a crashed child left behind (`killByHome`). The SDK
 * is imported lazily, so tests and the rest of the package never load it.
 */
export class CursorAdapter implements AgentAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly childScript: string = fileURLToPath(new URL("./cursor-child.js", import.meta.url)),
    private readonly graceMs: { readonly child: number; readonly dispose: number } = { child: CHILD_GRACE_MS, dispose: DISPOSE_GRACE_MS },
  ) {
    if (apiKey === "") throw new Error("a Cursor API key is required");
  }

  run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    const startedAt = new Date().toISOString();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.childScript], {
        cwd: request.cwd,
        env: childEnv(request.home),
        stdio: ["pipe", "ignore", "inherit", "pipe"],
        detached: true,
      });
      const untrack = trackGroup(child.pid);
      const seen: RunSeen = { agentId: null, outcome: null, killedAtDeadline: false, spawnError: null, calls: new Map() };
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
        killByHome(request.home);
        untrack();
        resolve(outcomeOf(startedAt, seen));
      };

      let buffer = "";
      const onLine = (line: string) => {
        let event: ChildEvent;
        try {
          event = JSON.parse(line) as ChildEvent;
        } catch {
          return;
        }
        if (event.type === "started" && seen.agentId === null) {
          seen.agentId = event.agentId;
          request.onStarted?.(event.agentId);
        }
        if (event.type === "tool") seen.calls.set(event.callId, { callId: event.callId, name: event.name, status: event.status });
        if (event.type === "outcome" && seen.outcome === null) {
          seen.outcome = event.outcome;
          timers.push(setTimeout(reap, this.graceMs.dispose));
        }
      };
      const results = child.stdio[3];
      results?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
          onLine(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      });
      results?.on("end", () => {
        if (buffer.trim() !== "") onLine(buffer);
        buffer = "";
      });

      timers.push(
        setTimeout(() => {
          seen.killedAtDeadline = true;
          reap();
        }, request.timeoutMs + this.graceMs.child),
      );
      child.on("error", (error) => {
        seen.spawnError = error.message;
        settle();
      });
      child.on("exit", () => {
        killGroup(child.pid);
        timers.push(setTimeout(settle, DRAIN_MS));
      });
      child.on("close", settle);
      const { onStarted: _, ...childRequest } = request;
      const message: ChildRequest = { apiKey: this.apiKey, request: childRequest };
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(JSON.stringify(message));
    });
  }

  async usage(agentId: string): Promise<UsageReport | null> {
    const { Agent } = await import("@cursor/sdk");
    const billed = await Agent.getUsage(agentId, { apiKey: this.apiKey });
    return { usage: billed.usage, rawCostCents: billed.cost?.rawCostCents ?? null };
  }

  /** Models the key can use, for the freeze step. */
  async models(): Promise<Array<{ id: string }>> {
    const { Cursor } = await import("@cursor/sdk");
    return (await Cursor.models.list({ apiKey: this.apiKey })).map((m) => ({ id: m.id }));
  }
}

interface RunSeen {
  agentId: string | null;
  outcome: AgentRunOutcome | null;
  killedAtDeadline: boolean;
  spawnError: string | null;
  readonly calls: Map<string, ToolCallSummary>;
}

/** The run's outcome: the child's own report, else what its early lines prove. */
function outcomeOf(startedAt: string, seen: RunSeen): AgentRunOutcome {
  if (seen.outcome !== null) return seen.outcome;
  const finishedAt = new Date().toISOString();
  if (seen.agentId === null) {
    const error = seen.spawnError ?? (seen.killedAtDeadline ? "the agent did not start before its deadline" : "the agent process ended before the run started");
    return { agentId: null, status: "startup-error", startedAt, finishedAt, toolCalls: [], usage: null, error };
  }
  // The run began, so it is billed and it counts: it timed out or failed, it did not fail to start.
  return {
    agentId: seen.agentId,
    status: seen.killedAtDeadline ? "timeout" : "error",
    startedAt,
    finishedAt,
    toolCalls: [...seen.calls.values()],
    usage: null,
    error: seen.killedAtDeadline ? "the agent process passed its deadline and was killed" : "the agent process ended without a result",
  };
}
