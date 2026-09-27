import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_USDC,
  type AdoptionReceipt,
  type Hex32,
  type PatchBundle,
  type SpendingPolicy,
  type WarrantyClaim,
  bundleDigest,
  deriveResolutionId,
  toAddress,
  warrantyClaimHash,
} from "@lemma/core";
import {
  MemoryStore,
  ReceiptVerifier,
  ResolutionService,
  WITHDRAWALS_PATH as SERVER_WITHDRAWALS_PATH,
  Secret,
  createApp,
  inProcessFacilitator,
  loadConfig,
  paidToolRegistrar,
  paymentResourceServer,
  silentLogger,
  startWarrantyPipeline,
  viemSignatureVerifier,
} from "@lemma/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPublicClient, custom } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server's own chain doubles, as in buy.test.ts: the real server app, its x402 facilitator and its warranty
// pipeline run end to end over a fake USDC and a fake warranty registry. Test code only; it never ships.
import { FakeUsdc } from "../../server/test/fake-chain.js";
import { FakeRegistry, REGISTRY } from "../../server/test/fake-registry.js";
import {
  BRIDGE_INSTRUCTIONS,
  LemmaRemote,
  LocalSigner,
  MAX_TOOL_TEXT,
  NO_CLAIMS_TEXT,
  NO_CLAIM_TEXT,
  type RefundEntry,
  ResolutionInbox,
  ScanCache,
  SpendLedger,
  Trace,
  WARRANTY_HINT,
  WITHDRAWALS_PATH,
  adoptionTools,
  buyTool,
  claimRefunds,
  createBridgeServer,
  refundText,
  warrantyHintMayApply,
  withWarrantyHint,
} from "../src/index.js";
import { removeTemps, temp, tree } from "./fixtures.js";
import { sellableIndexFor } from "./sellable.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const SDK = "@modelcontextprotocol/sdk";
const PROVIDER = "0x00000000000000000000000000000000000000a1";
const REFUND_TO = "0x00000000000000000000000000000000000000c3";
const CAPABILITY = "mcp-server.add-payment-gating";
const PASSES = 'node -e "process.exit(0)"';
const FAILS = 'node -e "process.exit(3)"';

const policy: SpendingPolicy = {
  schemaVersion: "1",
  network: ARBITRUM_SEPOLIA,
  asset: ARBITRUM_SEPOLIA_USDC,
  allowedPayTo: [PROVIDER],
  maxPerResolutionUsdc: "500000",
  dailyCapUsdc: "1000000",
  maxAuthorizationSeconds: 600,
};

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A request the bridge made: where to, and what it carried. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly redirect: RequestInit["redirect"];
}

const random32 = () => `0x${randomBytes(32).toString("hex")}` as Hex32;
const short = (id: Hex32) => `${id.slice(0, 10)}…`;

/** A claim this machine could hold, for a resolution of its own (the secret is made at run time). */
/**
 * JSON Schema keywords that mean the same in draft-07, which the MCP SDK
 * writes, and 2020-12, which MCP reads a schema without `$schema` as. Not
 * among them: a tuple `items` (2020-12's `prefixItems`), `additionalItems`,
 * `dependencies`, `definitions` and `$ref`, whose meaning changed.
 */
const SAME_IN_BOTH_DRAFTS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "description",
  "title",
  "default",
]);

/** Every keyword a schema uses, its subschemas' included; a tuple `items` is `items[]`. */
function keywordsOf(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    found.push(key === "items" && Array.isArray(value) ? "items[]" : key);
    if (key === "properties" && typeof value === "object" && value !== null) for (const sub of Object.values(value)) found.push(...keywordsOf(sub));
    else if (["anyOf", "oneOf", "allOf", "items"].includes(key) && Array.isArray(value)) for (const sub of value) found.push(...keywordsOf(sub));
    else if (["items", "not", "additionalProperties"].includes(key)) found.push(...keywordsOf(value));
  }
  return found;
}

function claimFor(resolutionId: Hex32, refundTo = REFUND_TO): WarrantyClaim {
  const claimSecret = random32();
  return { schemaVersion: "1", resolutionId, claimSecret, refundTo, claimHash: warrantyClaimHash(resolutionId, claimSecret, refundTo) };
}

