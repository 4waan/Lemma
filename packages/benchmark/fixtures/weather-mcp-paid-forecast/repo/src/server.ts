import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { alertsFor, formatAlert, formatForecast, stationNear } from "./weather.js";

/** The weather MCP server: its tools, ready to connect to a transport. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "weather", version: "1.4.0" });

  server.registerTool(
    "get_alerts",
    {
      description: "Active weather alerts for a US state.",
      inputSchema: { state: z.string().length(2).describe("Two-letter US state code, for example CA") },
      annotations: { readOnlyHint: true },
    },
    async ({ state }) => {
      const alerts = alertsFor(state);
      if (alerts === undefined) return { isError: true, content: [{ type: "text", text: `No alert data for ${state.toUpperCase()}.` }] };
      const text = alerts.length === 0 ? `No active alerts for ${state.toUpperCase()}.` : alerts.map(formatAlert).join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "get_forecast",
    {
      description: "The forecast for the next three periods at a location.",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
        longitude: z.number().min(-180).max(180).describe("Longitude of the location"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ latitude, longitude }) => {
      const station = stationNear(latitude, longitude);
      if (station === undefined) return { isError: true, content: [{ type: "text", text: `No forecast for ${latitude}, ${longitude}.` }] };
      return { content: [{ type: "text", text: formatForecast(station) }] };
    },
  );

  return server;
}
