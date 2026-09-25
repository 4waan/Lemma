import { type CatalogIndex, buildIndex, loadCatalog } from "@lemma/catalog";
import type { Hex32 } from "@lemma/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Hono } from "hono";

import { type AppDeps, MemoryPreviewStore, type ServerConfig, createApp, loadConfig, noResolutions, silentLogger } from "../src/index.js";

export const NOW = new Date("2026-10-01T00:00:00.000Z");

export function config(env: Record<string, string> = {}): ServerConfig {
  return loadConfig({ NODE_ENV: "test", ...env });
}

export function committedIndex(): CatalogIndex {
  return buildIndex(loadCatalog({ includeProvisional: false }));
}

let counter = 0;
export function deps(over: Partial<AppDeps> = {}): AppDeps {
  const clock = () => NOW;
  return {
    config: config(),
    index: committedIndex(),
    previews: new MemoryPreviewStore(clock),
    resolutions: noResolutions,
    clock,
    newPreviewId: () => `0x${(++counter).toString(16).padStart(64, "0")}` as Hex32,
    logger: silentLogger,
    ...over,
  };
}

/** A real MCP client whose HTTP requests go straight into the Hono app. */
export async function mcpClient(app: Hono): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://lemma.test/mcp"), {
    fetch: async (input, init) => app.request(String(input), init),
  });
  const client = new Client({ name: "lemma-bridge-test", version: "0.0.0" });
  // The SDK's transport class declares optional properties without `| undefined`,
  // which exactOptionalPropertyTypes rejects; the runtime object is a Transport.
  await client.connect(transport as unknown as Transport);
  return client;
}

export const app = (over: Partial<AppDeps> = {}) => createApp(deps(over));