beforeEach(() => {
  // x402 checks authorization windows against Date.now(); everything here runs at the tests' instant.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  removeTemps();
});

let previewCounter = 0;

/**
 * The real server app with its x402 facilitator over a fake USDC and its
 * warranty pipeline over a fake registry (jobs driven by the test, no
 * activation jitter, failed receipts finalized automatically), and a bridge
 * with every tool: an in-process signer, refunds to `REFUND_TO`, and a
 * package whose acceptance test runs `test`.
 */
async function world(options: { readonly test?: string; readonly pipeline?: boolean; readonly registered?: boolean; readonly fetch?: (real: Fetch) => Fetch } = {}) {
  const usdc = new FakeUsdc();
  const store = new MemoryStore();
  const index = sellableIndexFor();
  await store.saveCatalog(index, NOW);
  const releaseDigest = index.releases[0]!.releaseDigest;
  const chain = new FakeRegistry();
  if (options.registered !== false) {
    chain.registerRelease(releaseDigest);
    chain.depositBond(releaseDigest, 100_000_000n);
  }
  const clock = () => new Date();
  const service = new ResolutionService(store, clock, silentLogger);
  const pipeline =
    options.pipeline === false
      ? undefined
      : await startWarrantyPipeline({
          config: {
            registry: REGISTRY,
            startBlock: 0n,
            providerKey: new Secret("held by the fake registry"),
            providerAddress: chain.provider,
            evaluatorKey: new Secret("held by the fake registry"),
            evaluatorAddress: chain.evaluator,
            failures: "auto",
            activationJitterSeconds: 0,
            indexerConfirmations: 0n,
          },
          store,
          index,
          chain,
          usdc: ARBITRUM_SEPOLIA_USDC,
          clock,
          logger: silentLogger,
          start: false,
        });
  const app = createApp({
    config: loadConfig({ NODE_ENV: "test", PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER, FACILITATOR_PRIVATE_KEY: generatePrivateKey(), ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9", RATE_LIMIT_PER_MINUTE: "10000" }),
    index,
    store,
    service,
    clock,
    newPreviewId: () => `0x${(++previewCounter).toString(16).padStart(64, "0")}` as Hex32,
    logger: silentLogger,
    registerPaidTools: paidToolRegistrar({ resourceServer: await paymentResourceServer(inProcessFacilitator(usdc)), clock, logger: silentLogger }),
    warranty: pipeline?.views,
  });
  // A public client whose deployless validator call reverts, as it does for an EOA buyer: viem falls back to recovery.
  const reverting = createPublicClient({
    chain: arbitrumSepolia,
    transport: custom({
      async request() {
        throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
      },
    }),
  });
  const verifier = new ReceiptVerifier({ store, verifier: viemSignatureVerifier(reverting), chainId: 421614, clock, logger: silentLogger });

  const sent: Sent[] = [];
  const real: Fetch = async (input, init) => app.request(String(input), init);
  const outer = options.fetch?.(real) ?? real;
  const recorded: Fetch = async (input, init) => {
    sent.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: typeof init?.body === "string" ? init.body : "", redirect: init?.redirect });
    return outer(input, init);
  };
  const remote = new LemmaRemote(new URL("http://lemma.test"), recorded);
  const signer = new LocalSigner(privateKeyToAccount(generatePrivateKey()), policy, new SpendLedger(temp("lemma-signer-")));
  const inbox = new ResolutionInbox(temp("lemma-state-"));
  const root = tree({
    "package.json": JSON.stringify({ type: "module", scripts: { test: options.test ?? FAILS }, dependencies: { [SDK]: "^1.30.0" }, devDependencies: { typescript: "7.0.2" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, [`node_modules/${SDK}`]: { version: "1.30.1" } } }),
    ".nvmrc": "22\n",
  });
  const scanner = new ScanCache();
  const bridge = createBridgeServer({
    remote,
    scanner,
    inbox,
    trace: new Trace(undefined),
    root,
    cwd: () => root,
    runningNodeMajor: 22,
    monotonic: () => 0,
    registerPaidTools: buyTool({ signer, policy, ledger: new SpendLedger(temp("lemma-ledger-")), root, clock, refundTo: REFUND_TO }),
    registerAdoptionTools: adoptionTools({ inbox, remote, scanner, root, cwd: () => root, runningNodeMajor: 22, clock, offlineAcceptance: false, installTimeoutSec: 60, signReceipt: (receipt) => signer.signAdoptionReceipt(receipt) }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as Array<{ text: string }>)[0]?.text ?? "", isError: result.isError === true };
  };
  const answers: string[] = [];
  const refund = async (args: Record<string, unknown> = {}) => {
    const { text } = await call("lemma_claim_refund", args);
    answers.push(text);
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    return text;
  };

  return {
    store,
    chain,
    inbox,
    remote,
    client,
    sent,
    answers,
    call,
    refund,
    /** Withdrawal requests the bridge made. */
    posts: () => sent.filter((s) => s.method === "POST" && s.path === WITHDRAWALS_PATH),
    /** Previews and buys the sellable release: the purchase's resolution id and the claim kept for it. */
    async buy(): Promise<{ id: Hex32; claim: WarrantyClaim }> {
      expect((await call("lemma_preview", { capability: CAPABILITY })).text).toContain("call lemma_buy_resolution");
      expect((await call("lemma_buy_resolution", { capability: CAPABILITY })).text).toMatch(/^Lemma: bought for 0\.25 USDC/);
      const id = inbox.resolutions()[0]!.resolutionId;
      const claim = inbox.claim(id);
      expect(claim?.refundTo).toBe(REFUND_TO);
      return { id, claim: claim! };
    },
    /** Applies the purchase and runs its acceptance test: verify's answer. */
    async adopt(): Promise<string> {
      expect((await call("lemma_apply_resolution", { capability: CAPABILITY, mode: "apply" })).text).toContain("applied 1 file changes");
      const { text } = await call("lemma_verify_adoption", { capability: CAPABILITY });
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
      return text;
    },
    /** Posts the buyer's signed receipt directly, as verify would after a run with this outcome. */
    async report(id: Hex32, outcome: AdoptionReceipt["outcome"]): Promise<void> {
      const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: id, outcome, acceptance: { exitCode: outcome === "passed" ? 0 : 1, durationMs: 900, outputDigest: null }, recordedAt: new Date().toISOString(), signature: null };
      expect(await remote.postReceipt({ ...receipt, signature: await signer.signAdoptionReceipt(receipt) }, inbox.get(id)!.resolution.previewId)).toBe("ACCEPTED");
    },
    /** The server's jobs: the provider activates the warranty, and the indexer reads it. */
    async activate(): Promise<void> {
      await pipeline?.activator.runOnce();
      await pipeline?.indexer.runOnce();
    },
    /** The server's jobs: receipts are verified, the evaluator finalizes, and the indexer reads it. */
    async finalize(): Promise<void> {
      expect((await verifier.runOnce()).failed).toBe(0);
      await pipeline?.evaluator.runOnce();
      await pipeline?.indexer.runOnce();
    },
    /** The server's credit relay sends what the route queued; `index` reads the result. */
    relay: async () => pipeline?.relay.runOnce(),
    index: async () => pipeline?.indexer.runOnce(),
  };
}

