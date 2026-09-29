import type { BriefAgent, ToolOutput } from "./agent.js";

/** One section of the brief and the tool that fills it. */
const SECTIONS = [
  { title: "Quote", server: "market", tool: "get_quote" },
  { title: "Latest filing", server: "filings", tool: "get_filing_summary" },
  { title: "News", server: "news", tool: "search_news" },
] as const;

/**
 * A short Markdown brief on a listed company: its quote, its latest filing
 * and recent news, each from its MCP server. A section whose tool gives
 * nothing says why instead of failing the brief.
 */
export async function buildBrief(agent: BriefAgent, ticker: string): Promise<string> {
  const symbol = ticker.trim().toUpperCase();
  if (!/^[A-Z.]{1,6}$/.test(symbol)) throw new Error(`not a ticker: ${ticker}`);
  const outputs = await Promise.all(SECTIONS.map((s) => agent.callTool(s.server, s.tool, { ticker: symbol })));
  const lines = [`# ${symbol} brief`, ""];
  SECTIONS.forEach((section, i) => {
    lines.push(`## ${section.title}`, "", body(outputs[i] as ToolOutput), "");
  });
  return lines.join("\n").trimEnd() + "\n";
}

function body(output: ToolOutput): string {
  return output.ok ? output.text.trim() : `_Unavailable: ${output.error.trim().split("\n")[0]}_`;
}
