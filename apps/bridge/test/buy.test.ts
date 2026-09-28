import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_USDC,
  type Address,
  type AdoptionReceipt,
  type Hex32,
  type SpendingPolicy,
  derivePaymentNonce,
  deriveResolutionId,
  paymentRequirementsFor,
  toAddress,
  warrantyClaimHash,
} from "@lemma/core";
import {
  MemoryStore,
  ReceiptVerifier,
  ResolutionService,
  createApp,
  inProcessFacilitator,
  loadConfig,
  paidToolRegistrar,
  paymentResourceServer,
  silentLogger,
  viemSignatureVerifier,
} from "@lemma/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPublicClient, custom } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deliberately the server's own fake USDC: these tests drive the real server app and its real x402 facilitator
// end to end, so the bridge is checked against the same chain double the server's payment tests use. The root
// vitest config and tsconfig.test.json cover both workspaces; the fake is test code and never ships.
import { FakeUsdc } from "../../server/test/fake-chain.js";
import {
  BRIDGE_INSTRUCTIONS,
  LemmaRemote,
  LocalSigner,
  MAX_TOOL_TEXT,
  NO_OFFER_TEXT,
  ResolutionInbox,
  ScanCache,
  SpendLedger,
  Trace,
  buyTool,
  createBridgeServer,
  defaultSignerSocket,
  serveSigner,
} from "../src/index.js";
import { paymentsFromEnv } from "../src/payments.js";
import { sellableIndexFor } from "./sellable.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const SDK = "@modelcontextprotocol/sdk";
const PROVIDER = "0x00000000000000000000000000000000000000a1";
const CAPABILITY = "mcp-server.add-payment-gating";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