describe("lemma_claim_refund", () => {
  it("is registered with apply and verify, and every tool fits the context budget", async () => {
    const w = await world();
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["lemma_preview", "lemma_buy_resolution", "lemma_apply_resolution", "lemma_verify_adoption", "lemma_claim_refund"]);
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
    // Every tool main.ts registers with purchases on, with the instructions: all of it is in the agent's context on every turn.
    expect(JSON.stringify(tools).length + BRIDGE_INSTRUCTIONS.length).toBeLessThanOrEqual(3000);
    expect(tools.find((t) => t.name === "lemma_claim_refund")?.inputSchema).toEqual({
      type: "object",
      properties: { resolutionId: { type: "string", pattern: "^0x[0-9a-f]{64}$" } },
      additionalProperties: false,
    });
    // The listing drops each schema's draft-07 `$schema`, so clients read it as JSON Schema 2020-12: every keyword
    // in it must mean the same in both.
    for (const tool of tools) {
      for (const keyword of keywordsOf(tool.inputSchema)) expect(SAME_IN_BOTH_DRAFTS.has(keyword), `${tool.name} uses ${keyword}`).toBe(true);
    }
    expect(keywordsOf({ type: "array", items: [{ type: "string" }], additionalItems: false })).toEqual(["type", "items[]", "type", "additionalItems"]);
  });

  it("claims a failed warranty's refund once: asked again, it answers the same state and queues nothing new", async () => {
    const w = await world({ test: FAILS });
    const { id, claim } = await w.buy();
    // Paid, activation on its way: open, and nothing is sent.
    expect(await w.refund()).toBe(`Lemma: warranty refunds, by resolution: ${short(id)} open. Open: no verdict yet; the evaluator reviews failures, so call again later.`);
    await w.activate();
    expect(await w.refund()).toContain(`${short(id)} open 0.25 testnet USDC.`);

    // The acceptance test fails on a purchase under warranty: verify names the refund tool.
    const verified = await w.adopt();
    expect(verified).toMatch(/^Lemma: acceptance failed with exit code 3 \(npm run test, [\d.]+ s\); run it yourself to see why\. Receipt recorded\./);
    expect(verified.endsWith(WARRANTY_HINT)).toBe(true);
    await w.finalize();
    expect(w.posts()).toEqual([]);

    const queued = `Lemma: warranty refunds, by resolution: ${short(id)} queued 0.25 testnet USDC. Queued: the Lemma server pays it to the refund address, gas included; call again to see it refunded.`;
    expect(await w.refund()).toBe(queued);
    expect(await w.refund()).toBe(queued);
    // One relay action for the two requests, and nothing sent on chain before the relay runs.
    expect((await w.store.listWarrantyActions({ kind: "withdraw" }, 10)).map((a) => [a.resolutionId, a.state])).toEqual([[id, "queued"]]);
    expect(w.chain.sentOf("withdrawCredit")).toEqual([]);

    await w.relay();
    expect(w.chain.sentOf("withdrawCredit")).toHaveLength(1);
    expect(w.chain.paid.get(REFUND_TO)).toBe(250_000n);
    // Before the indexer reads it, the route answers the relay's own state; after, the view says refunded and nothing is sent.
    const refunded = `Lemma: warranty refunds, by resolution: ${short(id)} refunded 0.25 testnet USDC.`;
    expect(await w.refund()).toBe(refunded);
    await w.index();
    const posted = w.posts().length;
    expect(await w.refund()).toBe(refunded);
    expect(w.posts()).toHaveLength(posted);
    expect(w.chain.sentOf("withdrawCredit")).toHaveLength(1);

    // The claim secret went only to the withdrawal route, in a request that follows no redirect, and never into an answer.
    expect(SERVER_WITHDRAWALS_PATH).toBe(WITHDRAWALS_PATH);
    const carrying = w.sent.filter((s) => s.body.includes(claim.claimSecret.slice(2)) || s.path.includes(claim.claimSecret.slice(2)));
    expect(carrying).toHaveLength(3);
    expect(carrying.every((s) => s.method === "POST" && s.path === WITHDRAWALS_PATH && s.redirect === "error")).toBe(true);
    for (const text of [...w.answers, verified]) {
      expect(text).not.toContain(claim.claimSecret.slice(2));
      expect(text).not.toContain(claim.refundTo.slice(2));
    }
  });

  it("answers none for a passed warranty, and verify adds no warranty line after a passed run", async () => {
    const w = await world({ test: PASSES });
    const { id } = await w.buy();
    await w.activate();
    const verified = await w.adopt();
    expect(verified).toMatch(/^Lemma: acceptance passed .* Receipt recorded\.$/);
    await w.finalize();
    expect(await w.refund()).toBe(`Lemma: warranty refunds, by resolution: ${short(id)} none. None: no refund is due.`);
    expect(w.posts()).toEqual([]);
  });

  it("answers none, and verify adds no warranty line, when the purchase has no warranty", async () => {
    // The release has no warranty on the registry (its activation is skipped), or the server runs no warranty pipeline.
    for (const options of [{ registered: false }, { pipeline: false }]) {
      const w = await world({ ...options, test: FAILS });
      const { id } = await w.buy();
      await w.activate();
      const verified = await w.adopt();
      expect(verified).toContain("acceptance failed with exit code 3");
      expect(verified).not.toContain("lemma_claim_refund");
      expect(await w.refund()).toBe(`Lemma: warranty refunds, by resolution: ${short(id)} none. None: no refund is due.`);
      expect(w.posts()).toEqual([]);
    }
  });

  it("adds no warranty line without the claim, and has nothing to collect", async () => {
    // A purchase whose claim this machine does not hold (an older bridge's): nothing could collect its credit.
    const w = await world({ test: FAILS });
    const { id } = await w.buy();
    await w.activate();
    rmSync(join(w.inbox.dir, "claims", `${id}.json`));
    expect(await w.adopt()).not.toContain("lemma_claim_refund");
    expect(await w.refund()).toBe(NO_CLAIMS_TEXT);
    expect(await w.refund({ resolutionId: id })).toBe(NO_CLAIM_TEXT);
  });

  it("answers the route's code when it refuses, and queues nothing", async () => {
    const w = await world();
    const { id, claim } = await w.buy();
    await w.activate();
    await w.report(id, "failed");
    await w.finalize();
    // The claim kept here is not the one the purchase committed to.
    const other = claimFor(id, claim.refundTo);
    writeFileSync(join(w.inbox.dir, "claims", `${id}.json`), `${JSON.stringify(other)}\n`, { mode: 0o600 });
    expect(await w.refund()).toBe(`Lemma: warranty refunds, by resolution: ${short(id)} CLAIM_MISMATCH 0.25 testnet USDC. CLAIM_MISMATCH: refused by the server; nothing was queued.`);
    expect(await w.store.listWarrantyActions({ kind: "withdraw" }, 10)).toEqual([]);
    // A server that does not know a purchase this machine holds (another server, or one that lost it) answers a code, not none.
    const elsewhere = new LemmaRemote(new URL("http://elsewhere.test"), async () => Response.json({ error: "unknown resolution" }, { status: 404 }));
    expect(await claimRefunds({ inbox: w.inbox, remote: elsewhere })).toBe(
      `Lemma: warranty refunds, by resolution: ${short(id)} UNKNOWN_RESOLUTION. UNKNOWN_RESOLUTION: refused by the server; nothing was queued.`,
    );
  });

  it("answers a code when the server cannot be reached, and asks nothing more", async () => {
    let down = false;
    let failAfter = Infinity;
    const w = await world({
      test: FAILS,
      fetch: (real) => async (input, init) => {
        if (down || failAfter-- <= 0) throw new TypeError("fetch failed");
        return real(input, init);
      },
    });
    await w.buy();
    await w.activate();
    expect((await w.call("lemma_apply_resolution", { capability: CAPABILITY, mode: "apply" })).text).toContain("applied 1 file changes");
    // Two more claims, for purchases that never went through; the server does not know them.
    const others = [random32(), random32()].sort();
    for (const other of others) w.inbox.claimFor(other, () => claimFor(other));

    down = true;
    // Verify keeps the receipt to send later, and cannot tell whether a warranty covers the purchase: no line.
    const verified = (await w.call("lemma_verify_adoption", { capability: CAPABILITY })).text;
    expect(verified).toContain("The receipt will be sent when the Lemma server is reachable.");
    expect(verified).not.toContain("lemma_claim_refund");
    let before = w.remote.requests;
    expect(await w.refund()).toBe("Lemma: the Lemma server could not be reached (UNREACHABLE), so the refunds could not be checked. Try again shortly; asking again never queues a refund twice.");
    expect(w.remote.requests - before).toBe(1);

    // The server goes away after the first answer: what it answered is shown, the rest are not asked about.
    down = false;
    failAfter = 1;
    before = w.remote.requests;
    const text = await w.refund();
    expect(w.remote.requests - before).toBe(2);
    expect(text).toMatch(/^Lemma: warranty refunds, by resolution: (0x[0-9a-f]{8}… (open 0\.25 testnet USDC|none|UNREACHABLE)(; |\. )){3}/);
    expect(text).toContain("UNREACHABLE: the Lemma server could not be reached, so nothing more was asked; try again shortly.");
    expect(text.match(/UNREACHABLE/g)).toHaveLength(3);
    expect(w.posts()).toEqual([]);
  });

  it("checks only the named resolution when asked, and says when this machine holds no claim", async () => {
    const w = await world();
    expect(await w.refund()).toBe(NO_CLAIMS_TEXT);
    const { id } = await w.buy();
    for (const other of [random32(), random32()]) w.inbox.claimFor(other, () => claimFor(other));
    const before = w.remote.requests;
    expect(await w.refund({ resolutionId: id })).toBe(`Lemma: warranty refunds, by resolution: ${short(id)} open. Open: no verdict yet; the evaluator reviews failures, so call again later.`);
    expect(w.remote.requests - before).toBe(1);
    expect(await w.refund({ resolutionId: random32() })).toBe(NO_CLAIM_TEXT);
    expect(w.remote.requests - before).toBe(1);
    // All three: the purchase is open, and the two the server never saw are none.
    expect(await w.refund()).toBe(`Lemma: warranty refunds, by resolution: ${short(id)} open; ${[...w.inbox.claims()].filter((c) => c.resolutionId !== id).map((c) => `${short(c.resolutionId)} none`).join("; ")}. Open: no verdict yet; the evaluator reviews failures, so call again later. None: no refund is due.`);
    expect((await w.call("lemma_claim_refund", { resolutionId: "0xABC" })).isError).toBe(true);
  });
});

