import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { Address } from "@lemma/core";
import {
  LemmaRemote,
  LocalSigner,
  ResolutionInbox,
  ScanCache,
  SpendLedger,
  Trace,
  adoptionTools,
  createBridgeServer,
  defaultSignerSocket,
  paymentsFromEnv,
  spendingPolicyFromEnv,
} from "@lemma/bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { writeWorkspace } from "./catalog.js";

/**
 * The buyer's spending policy, as the bridge and lemma-signer read it: at most
 * 0.50 USDC per resolution and 5 USDC a day, paid only to the provider.
 */
export function policyEnv(provider: Address): Record<string, string> {
  return { LEMMA_MAX_USDC_PER_RESOLUTION: "500000", LEMMA_DAILY_USDC_CAP: "5000000", LEMMA_ALLOWED_PAY_TO: provider };
}

/**
 * A buyer's signer, in process (the bridge's `LocalSigner`, what lemma-signer
 * runs behind its socket), with its own spending policy and ledger. Several
 * bridges may share one: one wallet, used in several repositories.
 */
export function inProcessSigner(key: Hex, provider: Address, dir: string): LocalSigner {
  const policy = spendingPolicyFromEnv(policyEnv(provider));
  if (!policy.ok) throw new Error(`the spending policy does not parse: ${policy.problems.join("; ")}`);
  return new LocalSigner(privateKeyToAccount(key), policy.policy, new SpendLedger(mkdtempSync(join(dir, "signer-ledger-"))));
}

export interface ToolAnswer {
  readonly text: string;
  readonly isError: boolean;
}

export interface Bridge {
  readonly buyer: Address;
  readonly inbox: ResolutionInbox;
  readonly workspace: string;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * One coding agent's bridge, wired as the bridge's main.ts wires it: the
 * payment tools from `paymentsFromEnv` (the spending policy and refund
 * address from its environment, the signer found where lemma-signer's socket
 * would be, here answered in process), the adoption tools with the signer's
 * receipt signatures, the server over HTTP at `apiUrl`, and a fixture
 * repository as its workspace. The agent talks to it over MCP (in memory).
 */
export async function startBridge(options: {
  readonly apiUrl: string;
  readonly signer: LocalSigner;
  readonly provider: Address;
  readonly variant: "pass" | "fail";
  /** LEMMA_REFUND_TO: where a warranty credit goes; the buyer's own address when unset. */
  readonly refundTo?: Address;
  readonly dir: string;
}): Promise<Bridge> {
  const workspace = writeWorkspace(mkdtempSync(join(options.dir, "workspace-")), options.variant);
  const stateDir = mkdtempSync(join(options.dir, "state-"));
  // lemma-signer's default socket directory, which the bridge checks nobody else can write to.
  mkdirSync(join(stateDir, "signer"), { mode: 0o700 });
  const inbox = new ResolutionInbox(stateDir);
  const remote = new LemmaRemote(new URL(options.apiUrl));
  const scanner = new ScanCache();
  const clock = () => new Date();
  const runningNodeMajor = Number(process.versions.node.split(".")[0]);
  const env = { ...policyEnv(options.provider), ...(options.refundTo === undefined ? {} : { LEMMA_REFUND_TO: options.refundTo }) };
  const payments = await paymentsFromEnv(env, { stateDir, root: workspace, clock, signerFor: (socket) => (socket === defaultSignerSocket(stateDir) ? options.signer : unreachable()) });
  if (payments.registerPaidTools === undefined) throw new Error(`purchases are off: ${payments.note ?? "no reason given"}`);
  const server = createBridgeServer({
    remote,
    scanner,
    inbox,
    trace: new Trace(undefined),
    root: workspace,
    cwd: () => workspace,
    runningNodeMajor,
    monotonic: () => performance.now(),
    registerPaidTools: payments.registerPaidTools,
    registerAdoptionTools: adoptionTools({
      inbox,
      remote,
      scanner,
      root: workspace,
      cwd: () => workspace,
      runningNodeMajor,
      clock,
      offlineAcceptance: false,
      installTimeoutSec: 600,
      signReceipt: payments.signReceipt,
    }),
  });
  const [bridgeEnd, agentEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(bridgeEnd);
  const agent = new Client({ name: "lemma-e2e-agent", version: "0.0.0" });
  await agent.connect(agentEnd);
  return {
    buyer: await options.signer.address(),
    inbox,
    workspace,
    async call(tool, args = {}) {
      const result = await agent.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
      const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
      return { text: content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(" "), isError: result.isError === true };
    },
    async tools() {
      return (await agent.listTools()).tools.map((t) => t.name);
    },
    async close() {
      await agent.close();
      await server.close();
      await remote.close();
    },
  };
}

function unreachable(): never {
  throw new Error("the run's bridges use their in-process signer only");
}
