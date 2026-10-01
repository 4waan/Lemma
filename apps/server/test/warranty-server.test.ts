import { CatalogView, type Hex32, ResolutionView, StatusView, WarrantyWithdrawalAnswer, WarrantyWithdrawalRefusal } from "@lemma/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import {
  ConfigError,
  Secret,
  WITHDRAWALS_PATH,
  type WarrantyConfig,
  type WarrantyPipeline,
  WarrantyStartupError,
  checkRegistry,
  loadConfig,
  startWarrantyPipeline,
} from "../src/index.js";
import { REGISTRY } from "./fake-registry.js";
import { PROVIDER, app, config, timesOfDay } from "./helpers.js";
import { type Bought, idOf, warrantyWorld } from "./warranty-helpers.js";

type World = Awaited<ReturnType<typeof warrantyWorld>>;

const OTHER_BUYER_ADDRESS = "0x00000000000000000000000000000000000000c1";

/** Everything paid tools need, as config accepts them; keys made at run time. */
const paid = () => ({
  NODE_ENV: "test",
  PAID_TOOLS: "on",
  PROVIDER_ADDRESS: PROVIDER,
  FACILITATOR_PRIVATE_KEY: generatePrivateKey(),
  ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
  DATABASE_URL: "postgres://lemma@localhost:5432/lemma",
});
const warrantyEnv = () => {
  const providerKey = generatePrivateKey();
  return { ...paid(), PROVIDER_ADDRESS: privateKeyToAccount(providerKey).address, RESOLUTION_WARRANTY_REGISTRY_ADDRESS: REGISTRY, PROVIDER_PRIVATE_KEY: providerKey, EVALUATOR_PRIVATE_KEY: generatePrivateKey() };
};