describe("the claims in the inbox", () => {
  it("lists every claim stored under its own resolution id, and nothing else", () => {
    const inbox = new ResolutionInbox(temp("lemma-state-"));
    expect(inbox.claims()).toEqual([]);
    const [a, b, c] = [random32(), random32(), random32()].sort() as [Hex32, Hex32, Hex32];
    const kept = [inbox.claimFor(a, () => claimFor(a)), inbox.claimFor(b, () => claimFor(b))];
    // A claim under another resolution's name, an unreadable file, and a half-written one are not claims.
    writeFileSync(join(inbox.dir, "claims", `${c}.json`), `${JSON.stringify(claimFor(a))}\n`, { mode: 0o600 });
    writeFileSync(join(inbox.dir, "claims", `0x${"0".repeat(64)}.json`), "{", { mode: 0o600 });
    writeFileSync(join(inbox.dir, "claims", `${a}.json.123.tmp`), `${JSON.stringify(claimFor(a))}\n`, { mode: 0o600 });
    expect(inbox.claims()).toEqual(kept);
    expect(inbox.claim(c)).toBeUndefined();
    expect(inbox.claim(a)).toEqual(kept[0]);
  });
});

/** A bridge remote over a fake HTTP server: each resolution's view, and the withdrawal route's answer, as given. */
function fakeServer(views: Record<string, { status: number; body?: unknown }>, withdrawal: { status: number; body?: unknown } | ((id: string) => { status: number; body?: unknown })) {
  let requests = 0;
  const fetch: Fetch = async (input, init) => {
    requests++;
    const path = new URL(String(input)).pathname;
    const reply = (r: { status: number; body?: unknown }) => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      const id = (JSON.parse(init.body as string) as { resolutionId: string }).resolutionId;
      return reply(typeof withdrawal === "function" ? withdrawal(id) : withdrawal);
    }
    return reply(views[path.slice("/api/v1/resolutions/".length)] ?? { status: 404, body: { error: "unknown resolution" } });
  };
  return { remote: new LemmaRemote(new URL("http://lemma.test"), fetch), requests: () => requests };
}

