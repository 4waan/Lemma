import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BriefAgent } from "../src/agent.js";
import { buildBrief } from "../src/brief.js";

/** A server with one tool that answers `text`, or fails for an unknown ticker. */
function server(name: string, tool: string, text: (ticker: string) => string | undefined): McpServer {
  const s = new McpServer({ name, version: "1.0.0" });
  s.registerTool(tool, { description: tool, inputSchema: { ticker: z.string() } }, async ({ ticker }) => {
    const answer = text(ticker);
    return answer === undefined ? { isError: true, content: [{ type: "text", text: `Unknown ticker ${ticker}.` }] } : { content: [{ type: "text", text: answer }] };
  });
  return s;
}

describe("the brief", () => {
  const servers = [
    ["market", server("market", "get_quote", (t) => (t === "ACME" ? "ACME 41.20 USD, +1.3% today" : undefined))],
    ["filings", server("filings", "get_filing_summary", (t) => (t === "ACME" ? "10-Q for Q2: revenue up 8%" : undefined))],
    ["news", server("news", "search_news", (t) => `- ${t} opens a plant in Ohio`)],
  ] as const;
  let agent: BriefAgent;

  before(async () => {
    const transports: Record<string, InMemoryTransport> = {};
    for (const [name, s] of servers) {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      await s.connect(serverSide);
      transports[name] = client;
    }
    agent = await BriefAgent.connect(transports);
  });

  after(async () => {
    await agent.close();
    for (const [, s] of servers) await s.close();
  });

  test("lists each server's tools", async () => {
    assert.deepEqual(await agent.tools("news"), ["search_news"]);
  });

  test("has a section per tool", async () => {
    assert.equal(
      await buildBrief(agent, "acme"),
      "# ACME brief\n\n## Quote\n\nACME 41.20 USD, +1.3% today\n\n## Latest filing\n\n10-Q for Q2: revenue up 8%\n\n## News\n\n- ACME opens a plant in Ohio\n",
    );
  });

  test("says why a section is missing instead of failing", async () => {
    const brief = await buildBrief(agent, "ZZZ");
    assert.match(brief, /## Quote\n\n_Unavailable: Unknown ticker ZZZ\._/);
    assert.match(brief, /- ZZZ opens a plant in Ohio/);
  });

  test("refuses what is not a ticker", async () => {
    await assert.rejects(buildBrief(agent, "not a ticker"), /not a ticker/);
  });
});
