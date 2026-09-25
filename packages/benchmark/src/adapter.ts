import type { ReportedUsage } from "./tokens.js";

/** A model and parameter set, frozen before measured runs (`Cursor.models.list()` names them). */
export interface ModelSelection {
  readonly id: string;
  readonly params?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

/** A stdio MCP server handed to the agent explicitly, never through ambient settings. */
export interface McpStdioServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentRunRequest {
  /** The fresh fixture copy the agent works in, outside any repository. */
  readonly cwd: string;
  /** A fresh, empty home directory for this run only. */
  readonly home: string;
  readonly prompt: string;
  readonly model: ModelSelection;
  readonly mcpServers: Readonly<Record<string, McpStdioServer>>;
  readonly timeoutMs: number;
  /**
   * Called once the agent's run has begun, with its agent id, so the harness
   * can log a billed run before it ends (an interrupted run is then still
   * recorded and reconciled). Never sent to the agent process.
   */
  readonly onStarted?: (agentId: string) => void;
}

export interface ToolCallSummary {
  readonly callId: string;
  readonly name: string;
  readonly status: "running" | "completed" | "error";
}

export interface AgentRunOutcome {
  /** Null when the agent never started. */
  readonly agentId: string | null;
  readonly status: "finished" | "error" | "cancelled" | "timeout" | "startup-error";
  readonly startedAt: string;
  readonly finishedAt: string;
  /** One entry per distinct tool call id. */
  readonly toolCalls: readonly ToolCallSummary[];
  /** Usage the run itself reported; an independent measure next to billed usage. */
  readonly usage: ReportedUsage | null;
  readonly error: string | null;
}

/** Billed usage for an agent. `rawCostCents` is null while the provider has not reported cost yet. */
export interface UsageReport {
  readonly usage: ReportedUsage;
  readonly rawCostCents: number | null;
}

/**
 * The seam between the harness and an agent SDK. `CursorAdapter` implements it
 * for `@cursor/sdk`; `FakeAdapter` scripts outcomes for tests.
 */
export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
  usage(agentId: string): Promise<UsageReport | null>;
}
