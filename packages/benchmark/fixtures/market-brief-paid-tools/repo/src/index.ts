#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BriefAgent } from "./agent.js";
import { buildBrief } from "./brief.js";

/**
 * market-brief <ticker> [servers.json]
 *
 * servers.json maps each server name (market, filings, news) to the command
 * that starts it: { "market": { "command": "node", "args": ["market.js"] } }.
 */
const [ticker, config = "servers.json"] = process.argv.slice(2);
if (ticker === undefined) {
  console.error("usage: market-brief <ticker> [servers.json]");
  process.exit(2);
}
const servers = JSON.parse(readFileSync(config, "utf8")) as Record<string, { command: string; args?: string[] }>;
const agent = await BriefAgent.connect(Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, new StdioClientTransport({ command: s.command, args: s.args ?? [] })])));
try {
  process.stdout.write(await buildBrief(agent, ticker));
} finally {
  await agent.close();
}
