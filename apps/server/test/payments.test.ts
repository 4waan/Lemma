import { inspect } from "node:util";

import {
  type Hex32,
  LEMMA_TOOLS,
  type Preview,
  PreviewResult,
  ResolutionDelivery,
  derivePaymentNonce,
  deriveResolutionId,
  paymentRequirementsFor,
  toAddress,
  warrantyClaimHash,
} from "@lemma/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { PaymentPayload } from "@x402/core/types";
import { resetAssetContractCache } from "@x402/evm";
import { createPublicClient, createWalletClient, custom, getAddress, keccak256, parseAbi, parseTransaction, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MemoryStore,
  RECONCILE_GRACE_MS,
  ResolutionService,
  SettlementReconciler,
  authorizationOf,
  facilitatorWallet,
  inProcessFacilitator,
  paidToolRegistrar,
  paymentResourceServer,
  silentLogger,
  viemFacilitatorSigner,
  x402Requirements,
} from "../src/index.js";
import { FakeUsdc, paymentPayload, permit2Payload } from "./fake-chain.js";
import { NOW, PROVIDER, app, config, gatingTask, matchingProfile, mcpClient, sellableIndex } from "./helpers.js";

const buyer = privateKeyToAccount(generatePrivateKey());
const BUYER = toAddress(buyer.address);
const claimHash = warrantyClaimHash(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, BUYER);
const inWindow = BigInt(Math.floor(NOW.getTime() / 1000) + 300);

interface Harness {
  client: Client;
  usdc: FakeUsdc;
  store: MemoryStore;
  service: ResolutionService;
  preview(): Promise<Preview & { decision: "reuse" | "adapt" }>;
  buy(args: unknown, payment?: unknown): Promise<{ isError: boolean | undefined; text: string; meta: Record<string, unknown> | undefined; structured: unknown }>;
}

async function harness(): Promise<Harness> {
  const usdc = new FakeUsdc();
  const store = new MemoryStore();
  const clock = () => new Date();
  const service = new ResolutionService(store, clock, silentLogger);
  const resourceServer = await paymentResourceServer(inProcessFacilitator(usdc));
  const index = sellableIndex();
  // main.ts saves the catalog at startup; prepare reads the release and bundle from the store.
  await store.saveCatalog(index, NOW);
  const client = await mcpClient(
    app({
      config: config({
        PAID_TOOLS: "on",
        PROVIDER_ADDRESS: PROVIDER,
        FACILITATOR_PRIVATE_KEY: generatePrivateKey(),
        ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
        // The clock stands still in these tests, so the rate limiter never refills.
        RATE_LIMIT_PER_MINUTE: "10000",
      }),
      index,
      store,
      service,
      clock,
      registerPaidTools: paidToolRegistrar({ resourceServer, clock, logger: silentLogger }),
    }),
  );
  return {
    client,
    usdc,
    store,
    service,
    async preview() {
      const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } });
      const { preview } = PreviewResult.parse(result.structuredContent);
      if (preview.decision !== "reuse" || preview.offer === null) throw new Error("expected an offer");
      return preview;
    },
    async buy(args: unknown, payment?: unknown) {
      const result = await client.callTool({ name: LEMMA_TOOLS.buyResolution, arguments: args as Record<string, unknown>, ...(payment === undefined ? {} : { _meta: { "x402/payment": payment } }) });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      return { isError: result.isError as boolean | undefined, text, meta: result._meta as Record<string, unknown> | undefined, structured: result.structuredContent };
    },
  };
}

const nonceFor = (previewId: Hex32, payer = BUYER) => derivePaymentNonce(deriveResolutionId(previewId, payer), previewId);
const termsOf = (preview: Preview) => {
  if (!("offer" in preview) || preview.offer === null) throw new Error("no offer");
  return preview.offer.terms;
};

