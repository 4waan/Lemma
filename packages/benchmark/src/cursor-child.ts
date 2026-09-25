import { writeSync } from "node:fs";

import type { AgentRunOutcome, ToolCallSummary } from "./adapter.js";
import type { ChildEvent, ChildRequest } from "./cursor.js";
import { killTree } from "./process.js";

/** Longest the child waits for the SDK to dispose the agent before exiting anyway. */
const DISPOSE_TIMEOUT_MS = 20_000;

/** What the child has told the harness so far, and the key to keep out of error text. */
const state: { apiKey: string | null; agentId: string | null; reported: boolean; startedAt: string } = { apiKey: null, agentId: null, reported: false, startedAt: new Date().toISOString() };

const emit = (event: ChildEvent) => {
  writeSync(3, `${JSON.stringify(event)}\n`);
  if (event.type === "started") state.agentId = event.agentId;
  if (event.type === "outcome") state.reported = true;
};

/**
 * One agent run, in a process whose environment holds no credential. Reads a
 * ChildRequest from stdin and writes ChildEvent lines to fd 3; stdout is not
 * used, so nothing the SDK prints can corrupt the result. The harness owns the
 * overall deadline and kills this process when it passes.
 */
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let parsed: ChildRequest;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildRequest;
  } catch {
    // JSON.parse's message quotes the input, which holds the key.
    throw new Error("the harness sent a malformed request on stdin");
  }
  const { apiKey, request } = parsed;
  state.apiKey = apiKey;
  const startedAt = state.startedAt;
  const outcome = (fields: Omit<AgentRunOutcome, "startedAt" | "finishedAt">) => emit({ type: "outcome", outcome: { ...fields, startedAt, finishedAt: new Date().toISOString() } });

  const { Agent } = await import("@cursor/sdk");
  let agent: Awaited<ReturnType<typeof Agent.create>>;
  try {
    agent = await Agent.create({
      apiKey,
      model: { id: request.model.id, ...(request.model.params ? { params: request.model.params.map((p) => ({ ...p })) } : {}) },
      local: { cwd: request.cwd, settingSources: ["project"], sandboxOptions: { enabled: false } },
      mcpServers: Object.fromEntries(Object.entries(request.mcpServers).map(([name, s]) => [name, { type: "stdio" as const, command: s.command, args: [...s.args], env: { ...s.env } }])),
    });
  } catch (error) {
    outcome({ agentId: null, status: "startup-error", toolCalls: [], usage: null, error: String(error) });
    return;
  }

  const calls = new Map<string, ToolCallSummary>();
  let timer: NodeJS.Timeout | undefined;
  try {
    let run: Awaited<ReturnType<typeof agent.send>>;
    try {
      run = await agent.send(request.prompt);
    } catch (error) {
      // No run began, so nothing was billed for it: the agent never started.
      outcome({ agentId: null, status: "startup-error", toolCalls: [], usage: null, error: String(error) });
      return;
    }
    emit({ type: "started", agentId: agent.agentId });
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      run.cancel().catch(() => undefined);
    }, request.timeoutMs);
    try {
      for await (const message of run.stream()) {
        if (message.type !== "tool_call") continue;
        const call: ToolCallSummary = { callId: message.call_id, name: message.name, status: message.status };
        calls.set(call.callId, call);
        emit({ type: "tool", ...call });
      }
      const result = await run.wait();
      outcome({ agentId: agent.agentId, status: timedOut ? "timeout" : result.status, toolCalls: [...calls.values()], usage: result.usage ?? null, error: result.error?.message ?? null });
    } catch (error) {
      outcome({ agentId: agent.agentId, status: timedOut ? "timeout" : "error", toolCalls: [...calls.values()], usage: null, error: String(error) });
    }
  } finally {
    clearTimeout(timer);
    await Promise.race([agent[Symbol.asyncDispose]().catch(() => undefined), new Promise((r) => setTimeout(r, DISPOSE_TIMEOUT_MS))]);
  }
}

/**
 * Reports an error that escaped the run: on stderr, with the key removed, and
 * as the run's outcome when none was sent, so the harness does not have to
 * guess. Then, like a normal exit, kills whatever the agent left running.
 * Registered for uncaught exceptions and unhandled rejections too: the SDK
 * installs no handler, and Node would otherwise exit without this cleanup.
 */
function fatal(error: unknown): never {
  let message = error instanceof Error ? error.message : String(error);
  if (state.apiKey !== null && state.apiKey !== "") message = message.split(state.apiKey).join("[redacted]");
  try {
    process.stderr.write(`cursor-child: ${message}\n`);
    if (!state.reported) {
      const status = state.agentId === null ? "startup-error" : "error";
      emit({ type: "outcome", outcome: { agentId: state.agentId, status, startedAt: state.startedAt, finishedAt: new Date().toISOString(), toolCalls: [], usage: null, error: message } });
    }
  } catch {
    // The harness stopped reading; it reports the run from what it saw.
  }
  killTree(process.pid, { includeRoot: false });
  process.exit(1);
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

try {
  await main();
} catch (error) {
  fatal(error);
}
// Whatever the agent left running (a dev server, a watcher) goes with the run.
killTree(process.pid, { includeRoot: false });
process.exit(0);
