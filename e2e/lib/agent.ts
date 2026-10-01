import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ResolutionInbox } from "@lemma/bridge";
import { type Address, toAddress } from "@lemma/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type ToolAnswer, policyEnv } from "./bridge.js";
import { ROOT, until } from "./tools.js";

/** The two programs a buyer runs (`lemma-mcp` and `lemma-signer` in @lemma/bridge's package.json), as `tsc -b` builds them. */
export const LEMMA_MCP = join(ROOT, "apps", "bridge", "dist", "main.js");
export const LEMMA_SIGNER = join(ROOT, "apps", "bridge", "dist", "signer", "main.js");

/**
 * A process's environment: PATH and HOME from this one, and `extra`. Nothing
 * else is inherited, so a key in this process's environment reaches neither
 * the bridge (whose acceptance tests refuse to run beside one) nor the signer
 * (which reads its key from its key file only).
 */
function processEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", ...extra };
}

/**
 * `lemma-signer init` with `LEMMA_STATE_DIR=stateDir`: creates the buyer's key
 * file (`<state>/signer/key`, mode 0600) and returns the address it prints,
 * which the buyer funds with testnet USDC.
 */
export async function initSignerKey(stateDir: string): Promise<{ readonly address: Address; readonly keyFile: string; readonly output: string }> {
  const child = spawn(process.execPath, [LEMMA_SIGNER, "init"], { env: processEnv({ LEMMA_STATE_DIR: stateDir }), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const address = /Buyer address: (0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  if (code !== 0 || address === undefined) throw new Error(`lemma-signer init failed: ${output.trim()}`);
  return { address: toAddress(address), keyFile: join(stateDir, "signer", "key"), output };
}

export interface SignerProcess {
  /** Where it listens: the bridge's LEMMA_SIGNER_SOCKET. */
  readonly socket: string;
  /** What it printed: its address and socket at startup, then one JSON line per request. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * `lemma-signer serve`, as the buyer runs it: the key from its key file
 * (`keyFile`, or `<state>/signer/key`), the spending policy from its
 * environment (by default the run's: at most 0.50 USDC per resolution and 5
 * a day, paid only to `provider`), listening on `<state>/signer/signer.sock`.
 */
export async function startSignerProcess(options: { readonly stateDir: string; readonly provider: Address; readonly keyFile?: string; readonly policy?: Readonly<Record<string, string>> }): Promise<SignerProcess> {
  const env = processEnv({ LEMMA_STATE_DIR: options.stateDir, ...(options.keyFile === undefined ? {} : { LEMMA_SIGNER_KEY_FILE: options.keyFile }), ...(options.policy ?? policyEnv(options.provider)) });
  const child = spawn(process.execPath, [LEMMA_SIGNER, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  let exited = false;
  child.once("exit", () => (exited = true));
  const socket = join(options.stateDir, "signer", "signer.sock");
  const state = await until(() => (exited ? "exited" : output.includes(" signing on ") && existsSync(socket) ? "listening" : false), { what: "lemma-signer to listen", timeoutMs: 30_000, intervalMs: 100 }).catch(() => "timeout");
  if (state !== "listening") {
    child.kill();
    throw new Error(`lemma-signer serve did not start (${state}): ${output.trim()}`);
  }
  return { socket, output: () => output, stop: () => stop(child) };
}

export interface AgentProcess {
  readonly workspace: string;
  /** The bridge's state directory (LEMMA_STATE_DIR), read here through its own inbox: deliveries, claims and receipts. */
  readonly inbox: ResolutionInbox;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  tools(): Promise<string[]>;
  /** What the bridge printed on stderr: its notes, such as why purchases are off. */
  stderr(): string;
  close(): Promise<void>;
}

/**
 * A coding agent's view of Lemma: the real `lemma-mcp` process on
 * `workspace`, spoken to over stdio as an agent's MCP client speaks to it.
 * Purchases go through the signer at `signerSocket`, within the spending
 * policy (by default the run's), and a warranty credit goes to `refundTo`
 * (LEMMA_REFUND_TO; the buyer's own address when unset).
 */
export async function startAgentProcess(options: {
  readonly apiUrl: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly signerSocket: string;
  readonly provider: Address;
  readonly refundTo?: Address;
  readonly policy?: Readonly<Record<string, string>>;
}): Promise<AgentProcess> {
  const env = processEnv({
    LEMMA_API_URL: options.apiUrl,
    LEMMA_WORKSPACE: options.workspace,
    LEMMA_STATE_DIR: options.stateDir,
    LEMMA_SIGNER_SOCKET: options.signerSocket,
    ...(options.policy ?? policyEnv(options.provider)),
    ...(options.refundTo === undefined ? {} : { LEMMA_REFUND_TO: options.refundTo }),
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [LEMMA_MCP], env, cwd: options.workspace, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const client = new Client({ name: "lemma-agent", version: "0.0.0" });
  await client.connect(transport);
  return {
    workspace: options.workspace,
    inbox: new ResolutionInbox(options.stateDir),
    async call(tool, args = {}) {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
      const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
      return { text: content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(" "), isError: result.isError === true };
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    stderr: () => stderr,
    close: () => client.close(),
  };
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}
