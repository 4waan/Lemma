#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBridgeServer } from "./bridge.js";
import { ResolutionInbox, stateDirFor } from "./inbox.js";
import { recoverPending } from "./recovery.js";
import { LemmaRemote } from "./remote.js";
import { installRule } from "./rule.js";
import { ScanCache } from "./scan/cache.js";
import { Trace } from "./trace.js";

/**
 * `lemma-mcp`: the local MCP bridge on stdio.
 * `lemma-mcp install-rule [dir]`: writes the Lemma rule to `<dir>/.cursor/rules/lemma.mdc`.
 *
 * Environment: LEMMA_API_URL (default http://localhost:3000), LEMMA_WORKSPACE
 * (default: the current directory), LEMMA_STATE_DIR (default
 * $XDG_STATE_HOME/lemma; absolute, outside the workspace), LEMMA_BRIDGE_TRACE
 * (benchmark harness only).
 */
async function serve(): Promise<void> {
  // The real path, so a workspace reached through a link is scanned like any other; links below it are still refused.
  const root = realpathSync(resolvePath(process.env["LEMMA_WORKSPACE"] || process.cwd()));
  const remote = new LemmaRemote(new URL(process.env["LEMMA_API_URL"] ?? "http://localhost:3000"));
  let stateDir: string;
  try {
    stateDir = stateDirFor(root);
  } catch (error) {
    console.error(`lemma-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const inbox = new ResolutionInbox(stateDir);
  const server = createBridgeServer({
    remote,
    scanner: new ScanCache(),
    inbox,
    trace: new Trace(process.env["LEMMA_BRIDGE_TRACE"]),
    root,
    cwd: () => root,
    runningNodeMajor: Number(process.versions.node.split(".")[0]),
    monotonic: () => performance.now(),
  });
  await server.connect(new StdioServerTransport());
  // Recover purchases whose response was lost last time; failures only mean trying again next start.
  void recoverPending(inbox, remote, new Date()).catch(() => undefined);
}

const [command, arg] = process.argv.slice(2);
if (command === "install-rule") console.log(`wrote ${installRule(arg ?? process.cwd())}`);
else if (command === undefined) await serve();
else {
  console.error("usage: lemma-mcp [install-rule [dir]]");
  process.exitCode = 2;
}