beforeEach(() => {
  // x402 checks authorization windows against Date.now(); the whole path runs at the tests' instant.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lemma_buy_resolution over x402 (real facilitator, fake USDC)", () => {
  it("is listed with BuyInput and no outputSchema", async () => {
    const { client } = await harness();
    const tool = (await client.listTools()).tools.find((t) => t.name === LEMMA_TOOLS.buyResolution);
    expect(tool?.inputSchema.required?.sort()).toEqual(["claimHash", "previewId"]);
    expect(tool?.outputSchema).toBeUndefined();
    await client.close();
  });

  it("answers an unpaid call with a challenge whose accepts are the quoted terms, and charges nothing", async () => {
    const h = await harness();
    const preview = await h.preview();
    const answer = await h.buy({ previewId: preview.previewId, claimHash });
    expect(answer.isError).toBe(true);
    const challenge = answer.structured as { x402Version: number; accepts: unknown[] };
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toEqual([paymentRequirementsFor(termsOf(preview))]);
    expect(h.usdc.transfers).toEqual([]);
    await h.client.close();
  });

  it("sells once: verifies, prepares, settles once, commits the transaction and keeps the claim hash", async () => {
    const h = await harness();
    const preview = await h.preview();
    const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow);
    const answer = await h.buy({ previewId: preview.previewId, claimHash }, payload);
    expect(answer.isError).toBeFalsy();
    const delivery = ResolutionDelivery.parse(JSON.parse(answer.text));
    const id = deriveResolutionId(preview.previewId, BUYER);
    expect(delivery.resolution).toMatchObject({ resolutionId: id, previewId: preview.previewId, buyer: BUYER, terms: termsOf(preview) });
    expect(h.usdc.transfers).toHaveLength(1);
    expect(h.usdc.transfers[0]).toMatchObject({ from: BUYER, to: PROVIDER, value: 250_000n, nonce: nonceFor(preview.previewId) });
    expect(answer.meta?.["x402/payment-response"]).toMatchObject({ success: true, transaction: h.usdc.transfers[0]?.hash, network: "eip155:421614" });
    const row = await h.store.getResolution(id);
    expect(row).toMatchObject({ state: "settled", settlementRef: h.usdc.transfers[0]?.hash, claimHash, nonce: nonceFor(preview.previewId) });
    expect(await h.service.recover(preview.previewId, BUYER)).toEqual(delivery);
    await h.client.close();
  });

  it("never settles a replayed payment, nor a second payment for the same resolution", async () => {
    const h = await harness();
    const preview = await h.preview();
    const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow);
    expect((await h.buy({ previewId: preview.previewId, claimHash }, payload)).isError).toBeFalsy();
    // The same payload again: USDC's nonce is used, so verification fails and nothing settles.
    const replay = await h.buy({ previewId: preview.previewId, claimHash }, payload);
    expect(replay.isError).toBe(true);
    // A fresh authorization for the same resolution carries the same derived nonce: refused the same way.
    const second = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow + 60n);
    expect((await h.buy({ previewId: preview.previewId, claimHash }, second)).isError).toBe(true);
    expect(h.usdc.transfers).toHaveLength(1);
    expect(h.usdc.calls.filter((c) => c === "write:transferWithAuthorization")).toHaveLength(1);
    await h.client.close();
  });

  it("refuses a second payment while the first is still in flight, without settling it", async () => {
    const h = await harness();
    const preview = await h.preview();
    // A prepared row with another authorization (the first call's settlement still running).
    await h.service.prepare(preview.previewId, { payer: BUYER, nonce: `0x${"0e".repeat(32)}`, validBefore: new Date(Number(inWindow) * 1000) });
    const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow);
    const answer = await h.buy({ previewId: preview.previewId, claimHash }, payload);
    expect(answer).toMatchObject({ isError: true, text: expect.stringMatching(/^IN_FLIGHT: /) });
    expect(h.usdc.transfers).toEqual([]);
    await h.client.close();
  });

  it("refuses a nonce that is not the derived one, before anything is stored or settled", async () => {
    const h = await harness();
    const preview = await h.preview();
    const payload = await paymentPayload(buyer, termsOf(preview), `0x${"5a".repeat(32)}`, inWindow);
    const answer = await h.buy({ previewId: preview.previewId, claimHash }, payload);
    expect(answer).toMatchObject({ isError: true, text: expect.stringMatching(/^WRONG_NONCE: /) });
    expect(h.usdc.transfers).toEqual([]);
    expect(await h.store.getResolution(deriveResolutionId(preview.previewId, BUYER))).toBeUndefined();
    await h.client.close();
  });

  it("refuses an authorization window longer than the quoted one, before anything is stored or settled", async () => {
    const h = await harness();
    const preview = await h.preview();
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    // x402 accepts any window that has not closed; the handler holds it to the quoted 300 seconds plus 60 of slack.
    const tooLong = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), BigInt(nowSeconds + 300 + 61));
    expect(await h.buy({ previewId: preview.previewId, claimHash }, tooLong)).toMatchObject({ isError: true, text: expect.stringMatching(/^UNSUPPORTED_PAYMENT: /) });
    expect(h.usdc.transfers).toEqual([]);
    expect(await h.store.getResolution(deriveResolutionId(preview.previewId, BUYER))).toBeUndefined();
    const edge = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), BigInt(nowSeconds + 300 + 60));
    expect((await h.buy({ previewId: preview.previewId, claimHash }, edge)).isError).toBeFalsy();
    expect(h.usdc.transfers).toHaveLength(1);
    await h.client.close();
  });

  it("refuses a payment to another recipient or of another amount with a new challenge", async () => {
    const h = await harness();
    const preview = await h.preview();
    for (const overrides of [{ to: "0x00000000000000000000000000000000000000ee" as const }, { value: "1" }]) {
      const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow, overrides);
      const answer = await h.buy({ previewId: preview.previewId, claimHash }, payload);
      expect(answer.isError).toBe(true);
      expect((answer.structured as { accepts?: unknown[] }).accepts).toHaveLength(1);
    }
    expect(h.usdc.transfers).toEqual([]);
    await h.client.close();
  });

  it("refuses a Permit2 payload, even one carrying a forged EIP-3009 authorization, before anything is verified, stored or settled", async () => {
    const h = await harness();
    const preview = await h.preview();
    const terms = termsOf(preview);
    // Wallet P signs a valid Permit2 permit for the quoted terms; the payload also names wallet V as the payer
    // in an `authorization` object that x402's Permit2 path never verifies.
    const walletP = privateKeyToAccount(generatePrivateKey());
    const victim = toAddress(privateKeyToAccount(generatePrivateKey()).address);
    const forged = { from: getAddress(victim), to: getAddress(terms.payTo), value: terms.amount, validAfter: "0", validBefore: inWindow.toString(), nonce: nonceFor(preview.previewId, victim) };
    const withForgery = await h.buy({ previewId: preview.previewId, claimHash }, await permit2Payload(walletP, terms, inWindow, { authorization: forged }));
    expect(withForgery.isError).toBe(true);
    expect(await h.store.getResolution(deriveResolutionId(preview.previewId, victim))).toBeUndefined();
    expect(await h.store.getResolution(deriveResolutionId(preview.previewId, toAddress(walletP.address)))).toBeUndefined();
    // A plain Permit2 payload, and an EIP-3009 payload with anything beside its authorization and signature, are refused too.
    expect((await h.buy({ previewId: preview.previewId, claimHash }, await permit2Payload(walletP, terms, inWindow))).isError).toBe(true);
    const padded = await paymentPayload(buyer, terms, nonceFor(preview.previewId), inWindow);
    expect((await h.buy({ previewId: preview.previewId, claimHash }, { ...padded, payload: { ...padded.payload, permit2Authorization: null } })).isError).toBe(true);
    expect(await h.store.getResolution(deriveResolutionId(preview.previewId, BUYER))).toBeUndefined();
    expect(h.usdc.transfers).toEqual([]);
    expect(h.usdc.calls).toEqual([]);
    await h.client.close();
  });

  it("takes the payer only from a payload that is exactly an EIP-3009 authorization and its signature", async () => {
    const h = await harness();
    const preview = await h.preview();
    const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow);
    expect(authorizationOf(payload)).toMatchObject({ payer: BUYER, nonce: nonceFor(preview.previewId) });
    expect(authorizationOf({ ...payload, payload: { ...payload.payload, permit2Authorization: {} } })).toBeUndefined();
    expect(authorizationOf({ ...payload, payload: { ...payload.payload, authorization: { ...payload.payload.authorization, spender: BUYER } } })).toBeUndefined();
    expect(authorizationOf({ ...payload, payload: { authorization: payload.payload.authorization } })).toBeUndefined();
    await h.client.close();
  });

  it("keeps the payer, nonce and signature out of what x402 prints when the facilitator throws", async () => {
    const h = await harness();
    const preview = await h.preview();
    const nonce = nonceFor(preview.previewId);
    const payload = await paymentPayload(buyer, termsOf(preview), nonce, inWindow);
    const quoted = [BUYER, nonce, payload.payload.signature];
    // An RPC failure whose text quotes the request, during the check that the token is a contract (awaited once the signature verified).
    resetAssetContractCache();
    h.usdc.tokenCodeError = `HTTP request failed. Request body: ${JSON.stringify(quoted)}`;
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void printed.push(args.map((a) => inspect(a, { depth: 10 })).join(" ")));
    expect((await h.buy({ previewId: preview.previewId, claimHash }, payload)).isError).toBe(true);
    const all = printed.join("\n").toLowerCase();
    expect(all).toContain("facilitatorerror");
    for (const value of quoted) expect(all).not.toContain(value.slice(2).toLowerCase());
    expect(h.usdc.transfers).toEqual([]);
    // A settlement that fails without throwing keeps its reason code and loses its message.
    h.usdc.tokenCodeError = undefined;
    h.usdc.failWrites = true;
    const failed = await inProcessFacilitator(h.usdc).settle(payload as PaymentPayload, x402Requirements(termsOf(preview)));
    expect(failed).toMatchObject({ success: false, errorReason: expect.any(String) });
    expect(failed).not.toHaveProperty("errorMessage");
    await h.client.close();
  });

  it("never leaves a rejected token check unhandled when the RPC fails during a payment with a bad signature", async () => {
    const h = await harness();
    const preview = await h.preview();
    const down = custom(
      {
        async request() {
          throw new Error("HTTP request failed.");
        },
      },
      { retryCount: 0 },
    );
    const facilitator = inProcessFacilitator(
      viemFacilitatorSigner(createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: arbitrumSepolia, transport: down }), createPublicClient({ chain: arbitrumSepolia, transport: down })),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      resetAssetContractCache();
      // Signed by another key: x402 stops at the signature and never awaits the token check it started.
      const forged = await paymentPayload(privateKeyToAccount(generatePrivateKey()), termsOf(preview), nonceFor(preview.previewId), inWindow);
      const payload = { ...forged, payload: { ...forged.payload, authorization: { ...forged.payload.authorization, from: buyer.address } } };
      expect(await facilitator.verify(payload as PaymentPayload, x402Requirements(termsOf(preview)))).toMatchObject({ isValid: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await h.client.close();
    }
  });

  it("charges nothing for an expired quote, an unknown or no-match preview, or bad input", async () => {
    const h = await harness();
    const preview = await h.preview();
    const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow + 3600n);
    // A no-match preview is never stored, so nothing can be bought from it.
    const noMatch = await h.client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: { schemaVersion: "1", capability: "node-service.add-payment-facilitator" }, profile: matchingProfile } });
    const { preview: build } = PreviewResult.parse(noMatch.structuredContent);
    expect(build.decision).toBe("build");
    expect(await h.buy({ previewId: build.previewId, claimHash }, payload)).toMatchObject({ isError: true, text: expect.stringMatching(/^NOT_FOUND: /) });
    expect(await h.buy({ previewId: preview.previewId }, payload)).toMatchObject({ isError: true, text: expect.stringMatching(/^BAD_INPUT: /) });
    expect(await h.buy({ previewId: preview.previewId, claimHash, buyer: BUYER }, payload)).toMatchObject({ isError: true, text: expect.stringMatching(/^BAD_INPUT: /) });
    vi.setSystemTime(new Date(Date.parse(preview.offer?.validUntil ?? "") + 1000));
    expect(await h.buy({ previewId: preview.previewId, claimHash }, payload)).toMatchObject({ isError: true, text: expect.stringMatching(/^QUOTE_EXPIRED: /) });
    expect(h.usdc.calls).toEqual([]);
    await h.client.close();
  });

  it("leaves a failed settlement prepared, and the reconciler expires it once USDC shows it unused", async () => {
    const h = await harness();
    h.usdc.failWrites = true;
    const preview = await h.preview();
    const payload = await paymentPayload(buyer, termsOf(preview), nonceFor(preview.previewId), inWindow);
    const answer = await h.buy({ previewId: preview.previewId, claimHash }, payload);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("settlement failed");
    const id = deriveResolutionId(preview.previewId, BUYER);
    expect((await h.store.getResolution(id))?.state).toBe("prepared");
    expect(await h.service.recover(preview.previewId, BUYER)).toBe("IN_FLIGHT");
    const later = new Date(Number(inWindow) * 1000 + 10 * 60_000);
    const reconciler = new SettlementReconciler({ service: new ResolutionService(h.store, () => later, silentLogger), chain: h.usdc, clock: () => later, logger: silentLogger });
    // While the chain's head is still inside the window, the authorization could land: the row waits.
    h.usdc.chainTime = new Date(Number(inWindow) * 1000 - 1000);
    expect(await reconciler.runOnce()).toEqual({ settled: 0, expired: 0, waiting: 1, failed: 0, deferred: 0, unchanged: 0 });
    expect((await h.store.getResolution(id))?.state).toBe("prepared");
    h.usdc.chainTime = later;
    expect(await reconciler.runOnce()).toEqual({ settled: 0, expired: 1, waiting: 0, failed: 0, deferred: 0, unchanged: 0 });
    expect((await h.store.getResolution(id))?.state).toBe("expired");
    await h.client.close();
  });

  it("re-arms an expired resolution when the buyer pays again, and settles it once with the new claim hash", async () => {
    const h = await harness();
    h.usdc.failWrites = true;
    const preview = await h.preview();
    const nonce = nonceFor(preview.previewId);
    const id = deriveResolutionId(preview.previewId, BUYER);
    expect((await h.buy({ previewId: preview.previewId, claimHash }, await paymentPayload(buyer, termsOf(preview), nonce, inWindow))).isError).toBe(true);
    // The window closes unused, and the reconciler expires the row while the quote is still open.
    const expiry = new Date(Number(inWindow) * 1000 + RECONCILE_GRACE_MS + 1000);
    h.usdc.chainTime = expiry;
    const reconciler = new SettlementReconciler({ service: new ResolutionService(h.store, () => expiry, silentLogger), chain: h.usdc, clock: () => expiry, logger: silentLogger });
    expect(await reconciler.runOnce()).toMatchObject({ expired: 1 });
    expect(await h.service.recover(preview.previewId, BUYER)).toBe("NOT_FOUND");
    // Paying again: the same resolution and derived nonce (never used on chain), a new window and a new claim.
    vi.setSystemTime(expiry);
    h.usdc.failWrites = false;
    const newClaim = warrantyClaimHash(id, `0x${"33".repeat(32)}`, BUYER);
    const newWindow = BigInt(Math.floor(expiry.getTime() / 1000) + 300);
    const again = await h.buy({ previewId: preview.previewId, claimHash: newClaim }, await paymentPayload(buyer, termsOf(preview), nonce, newWindow));
    expect(again.isError).toBeFalsy();
    expect(ResolutionDelivery.parse(JSON.parse(again.text)).resolution).toMatchObject({ resolutionId: id, buyer: BUYER });
    expect(h.usdc.transfers).toEqual([expect.objectContaining({ from: BUYER, nonce })]);
    expect(await h.store.getResolution(id)).toMatchObject({ state: "settled", nonce, claimHash: newClaim, validBefore: new Date(Number(newWindow) * 1000), settlementRef: h.usdc.transfers[0]?.hash });
    // A third payment carries the same nonce, now spent on chain: x402 refuses it and nothing more settles.
    const third = await h.buy({ previewId: preview.previewId, claimHash: newClaim }, await paymentPayload(buyer, termsOf(preview), nonce, newWindow + 30n));
    expect(third.isError).toBe(true);
    expect(h.usdc.transfers).toHaveLength(1);
    // One send that failed, one settlement.
    expect(h.usdc.calls.filter((c) => c === "write:transferWithAuthorization")).toHaveLength(2);
    expect((await h.store.getResolution(id))?.claimHash).toBe(newClaim);
    await h.client.close();
  });

  it("lets the reconciler commit a settlement that landed after its call failed, so recovery delivers it free", async () => {
    const h = await harness();
    h.usdc.failWrites = true;
    const preview = await h.preview();
    const nonce = nonceFor(preview.previewId);
    await h.buy({ previewId: preview.previewId, claimHash }, await paymentPayload(buyer, termsOf(preview), nonce, inWindow));
    const tx = h.usdc.settleOutside(BUYER, PROVIDER, 250_000n, nonce);
    const later = new Date(Number(inWindow) * 1000 + 10 * 60_000);
    h.usdc.chainTime = later;
    const reconciler = new SettlementReconciler({ service: new ResolutionService(h.store, () => later, silentLogger), chain: h.usdc, clock: () => later, logger: silentLogger });
    expect(await reconciler.runOnce()).toEqual({ settled: 1, expired: 0, waiting: 0, failed: 0, deferred: 0, unchanged: 0 });
    expect((await h.store.getResolution(deriveResolutionId(preview.previewId, BUYER)))?.settlementRef).toBe(tx);
    expect(ResolutionDelivery.safeParse(await h.service.recover(preview.previewId, BUYER)).success).toBe(true);
    await h.client.close();
  });

  it("settles both resolutions when one transaction used two buyers' authorizations, so each buyer recovers theirs", async () => {
    const h = await harness();
    h.usdc.failWrites = true;
    const preview = await h.preview();
    const other = privateKeyToAccount(generatePrivateKey());
    const OTHER = toAddress(other.address);
    for (const [account, payer] of [[buyer, BUYER], [other, OTHER]] as const) {
      expect((await h.buy({ previewId: preview.previewId, claimHash }, await paymentPayload(account, termsOf(preview), nonceFor(preview.previewId, payer), inWindow))).isError).toBe(true);
    }
    // Anyone may submit EIP-3009 authorizations: one call (a multicall, say) uses both, and each pays the quoted amount.
    const amount = BigInt(termsOf(preview).amount);
    const tx = h.usdc.settleOutside(BUYER, PROVIDER, amount, nonceFor(preview.previewId, BUYER));
    h.usdc.settleOutside(OTHER, PROVIDER, amount, nonceFor(preview.previewId, OTHER), tx);
    const later = new Date(Number(inWindow) * 1000 + 10 * 60_000);
    h.usdc.chainTime = later;
    const reconciler = new SettlementReconciler({ service: new ResolutionService(h.store, () => later, silentLogger), chain: h.usdc, clock: () => later, logger: silentLogger });
    expect(await reconciler.runOnce()).toEqual({ settled: 2, expired: 0, waiting: 0, failed: 0, deferred: 0, unchanged: 0 });
    for (const payer of [BUYER, OTHER]) {
      expect(await h.store.getResolution(deriveResolutionId(preview.previewId, payer))).toMatchObject({ state: "settled", settlementRef: tx });
      expect(ResolutionDelivery.parse(await h.service.recover(preview.previewId, payer)).resolution.buyer).toBe(payer);
    }
    expect(await reconciler.runOnce()).toEqual({ settled: 0, expired: 0, waiting: 0, failed: 0, deferred: 0, unchanged: 0 });
    await h.client.close();
  });
});