describe("warranty configuration", () => {
  it("leaves the pipeline off, and nothing else changed, when none of it is set", () => {
    expect(loadConfig({ NODE_ENV: "test" }).warranty).toBeUndefined();
    // .env.example's empty placeholders are unset.
    const placeholders = { RESOLUTION_WARRANTY_REGISTRY_ADDRESS: "", PROVIDER_PRIVATE_KEY: "", EVALUATOR_PRIVATE_KEY: "", WARRANTY_REGISTRY_START_BLOCK: "", EVALUATOR_FAILURES: "", WARRANTY_ACTIVATION_JITTER_SECONDS: "", WARRANTY_ACTIVATION_BATCH_SECONDS: "", BUYER_COUNTS_REFRESH_SECONDS: "" };
    expect(loadConfig({ ...paid(), ...placeholders }).warranty).toBeUndefined();
  });

  it("turns it on with everything it needs, keeping both keys secret", () => {
    const env = { ...warrantyEnv(), WARRANTY_REGISTRY_START_BLOCK: "123456", EVALUATOR_FAILURES: "auto", WARRANTY_ACTIVATION_JITTER_SECONDS: "0", WARRANTY_ACTIVATION_BATCH_SECONDS: "0", BUYER_COUNTS_REFRESH_SECONDS: "0" };
    const c = loadConfig(env);
    expect(c.warranty).toMatchObject({
      registry: REGISTRY,
      startBlock: 123_456n,
      providerAddress: privateKeyToAccount(env.PROVIDER_PRIVATE_KEY).address.toLowerCase(),
      evaluatorAddress: privateKeyToAccount(env.EVALUATOR_PRIVATE_KEY).address.toLowerCase(),
      failures: "auto",
      activationJitterSeconds: 0,
      activationBatchSeconds: 0,
      buyerCountsRefreshSeconds: 0,
    });
    expect(c.warranty?.providerKey.reveal()).toBe(env.PROVIDER_PRIVATE_KEY);
    const printed = JSON.stringify(c, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    for (const key of [env.PROVIDER_PRIVATE_KEY, env.EVALUATOR_PRIVATE_KEY]) expect(printed).not.toContain(key.slice(2));
    // Defaults: review, hourly batches (300 seconds of jitter when they are off), block 0, 64 confirmations.
    expect(loadConfig(warrantyEnv()).warranty).toMatchObject({ failures: "review", activationJitterSeconds: 300, activationBatchSeconds: 3600, buyerCountsRefreshSeconds: 86_400, startBlock: 0n, indexerConfirmations: 64n });
    expect(loadConfig({ ...warrantyEnv(), WARRANTY_INDEXER_CONFIRMATIONS: "0" }).warranty?.indexerConfirmations).toBe(0n);
    expect(loadConfig({ ...warrantyEnv(), WARRANTY_INDEXER_CONFIRMATIONS: "240" }).warranty?.indexerConfirmations).toBe(240n);
    expect(loadConfig({ ...warrantyEnv(), WARRANTY_INDEXER_CONFIRMATIONS: "" }).warranty?.indexerConfirmations).toBe(64n);
  });

  it("refuses a partial configuration, naming what is missing and never a value", () => {
    const key = generatePrivateKey();
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ NODE_ENV: "test", RESOLUTION_WARRANTY_REGISTRY_ADDRESS: REGISTRY }, /PAID_TOOLS=on, PROVIDER_PRIVATE_KEY, EVALUATOR_PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC_URL, DATABASE_URL/],
      [{ ...paid(), PROVIDER_PRIVATE_KEY: key }, /\(PROVIDER_PRIVATE_KEY set\).*RESOLUTION_WARRANTY_REGISTRY_ADDRESS, EVALUATOR_PRIVATE_KEY/],
      [{ ...warrantyEnv(), DATABASE_URL: "" }, /needs DATABASE_URL/],
      [{ ...warrantyEnv(), PAID_TOOLS: "off" }, /needs PAID_TOOLS=on/],
      [{ ...paid(), WARRANTY_REGISTRY_START_BLOCK: "5" }, /\(WARRANTY_REGISTRY_START_BLOCK set\)/],
    ];
    for (const [env, message] of cases) {
      expect(() => loadConfig(env), JSON.stringify(Object.keys(env))).toThrow(message);
      try {
        loadConfig(env);
      } catch (error) {
        expect((error as Error).message).not.toContain(key.slice(2));
      }
    }
  });

  it("refuses a key that is not one, one account in two roles, or a provider key that is not PROVIDER_ADDRESS", () => {
    const zero = `0x${"0".repeat(64)}`;
    expect(() => loadConfig({ ...warrantyEnv(), PROVIDER_PRIVATE_KEY: zero })).toThrow(/^PROVIDER_PRIVATE_KEY is not a valid secp256k1 private key; its value is not shown$/);
    const shared = generatePrivateKey();
    expect(() => loadConfig({ ...warrantyEnv(), PROVIDER_PRIVATE_KEY: shared, EVALUATOR_PRIVATE_KEY: shared })).toThrow(/PROVIDER_PRIVATE_KEY and EVALUATOR_PRIVATE_KEY are the same account/);
    expect(() => loadConfig({ ...warrantyEnv(), PROVIDER_PRIVATE_KEY: shared, FACILITATOR_PRIVATE_KEY: shared })).toThrow(/PROVIDER_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY/);
    const attester = { ATTESTER_PRIVATE_KEY: shared, LEMMA_AGENT_ID: "7", PUBLIC_BASE_URL: "https://lemma.example" };
    expect(() => loadConfig({ ...warrantyEnv(), ...attester, EVALUATOR_PRIVATE_KEY: shared })).toThrow(/EVALUATOR_PRIVATE_KEY and ATTESTER_PRIVATE_KEY/);
    expect(loadConfig({ ...warrantyEnv(), ...attester }).warranty).toBeDefined();
    // Offers pay PROVIDER_ADDRESS, and the activator sends from the provider key: two accounts would sell warranties that never activate.
    const env = warrantyEnv();
    expect(() => loadConfig({ ...env, PROVIDER_ADDRESS: PROVIDER })).toThrow(/^PROVIDER_ADDRESS is not the address of PROVIDER_PRIVATE_KEY/);
    try {
      loadConfig({ ...env, PROVIDER_ADDRESS: PROVIDER });
    } catch (error) {
      expect((error as Error).message).not.toContain(env.PROVIDER_PRIVATE_KEY.slice(2));
    }
    expect(loadConfig({ ...env, PROVIDER_ADDRESS: env.PROVIDER_ADDRESS.toLowerCase() }).warranty?.providerAddress).toBe(env.PROVIDER_ADDRESS.toLowerCase());
    for (const bad of [{ WARRANTY_INDEXER_CONFIRMATIONS: "-1" }, { WARRANTY_INDEXER_CONFIRMATIONS: "1.5" }, { WARRANTY_INDEXER_CONFIRMATIONS: "safe" }, { WARRANTY_INDEXER_CONFIRMATIONS: "1000000" }, { EVALUATOR_FAILURES: "sometimes" }, { WARRANTY_ACTIVATION_JITTER_SECONDS: "86401" }, { WARRANTY_ACTIVATION_JITTER_SECONDS: "-1" }, { WARRANTY_ACTIVATION_BATCH_SECONDS: "86401" }, { WARRANTY_ACTIVATION_BATCH_SECONDS: "-1" }, { BUYER_COUNTS_REFRESH_SECONDS: "604801" }, { WARRANTY_REGISTRY_START_BLOCK: "1.5" }, { RESOLUTION_WARRANTY_REGISTRY_ADDRESS: "0x4C454D4D41000000000000000000000000000001" }]) {
      expect(() => loadConfig({ ...warrantyEnv(), ...bad }), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });
});

