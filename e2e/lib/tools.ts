import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Abi, Hex } from "viem";

/** The repository root. */
export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A free TCP port on the loopback interface. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface Anvil {
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * A local anvil posing as Arbitrum Sepolia (chain id 421614), with automine.
 * It also makes a block every second without transactions, as a live chain
 * goes on making blocks, so the server's indexer, which reads only blocks
 * its confirmation depth behind the head, catches up while the run waits.
 * It starts with no accounts at all (`--accounts 0`), so nothing can use the
 * dev mnemonic every anvil shares: the run funds its own runtime keys with
 * `anvil_setBalance`.
 */
export async function startAnvil(): Promise<Anvil> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("anvil", ["--chain-id", "421614", "--port", String(port), "--accounts", "0", "--block-time", "1", "--mixed-mining", "--silent"], { stdio: "ignore" });
  let exited = false;
  child.once("exit", () => (exited = true));
  await until(
    async () => {
      if (exited) throw new Error("anvil exited at startup");
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).catch(() => undefined);
      return res?.ok === true && ((await res.json()) as { result?: string }).result === "0x66eee";
    },
    { what: "anvil to answer as chain 421614", timeoutMs: 30_000, intervalMs: 100 },
  );
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        if (exited) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

/**
 * Polls `check` until it returns something other than false or undefined,
 * and returns that. A check that throws is retried until the deadline, when
 * its last error is reported.
 */
export async function until<T>(check: () => Promise<T | false | undefined> | T | false | undefined, options: { readonly what: string; readonly timeoutMs?: number; readonly intervalMs?: number }): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== false && value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      const why = last instanceof Error ? `: ${last.message}` : "";
      throw new Error(`timed out waiting for ${options.what}${why}`);
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 150));
  }
}

export interface ScriptResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a TypeScript operator script with tsx, as an operator would (`npm run
 * <script> -w @lemma/server` runs the same), with exactly `env` besides PATH
 * and HOME: keys reach it through its environment only, never its arguments.
 */
export async function runScript(script: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd: string = ROOT): Promise<ScriptResult> {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const child = spawn(tsx, [join(ROOT, script), ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (c) => resolve(c));
  });
  return { code, stdout, stderr };
}

/** A Foundry artifact: its ABI and creation code. */
export function forgeArtifact(outDir: string, file: string, contract: string): { readonly abi: Abi; readonly bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(outDir, file, `${contract}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}