beforeEach(() => {
  // x402 checks authorization windows against Date.now(); everything here runs at the tests' instant.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const root = temp("lemma-ws-");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module", dependencies: { [SDK]: "^1.30.0" }, devDependencies: { typescript: "7.0.2" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, [`node_modules/${SDK}`]: { version: "1.30.1" } } }),
    ".nvmrc": "22\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const basePolicy: SpendingPolicy = {
  schemaVersion: "1",
  network: ARBITRUM_SEPOLIA,
  asset: ARBITRUM_SEPOLIA_USDC,
  allowedPayTo: [PROVIDER],
  maxPerResolutionUsdc: "500000",
  dailyCapUsdc: "1000000",
  maxAuthorizationSeconds: 600,
};

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

let previewCounter = 0;

/** The real server app with the real x402 facilitator over a fake USDC, and a bridge with the buy tool and an in-process signer. */
async function world(options: { bridgePolicy?: Partial<SpendingPolicy>; signerPolicy?: Partial<SpendingPolicy>; fetch?: (real: Fetch) => Fetch; refundTo?: Address; bridgeClockAheadMs?: number } = {}) {
  const usdc = new FakeUsdc();
  const store = new MemoryStore();
  const index = sellableIndexFor();
  await store.saveCatalog(index, NOW);
  let serverTime: Date | undefined;
  const serverClock = () => serverTime ?? new Date();
  const service = new ResolutionService(store, serverClock, silentLogger);
  const resourceServer = await paymentResourceServer(inProcessFacilitator(usdc));
  const app = createApp({
    config: loadConfig({ NODE_ENV: "test", PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER, FACILITATOR_PRIVATE_KEY: generatePrivateKey(), ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9", RATE_LIMIT_PER_MINUTE: "10000" }),
    index,
    store,
    service,
    clock: serverClock,
    newPreviewId: () => `0x${(++previewCounter).toString(16).padStart(64, "0")}` as Hex32,
    logger: silentLogger,
    registerPaidTools: paidToolRegistrar({ resourceServer, clock: serverClock, logger: silentLogger }),
  });
  const real: Fetch = async (input, init) => app.request(String(input), init);
  const remote = new LemmaRemote(new URL("http://lemma.test"), options.fetch?.(real) ?? real);
  const account = privateKeyToAccount(generatePrivateKey());
  const signerLedger = new SpendLedger(temp("lemma-signer-"));
  const signer = new LocalSigner(account, { ...basePolicy, ...options.signerPolicy }, signerLedger);
  const ledger = new SpendLedger(temp("lemma-ledger-"));
  const inbox = new ResolutionInbox(temp("lemma-state-"));
  const root = workspace();
  let mono = 0;
  const server = createBridgeServer({
    remote,
    scanner: new ScanCache(),
    inbox,
    trace: new Trace(undefined),
    root,
    cwd: () => root,
    runningNodeMajor: 22,
    monotonic: () => mono,
    registerPaidTools: buyTool({
      signer,
      policy: { ...basePolicy, ...options.bridgePolicy },
      ledger,
      root,
      clock: () => new Date(Date.now() + (options.bridgeClockAheadMs ?? 0)),
      randomSecret: () => `0x${"5e".repeat(32)}`,
      refundTo: options.refundTo,
    }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as Array<{ text: string }>)[0]?.text ?? "", isError: result.isError === true };
  };
  const buyer = toAddress(account.address);
  return {
    usdc,
    store,
    service,
    remote,
    inbox,
    ledger,
    signer,
    signerLedger,
    buyer,
    client,
    preview: async (capability = CAPABILITY) => (await call("lemma_preview", { capability })).text,
    buy: async (args: Record<string, unknown> = { capability: CAPABILITY }) => call("lemma_buy_resolution", args),
    setServerTime: (t: Date) => (serverTime = t),
    tick: (ms: number) => (mono += ms),
  };
}

const isPaidCall = (init?: RequestInit) => typeof init?.body === "string" && init.body.includes('"x402/payment"');

describe("lemma_buy_resolution in the bridge", () => {
  it("fits the context budget with the buy tool registered", async () => {
    const w = await world();
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["lemma_buy_resolution", "lemma_preview"]);
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
    expect(JSON.stringify(tools).length + BRIDGE_INSTRUCTIONS.length).toBeLessThanOrEqual(3000);
  });

  it("buys with one MCP round trip and no chain call, stores the delivery and the claim, and settles the ledger", async () => {
    const w = await world();
    expect(await w.preview()).toContain("call lemma_buy_resolution");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = w.remote.requests;
    const answer = await w.buy();
    expect(answer.text).toMatch(/^Lemma: bought for 0\.25 USDC/);
    expect(answer.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    // One request to the server, and nothing else: the bridge never reads or writes the chain.
    expect(w.remote.requests - before).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    const [resolution] = w.inbox.resolutions();
    expect(resolution?.buyer).toBe(w.buyer);
    const id = deriveResolutionId(resolution?.previewId as Hex32, w.buyer);
    const nonce = derivePaymentNonce(id, resolution?.previewId as Hex32);
    expect(w.usdc.transfers).toEqual([expect.objectContaining({ from: w.buyer, to: PROVIDER, value: 250_000n, nonce })]);
    expect(w.inbox.pending()).toEqual([]);
    // The claim: a secret and refund address kept locally (0600); only its hash reached the server.
    const claim = w.inbox.claim(id);
    expect(claim).toEqual({ schemaVersion: "1", resolutionId: id, claimSecret: `0x${"5e".repeat(32)}`, refundTo: w.buyer, claimHash: warrantyClaimHash(id, `0x${"5e".repeat(32)}`, w.buyer) });
    expect(statSync(join(w.inbox.dir, "claims", `${id}.json`)).mode & 0o777).toBe(0o600);
    expect((await w.store.getResolution(id))?.claimHash).toBe(claim?.claimHash);
    expect(w.ledger.entries()).toEqual([expect.objectContaining({ nonce, amount: "250000", state: "settled" })]);
    expect(w.signerLedger.entries()).toEqual([expect.objectContaining({ nonce, amount: "250000", state: "reserved" })]);
  });

  it("commits warranty credits to a configured refund address instead of the buyer's", async () => {
    const refundTo = "0x00000000000000000000000000000000000000c3";
    const w = await world({ refundTo });
    await w.preview();
    expect((await w.buy()).text).toMatch(/^Lemma: bought for/);
    const [resolution] = w.inbox.resolutions();
    const id = resolution?.resolutionId as Hex32;
    const claim = w.inbox.claim(id);
    expect(claim).toMatchObject({ refundTo, claimHash: warrantyClaimHash(id, `0x${"5e".repeat(32)}`, refundTo) });
    expect((await w.store.getResolution(id))?.claimHash).toBe(claim?.claimHash);
  });

  it("offers nothing more to buy once bought, so a second purchase is never signed", async () => {
    const w = await world();
    await w.preview();
    await w.buy();
    expect(await w.preview()).toContain("already bought in this bridge");
    expect(await w.buy()).toEqual({ text: NO_OFFER_TEXT, isError: false });
    expect(w.usdc.transfers).toHaveLength(1);
    expect(w.signerLedger.entries()).toHaveLength(1);
  });

  it("claims a buyer pass once a purchase settled, and sends it with later previews so demand counts this bridge as a buyer", async () => {
    const w = await world();
    await w.preview();
    expect(w.inbox.buyerPass()).toBeUndefined();
    await w.buy();
    // The next preview starts the claim and answers without waiting for it.
    await w.preview();
    await vi.waitFor(() => expect(w.inbox.buyerPass()).toMatch(/^0x[0-9a-f]{64}$/));
    const pass = w.inbox.buyerPass();
    // Kept, and sent with the next preview without asking for it again.
    const before = w.remote.requests;
    await w.preview();
    expect(w.inbox.buyerPass()).toBe(pass);
    expect(w.remote.requests - before).toBeLessThanOrEqual(2);
    await w.store.closeDemandDaysBefore("2099-01-01");
    // One repository, previewed before and after buying: one profile, and one buyer from the preview that carried the pass.
    expect((await w.store.demandBuckets(1)).map((b) => [b.profiles, b.buyers])).toEqual([[1, 1]]);
  });

  it("recovers a lost answer for free and never pays twice", async () => {
    let drop = true;
    const w = await world({
      fetch: (real) => async (input, init) => {
        const res = await real(input, init);
        if (drop && isPaidCall(init)) {
          drop = false;
          throw new TypeError("fetch failed");
        }
        return res;
      },
    });
    await w.preview();
    const answer = await w.buy();
    expect(answer.text).toMatch(/^Lemma: bought for 0\.25 USDC/);
    expect(w.usdc.transfers).toHaveLength(1);
    expect(w.inbox.resolutions()).toHaveLength(1);
    expect(w.inbox.pending()).toEqual([]);
    expect(await w.buy()).toEqual({ text: NO_OFFER_TEXT, isError: false });
    expect(w.usdc.transfers).toHaveLength(1);
  });

  it("keeps a purchase pending when its settlement is still unknown, and signs nothing more", async () => {
    const w = await world({
      fetch: (real) => async (input, init) => {
        if (isPaidCall(init)) throw new TypeError("fetch failed");
        return real(input, init);
      },
    });
    await w.preview();
    expect((await w.buy()).text).toContain("never made twice");
    expect(w.inbox.pending()).toHaveLength(1);
    expect(w.usdc.transfers).toEqual([]);
    expect(await w.preview()).toContain("still settling");
    expect(await w.buy()).toEqual({ text: NO_OFFER_TEXT, isError: false });
    expect(w.signerLedger.entries()).toHaveLength(1);
  });

  it("signs a window a minute shorter than quoted, so a buyer clock a little fast still buys, and a clock far off is named", async () => {
    // 90 seconds fast: the whole quoted window would end past what the server accepts (its clock plus 300 plus 60 seconds).
    const fast = await world({ bridgeClockAheadMs: 90_000 });
    await fast.preview();
    expect((await fast.buy()).text).toMatch(/^Lemma: bought for 0\.25 USDC/);
    expect(fast.usdc.transfers).toHaveLength(1);
    // Far beyond any slack: refused before anything settles, with a hint at the clock.
    const far = await world({ bridgeClockAheadMs: 200_000 });
    await far.preview();
    const answer = await far.buy();
    expect(answer.text).toContain("the server refused the purchase (UNSUPPORTED_PAYMENT)");
    expect(answer.text).toContain("clock");
    expect(answer.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    expect(far.usdc.transfers).toEqual([]);
  });

  it("refuses over the bridge's caps before anything is signed or sent", async () => {
    const cases: Array<[Partial<SpendingPolicy>, string]> = [
      [{ maxPerResolutionUsdc: "100000" }, "EXCEEDS_PER_RESOLUTION"],
      [{ dailyCapUsdc: "200000" }, "EXCEEDS_DAILY_CAP"],
      [{ allowedPayTo: ["0x00000000000000000000000000000000000000b2"] }, "WRONG_RECIPIENT"],
    ];
    for (const [policy, code] of cases) {
      const w = await world({ bridgePolicy: policy });
      await w.preview();
      const before = w.remote.requests;
      const answer = await w.buy();
      expect(answer.text).toContain(`spending policy refused the purchase (${code})`);
      expect(w.remote.requests - before).toBe(0);
      expect(w.signerLedger.entries()).toEqual([]);
      expect(w.inbox.pending()).toEqual([]);
    }
  });

  it("counts earlier spend in the rolling day against the daily cap", async () => {
    const w = await world();
    w.ledger.reserve({ nonce: `0x${"01".repeat(32)}`, amount: 900_000n, payTo: PROVIDER }, new Date(NOW.getTime() - 3600_000), () => ({ ok: true }));
    await w.preview();
    expect((await w.buy()).text).toContain("(EXCEEDS_DAILY_CAP)");
    expect(w.usdc.transfers).toEqual([]);
  });

  it("pays nothing when the signer refuses a payee or an amount the bridge would allow", async () => {
    const cases: Array<[Partial<SpendingPolicy>, string]> = [
      [{ allowedPayTo: ["0x00000000000000000000000000000000000000b2"] }, "WRONG_RECIPIENT"],
      [{ maxPerResolutionUsdc: "100000" }, "EXCEEDS_PER_RESOLUTION"],
    ];
    for (const [policy, code] of cases) {
      const w = await world({ signerPolicy: policy });
      await w.preview();
      const before = w.remote.requests;
      expect((await w.buy()).text).toContain(`the signer refused to sign (${code})`);
      expect(w.remote.requests - before).toBe(0);
      // Nothing was signed: the bridge's reservation and the pending mark are undone, and the offer stays open.
      expect(w.ledger.entries()).toEqual([expect.objectContaining({ state: "released" })]);
      expect(w.inbox.pending()).toEqual([]);
    }
  });

  it("charges nothing for a quote the server finds expired, or when no offer is open", async () => {
    const w = await world();
    expect(await w.buy()).toEqual({ text: NO_OFFER_TEXT, isError: false });
    expect(await w.preview("node-service.add-payment-facilitator")).toContain("no release fits");
    expect(await w.buy({ capability: "node-service.add-payment-facilitator" })).toEqual({ text: NO_OFFER_TEXT, isError: false });
    await w.preview();
    w.setServerTime(new Date(NOW.getTime() + 16 * 60_000));
    expect((await w.buy()).text).toContain("the server refused the purchase (QUOTE_EXPIRED)");
    expect(w.usdc.calls).toEqual([]);
    expect(w.inbox.pending()).toEqual([]);
    // The bridge's own clock expires the offer too.
    w.tick(900_000);
    expect(await w.buy()).toEqual({ text: NO_OFFER_TEXT, isError: false });
  });

  it("refuses an offer from another package's preview", async () => {
    const w = await world();
    await w.preview();
    expect((await w.buy({ capability: CAPABILITY, package: "apps/other" })).text).toContain("for another package");
    expect(w.usdc.transfers).toEqual([]);
  });

  it("never pays a challenge that changes the terms, and never pays a challenge at all", async () => {
    const w = await world({
      fetch: (real) => async (input, init) => {
        if (!isPaidCall(init)) return real(input, init);
        const { id } = JSON.parse(init?.body as string) as { id: number };
        const accepted = { ...paymentRequirementsFor({ scheme: "exact", network: ARBITRUM_SEPOLIA, asset: ARBITRUM_SEPOLIA_USDC, amount: "900000", payTo: PROVIDER, maxTimeoutSeconds: 300 }) };
        const required = { x402Version: 2, error: "Payment required", resource: { url: "mcp://tool/lemma_buy_resolution" }, accepts: [accepted] };
        return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(required) }], structuredContent: required } });
      },
    });
    await w.preview();
    const before = w.remote.requests;
    expect((await w.buy()).text).toContain("asked for other payment terms (TERMS_MISMATCH)");
    expect(w.remote.requests - before).toBe(1);
    expect(w.signerLedger.entries()).toHaveLength(1);
  });

  it("does not store a delivery that is not the resolution the offer sold", async () => {
    const w = await world({
      fetch: (real) => async (input, init) => {
        const res = await real(input, init);
        if (!isPaidCall(init)) return res;
        const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
        const delivery = JSON.parse(body.result.content[0]?.text ?? "{}") as { resolution: { profileDigest: string } };
        delivery.resolution.profileDigest = `0x${"ee".repeat(32)}`;
        body.result.content = [{ type: "text", text: JSON.stringify(delivery) } as { text: string }];
        return Response.json(body);
      },
    });
    await w.preview();
    expect((await w.buy()).text).toContain("does not match the offer");
    expect(w.inbox.resolutions()).toEqual([]);
    expect(w.inbox.pending()).toHaveLength(1);
  });

  it("signs the adoption receipt through the signer, and the server verifies it against the buyer", async () => {
    const w = await world();
    await w.preview();
    await w.buy();
    const [resolution] = w.inbox.resolutions();
    if (resolution === undefined) throw new Error("expected a purchase");
    const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: resolution.resolutionId, outcome: "passed", acceptance: { exitCode: 0, durationMs: 900, outputDigest: null }, recordedAt: NOW.toISOString(), signature: null };
    const signed = { ...receipt, signature: await w.signer.signAdoptionReceipt(receipt, resolution.previewId) };
    expect(await w.remote.postReceipt(signed, resolution.previewId)).toBe("ACCEPTED");
    // A public client whose deployless validator call reverts, as it does for an EOA buyer: viem falls back to recovery.
    const chain = createPublicClient({
      chain: arbitrumSepolia,
      transport: custom({
        async request() {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        },
      }),
    });
    const verifier = new ReceiptVerifier({ store: w.store, verifier: viemSignatureVerifier(chain), chainId: 421614, clock: () => NOW, logger: silentLogger });
    expect(await verifier.runOnce()).toEqual({ verified: 1, rejected: 0, failed: 0 });
    expect((await w.service.publicResolution(resolution.resolutionId))?.receipt).toEqual({ outcome: "passed", verified: true });
  });

  it("is registered by main.ts only with a reachable signer and a valid policy", async () => {
    const env = { LEMMA_MAX_USDC_PER_RESOLUTION: "250000", LEMMA_DAILY_USDC_CAP: "1000000", LEMMA_ALLOWED_PAY_TO: PROVIDER, LEMMA_REFUND_TO: "0x00000000000000000000000000000000000000c3" };
    // The start environment is fixed, so a wallet secret in this machine's own environment cannot change the answers.
    const deps = { stateDir: temp("lemma-state-"), root: temp("lemma-root-"), clock: () => NOW, startEnv: {} };
    // Without LEMMA_SIGNER_SOCKET the bridge looks where lemma-signer serve listens by default: <state>/signer/signer.sock.
    expect(await paymentsFromEnv({ ...env }, deps)).toEqual({ note: expect.stringContaining("no signer answers at the default socket") });
    const byDefault = await serveSigner(new LocalSigner(privateKeyToAccount(generatePrivateKey()), basePolicy, new SpendLedger(temp("lemma-signer-"))), { socketPath: defaultSignerSocket(deps.stateDir) });
    try {
      expect((await paymentsFromEnv({ ...env }, deps)).registerPaidTools).toBeDefined();
    } finally {
      await byDefault.close();
    }
    expect((await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "signer.sock" }, deps)).note).toContain("LEMMA_SIGNER_SOCKET must be an absolute path");
    const gone = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: join(deps.stateDir, "none.sock") }, deps);
    expect(gone.registerPaidTools).toBeUndefined();
    expect(gone.note).toContain("no signer answers");
    const signer = new LocalSigner(privateKeyToAccount(generatePrivateKey()), basePolicy, new SpendLedger(temp("lemma-signer-")));
    const signerFor = () => signer;
    const noPolicy = await paymentsFromEnv({ LEMMA_SIGNER_SOCKET: "/unused.sock" }, { ...deps, signerFor });
    expect(noPolicy.registerPaidTools).toBeUndefined();
    expect(noPolicy.signReceipt).toBeDefined();
    const on = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock" }, { ...deps, signerFor });
    expect(on.registerPaidTools).toBeDefined();
    expect(on.note).toBeUndefined();
    // Purchases need a refund address other than the paying wallet, which a withdrawal would show next to the resolution id.
    const { LEMMA_REFUND_TO: _unset, ...noRefund } = env;
    const unset = await paymentsFromEnv({ ...noRefund, LEMMA_SIGNER_SOCKET: "/unused.sock" }, { ...deps, signerFor });
    expect(unset.registerPaidTools).toBeUndefined();
    expect(unset.signReceipt).toBeDefined();
    expect(unset.note).toMatch(/^purchases are off: LEMMA_REFUND_TO is not set/);
    const ownRefund = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock", LEMMA_REFUND_TO: await signer.address() }, { ...deps, signerFor });
    expect(ownRefund.registerPaidTools).toBeUndefined();
    expect(ownRefund.note).toMatch(/^purchases are off: LEMMA_REFUND_TO is the buyer's own address/);
    const warned = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock", ["BUYER" + "_PRIVATE_KEY"]: "set" }, { ...deps, signerFor });
    expect(warned.note).toContain("remove it");
    // A malformed or zero LEMMA_REFUND_TO turns purchases off rather than losing credits (checked below).
    // LEMMA_BUYER_ADDRESS pins the signer: one answering another address is not used, for purchases or receipts.
    const own = await signer.address();
    const pinned = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock", LEMMA_BUYER_ADDRESS: own, LEMMA_REFUND_TO: "0x00000000000000000000000000000000000000c3" }, { ...deps, signerFor });
    expect(pinned.registerPaidTools).toBeDefined();
    expect(pinned.note).toBeUndefined();
    const impostor = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock", LEMMA_BUYER_ADDRESS: "0x00000000000000000000000000000000000000c3" }, { ...deps, signerFor });
    expect(impostor).toEqual({ note: expect.stringMatching(/^purchases are off: the signer at LEMMA_SIGNER_SOCKET answers another address than LEMMA_BUYER_ADDRESS/) });
    expect((await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock", LEMMA_BUYER_ADDRESS: "0xnope" }, { ...deps, signerFor })).note).toMatch(/^purchases are off: LEMMA_BUYER_ADDRESS /);
    // A socket in a directory others can write to could be anyone's: purchases and receipt signing stay off.
    const open = temp("lemma-open-");
    chmodSync(open, 0o777);
    const shared = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: join(open, "signer.sock") }, { ...deps, signerFor });
    expect(shared).toEqual({ note: expect.stringMatching(/^purchases are off: the signer socket's directory can be written by its group or by others/) });
    for (const bad of ["0xnope", "0x0000000000000000000000000000000000000000"]) {
      const off = await paymentsFromEnv({ ...env, LEMMA_SIGNER_SOCKET: "/unused.sock", LEMMA_REFUND_TO: bad }, { ...deps, signerFor });
      expect(off.registerPaidTools).toBeUndefined();
      expect(off.signReceipt).toBeDefined();
      expect(off.note).toMatch(/^purchases are off: LEMMA_REFUND_TO /);
      expect(off.note).not.toContain(bad);
    }
  });
});