/** The pipeline over the world's fake registry, its jobs not started (tests drive them). */
async function pipelineOf(w: World, over: Partial<WarrantyConfig> = {}): Promise<WarrantyPipeline> {
  const settings: WarrantyConfig = {
    registry: REGISTRY,
    startBlock: 0n,
    providerKey: new Secret("held by the fake registry"),
    providerAddress: w.chain.provider,
    evaluatorKey: new Secret("held by the fake registry"),
    evaluatorAddress: w.chain.evaluator,
    failures: "auto",
    activationJitterSeconds: 0,
    activationBatchSeconds: 0,
    buyerCountsRefreshSeconds: 0,
    // The fake chain makes a block only per transaction: read up to its head.
    indexerConfirmations: 0n,
    ...over,
  };
  return startWarrantyPipeline({ config: settings, store: w.store, index: w.index, chain: w.chain, usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", clock: () => w.clock.now, logger: w.logger, start: false });
}

describe("starting the pipeline", () => {
  it("refuses a registry that is not the one this server signs for", async () => {
    const w = await warrantyWorld();
    const settings: WarrantyConfig = { registry: REGISTRY, startBlock: 0n, providerKey: new Secret("x"), providerAddress: w.chain.provider, evaluatorKey: new Secret("x"), evaluatorAddress: w.chain.evaluator, failures: "review", activationJitterSeconds: 0, activationBatchSeconds: 0, buyerCountsRefreshSeconds: 0, indexerConfirmations: 0n };
    const usdc = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d";
    const code = async (run: () => Promise<void>) => run().then(() => "OK", (e: unknown) => (e instanceof WarrantyStartupError ? e.code : String(e)));
    expect(await code(() => checkRegistry(w.chain, settings, usdc))).toBe("OK");
    w.chain.usdc = "0x00000000000000000000000000000000000000cc";
    expect(await code(() => checkRegistry(w.chain, settings, usdc))).toBe("REGISTRY_TOKEN_MISMATCH");
    w.chain.usdc = usdc;
    w.chain.identityDigestOverride = idOf("another domain");
    expect(await code(() => checkRegistry(w.chain, settings, usdc))).toBe("REGISTRY_DOMAIN_MISMATCH");
    w.chain.identityDigestOverride = undefined;
    expect(await code(() => checkRegistry(w.chain, { ...settings, evaluatorAddress: w.chain.provider }, usdc))).toBe("SENDER_MISMATCH");
    expect(await code(() => checkRegistry(w.chain, { ...settings, registry: "0x4c454d4d41000000000000000000000000000002" }, usdc))).toBe("REGISTRY_MISMATCH");
    w.chain.down = true;
    await expect(checkRegistry(w.chain, settings, usdc)).rejects.toThrow("fetch failed");
  });

  it("indexes the configured depth behind the head", async () => {
    const w = await warrantyWorld();
    const pipeline = await pipelineOf(w, { indexerConfirmations: 3n });
    const b = await w.buy();
    await pipeline.activator.runOnce();
    expect(w.chain.status(b.id)).toBe("active");
    w.chain.block += 2n;
    // The activation is two blocks deep: not confirmed yet, so the view still waits for it.
    expect(await pipeline.indexer.runOnce()).toMatchObject({ head: w.chain.block, confirmed: w.chain.block - 3n });
    expect((await pipeline.views.forResolution(b.id)).state).toBe("pending");
    w.chain.block += 1n;
    await pipeline.indexer.runOnce();
    expect((await pipeline.views.forResolution(b.id)).state).toBe("active");
  });

  it("starts every job, which activates a paid warranty on its own, and stops them", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    const pipeline = await startWarrantyPipeline({
      config: { registry: REGISTRY, startBlock: 0n, providerKey: new Secret("x"), providerAddress: w.chain.provider, evaluatorKey: new Secret("x"), evaluatorAddress: w.chain.evaluator, failures: "auto", activationJitterSeconds: 0, activationBatchSeconds: 0, buyerCountsRefreshSeconds: 0, indexerConfirmations: 0n },
      store: w.store,
      index: w.index,
      chain: w.chain,
      usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
      clock: () => w.clock.now,
      logger: w.logger,
      intervals: { indexerMs: 50, actionsMs: 50 },
    });
    await vi.waitFor(() => expect(w.chain.status(b.id)).toBe("active"));
    await vi.waitFor(async () => expect((await pipeline.views.forResolution(b.id)).state).toBe("active"));
    pipeline.stop();
    expect(w.logger.events()).toContain("warranty.on");
    expect(w.logger.events()).toContain("warranty.start_block_unset");
  });
});

describe("the warranty in the resolution view", () => {
  async function publicViewOf(w: World, pipeline: WarrantyPipeline, b: Bought): Promise<unknown> {
    const res = await app({ store: w.store, index: w.index, clock: () => w.clock.now, warranty: pipeline.views }).request(`/api/v1/resolutions/${b.id}`);
    expect(res.status).toBe(200);
    return res.json();
  }
  async function viewOf(w: World, pipeline: WarrantyPipeline, b: Bought) {
    return ResolutionView.parse(await publicViewOf(w, pipeline, b)).warranty;
  }
  const sync = async (w: World, pipeline: WarrantyPipeline) => {
    await w.jobs.indexer.runOnce();
    await pipeline.snapshot.refresh();
  };

  it("follows a warranty from pending to refunded, from the indexed events only", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const pipeline = await pipelineOf(w);
    const b = await w.buy();
    expect(await viewOf(w, pipeline, b)).toEqual({ state: "pending", amount: null, claimDeadline: null, activation: null, outcome: null, expiry: null, withdrawal: null, feedback: null });
    await w.jobs.activator.runOnce();
    // Activated on chain, not indexed yet: still pending.
    expect((await viewOf(w, pipeline, b))?.state).toBe("pending");
    await sync(w, pipeline);
    const [activation] = await w.store.listRegistryEvents({ resolutionId: b.id, names: ["ResolutionActivated"] }, 1);
    const active = await viewOf(w, pipeline, b);
    expect(active).toEqual({
      state: "active",
      amount: "250000",
      claimDeadline: new Date(Number(activation!.claimDeadline) * 1000).toISOString(),
      activation: activation!.txHash,
      outcome: null,
      expiry: null,
      withdrawal: null,
      feedback: null,
    });
    // The resolution id is now public on chain. The only time of day the view gives is the claim deadline
    // the registry's own ResolutionActivated event publishes, never when the payment settled.
    expect(timesOfDay(await publicViewOf(w, pipeline, b))).toEqual([["warranty.claimDeadline", active?.claimDeadline]]);
    await w.receipt(b, "failed");
    await w.jobs.evaluator.runOnce();
    await sync(w, pipeline);
    const failed = await viewOf(w, pipeline, b);
    expect(failed).toMatchObject({ state: "failed", outcome: expect.stringMatching(/^0x/), withdrawal: null });
    const res = await app({ store: w.store, index: w.index, clock: () => w.clock.now, warranty: pipeline.views }).request(WITHDRAWALS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionId: b.id, claimSecret: b.secret, to: b.refundTo }),
    });
    expect(res.status).toBe(202);
    await w.jobs.relay.runOnce();
    await sync(w, pipeline);
    const refunded = await viewOf(w, pipeline, b);
    expect(refunded).toMatchObject({ state: "refunded", withdrawal: expect.stringMatching(/^0x/), outcome: failed?.outcome });
    // Never the buyer, the payer, the claim or the payment reference.
    const text = JSON.stringify(refunded);
    for (const hidden of [b.payer, b.secret, b.refundTo]) expect(text).not.toContain(hidden.slice(2));
  });

  it("shows passed with its feedback, void, expired, and none when no warranty comes", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const pipeline = await pipelineOf(w);
    const [passed, voided, expired] = [await w.activeWarranty(), await w.activeWarranty(OTHER_BUYER_ADDRESS), await w.activeWarranty("0x00000000000000000000000000000000000000c7")];
    await w.receipt(passed!, "passed");
    await w.receipt(voided!, "abandoned");
    await w.jobs.evaluator.runOnce();
    // The attester posted its feedback about the passed outcome.
    await w.store.enqueueReputationPosts([{ resolutionId: passed!.id, target: "provider", agentId: "7", capability: "mcp-server.add-payment-gating", value: 100, feedbackHash: idOf("f"), evidence: "{}" }], w.clock.now);
    await w.store.updateReputationPost(passed!.id, "provider", 0, { attempts: 1, txHash: idOf("feedback tx"), state: "posted" }, w.clock.now);
    w.advance(72 * 3600 + 1);
    await w.jobs.expirer.runOnce();
    await sync(w, pipeline);
    expect(await viewOf(w, pipeline, passed!)).toMatchObject({ state: "passed", feedback: idOf("feedback tx") });
    expect(await viewOf(w, pipeline, voided!)).toMatchObject({ state: "void", feedback: null });
    expect(await viewOf(w, pipeline, expired!)).toMatchObject({ state: "expired", expiry: expect.stringMatching(/^0x/), outcome: null });
    // A release the registry does not know: the activation is skipped, and no warranty comes.
    w.chain.releases.delete(w.entry.releaseDigest);
    const skipped = await w.buy();
    await w.jobs.activator.runOnce();
    expect((await viewOf(w, pipeline, skipped))?.state).toBe("none");
    // Without the pipeline, the view has no warranty at all.
    const res = await app({ store: w.store, index: w.index, clock: () => w.clock.now }).request(`/api/v1/resolutions/${passed!.id}`);
    expect(ResolutionView.parse(await res.json()).warranty).toBeNull();
  });

  it("moves the claim deadline by every second paused while the warranty runs", async () => {
    const w = await warrantyWorld();
    const pipeline = await pipelineOf(w);
    const b = await w.activeWarranty();
    await sync(w, pipeline);
    const before = (await viewOf(w, pipeline, b))?.claimDeadline as string;
    w.advance(600);
    w.chain.pause();
    w.advance(3600);
    // An ongoing pause counts up to now.
    await sync(w, pipeline);
    expect(Date.parse((await viewOf(w, pipeline, b))?.claimDeadline as string) - Date.parse(before)).toBe(3600_000);
    w.advance(400);
    w.chain.unpause();
    w.advance(1000);
    await sync(w, pipeline);
    expect(Date.parse((await viewOf(w, pipeline, b))?.claimDeadline as string) - Date.parse(before)).toBe(4000_000);
    expect(w.chain.deadlineOf(w.chain.resolutions.get(b.id)!)).toBe(BigInt(Date.parse((await viewOf(w, pipeline, b))?.claimDeadline as string) / 1000));
  });
});

