import type { AgentAdapter, AgentRunOutcome, AgentRunRequest, UsageReport } from "./adapter.js";

/**
 * A scripted adapter for tests and dry runs: each run returns the next scripted
 * outcome (optionally editing the workspace first), and usage is looked up by
 * agent id.
 */
export class FakeAdapter implements AgentAdapter {
  readonly requests: AgentRunRequest[] = [];

  constructor(
    private readonly outcomes: Array<(request: AgentRunRequest) => AgentRunOutcome | Promise<AgentRunOutcome>>,
    private readonly billed: ReadonlyMap<string, UsageReport | null> = new Map(),
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    this.requests.push(request);
    const next = this.outcomes.shift();
    if (next === undefined) throw new Error("FakeAdapter: no scripted outcome left");
    return next(request);
  }

  async usage(agentId: string): Promise<UsageReport | null> {
    return this.billed.get(agentId) ?? null;
  }
}