const warranty = (state: string, amount: string | null = "250000") => ({ resolutionId: "", warranty: { state, amount, claimDeadline: null } });

describe("refund answers", () => {
  it("maps each view and each answer of the withdrawal route to a word or a code", async () => {
    const id = `0x${"ab".repeat(32)}` as Hex32;
    const cases: Array<[{ status: number; body?: unknown }, { status: number; body?: unknown } | null, string]> = [
      [{ status: 200, body: { ...warranty("active"), resolutionId: id } }, null, "open 0.25 testnet USDC"],
      [{ status: 200, body: { ...warranty("pending", null), resolutionId: id } }, null, "open."],
      [{ status: 200, body: { ...warranty("passed"), resolutionId: id } }, null, "none."],
      [{ status: 200, body: { ...warranty("void"), resolutionId: id } }, null, "none."],
      [{ status: 200, body: { ...warranty("expired"), resolutionId: id } }, null, "none."],
      [{ status: 200, body: { ...warranty("none", null), resolutionId: id } }, null, "none."],
      [{ status: 200, body: { ...warranty("refunded"), resolutionId: id } }, null, "refunded 0.25 testnet USDC."],
      // A server without the warranty pipeline, and one from before it.
      [{ status: 200, body: { resolutionId: id, warranty: null } }, null, "none."],
      [{ status: 200, body: { resolutionId: id, state: "settled" } }, null, "none."],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 202, body: { resolutionId: id, state: "queued" } }, "queued 0.25 testnet USDC."],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 202, body: { resolutionId: id, state: "sent" } }, "queued 0.25 testnet USDC."],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 202, body: { resolutionId: id, state: "done" } }, "refunded 0.25 testnet USDC."],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 202, body: { resolutionId: id, state: "abandoned" } }, "abandoned 0.25 testnet USDC. Abandoned:"],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 409, body: { error: "NO_CREDIT" } }, "NO_CREDIT 0.25 testnet USDC. NO_CREDIT: refused by the server"],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 404, body: { error: "WARRANTY_OFF" } }, "WARRANTY_OFF 0.25 testnet USDC."],
      // Answers the bridge cannot use: another resolution's, or a status the route never gives.
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 202, body: { resolutionId: `0x${"cd".repeat(32)}`, state: "done" } }, "(SERVER_ERROR)"],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 500, body: { error: "internal error" } }, "(SERVER_ERROR)"],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: id } }, { status: 429, body: { error: "rate limited" } }, "(RATE_LIMITED)"],
      [{ status: 429, body: { error: "rate limited" } }, null, "Lemma: the Lemma server asked to slow down (RATE_LIMITED)"],
      [{ status: 500, body: { error: "internal error" } }, null, "Lemma: the Lemma server gave no usable answer (SERVER_ERROR)"],
      [{ status: 200, body: { ...warranty("failed"), resolutionId: `0x${"cd".repeat(32)}` } }, null, "(SERVER_ERROR)"],
      [{ status: 200, body: { ...warranty("unknown"), resolutionId: id } }, null, "(SERVER_ERROR)"],
      [{ status: 404, body: { error: "unknown resolution" } }, null, "none."],
    ];
    for (const [view, withdrawal, expected] of cases) {
      const inbox = new ResolutionInbox(temp("lemma-state-"));
      inbox.claimFor(id, () => claimFor(id));
      const server = fakeServer({ [id]: view }, withdrawal ?? { status: 500 });
      const text = await claimRefunds({ inbox, remote: server.remote });
      expect(text, JSON.stringify([view, withdrawal])).toContain(expected);
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
      // Only a failed warranty's claim is ever sent.
      expect(server.requests(), JSON.stringify(view)).toBe(withdrawal === null ? 1 : 2);
    }
  });

  it("says so when a refund it asks for pays the wallet that paid, which the withdrawal then shows next to the resolution", async () => {
    const payer = toAddress(privateKeyToAccount(generatePrivateKey()).address);
    const bundle: PatchBundle = { schemaVersion: "1", files: [{ path: "src/x.ts", op: "add", baseDigest: null, content: "x\n" }], dependencies: {}, devDependencies: {} };
    const inbox = new ResolutionInbox(temp("lemma-state-"));
    /** A purchase this machine made and keeps, paid by `payer`. */
    const bought = (previewId: Hex32) =>
      inbox.put({
        resolution: {
          schemaVersion: "1",
          resolutionId: deriveResolutionId(previewId, payer),
          previewId,
          release: { releaseId: "gating", version: "1.0.0", releaseDigest: `0x${"55".repeat(32)}`, profileIndex: 0 },
          profileDigest: `0x${"44".repeat(32)}`,
          payloadDigest: bundleDigest(bundle),
          buyer: payer,
          terms: { scheme: "exact", network: "eip155:421614", asset: ARBITRUM_SEPOLIA_USDC, amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
          createdAt: NOW.toISOString(),
        },
        bundle,
      }).resolution.resolutionId;
    const [own, apart, done] = [bought(`0x${"21".repeat(32)}`), bought(`0x${"22".repeat(32)}`), bought(`0x${"23".repeat(32)}`)];
    // The bridge's default refund address is the paying wallet; LEMMA_REFUND_TO names another.
    inbox.claimFor(own, () => claimFor(own, payer));
    inbox.claimFor(apart, () => claimFor(apart));
    inbox.claimFor(done, () => claimFor(done, payer));
    const failed = (id: Hex32) => ({ status: 200, body: { ...warranty("failed"), resolutionId: id } });
    // One refunded by an earlier call: nothing is asked for it now, so this call links nothing more.
    const server = fakeServer({ [own]: failed(own), [apart]: failed(apart), [done]: { status: 200, body: { ...warranty("refunded"), resolutionId: done } } }, (id) => ({ status: 202, body: { resolutionId: id, state: "queued" } }));
    const text = await claimRefunds({ inbox, remote: server.remote });
    expect(text).toContain(`${short(own)} queued 0.25 testnet USDC to the paying wallet;`);
    expect(text).toContain(`${short(apart)} queued 0.25 testnet USDC;`);
    expect(text).toContain(`${short(done)} refunded 0.25 testnet USDC.`);
    expect(text).toContain("To the paying wallet: the chain shows that wallet next to the resolution id once it is paid; LEMMA_REFUND_TO sets another refund address for later purchases.");
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    expect(text.toLowerCase()).not.toContain(payer.slice(2).toLowerCase());
    // Without such a claim, no such line.
    const apartOnly = await claimRefunds({ inbox, remote: server.remote }, apart);
    expect(apartOnly).not.toContain("paying wallet");
  });

  it("stays within 600 characters for any number of claims, counting what does not fit", async () => {
    const ids = Array.from({ length: 30 }, () => random32()).sort();
    const states = ["failed", "active", "passed", "refunded", "expired"] as const;
    const views = Object.fromEntries(ids.map((id, i) => [id, { status: 200, body: { ...warranty(states[i % states.length]!), resolutionId: id } }]));
    const inbox = new ResolutionInbox(temp("lemma-state-"));
    for (const id of ids) inbox.claimFor(id, () => claimFor(id));
    const server = fakeServer(views, (id) => ({ status: 202, body: { resolutionId: id, state: "queued" } }));
    const text = await claimRefunds({ inbox, remote: server.remote });
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    // Every claim was asked about, and what was asked for comes first.
    expect(server.requests()).toBe(30 + 6);
    expect(text).toMatch(/^Lemma: warranty refunds, by resolution: 0x[0-9a-f]{8}… queued 0\.25 testnet USDC; /);
    expect(text).toMatch(/; and \d+ more: (\d+ (queued|refunded|open|none)(, )?)+\. Queued: .* Open: .* None: no refund is due\.$/);
    const shown = text.match(/0x[0-9a-f]{8}…/g) ?? [];
    const counted = [...text.matchAll(/(\d+) (queued|refunded|open|none)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(shown.length + counted).toBe(30);

    // Every word and code at once, many times over: still within the limit.
    const words: Array<RefundEntry["word"]> = ["queued", "refunded", "open", "none", "abandoned", "CLAIM_MISMATCH", "NO_CREDIT", "UNKNOWN_RESOLUTION", "WARRANTY_OFF", "BAD_REQUEST", "BROWSER_REQUEST", "UNREACHABLE"];
    const entries = Array.from({ length: 200 }, (_, i) => ({ resolutionId: random32(), word: words[i % words.length]!, amount: i % 2 === 0 ? "123456789" : null }));
    expect(refundText(entries).length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
  });
});

describe("the warranty line in verify", () => {
  it("applies after a failed receipt the server has not refused for good, and never cuts an answer short", () => {
    expect(warrantyHintMayApply("failed", "ACCEPTED")).toBe(true);
    for (const note of ["unsent", "unsigned", "NOT_SETTLED", "TOO_EARLY", "DUPLICATE", "recorded-before"] as const) expect(warrantyHintMayApply("failed", note)).toBe(true);
    expect(warrantyHintMayApply("passed", "ACCEPTED")).toBe(false);
    expect(warrantyHintMayApply("abandoned", "ACCEPTED")).toBe(false);
    expect(warrantyHintMayApply("failed", "UNKNOWN_RESOLUTION")).toBe(false);
    expect(warrantyHintMayApply("failed", "MISMATCH")).toBe(false);
    expect(withWarrantyHint("Lemma: x.")).toBe(`Lemma: x.${WARRANTY_HINT}`);
    const long = "x".repeat(MAX_TOOL_TEXT - WARRANTY_HINT.length + 1);
    expect(withWarrantyHint(long)).toBe(long);
    expect(WARRANTY_HINT.length).toBeLessThanOrEqual(120);
  });
});
