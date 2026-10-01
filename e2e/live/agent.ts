/**
 * A coding agent for a live run on Arbitrum Sepolia (docs/deployment.md,
 * runbook step 10): the shipped lemma-mcp program on a fixture repository
 * the demo release fits (e2e/live/catalog.ts), spoken to over stdio as an
 * agent's MCP client does, buying through a running `lemma-signer serve`.
 *
 *   tsx e2e/live/agent.ts adopt pass|fail --dir <dir> --api <server url> --signer-socket <path> --pay-to <provider> [--refund-to <address>]
 *   tsx e2e/live/agent.ts refund --dir <dir> --api <server url> --signer-socket <path> --pay-to <provider>
 *
 * `adopt` writes the fixture repository (`<dir>/workspace`, whose test
 * passes or fails once the release is applied) and the bridge's state
 * directory (`<dir>/state`) on first use. It previews and buys, waits for the
 * warranty to be active, applies and verifies, and waits for the server to
 * verify the receipt, printing each tool's answer. A failed outcome then
 * waits for the evaluator (`npm run evaluator -w @lemma/server -- decide`),
 * after which `refund` asks lemma_claim_refund for this bridge's claims; run
 * it again until it answers refunded. Both print the resolution id, and
 * `adopt` also the settlement transaction when ARBITRUM_SEPOLIA_RPC_URL is
 * set (USDC's AuthorizationUsed for the payment's nonce). The spending policy
 * is the local run's: at most 0.50 USDC per resolution and 5 a day, paid
 * only to --pay-to. Nothing here holds or reads a key.
 */
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ARBITRUM_SEPOLIA_USDC, type Address, type Hex32, ResolutionView, derivePaymentNonce, toAddress } from "@lemma/core";
import { type Hex, createPublicClient, http, parseAbiItem } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { type AgentProcess, startAgentProcess } from "../lib/agent.js";
import { CAPABILITY, writeWorkspace } from "../lib/catalog.js";
import { ROOT, until } from "../lib/tools.js";

const USAGE = [
  "usage: tsx e2e/live/agent.ts adopt pass|fail --dir <dir> --api <server url> --signer-socket <path> --pay-to <provider> [--refund-to <address>]",
  "       tsx e2e/live/agent.ts refund --dir <dir> --api <server url> --signer-socket <path> --pay-to <provider>",
].join("\n");

function fail(message: string): never {
  console.error(`live-agent: ${message}`);
  process.exit(1);
}

let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    strict: true,
    options: { dir: { type: "string" }, api: { type: "string" }, "signer-socket": { type: "string" }, "pay-to": { type: "string" }, "refund-to": { type: "string" } },
  });
}
try {
  parsed = parse();
} catch {
  fail(USAGE);
}
const [command, variant] = parsed.positionals;
const { dir: dirArg, api, "signer-socket": signerSocket, "pay-to": payTo, "refund-to": refundTo } = parsed.values;
if (dirArg === undefined || api === undefined || signerSocket === undefined || payTo === undefined) fail(USAGE);
if (!(command === "adopt" && (variant === "pass" || variant === "fail") && parsed.positionals.length === 2) && !(command === "refund" && parsed.positionals.length === 1)) fail(USAGE);
const dir = resolve(dirArg);
const rel = relative(ROOT, dir);
if (!isAbsolute(rel) && !rel.startsWith("..")) fail("--dir is inside the repository; keep run data outside it");
const address = (value: string, flag: string): Address => {
  try {
    return toAddress(value);
  } catch {
    fail(`${flag} must be an address`);
  }
};
const provider = address(payTo, "--pay-to");
const refundAddress = refundTo === undefined ? undefined : address(refundTo, "--refund-to");

mkdirSync(dir, { recursive: true, mode: 0o700 });
const workspace = join(dir, "workspace");
if (!existsSync(workspace)) {
  if (command !== "adopt") fail(`${workspace} does not exist: run adopt first`);
  mkdirSync(workspace, { mode: 0o700 });
  writeWorkspace(workspace, variant as "pass" | "fail");
}
const stateDir = join(dir, "state");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const view = async (id: Hex32) => {
  const res = await fetch(new URL(`/api/v1/resolutions/${id}`, api));
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return ResolutionView.parse(await res.json());
};
/** Polls the resolution's public view until `done` holds, printing each change of its warranty's state. */
const watch = async (id: Hex32, what: string, done: (v: ResolutionView) => boolean, timeoutMs: number) => {
  let last = "";
  return until(
    async () => {
      const v = await view(id);
      const now = `${v.state}/${v.warranty?.state ?? "no warranty"}/${v.receipt === null ? "no receipt" : `receipt ${v.receipt.outcome}${v.receipt.verified ? " verified" : ""}`}`;
      if (now !== last) console.log(`  ${new Date().toISOString()} ${now}`);
      last = now;
      return done(v) && v;
    },
    { what, timeoutMs, intervalMs: 3000 },
  );
};
const say = (tool: string, answer: { text: string; isError: boolean }) => console.log(`${tool}${answer.isError ? " (error)" : ""}: ${answer.text}`);

const agent: AgentProcess = await startAgentProcess({ apiUrl: api, workspace, stateDir, signerSocket, provider, ...(refundAddress === undefined ? {} : { refundTo: refundAddress }) });
try {
  if (command === "adopt") {
    const preview = await agent.call("lemma_preview", { capability: CAPABILITY });
    say("lemma_preview", preview);
    if (!preview.text.includes("lemma_buy_resolution")) fail(`no offer to buy. The bridge said: ${agent.stderr().trim() || "nothing"}`);
    const bought = await agent.call("lemma_buy_resolution", { capability: CAPABILITY });
    say("lemma_buy_resolution", bought);
    const [resolution] = agent.inbox.resolutions();
    if (resolution === undefined) fail("no delivery was stored");
    const id = resolution.resolutionId;
    console.log(`resolution ${id}`);
    const rpc = process.env["ARBITRUM_SEPOLIA_RPC_URL"];
    if (rpc !== undefined && rpc !== "") {
      const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
      const head = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: ARBITRUM_SEPOLIA_USDC,
        event: parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"),
        args: { authorizer: resolution.buyer as Hex, nonce: derivePaymentNonce(id, resolution.previewId) as Hex },
        fromBlock: head > 20_000n ? head - 20_000n : 0n,
        toBlock: head,
      });
      console.log(`settlement ${logs[0]?.transactionHash ?? "not found in the last 20,000 blocks"}`);
    }
    // The activation waits out WARRANTY_ACTIVATION_JITTER_SECONDS and the indexer's confirmations.
    await watch(id, "the warranty to be active", (v) => v.warranty?.state === "active", 20 * 60_000);
    say("lemma_apply_resolution", await agent.call("lemma_apply_resolution", { capability: CAPABILITY, mode: "apply" }));
    say("lemma_verify_adoption", await agent.call("lemma_verify_adoption", { capability: CAPABILITY }));
    const v = await watch(id, "the receipt to be verified", (r) => r.receipt?.verified === true, 10 * 60_000);
    console.log(`receipt ${v.receipt?.outcome}, verified. ${variant === "pass" ? "The evaluator finalizes it." : "It waits for the evaluator's decision (EVALUATOR_FAILURES=review)."}`);
  } else {
    const claims = agent.inbox.claims();
    for (const claim of claims) console.log(`resolution ${claim.resolutionId}`);
    say("lemma_claim_refund", await agent.call("lemma_claim_refund", {}));
  }
} finally {
  await agent.close();
}
