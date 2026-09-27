#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";

import { AgentId } from "@lemma/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { adoptionTools } from "./adoption.js";
import { confinementAvailable } from "./confine.js";
import { recoverJournals } from "./apply.js";
import { killInstalls } from "./install.js";
import { createBridgeServer } from "./bridge.js";
import { ResolutionInbox, stateDirFor } from "./inbox.js";
import { paymentsFromEnv } from "./payments.js";
import { flushReceipts, recoverPending } from "./recovery.js";
import { LemmaRemote } from "./remote.js";
import { installRule } from "./rule.js";
import { ScanCache } from "./scan/cache.js";
import { defaultSignerSocket } from "./signer/paths.js";
import { Trace } from "./trace.js";

/**
 * `lemma-mcp`: the local MCP bridge on stdio.
 * `lemma-mcp install-rule [dir]`: writes the Lemma rule to `<dir>/.cursor/rules/lemma.mdc`.
 *
 * Environment: LEMMA_API_URL (default http://localhost:3000), LEMMA_WORKSPACE
 * (default: the current directory), LEMMA_STATE_DIR (default
 * $XDG_STATE_HOME/lemma; absolute, outside the workspace), LEMMA_ACCEPTANCE_OFFLINE=1
 * (Linux: run acceptance tests without network), LEMMA_ACCEPTANCE_CONFINE=0
 * (run acceptance tests without the sandbox that hides the state directory and
 * the signer; on by default where it works), LEMMA_AGENT_ID (opt-in: this
 * agent's own ERC-8004 agent id, sent with receipts), LEMMA_BRIDGE_TRACE
 * (benchmark harness only).
 */
async function serve(): Promise<void> {
  // The real path, so a workspace reached through a link is scanned like any other; links below it are still refused.
  const root = realpathSync(resolvePath(process.env["LEMMA_WORKSPACE"] || process.cwd()));
  const agentId = process.env["LEMMA_AGENT_ID"] || undefined;
  if (agentId !== undefined && !AgentId.safeParse(agentId).success) {
    console.error("lemma-mcp: LEMMA_AGENT_ID must be this agent's ERC-8004 agent id, a decimal number such as 42");
    process.exitCode = 2;
    return;
  }
  const remote = new LemmaRemote(new URL(process.env["LEMMA_API_URL"] ?? "http://localhost:3000"), undefined, undefined, { agentId });
  let stateDir: string;
  try {
    stateDir = stateDirFor(root);
  } catch (error) {
    console.error(`lemma-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const inbox = new ResolutionInbox(stateDir);
  // An apply the last run did not finish is undone before anything else happens. It never stops the bridge:
  // a journal it cannot undo is kept, and what the undo left or put back is kept too, and all of it reported.
  const recovery = recoverJournals(inbox.journalDir, inbox.recoveredDir);
  if (recovery.kept > 0) console.error(`lemma-mcp: ${recovery.kept} unfinished applies could not be undone; their journals are kept in ${inbox.journalDir}, and the next apply in each repository tries again`);
  if (recovery.putBack > 0) console.error(`lemma-mcp: ${recovery.putBack} package manifests (package.json or a lockfile) were put back to their state before an interrupted install; what they held is kept in ${inbox.recoveredDir}`);
  if (recovery.left > 0) console.error(`lemma-mcp: ${recovery.left} files changed after an interrupted apply were left as they are; the originals of files it had replaced are kept in ${inbox.recoveredDir}`);
  const scanner = new ScanCache();
  const runningNodeMajor = Number(process.versions.node.split(".")[0]);
  const clock = () => new Date();
  const payments = await paymentsFromEnv(process.env, { stateDir, root, clock });
  if (payments.note !== undefined) console.error(`lemma-mcp: ${payments.note}`);
  // Acceptance tests run confined (hiding these and the state directory) where Linux user namespaces work.
  const socket = process.env["LEMMA_SIGNER_SOCKET"];
  const acceptanceHidden = process.env["LEMMA_ACCEPTANCE_CONFINE"] === "0" ? false : [dirname(socket !== undefined && isAbsolute(socket) ? socket : defaultSignerSocket(stateDir))];
  if (acceptanceHidden === false) console.error("lemma-mcp: LEMMA_ACCEPTANCE_CONFINE=0: acceptance tests run unconfined, able to read the Lemma state directory and reach the signer");
  else {
    // Checked in the background, so the trial run never delays the MCP handshake.
    void confinementAvailable().then((ok) => {
      if (!ok) console.error("lemma-mcp: acceptance tests run unconfined here (the sandbox needs Linux with unprivileged user namespaces, unshare and mount): a release's tests could read the Lemma state directory and reach the signer. Verify on Linux for receipts you can fully trust.");
    });
  }
  const server = createBridgeServer({
    remote,
    scanner,
    inbox,
    trace: new Trace(process.env["LEMMA_BRIDGE_TRACE"]),
    root,
    cwd: () => root,
    runningNodeMajor,
    monotonic: () => performance.now(),
    registerPaidTools: payments.registerPaidTools,
    registerAdoptionTools: adoptionTools({
      inbox,
      remote,
      scanner,
      root,
      cwd: () => root,
      runningNodeMajor,
      clock,
      offlineAcceptance: process.env["LEMMA_ACCEPTANCE_OFFLINE"] === "1",
      installTimeoutSec: 600,
      acceptanceHidden,
      signReceipt: payments.signReceipt,
    }),
  });
  // Installs are killed when the bridge exits or is stopped by a signal; after a crash, the next start's recovery kills a verified one before undoing its apply.
  process.once("exit", killInstalls);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      killInstalls();
      process.exit(130);
    });
  }
  process.stdin.once("end", () => {
    killInstalls();
    process.exit(0);
  });
  // A stray error in one tool call must not take the whole MCP server down.
  process.on("uncaughtException", (error) => console.error(`lemma-mcp: ${error.name}`));
  process.on("unhandledRejection", (error) => console.error(`lemma-mcp: ${error instanceof Error ? error.name : "rejection"}`));
  await server.connect(new StdioServerTransport());
  // Recover purchases whose response was lost, and send receipts that could not be sent; failures only mean trying again next start.
  void recoverPending(inbox, remote, new Date())
    .then(() => flushReceipts(inbox, remote))
    .catch(() => undefined);
}

const [command, arg] = process.argv.slice(2);
if (command === "install-rule") console.log(`wrote ${installRule(arg ?? process.cwd())}`);
else if (command === undefined) await serve();
else {
  console.error("usage: lemma-mcp [install-rule [dir]]");
  process.exitCode = 2;
}
