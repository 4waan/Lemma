import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What a tool call gave back: its text, or why there is none. */
export type ToolOutput = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

/** How long one tool call may take. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * An agent connected to named MCP servers ("market", "filings", "news"),
 * calling their tools on behalf of `buildBrief`.
 */
export class BriefAgent {
  private constructor(private readonly clients: ReadonlyMap<string, Client>) {}

  /** Connects one MCP client per named transport. */
  static async connect(transports: Readonly<Record<string, Transport>>): Promise<BriefAgent> {
    const clients = new Map<string, Client>();
    try {
      for (const [name, transport] of Object.entries(transports)) {
        const client = new Client({ name: "market-brief", version: "0.6.0" });
        await client.connect(transport);
        clients.set(name, client);
      }
    } catch (error) {
      await Promise.allSettled([...clients.values()].map((c) => c.close()));
      throw error;
    }
    return new BriefAgent(clients);
  }

  /** The names of the tools a server offers. */
  async tools(server: string): Promise<string[]> {
    const { tools } = await this.client(server).listTools();
    return tools.map((t) => t.name);
  }

  /** Calls a tool; a tool error or a failed call comes back as `ok: false`. */
  async callTool(server: string, tool: string, args: Record<string, unknown> = {}): Promise<ToolOutput> {
    let result: CallToolResult;
    try {
      result = (await this.client(server).callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const text = textOf(result);
    return result.isError === true ? { ok: false, error: text || `${server}.${tool} failed` } : { ok: true, text };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }

  private client(server: string): Client {
    const client = this.clients.get(server);
    if (client === undefined) throw new Error(`no MCP server named ${server}`);
    return client;
  }
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
