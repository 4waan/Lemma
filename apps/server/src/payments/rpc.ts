import { type Transport, custom, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

import type { Secret } from "../config.js";

/** How long one RPC request may take before it fails (and is retried by the job that made it). */
export const RPC_TIMEOUT_MS = 10_000;

/**
 * viem's HTTP transport to the Arbitrum Sepolia RPC, with every error
 * scrubbed of URLs before it leaves. RPC providers put their API key in the
 * URL, and viem quotes the URL in its error messages; x402 prints some errors
 * as they are (`console.error`), so an unscrubbed error would put the key in
 * the server's logs. The JSON-RPC `code` and `data` are kept, so viem still
 * recognizes reverts and x402 still diagnoses them.
 */
export function redactingTransport(rpcUrl: Secret, options: { timeoutMs?: number } = {}): Transport {
  const url = rpcUrl.reveal();
  const inner = http(url, { timeout: options.timeoutMs ?? RPC_TIMEOUT_MS, retryCount: 2 })({ chain: arbitrumSepolia });
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        try {
          return await inner.request({ method, params } as Parameters<typeof inner.request>[0]);
        } catch (error) {
          throw scrubRpcError(error, url);
        }
      },
    },
    { key: "lemma-rpc", name: "Arbitrum Sepolia RPC", retryCount: 0 },
  );
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * A copy of an RPC error without any URL: its name, a scrubbed message, and
 * the first JSON-RPC `code` and `data` found on it or its causes.
 */
export function scrubRpcError(error: unknown, secret: string): Error & { code?: number; data?: unknown } {
  let code: number | undefined;
  let data: unknown;
  for (let e: unknown = error, depth = 0; e !== null && typeof e === "object" && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const c = (e as { code?: unknown }).code;
    if (code === undefined && typeof c === "number") code = c;
    const d = (e as { data?: unknown }).data;
    if (data === undefined && d !== undefined) data = d;
  }
  const original = error instanceof Error ? ((error as { shortMessage?: unknown }).shortMessage as string | undefined) ?? error.message : String(error);
  const scrubbed = new Error(original.split(secret).join("[rpc]").replace(URL_PATTERN, "[url]")) as Error & { code?: number; data?: unknown };
  scrubbed.name = error instanceof Error ? error.name : "RpcError";
  if (code !== undefined) scrubbed.code = code;
  if (data !== undefined) scrubbed.data = data;
  return scrubbed;
}
