import { inspect } from "node:util";

import { resolve } from "@lemma/catalog";
import { type AdoptionReceipt, type Address, type Hex32, type Preview, adoptionReceiptTypedData, deriveResolutionId, toAddress } from "@lemma/core";
import { type Hex, HttpRequestError, createPublicClient, custom, encodeAbiParameters, encodeEventTopics, getAddress, numberToHex, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { beforeEach, describe, expect, it } from "vitest";

import {
  type AuthorizationOutcome,
  type Logger,
  MemoryStore,
  type PaymentChain,
  ReceiptVerifier,
  ResolutionService,
  Secret,
  SettlementReconciler,
  redactingTransport,
  scrubRpcError,
  silentLogger,
  viemPaymentChain,
  viemSignatureVerifier,
} from "../src/index.js";
import { NOW, PROVIDER, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";

const USDC = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d";
const buyer = privateKeyToAccount(generatePrivateKey());
const BUYER = toAddress(buyer.address);
const VALID_BEFORE = new Date(NOW.getTime() + 300_000);
const AFTER = new Date(VALID_BEFORE.getTime() + 10 * 60_000);

async function preparedStore(nonce: Hex32 = `0x${"0a".repeat(32)}`) {
  const store = new MemoryStore();
  const index = sellableIndex();
  await store.saveCatalog(index, NOW);
  const offer: Preview = resolve({ task: gatingTask, profile: matchingProfile }, index, {
    now: NOW,
    previewId: nextPreviewId(),
    payment: { network: "eip155:421614", asset: USDC, maxTimeoutSeconds: 300 },
    offerTtlSeconds: 900,
  });
  await store.saveOffer(offer);
  const service = new ResolutionService(store, () => NOW, silentLogger);
  const prepared = await service.prepare(offer.previewId, { payer: BUYER, nonce, validBefore: VALID_BEFORE });
  if (!prepared.ok) throw new Error("expected a prepared row");
  return { store, offer, id: deriveResolutionId(offer.previewId, BUYER), nonce };
}

const HEAD_BLOCK = 777n;

function chain(used: boolean, outcome: AuthorizationOutcome | Error, headTime: Date | Error = AFTER): PaymentChain & { asked: number; blocks: bigint[] } {
  return {
    asked: 0,
    blocks: [],
    async head() {
      if (headTime instanceof Error) throw headTime;
      return { number: HEAD_BLOCK, timestamp: headTime };
    },
    async authorizationUsed(_authorizer, _nonce, blockNumber) {
      this.asked++;
      this.blocks.push(blockNumber);
      return used;
    },
    async authorizationOutcome() {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

describe("SettlementReconciler", () => {
  it("waits for the grace period after the window before judging a row", async () => {
    const { store } = await preparedStore();
    const c = chain(false, { kind: "unknown" });
    const early = new Date(VALID_BEFORE.getTime() + 60_000);
    await new SettlementReconciler({ service: new ResolutionService(store, () => early, silentLogger), chain: c, clock: () => early, logger: silentLogger }).runOnce();
    expect(c.asked).toBe(0);
  });

  it("commits a used authorization from its log, and expires an unused or canceled one", async () => {
    for (const [used, outcome, state] of [
      [true, { kind: "used", transaction: `0x${"7b".repeat(32)}` }, "settled"],
      [false, { kind: "unknown" }, "expired"],
      [true, { kind: "canceled" }, "expired"],
    ] as const) {
      const { store, id } = await preparedStore();
      const reconciler = new SettlementReconciler({ service: new ResolutionService(store, () => AFTER, silentLogger), chain: chain(used, outcome), clock: () => AFTER, logger: silentLogger });
      await reconciler.runOnce();
      expect((await store.getResolution(id))?.state, JSON.stringify(outcome)).toBe(state);
    }
  });

  it("judges the window by the chain's clock, reading USDC at the head block", async () => {
    // A lagging RPC: this server's clock is well past the window, but the head it serves is not, so "unused" there is not final.
    const lagging = await preparedStore();
    const behind = chain(false, { kind: "unknown" }, new Date(VALID_BEFORE.getTime() - 1000));
    const reconcile = (store: MemoryStore, c: PaymentChain) => new SettlementReconciler({ service: new ResolutionService(store, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger: silentLogger }).runOnce();
    expect(await reconcile(lagging.store, behind)).toEqual({ settled: 0, expired: 0, waiting: 1, failed: 0, deferred: 0, unchanged: 0 });
    expect(behind.asked).toBe(0);
    expect((await lagging.store.getResolution(lagging.id))?.state).toBe("prepared");
    // Once the head is past the window, the state read at that block decides.
    const past = chain(false, { kind: "unknown" }, VALID_BEFORE);
    expect(await reconcile(lagging.store, past)).toEqual({ settled: 0, expired: 1, waiting: 0, failed: 0, deferred: 0, unchanged: 0 });
    expect(past.blocks).toEqual([HEAD_BLOCK]);
    // A head that cannot be read judges nothing.
    const { store, id } = await preparedStore();
    expect(await reconcile(store, chain(false, { kind: "unknown" }, new Error("rpc down")))).toEqual({ settled: 0, expired: 0, waiting: 0, failed: 1, deferred: 0, unchanged: 0 });
    expect((await store.getResolution(id))?.state).toBe("prepared");
  });

  it("leaves a row alone when the log is not found or the chain cannot be asked", async () => {
    for (const [c, report] of [
      [chain(true, { kind: "unknown" }), { settled: 0, expired: 0, waiting: 1, failed: 0, deferred: 0, unchanged: 0 }],
      [chain(true, new Error("rpc down")), { settled: 0, expired: 0, waiting: 0, failed: 1, deferred: 0, unchanged: 0 }],
    ] as const) {
      const { store, id } = await preparedStore();
      const reconciler = new SettlementReconciler({ service: new ResolutionService(store, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger: silentLogger });
      expect(await reconciler.runOnce()).toEqual(report);
      expect((await store.getResolution(id))?.state).toBe("prepared");
    }
  });

  it("expires a row whose authorization was spent on a transfer that did not pay its quoted terms, and never commits it", async () => {
    const { store, id, nonce } = await preparedStore();
    const terms = (await store.getResolution(id))?.resolution.terms;
    const asked: unknown[] = [];
    const c: PaymentChain = {
      head: async () => ({ number: HEAD_BLOCK, timestamp: AFTER }),
      authorizationUsed: async () => true,
      async authorizationOutcome(authorizer, n, quoted) {
        asked.push([authorizer, n, quoted]);
        return { kind: "mismatched" };
      },
    };
    const logged: unknown[] = [];
    const logger: Logger = { log: (level, event, fields) => void logged.push([level, event, fields]) };
    const reconciler = new SettlementReconciler({ service: new ResolutionService(store, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger });
    expect(await reconciler.runOnce()).toEqual({ settled: 0, expired: 1, waiting: 0, failed: 0, deferred: 0, unchanged: 0 });
    expect(await store.getResolution(id)).toMatchObject({ state: "expired", settlementRef: null });
    // The chain is asked whether the row's own terms were paid, and the log names the resolution only.
    expect(asked).toEqual([[BUYER, nonce, terms]]);
    expect(logged).toContainEqual(["warn", "reconcile.transfer_mismatch", { resolutionId: id }]);
  });
});

describe("SettlementReconciler with rows it cannot decide", () => {
  /** Unsettled rows for one offer, one per payer, each window a second after the last. */
  async function unsettledRows(count: number) {
    const store = new MemoryStore();
    const index = sellableIndex();
    await store.saveCatalog(index, NOW);
    const offer: Preview = resolve({ task: gatingTask, profile: matchingProfile }, index, {
      now: NOW,
      previewId: nextPreviewId(),
      payment: { network: "eip155:421614", asset: USDC, maxTimeoutSeconds: 300 },
      offerTtlSeconds: 900,
    });
    await store.saveOffer(offer);
    const service = new ResolutionService(store, () => NOW, silentLogger);
    const rows: Array<{ id: Hex32; nonce: Hex32 }> = [];
    for (let i = 0; i < count; i++) {
      const payer = toAddress(privateKeyToAccount(generatePrivateKey()).address);
      const nonce = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex32;
      const prepared = await service.prepare(offer.previewId, { payer, nonce, validBefore: new Date(VALID_BEFORE.getTime() + i * 1000) });
      if (!prepared.ok) throw new Error("expected a prepared row");
      rows.push({ id: deriveResolutionId(offer.previewId, payer), nonce });
    }
    return { store, rows };
  }

  it("looks past rows it could not decide, so more of them than a batch never keep a newer row from being judged", async () => {
    // Three older rows are used on chain but their log is never found; the newest was never paid. A run asks about two rows.
    const { store, rows } = await unsettledRows(4);
    const unpaid = rows[3] as { id: Hex32; nonce: Hex32 };
    const asked: string[] = [];
    const c: PaymentChain = {
      head: async () => ({ number: HEAD_BLOCK, timestamp: AFTER }),
      async authorizationUsed(_authorizer, nonce) {
        asked.push(nonce);
        return nonce !== unpaid.nonce;
      },
      authorizationOutcome: async () => ({ kind: "unknown" }),
    };
    const reconciler = new SettlementReconciler({ service: new ResolutionService(store, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger: silentLogger, batch: 2 });
    for (let run = 0; run < 3; run++) await reconciler.runOnce();
    expect((await store.getResolution(unpaid.id))?.state).toBe("expired");
    // Each undecided row was asked about once: later runs waited out its backoff.
    expect(asked.filter((n) => n !== unpaid.nonce).sort()).toEqual(rows.slice(0, 3).map((r) => r.nonce));
    for (const row of rows.slice(0, 3)) expect((await store.getResolution(row.id))?.state).toBe("prepared");
  });

  it("looks at an undecided row again after a backoff that doubles from one interval", async () => {
    const { store } = await preparedStore();
    let now = AFTER;
    const c = chain(true, { kind: "unknown" });
    const reconciler = new SettlementReconciler({ service: new ResolutionService(store, () => now, silentLogger), chain: c, clock: () => now, logger: silentLogger });
    const at = async (ms: number) => {
      now = new Date(AFTER.getTime() + ms);
      return reconciler.runOnce();
    };
    expect(await at(0)).toMatchObject({ waiting: 1, deferred: 0 });
    expect(await at(30_000)).toMatchObject({ waiting: 0, deferred: 1 });
    expect(await at(60_000)).toMatchObject({ waiting: 1, deferred: 0 });
    // Second failure: two intervals.
    expect(await at(150_000)).toMatchObject({ waiting: 0, deferred: 1 });
    expect(await at(180_000)).toMatchObject({ waiting: 1, deferred: 0 });
    expect(c.asked).toBe(3);
  });

  const none = { settled: 0, expired: 0, waiting: 0, failed: 0, deferred: 0, unchanged: 0 };

  it("settles every row whose authorization one transaction used, more of them than a batch, and still reaches a newer unpaid row", async () => {
    // Anyone may submit EIP-3009 authorizations, so one transaction (a multicall, say) can use four, each a payment; the newest row was never paid.
    const { store, rows } = await unsettledRows(5);
    const unpaid = rows[4] as { id: Hex32; nonce: Hex32 };
    const tx = `0x${"7d".repeat(32)}` as Hex32;
    const c: PaymentChain = {
      head: async () => ({ number: HEAD_BLOCK, timestamp: AFTER }),
      authorizationUsed: async (_authorizer, nonce) => nonce !== unpaid.nonce,
      authorizationOutcome: async () => ({ kind: "used", transaction: tx }),
    };
    const reconciler = new SettlementReconciler({ service: new ResolutionService(store, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger: silentLogger, batch: 2 });
    expect(await reconciler.runOnce()).toEqual({ ...none, settled: 2 });
    expect(await reconciler.runOnce()).toEqual({ ...none, settled: 2 });
    expect(await reconciler.runOnce()).toEqual({ ...none, expired: 1 });
    for (const row of rows.slice(0, 4)) expect(await store.getResolution(row.id)).toMatchObject({ state: "settled", settlementRef: tx });
    expect((await store.getResolution(unpaid.id))?.state).toBe("expired");
  });

  it("backs off a row whose commit or expiry changed nothing, so such rows never keep a newer row from being judged", async () => {
    // Four used rows whose settlement the store does not record (a rule the reconciler knows nothing of, say), then an unpaid row.
    const { store, rows } = await unsettledRows(5);
    const unpaid = rows[4] as { id: Hex32; nonce: Hex32 };
    const refusing = Object.assign(Object.create(store) as MemoryStore, { markSettled: async () => false });
    const c: PaymentChain = {
      head: async () => ({ number: HEAD_BLOCK, timestamp: AFTER }),
      authorizationUsed: async (_authorizer, nonce) => nonce !== unpaid.nonce,
      authorizationOutcome: async () => ({ kind: "used", transaction: `0x${"7d".repeat(32)}` }),
    };
    const reconciler = new SettlementReconciler({ service: new ResolutionService(refusing, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger: silentLogger, batch: 2 });
    expect(await reconciler.runOnce()).toEqual({ ...none, unchanged: 2 });
    expect(await reconciler.runOnce()).toEqual({ ...none, unchanged: 2, deferred: 2 });
    expect(await reconciler.runOnce()).toEqual({ ...none, expired: 1, deferred: 4 });
    expect((await store.getResolution(unpaid.id))?.state).toBe("expired");
    for (const row of rows.slice(0, 4)) expect((await store.getResolution(row.id))?.state).toBe("prepared");
    // An expiry the store does not record is backed off the same way.
    const one = await preparedStore();
    const stuck = Object.assign(Object.create(one.store) as MemoryStore, { markExpired: async () => false });
    const expiring = new SettlementReconciler({ service: new ResolutionService(stuck, () => AFTER, silentLogger), chain: chain(false, { kind: "unknown" }), clock: () => AFTER, logger: silentLogger });
    expect(await expiring.runOnce()).toEqual({ ...none, unchanged: 1 });
    expect(await expiring.runOnce()).toEqual({ ...none, deferred: 1 });
  });

  it("counts a store failure as failed, never as settled or expired, and looks at the row again later", async () => {
    const down = await preparedStore();
    const failing = Object.assign(Object.create(down.store) as MemoryStore, {
      markSettled: async () => {
        throw new Error("database down");
      },
      markExpired: async () => {
        throw new Error("database down");
      },
    });
    const broken = new SettlementReconciler({ service: new ResolutionService(failing, () => AFTER, silentLogger), chain: chain(true, { kind: "used", transaction: `0x${"7e".repeat(32)}` }), clock: () => AFTER, logger: silentLogger });
    expect(await broken.runOnce()).toMatchObject({ settled: 0, failed: 1 });
    expect((await down.store.getResolution(down.id))?.state).toBe("prepared");
    // Unused or canceled: the expiry fails the same way, and the run still finishes with a report.
    for (const c of [chain(false, { kind: "unknown" }), chain(true, { kind: "canceled" })]) {
      const expiring = new SettlementReconciler({ service: new ResolutionService(failing, () => AFTER, silentLogger), chain: c, clock: () => AFTER, logger: silentLogger });
      expect(await expiring.runOnce()).toEqual({ ...none, failed: 1 });
      expect(await expiring.runOnce()).toEqual({ ...none, deferred: 1 });
      expect((await down.store.getResolution(down.id))?.state).toBe("prepared");
    }
  });
});

describe("ReceiptVerifier", () => {
  let store: MemoryStore;
  let id: Hex32;
  let receipt: AdoptionReceipt;

  beforeEach(async () => {
    const prepared = await preparedStore();
    store = prepared.store;
    id = prepared.id;
    const service = new ResolutionService(store, () => NOW, silentLogger);
    await service.commit(id, { nonce: prepared.nonce, settlementRef: `0x${"7b".repeat(32)}` });
    receipt = { schemaVersion: "1", resolutionId: id, outcome: "passed", acceptance: { exitCode: 0, durationMs: 1000, outputDigest: null }, recordedAt: NOW.toISOString(), signature: null };
  });

  const submit = async (r: AdoptionReceipt) => {
    const previewId = (await store.getResolution(id))?.previewId as Hex32;
    expect(await new ResolutionService(store, () => NOW, silentLogger).acceptReceipt({ receipt: r, previewId })).toBe("ACCEPTED");
  };
  const signedBy = async (account = buyer) => ({ ...receipt, signature: (await account.signTypedData(adoptionReceiptTypedData(receipt, 421614))).toLowerCase() });

  /** A viem public client whose eth_call fails the way a reverting deployless validator does, so EOAs verify by recovery. */
  const eoaOnlyChain = () =>
    createPublicClient({
      chain: arbitrumSepolia,
      transport: custom({
        async request({ method }) {
          if (method === "eth_call") throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
          throw new Error(`unexpected ${method}`);
        },
      }),
    });

  it("verifies the buyer's signature with viem verifyTypedData on a public client, once", async () => {
    await submit(await signedBy());
    const verifier = new ReceiptVerifier({ store, verifier: viemSignatureVerifier(eoaOnlyChain()), chainId: 421614, clock: () => NOW, logger: silentLogger });
    expect(await verifier.runOnce()).toEqual({ verified: 1, rejected: 0, failed: 0 });
    expect((await store.getReceipt(id))?.verified).toBe(true);
    expect(await verifier.runOnce()).toEqual({ verified: 0, rejected: 0, failed: 0 });
  });

  it("leaves another signer's receipt, and an unsigned one, unverified and checked", async () => {
    await submit(await signedBy(privateKeyToAccount(generatePrivateKey())));
    const verifier = new ReceiptVerifier({ store, verifier: viemSignatureVerifier(eoaOnlyChain()), chainId: 421614, clock: () => NOW, logger: silentLogger });
    expect(await verifier.runOnce()).toEqual({ verified: 0, rejected: 1, failed: 0 });
    expect((await store.getReceipt(id))?.verified).toBe(false);
    expect(await store.listUncheckedReceipts(10)).toEqual([]);

    const fresh = await preparedStore(`0x${"0b".repeat(32)}`);
    await new ResolutionService(fresh.store, () => NOW, silentLogger).commit(fresh.id, { nonce: fresh.nonce, settlementRef: `0x${"7c".repeat(32)}` });
    expect(await new ResolutionService(fresh.store, () => NOW, silentLogger).acceptReceipt({ receipt: { ...receipt, resolutionId: fresh.id }, previewId: fresh.offer.previewId })).toBe("ACCEPTED");
    const unsigned = new ReceiptVerifier({ store: fresh.store, verifier: { verifyTypedData: async () => { throw new Error("never asked"); } }, chainId: 421614, clock: () => NOW, logger: silentLogger });
    expect(await unsigned.runOnce()).toEqual({ verified: 0, rejected: 1, failed: 0 });
  });

  it("accepts a smart account's signature when its ERC-1271 check says so through the deployless validator", async () => {
    await submit({ ...receipt, signature: `0x${"ab".repeat(100)}` });
    let calls = 0;
    const smartAccountChain = createPublicClient({
      chain: arbitrumSepolia,
      transport: custom({
        async request({ method }) {
          calls++;
          if (method === "eth_call") return `0x${"0".repeat(63)}1`;
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    const verifier = new ReceiptVerifier({ store, verifier: viemSignatureVerifier(smartAccountChain), chainId: 421614, clock: () => NOW, logger: silentLogger });
    expect(await verifier.runOnce()).toEqual({ verified: 1, rejected: 0, failed: 0 });
    expect(calls).toBe(1);
  });

  it("checks again later when the chain cannot answer", async () => {
    await submit(await signedBy());
    const down = new ReceiptVerifier({ store, verifier: { verifyTypedData: async () => { throw new Error("rpc down"); } }, chainId: 421614, clock: () => NOW, logger: silentLogger });
    expect(await down.runOnce()).toEqual({ verified: 0, rejected: 0, failed: 1 });
    expect(await store.listUncheckedReceipts(10)).toHaveLength(1);
    expect((await store.getReceipt(id))?.verified).toBe(false);
  });
});

describe("viem chain reads", () => {
  const nonce = `0x${"3c".repeat(32)}` as Hex32;
  const TX = `0x${"9d".repeat(32)}`;
  const AMOUNT = 250_000n;
  /** The quoted terms the authorization was signed for. */
  const TERMS = { payTo: PROVIDER, amount: AMOUNT.toString() };
  const events = parseAbi([
    "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
    "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);

  type RawLog = { address: string; topics: Hex[]; data: Hex };
  /** USDC's AuthorizationUsed log, by default for the buyer's authorization with `nonce`. */
  const usedLog = (authorizer: Address = BUYER, usedNonce: Hex32 = nonce): RawLog => ({
    address: USDC,
    topics: encodeEventTopics({ abi: events, eventName: "AuthorizationUsed", args: { authorizer: getAddress(authorizer), nonce: usedNonce as Hex } }) as Hex[],
    data: "0x",
  });
  /** A Transfer log, by default USDC's of the quoted amount from the buyer to the quoted payee. */
  const transferLog = (t: { from?: Address; to?: Address; value?: bigint; address?: string } = {}): RawLog => ({
    address: t.address ?? USDC,
    topics: encodeEventTopics({ abi: events, eventName: "Transfer", args: { from: getAddress(t.from ?? BUYER), to: getAddress(t.to ?? PROVIDER) } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [t.value ?? AMOUNT]),
  });

  /**
   * A JSON-RPC node for viem: block n's timestamp is `latestTime` less (latest - n) / blocksPerSecond seconds
   * (default four blocks a second), one AuthorizationUsed log at `logAt` in transaction TX, whose receipt holds
   * `receipt` (by default that log and USDC's Transfer of the quoted terms), and `eth_getLogs` ranges wider than
   * `maxRange` refused with a JSON-RPC error, as providers do.
   */
  function fakeRpc(options: { used: boolean; latest: bigint; latestTime: number; logAt?: bigint; blocksPerSecond?: number; maxRange?: bigint; receipt?: RawLog[] }) {
    const requests: Array<{ method: string; params: unknown }> = [];
    const rate = BigInt(options.blocksPerSecond ?? 4);
    const timestampAt = (n: bigint) => BigInt(options.latestTime) - (options.latest - n) / rate;
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: custom(
        {
          async request({ method, params }: { method: string; params: unknown }) {
            requests.push({ method, params });
            if (method === "eth_call") return encodeAbiParameters([{ type: "bool" }], [options.used]);
            if (method === "eth_getBlockByNumber") {
              const [tag] = params as [string];
              const n = tag === "latest" ? options.latest : BigInt(tag);
              return { number: numberToHex(n), timestamp: numberToHex(timestampAt(n)), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"10".repeat(32)}`, transactions: [], logsBloom: null, nonce: null };
            }
            if (method === "eth_getLogs") {
              const [filter] = params as [{ topics: Array<string | string[] | null>; fromBlock: Hex; toBlock: Hex }];
              if (options.maxRange !== undefined && BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > options.maxRange) {
                throw Object.assign(new Error("block range too large"), { code: -32005 });
              }
              const usedTopic = encodeEventTopics({ abi: events, eventName: "AuthorizationUsed" })[0];
              const wanted = filter.topics[0];
              const asked = Array.isArray(wanted) ? wanted.includes(usedTopic) : wanted === usedTopic;
              const inRange = options.logAt !== undefined && BigInt(filter.fromBlock) <= options.logAt && options.logAt <= BigInt(filter.toBlock);
              if (!asked || !inRange) return [];
              return [{ ...usedLog(), blockNumber: numberToHex(options.logAt as bigint), transactionHash: TX, transactionIndex: "0x0", blockHash: `0x${"12".repeat(32)}`, logIndex: "0x0", removed: false }];
            }
            if (method === "eth_getTransactionReceipt") {
              const [hash] = params as [string];
              if (hash.toLowerCase() !== TX) return null;
              const block = { blockNumber: numberToHex(options.logAt ?? 0n), blockHash: `0x${"12".repeat(32)}`, transactionHash: TX, transactionIndex: "0x3" };
              // Log indexes count across the block, so this transaction's first log is not log 0.
              const logs = (options.receipt ?? [usedLog(), transferLog()]).map((log, i) => ({ ...log, ...block, logIndex: numberToHex(7 + i), removed: false }));
              return { ...block, from: BUYER, to: USDC, status: "0x1", type: "0x2", cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null, logs, logsBloom: `0x${"00".repeat(256)}` };
            }
            throw new Error(`unexpected ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    });
    const logRequests = () => requests.filter((r) => r.method === "eth_getLogs").map((r) => (r.params as [{ topics: unknown[]; fromBlock: Hex; toBlock: Hex }])[0]);
    return { client, requests, timestampAt, logRequests };
  }

  it("reads the head block, and authorizationState from USDC at a given block", async () => {
    const { client, requests } = fakeRpc({ used: true, latest: 1000n, latestTime: 1_000_000 });
    expect(await viemPaymentChain(client, USDC).head()).toEqual({ number: 1000n, timestamp: new Date(1_000_000_000) });
    expect(await viemPaymentChain(client, USDC).authorizationUsed(BUYER, nonce, 1000n)).toBe(true);
    const [call, block] = requests.find((r) => r.method === "eth_call")?.params as [{ to: string; data: string }, string];
    expect(call.to.toLowerCase()).toBe(USDC);
    // authorizationState(address,bytes32), at block 1000, not "latest".
    expect(call.data.slice(0, 10)).toBe("0xe94a0102");
    expect(block).toBe("0x3e8");
  });

  it("finds the settling transaction by the indexed authorizer and nonce, starting at the last block before the window", async () => {
    const latestTime = 2_000_000;
    const from = latestTime - 600;
    const { client, timestampAt, logRequests } = fakeRpc({ used: true, latest: 50_000n, latestTime, logAt: 49_500n });
    const outcome = await viemPaymentChain(client, USDC).authorizationOutcome(BUYER, nonce, TERMS, { from: new Date(from * 1000) });
    expect(outcome).toEqual({ kind: "used", transaction: TX });
    const [first] = logRequests();
    const start = BigInt(first?.fromBlock as Hex);
    expect(timestampAt(start)).toBeLessThan(from);
    expect(timestampAt(start + 1n)).toBeGreaterThanOrEqual(from);
    expect(first?.topics.slice(1)).toEqual([toHex(BigInt(BUYER), { size: 32 }), nonce]);
  });

  it("finds a log far past where a fixed block-rate guess would stop, whatever the block rate", async () => {
    // One block a second, and a transfer eight days back: the search starts at the window by the blocks' own timestamps.
    const latestTime = 10_000_000;
    const from = latestTime - 700_000;
    const { client, requests, logRequests } = fakeRpc({ used: true, latest: 3_000_000n, latestTime, logAt: 2_300_300n, blocksPerSecond: 1 });
    expect(await viemPaymentChain(client, USDC).authorizationOutcome(BUYER, nonce, TERMS, { from: new Date(from * 1000) })).toEqual({ kind: "used", transaction: TX });
    expect(logRequests()).toHaveLength(1);
    // Bisection over block timestamps: a few dozen block reads at most.
    expect(requests.filter((r) => r.method === "eth_getBlockByNumber").length).toBeLessThan(30);
  });

  it("halves the block range while the RPC refuses it, and still finds the log", async () => {
    const latestTime = 2_000_000;
    const { client, logRequests } = fakeRpc({ used: true, latest: 50_000n, latestTime, logAt: 49_000n, maxRange: 1_000n });
    expect(await viemPaymentChain(client, USDC).authorizationOutcome(BUYER, nonce, TERMS, { from: new Date((latestTime - 900) * 1000) })).toEqual({ kind: "used", transaction: TX });
    // The whole way to the head at first (3,605 blocks), refused and halved twice, then walked in accepted ranges.
    const ranges = logRequests().map((f) => BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n);
    expect(ranges.slice(0, 3)).toEqual([3_605n, 1_802n, 901n]);
    expect(ranges.slice(2).every((r) => r <= 1_000n)).toBe(true);
  });

  it("answers used only when the log right after AuthorizationUsed is USDC's Transfer of the quoted amount to the quoted payee", async () => {
    const otherPayee = "0x00000000000000000000000000000000000000ee";
    const otherContract = "0x00000000000000000000000000000000000000cc";
    const otherNonce = `0x${"4d".repeat(32)}` as Hex32;
    const cases: Array<[string, RawLog[], AuthorizationOutcome]> = [
      ["the quoted transfer", [usedLog(), transferLog()], { kind: "used", transaction: TX }],
      ["another payee", [usedLog(), transferLog({ to: otherPayee })], { kind: "mismatched" }],
      ["another amount", [usedLog(), transferLog({ value: AMOUNT - 1n })], { kind: "mismatched" }],
      ["a Transfer from another contract", [usedLog(), transferLog({ address: otherContract })], { kind: "mismatched" }],
      ["no Transfer", [usedLog()], { kind: "mismatched" }],
      ["another USDC event", [usedLog(), usedLog(BUYER, otherNonce), transferLog()], { kind: "mismatched" }],
      // One transaction, two of the buyer's authorizations: the quoted transfer is there, but another authorization made it.
      ["the quoted transfer, made by another authorization", [usedLog(), transferLog({ to: BUYER, value: 0n }), usedLog(BUYER, otherNonce), transferLog()], { kind: "mismatched" }],
      ["the quoted transfer, after another authorization's", [usedLog(BUYER, otherNonce), transferLog({ to: BUYER, value: 0n }), usedLog(), transferLog()], { kind: "used", transaction: TX }],
      // The node no longer shows the log in this transaction (a reorganization since the search): undecided, never mismatched.
      ["a receipt without the AuthorizationUsed log", [transferLog()], { kind: "unknown" }],
    ];
    for (const [name, receipt, outcome] of cases) {
      const { client } = fakeRpc({ used: true, latest: 50_000n, latestTime: 2_000_000, logAt: 49_990n, receipt });
      expect(await viemPaymentChain(client, USDC).authorizationOutcome(BUYER, nonce, TERMS, { from: new Date((2_000_000 - 60) * 1000) }), name).toEqual(outcome);
    }
  });

  it("still fails when the RPC does not answer at all, rather than narrowing the range forever", async () => {
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: custom(
        {
          async request({ method }: { method: string }) {
            if (method === "eth_getBlockByNumber") return { number: "0x64", timestamp: numberToHex(2_000_000), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"10".repeat(32)}`, transactions: [], logsBloom: null, nonce: null };
            throw new Error("socket hang up");
          },
        },
        { retryCount: 0 },
      ),
    });
    await expect(viemPaymentChain(client, USDC).authorizationOutcome(BUYER, nonce, TERMS, { from: new Date((2_000_000 - 60) * 1000) })).rejects.toThrow();
  });

  it("answers unknown when no log is in range", async () => {
    const { client } = fakeRpc({ used: true, latest: 50_000n, latestTime: 2_000_000 });
    expect(await viemPaymentChain(client, USDC).authorizationOutcome(BUYER, nonce, TERMS, { from: new Date((2_000_000 - 60) * 1000) })).toEqual({ kind: "unknown" });
  });
});

describe("RPC errors and secrets", () => {
  const key = ["k", "3y", "Z9", "q7", "x1", "w5", "v2", "u8"].join("");
  const url = `https://arb-sepolia.rpc.example/v2/${key}`;

  it("scrubs the RPC URL from viem's errors, keeping the JSON-RPC code and data", () => {
    const original = Object.assign(new HttpRequestError({ url, body: { method: "eth_call" }, details: "boom" }), { code: 3, data: "0x08c379a0" });
    const scrubbed = scrubRpcError(original, url);
    expect(`${scrubbed.message} ${JSON.stringify(scrubbed)} ${inspect(scrubbed)}`).not.toContain(key);
    expect(scrubbed).toMatchObject({ name: "HttpRequestError", code: 3, data: "0x08c379a0" });
  });

  it("never lets a failing request's error carry the URL", async () => {
    const secretUrl = `http://127.0.0.1:9/${key}`;
    const client = createPublicClient({ chain: arbitrumSepolia, transport: redactingTransport(new Secret(secretUrl), { timeoutMs: 2000 }) });
    const error = await client.getChainId().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const all = `${String(error)} ${inspect(error, { depth: 10 })} ${JSON.stringify(error)}`;
    expect(all).not.toContain(key);
  });
});