describe("the facilitator's wallet", () => {
  it("gives settlements sent at the same moment consecutive transaction nonces", async () => {
    const sent: number[] = [];
    const node = custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          switch (method) {
            case "eth_chainId":
              return "0x66eee";
            case "eth_getTransactionCount":
              return "0x5";
            case "eth_estimateGas":
              return "0x5208";
            case "eth_maxPriorityFeePerGas":
            case "eth_gasPrice":
              return "0x1";
            case "eth_getBlockByNumber":
              return { number: "0x1", timestamp: "0x1", baseFeePerGas: "0x1", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"10".repeat(32)}`, transactions: [], logsBloom: null, nonce: null };
            case "eth_sendRawTransaction": {
              const [raw] = params as [`0x${string}`];
              sent.push(parseTransaction(raw).nonce ?? -1);
              return keccak256(stringToHex(`tx ${sent.length}`));
            }
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      },
      { retryCount: 0 },
    );
    const signer = viemFacilitatorSigner(facilitatorWallet(generatePrivateKey(), node), createPublicClient({ chain: arbitrumSepolia, transport: node }));
    const abi = parseAbi(["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)"]);
    const settle = (n: number) =>
      signer.writeContract({ address: getAddress("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d"), abi, functionName: "transferWithAuthorization", args: [BUYER, PROVIDER, 250_000n, 0n, inWindow, `0x${n.toString(16).padStart(64, "0")}`, "0x"] });
    // Two buyers' settlements at once: both would read pending count 5 and send nonce 5 without the nonce manager.
    await Promise.all([settle(1), settle(2)]);
    expect(sent.sort()).toEqual([5, 6]);
  });
});