describe("POST /api/v1/warranty/withdrawals", () => {
  async function failedWarranty() {
    const w = await warrantyWorld({ failures: "auto" });
    const pipeline = await pipelineOf(w);
    const b = await w.activeWarranty();
    await w.receipt(b, "failed");
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    return { w, pipeline, b };
  }
  const post = (a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
    a.request(WITHDRAWALS_PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("answers 202 with the relay's state, the same for the same request", async () => {
    const { w, pipeline, b } = await failedWarranty();
    const a = app({ store: w.store, index: w.index, clock: () => w.clock.now, warranty: pipeline.views });
    const request = { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo };
    for (let i = 0; i < 2; i++) {
      const res = await post(a, request);
      expect(res.status).toBe(202);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(WarrantyWithdrawalAnswer.parse(await res.json())).toEqual({ resolutionId: b.id, state: "queued" });
    }
    await w.jobs.relay.runOnce();
    expect(WarrantyWithdrawalAnswer.parse(await (await post(a, request)).json()).state).toBe("done");
  });

  it("refuses with a code and queues nothing: bad body, browser, unknown resolution, wrong secret or address, no credit, pipeline off", async () => {
    const { w, pipeline, b } = await failedWarranty();
    const a = app({ store: w.store, index: w.index, clock: () => w.clock.now, warranty: pipeline.views });
    const request = { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo };
    const refusal = async (res: Response) => [res.status, WarrantyWithdrawalRefusal.parse(await res.json()).error];
    expect(await refusal(await post(a, "{not json"))).toEqual([400, "BAD_REQUEST"]);
    expect(await refusal(await post(a, { ...request, extra: true }))).toEqual([400, "BAD_REQUEST"]);
    expect(await refusal(await post(a, request, { origin: "https://evil.example" }))).toEqual([403, "BROWSER_REQUEST"]);
    expect(await refusal(await post(a, { ...request, resolutionId: idOf("nobody") }))).toEqual([404, "UNKNOWN_RESOLUTION"]);
    expect(await refusal(await post(a, { ...request, claimSecret: idOf("wrong") }))).toEqual([403, "CLAIM_MISMATCH"]);
    expect(await refusal(await post(a, { ...request, to: "0x00000000000000000000000000000000000000e5" }))).toEqual([403, "CLAIM_MISMATCH"]);
    const active = await w.activeWarranty(OTHER_BUYER_ADDRESS);
    expect(await refusal(await post(a, { resolutionId: active.id, claimSecret: active.secret, to: active.refundTo }))).toEqual([409, "NO_CREDIT"]);
    expect(await refusal(await post(app({ store: w.store, index: w.index }), request))).toEqual([404, "WARRANTY_OFF"]);
    expect(await w.store.listWarrantyActions({ kind: "withdraw" }, 10)).toEqual([]);
    expectNoClaimLogged(w, b);
  });

  it("is rate limited like the other writes", async () => {
    const { w, pipeline, b } = await failedWarranty();
    const a = app({ store: w.store, index: w.index, clock: () => w.clock.now, warranty: pipeline.views, config: config({ RATE_LIMIT_PER_MINUTE: "2" }) });
    const request = { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo };
    expect((await post(a, request)).status).toBe(202);
    expect((await post(a, request)).status).toBe(202);
    const limited = await post(a, request);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

function expectNoClaimLogged(w: World, b: Bought): void {
  const text = JSON.stringify(w.logger.lines);
  expect(text).not.toContain(b.secret.slice(2));
  expect(text).not.toContain(b.refundTo.slice(2));
}

describe("the status and catalog views with the pipeline on", () => {
  it("name the registry and the engine it records into, and publish distinct buyers from three up", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const pipeline = await pipelineOf(w);
    const env = warrantyEnv();
    const on = (over = {}) => app({ store: w.store, index: w.index, clock: () => w.clock.now, warranty: pipeline.views, outcomes: pipeline.source, reputationBuyers: pipeline.feed, config: config(env), ...over });
    const status = async () => StatusView.parse(await (await on().request("/api/v1/status")).json()).chain;
    expect(await status()).toMatchObject({ registry: REGISTRY, engine: null });
    w.chain.setEngine("0x00000000000000000000000000000000000000e1");
    await w.jobs.indexer.runOnce();
    await pipeline.snapshot.refresh();
    expect((await status()).engine).toBe("0x00000000000000000000000000000000000000e1");

    for (const payer of ["0x00000000000000000000000000000000000000b1", OTHER_BUYER_ADDRESS, "0x00000000000000000000000000000000000000c7"]) {
      const b = await w.activeWarranty(payer);
      await w.receipt(b, "passed");
    }
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    await pipeline.snapshot.refresh();
    const reputation = { current: () => ({ passBps: 10_000, count: 3 }) };
    const catalog = CatalogView.parse(await (await on({ reputation }).request("/api/v1/catalog")).json());
    const release = catalog.releases.find((r) => r.releaseDigest === (w.entry.releaseDigest as Hex32));
    expect(release?.profiles[0]?.compatibility).toMatchObject({ outcomes: 3, buyers: 3, source: "benchmark+outcomes" });
    expect(release?.reputation).toEqual({ passBps: 10_000, count: 3, buyers: 3 });
  });
});
