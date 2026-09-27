import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { resolve } from "@lemma/catalog";
import { AdoptionFeedbackFile, CatalogView, LEMMA_TOOLS, PreviewResult, REPUTATION_META_KEY, deriveResolutionId } from "@lemma/core";
import { encodeErrorResult, keccak256, toEventSelector, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import {
  Attester,
  ConfigError,
  ERC8004_ARBITRUM_SEPOLIA,
  MemoryOutcomeFeed,
  MemoryStore,
  REPUTATION_OFF,
  RegistrationFile,
  ReputationSummaries,
  ResolutionService,
  buildEvidence,
  identityRegistryAbi,
  loadConfig,
  parseRegisterArgs,
  privateKeyFrom,
  reputationRegistryAbi,
  silentLogger,
  startReputation,
  toReputation,
} from "../src/index.js";
import { BUYER_AGENT, FakeChain, PROVIDER_AGENT, outcomeFor } from "./fake-reputation-chain.js";
import { BUYER, NOW, PROVIDER, app, config, gatingTask, matchingProfile, mcpClient, nextPreviewId, paidConfig, sellableIndex } from "./helpers.js";

const BASE = "https://lemma.example";
/** Everything the attester needs; the key is made at runtime, never written down. */
const reputationEnv = (key = generatePrivateKey()) => ({
  PUBLIC_BASE_URL: BASE,
  ARBITRUM_SEPOLIA_RPC_URL: "https://rpc.example/v1/abc",
  LEMMA_AGENT_ID: PROVIDER_AGENT,
  ATTESTER_PRIVATE_KEY: key,
  DATABASE_URL: "postgres://lemma@db.example:5432/lemma",
});

describe("reputation config", () => {
  it("is off by default, and changes nothing else", () => {
    const c = loadConfig({});
    expect(c.reputation).toEqual(REPUTATION_OFF);
    expect(c.reputation.identityRegistry).toBe(ERC8004_ARBITRUM_SEPOLIA.identityRegistry);
    expect(loadConfig({ PUBLIC_BASE_URL: "", LEMMA_AGENT_ID: "", ATTESTER_PRIVATE_KEY: "", ARBITRUM_SEPOLIA_RPC_URL: "" }).reputation).toEqual(REPUTATION_OFF);
  });

  it("derives the attester's address and never prints its key", () => {
    const key = generatePrivateKey();
    const c = loadConfig(reputationEnv(key)).reputation;
    expect(c.attester?.address).toBe(privateKeyToAccount(key).address.toLowerCase());
    expect(c).toMatchObject({ publicBaseUrl: BASE, agentId: "7" });
    for (const shown of [JSON.stringify(c), String(c.attester?.key), inspect(c, { depth: 5 }), `${c.attester?.key}`]) expect(shown).not.toContain(key.slice(2));
    expect(c.attester?.key.reveal()).toBe(key);
    expect(loadConfig({ ...reputationEnv(), PUBLIC_BASE_URL: `${BASE}/lemma/` }).reputation.publicBaseUrl).toBe(`${BASE}/lemma`);
    expect(loadConfig({ ERC8004_IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e" }).reputation.identityRegistry).toBe(ERC8004_ARBITRUM_SEPOLIA.identityRegistry);
  });

  it("refuses bad or partial settings without ever repeating a key or an RPC URL", () => {
    const key = generatePrivateKey();
    const secretRpc = `https://rpc.example/v2/${"k".repeat(12)}secret`;
    const cases: Array<Record<string, string>> = [
      { ...reputationEnv(key), ATTESTER_PRIVATE_KEY: key.slice(0, -1) },
      { ...reputationEnv(key), ATTESTER_PRIVATE_KEY: `0x${"0".repeat(64)}` },
      { ...reputationEnv(key), ATTESTER_PRIVATE_KEY: key.toUpperCase().replace("0X", "0x").replace(/[A-F]/, "g") },
      { ATTESTER_PRIVATE_KEY: key },
      { ...reputationEnv(key), ARBITRUM_SEPOLIA_RPC_URL: secretRpc.replace("https", "wss") },
      { ...reputationEnv(key), PUBLIC_BASE_URL: "http://lemma.example" },
      { ...reputationEnv(key), PUBLIC_BASE_URL: `${BASE}/?token=${key}` },
      { ...reputationEnv(key), LEMMA_AGENT_ID: "07" },
      { ...reputationEnv(key), ERC8004_REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388714" },
    ];
    for (const env of cases) {
      let message = "";
      try {
        loadConfig(env);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(env))).not.toBe("");
      expect(message).not.toContain(key.slice(2, 20));
      expect(message).not.toContain("secret");
    }
    expect(() => loadConfig({ ATTESTER_PRIVATE_KEY: key })).toThrow(/ARBITRUM_SEPOLIA_RPC_URL, DATABASE_URL, LEMMA_AGENT_ID, PUBLIC_BASE_URL/);
  });

  it("refuses the attester on the in-memory store, where a restart would lose its ledger and post every outcome again", () => {
    expect(loadConfig(reputationEnv()).reputation.attester).toBeDefined();
    for (const DATABASE_URL of [undefined, ""]) {
      const env: Record<string, string | undefined> = { ...reputationEnv(), DATABASE_URL };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(/needs DATABASE_URL.*restart/);
    }
    // Without the attester, reputation reads and the registration file need no database.
    expect(loadConfig({ PUBLIC_BASE_URL: BASE, LEMMA_AGENT_ID: PROVIDER_AGENT }).reputation).toMatchObject({ publicBaseUrl: BASE, attester: undefined });
  });

  it("takes the log search's block range from ERC8004_LOG_RANGE, for RPC providers with a smaller limit", () => {
    expect(loadConfig({}).reputation.logRange).toBe(10_000);
    expect(loadConfig({ ERC8004_LOG_RANGE: "" }).reputation.logRange).toBe(10_000);
    expect(loadConfig({ ERC8004_LOG_RANGE: "500" }).reputation.logRange).toBe(500);
    expect(loadConfig({ ERC8004_LOG_RANGE: "1000000" }).reputation.logRange).toBe(1_000_000);
    for (const bad of ["0", "-5", "1e3", "10.5", "0x10", "1000001", " 500"]) {
      expect(() => loadConfig({ ERC8004_LOG_RANGE: bad }), bad).toThrow(/ERC8004_LOG_RANGE/);
    }
  });
});

describe("the ERC-8004 registration file", () => {
  it("is not served without PUBLIC_BASE_URL", async () => {
    for (const path of ["/api/v1/agent/registration.json", "/.well-known/agent-registration.json"]) {
      const res = await app().request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("names the MCP endpoint, x402 support, the trust models and the provider agent's registration", async () => {
    const before = await (await app({ config: config({ PUBLIC_BASE_URL: `${BASE}/` }) }).request("/api/v1/agent/registration.json")).json();
    expect(RegistrationFile.parse(before)).toMatchObject({ registrations: [], x402Support: false });

    const paid = app({ config: paidConfig({ PUBLIC_BASE_URL: BASE, LEMMA_AGENT_ID: "7" }), registerPaidTools: () => undefined });
    const res = await paid.request("/api/v1/agent/registration.json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const file = RegistrationFile.parse(await res.json());
    expect(file).toEqual({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Lemma",
      description: expect.stringContaining("x402"),
      services: [
        { name: "MCP", endpoint: `${BASE}/mcp`, version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
        { name: "web", endpoint: `${BASE}/` },
      ],
      x402Support: true,
      active: true,
      registrations: [{ agentId: 7, agentRegistry: "eip155:421614:0x8004a818bfb912233c491871b3d84c89a494bd9e" }],
      supportedTrust: ["reputation", "crypto-economic"],
    });
    // The spec's well-known path serves the same file.
    expect(await (await paid.request("/.well-known/agent-registration.json")).json()).toEqual(file);
  });

  it("names the dashboard's icon as its image when the dashboard is served, for ERC-721 apps", async () => {
    const web = mkdtempSync(join(tmpdir(), "lemma-web-"));
    try {
      mkdirSync(join(web, "assets"));
      writeFileSync(join(web, "index.html"), "<!doctype html><div id=\"root\"></div>");
      writeFileSync(join(web, "assets", "apple-touch-icon-Ab12_c.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      const a = app({ config: config({ PUBLIC_BASE_URL: BASE }), webRoot: web });
      const file = RegistrationFile.parse(await (await a.request("/api/v1/agent/registration.json")).json());
      expect(file.image).toBe(`${BASE}/assets/apple-touch-icon-Ab12_c.png`);
      const icon = await a.request("/assets/apple-touch-icon-Ab12_c.png");
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/png");
      // An icon reached through a link is never named (the dashboard would not serve it either).
      rmSync(join(web, "assets", "apple-touch-icon-Ab12_c.png"));
      symlinkSync("/etc/hostname", join(web, "assets", "apple-touch-icon-Zz9.png"));
      const linked = app({ config: config({ PUBLIC_BASE_URL: BASE }), webRoot: web });
      expect(await (await linked.request("/api/v1/agent/registration.json")).json()).not.toHaveProperty("image");
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
    // Without a dashboard, no image.
    expect(await (await app({ config: config({ PUBLIC_BASE_URL: BASE }) }).request("/api/v1/agent/registration.json")).json()).not.toHaveProperty("image");
  });
});

/** A store holding one resolution BUYER bought and settled, with its receipt accepted (opted in with `agentId`, if given), and the app over it. */
async function adopted(agentId?: string) {
  const store = new MemoryStore();
  const index = sellableIndex();
  await store.saveCatalog(index, NOW);
  const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
    now: NOW,
    previewId: nextPreviewId(),
    payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
    offerTtlSeconds: 900,
  });
  await store.saveOffer(offer);
  const service = new ResolutionService(store, () => NOW, silentLogger);
  const nonce = `0x${"9a".repeat(32)}`;
  const settlementRef = `0x${"7b".repeat(32)}`;
  await service.prepare(offer.previewId, { payer: BUYER, nonce, validBefore: new Date(NOW.getTime() + 300_000) });
  const id = deriveResolutionId(offer.previewId, BUYER);
  await service.commit(id, { nonce, settlementRef });
  const receipt = { schemaVersion: "1" as const, resolutionId: id, outcome: "passed" as const, acceptance: { exitCode: 0, durationMs: 41_250, outputDigest: `0x${"88".repeat(32)}` }, recordedAt: NOW.toISOString(), signature: null };
  expect(await service.acceptReceipt({ receipt, previewId: offer.previewId, ...(agentId === undefined ? {} : { agentId }) })).toBe("ACCEPTED");
  return { store, id, previewId: offer.previewId, nonce, settlementRef, a: app({ store, service }) };
}

describe("the feedback files", () => {
  it("serve each feedback's own file byte for byte as hashed, with ERC-8004's fields equal to the call, and never the buyer, payer, preview id, nonce or settlement", async () => {
    const { store, id, previewId, nonce, settlementRef, a } = await adopted(BUYER_AGENT);
    // The outcome as a pipeline might pass it, with more than the feed asks for: none of the extras may leak.
    const stored = await store.getReceipt(id);
    const outcome = { ...outcomeFor(previewId, BUYER, { buyerAgentId: stored?.buyerAgentId ?? null }), buyer: BUYER, payer: BUYER, previewId, nonce, settlementRef };
    const feed = new MemoryOutcomeFeed();
    feed.add(outcome);
    const chain = new FakeChain();
    chain.owners.set(42n, BUYER);
    await new Attester({ store, chain, feed, providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => NOW, logger: silentLogger }).tick();
    expect(chain.logs).toHaveLength(2);

    const texts = new Map<string, string>();
    for (const [segment, agentId] of [["provider", 7n], ["buyer-agent", 42n]] as const) {
      const res = await a.request(`/api/v1/evidence/${id}/${segment}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      texts.set(segment, text);
      // This feedback points at this file, and its hash on chain is keccak256 of exactly the bytes served.
      const call = chain.logs.find((l) => l.agentId === agentId)?.request;
      expect(call?.feedbackURI).toBe(`${BASE}/api/v1/evidence/${id}/${segment}`);
      expect(call?.feedbackHash).toBe(keccak256(bytes));
      expect(call?.feedbackHash).toBe(buildEvidence(outcomeFor(previewId, BUYER), agentId.toString(), chain).feedbackHash);
      // ERC-8004's required fields, and the optional ones Lemma sets, are the call's; Lemma's evidence sits under "lemma".
      const file = AdoptionFeedbackFile.parse(JSON.parse(text));
      expect(file).toEqual({
        agentRegistry: `eip155:421614:${ERC8004_ARBITRUM_SEPOLIA.identityRegistry}`,
        agentId: Number(agentId),
        clientAddress: `eip155:421614:${chain.attester}`,
        createdAt: outcome.finalizedAt,
        value: 100,
        valueDecimals: 0,
        tag1: "lemma.adoption",
        tag2: "mcp-server.add-payment-gating",
        endpoint: "",
        lemma: expect.objectContaining({ kind: "lemma.adoption-evidence", resolutionId: id, verdict: "passed", capability: "mcp-server.add-payment-gating", finalizedAt: outcome.finalizedAt }),
      });
      expect([BigInt(file.agentId), BigInt(file.value), file.valueDecimals, file.tag1, file.tag2, file.endpoint]).toEqual([call?.agentId, call?.value, call?.valueDecimals, call?.tag1, call?.tag2, call?.endpoint]);
      for (const secret of [BUYER.slice(2), previewId.slice(2), nonce.slice(2), settlementRef.slice(2), "buyer", "payer", "nonce", "settlement", "proofOfPayment"]) expect(text).not.toContain(secret);
    }
    // The provider's file never names the buyer's agent; only that agent's own file does, as the buyer opted in to.
    expect(texts.get("provider")).toContain('"agentId":7,');
    expect(texts.get("provider")).not.toContain('"agentId":42');
    expect(texts.get("buyer-agent")).toContain('"agentId":42,');
  });

  it("serve a feedback's file once its send is claimed and not before, and never the file of a buyer agent the payer does not control", async () => {
    const { store, id, previewId, a } = await adopted("99");
    const chain = new FakeChain();
    // The buyer named someone else's agent.
    chain.owners.set(99n, "0x00000000000000000000000000000000000000c1");
    const feed = new MemoryOutcomeFeed();
    const clock = { now: NOW };
    const attester = new Attester({ store, chain, feed, providerAgentId: PROVIDER_AGENT, publicBaseUrl: BASE, clock: () => clock.now, logger: silentLogger });
    const get = (segment: string) => a.request(`/api/v1/evidence/${id}/${segment}`);
    await attester.tick();
    // Queued while the chain is down, so nothing is sent: nothing is served yet, and the miss is never cached.
    feed.add(outcomeFor(previewId, BUYER, { buyerAgentId: "99" }));
    chain.down = true;
    expect(await attester.tick()).toMatchObject({ queued: 2, posted: 0 });
    for (const segment of ["provider", "buyer-agent"]) {
      const res = await get(segment);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    // Claimed, and about to be broadcast: from now on the feedback may be on chain, so its URI answers.
    chain.down = false;
    clock.now = new Date(NOW.getTime() + 60_000);
    const held = chain.holdNextSend();
    const ticking = attester.tick();
    await held.reached;
    expect((await get("provider")).status).toBe(200);
    held.release();
    expect(await ticking).toMatchObject({ posted: 1, skipped: 1 });
    // The buyer agent's post was skipped before any send (AGENT_NOT_BUYER), so its file, which names that agent, is never shown.
    expect(await store.getReputationPost(id, "buyer")).toMatchObject({ state: "skipped", attempts: 0 });
    const skipped = await get("buyer-agent");
    expect(skipped.status).toBe(404);
    expect(await skipped.text()).not.toContain("99");
  });

  it("answer 400 to a malformed path, and nothing at the old one-file-per-resolution path", async () => {
    const a = app();
    const id = `0x${"ab".repeat(32)}`;
    for (const path of ["/api/v1/evidence/0x1234/provider", `/api/v1/evidence/${id}/buyer`, `/api/v1/evidence/${id}/Provider`, `/api/v1/evidence/${id.toUpperCase()}/provider`]) {
      expect((await a.request(path)).status, path).toBe(400);
    }
    const missing = await a.request(`/api/v1/evidence/${id}/provider`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    // Each feedback has its own file now; nothing is served for a resolution as a whole.
    expect((await a.request(`/api/v1/evidence/${id}`)).status).toBe(404);
  });
});

describe("cached reputation summaries", () => {
  it("reads a pass rate in basis points from getSummary", () => {
    expect(toReputation({ count: 0n, value: 0n, decimals: 0 })).toBeNull();
    expect(toReputation({ count: 34n, value: 97n, decimals: 0 })).toEqual({ passBps: 9700, count: 34 });
    expect(toReputation({ count: 3n, value: 6666n, decimals: 2 })).toEqual({ passBps: 6666, count: 3 });
    expect(toReputation({ count: 3n, value: 666_666_666_666_666_666n, decimals: 16 })).toEqual({ passBps: 6666, count: 3 });
    expect(toReputation({ count: 1n, value: 1n, decimals: 1 })).toEqual({ passBps: 10, count: 1 });
    expect(toReputation({ count: 2n, value: -5n, decimals: 0 })).toEqual({ passBps: 0, count: 2 });
    expect(toReputation({ count: 2n, value: 150n, decimals: 0 })).toEqual({ passBps: 10_000, count: 2 });
    expect(toReputation({ count: 2n ** 64n - 1n, value: 100n, decimals: 0 })?.count).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("serves each capability from a five-minute cache, filtered to Lemma's attester and tag", async () => {
    const chain = new FakeChain();
    chain.summaries.set("7/lemma.adoption/mcp-server.add-payment-gating", { count: 34n, value: 97n, decimals: 0 });
    let now = 0;
    const s = new ReputationSummaries(chain, PROVIDER_AGENT, silentLogger, { now: () => now });
    // The first read never waits: null now, refreshed in the background.
    expect(s.current("mcp-server.add-payment-gating")).toBeNull();
    expect(await s.refresh("mcp-server.add-payment-gating")).toEqual({ passBps: 9700, count: 34 });
    expect(chain.summaryCalls).toBe(1);
    expect(s.current("mcp-server.add-payment-gating")).toEqual({ passBps: 9700, count: 34 });
    now = 299_999;
    expect(s.current("mcp-server.add-payment-gating")).toEqual({ passBps: 9700, count: 34 });
    expect(chain.summaryCalls).toBe(1);
    now = 300_000;
    chain.summaries.set("7/lemma.adoption/mcp-server.add-payment-gating", { count: 35n, value: 94n, decimals: 0 });
    expect(s.current("mcp-server.add-payment-gating")).toEqual({ passBps: 9700, count: 34 });
    // One read at a time per capability.
    expect(s.current("mcp-server.add-payment-gating")).toEqual({ passBps: 9700, count: 34 });
    expect(chain.summaryCalls).toBe(2);
    await s.refresh("mcp-server.add-payment-gating");
    expect(s.current("mcp-server.add-payment-gating")).toEqual({ passBps: 9400, count: 35 });
    expect(await s.refresh("mcp-client.add-paying-client")).toBeNull();
  });

  it("falls back to the last value, or null, when the chain fails, and retries after a minute", async () => {
    const chain = new FakeChain();
    chain.summaries.set("7/lemma.adoption/mcp-server.add-payment-gating", { count: 2n, value: 50n, decimals: 0 });
    let now = 0;
    const s = new ReputationSummaries(chain, PROVIDER_AGENT, silentLogger, { now: () => now });
    chain.failSummaries = true;
    expect(await s.refresh("mcp-server.add-payment-gating")).toBeNull();
    chain.failSummaries = false;
    now = 59_999;
    expect(s.current("mcp-server.add-payment-gating")).toBeNull();
    expect(chain.summaryCalls).toBe(1);
    now = 60_000;
    s.current("mcp-server.add-payment-gating");
    expect(await s.refresh("mcp-server.add-payment-gating")).toEqual({ passBps: 5000, count: 2 });
    chain.failSummaries = true;
    now = 60_000 + 300_000;
    expect(await s.refresh("mcp-server.add-payment-gating")).toEqual({ passBps: 5000, count: 2 });
    expect(s.current("mcp-server.add-payment-gating")).toEqual({ passBps: 5000, count: 2 });
  });
});

describe("reputation in previews and the catalog", () => {
  const reader = (record: { passBps: number; count: number } | null) => ({ current: () => record });

  it("adds the matched release's record to the preview's _meta, and nothing to the preview itself", async () => {
    const client = await mcpClient(app({ index: sellableIndex(), config: config({ PROVIDER_ADDRESS: PROVIDER }), reputation: reader({ passBps: 9700, count: 34 }) }));
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } });
    expect(result._meta?.[REPUTATION_META_KEY]).toEqual({ passBps: 9700, count: 34 });
    expect(PreviewResult.parse(result.structuredContent).preview.decision).toBe("reuse");
    // No match, no record.
    const none = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: { schemaVersion: "1", capability: "node-service.add-payment-facilitator" }, profile: matchingProfile } });
    expect(PreviewResult.parse(none.structuredContent).preview.decision).toBe("build");
    expect(none._meta?.[REPUTATION_META_KEY]).toBeUndefined();
    await client.close();
    const unknown = await mcpClient(app({ index: sellableIndex(), config: config({ PROVIDER_ADDRESS: PROVIDER }), reputation: reader(null) }));
    expect((await unknown.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } }))._meta?.[REPUTATION_META_KEY]).toBeUndefined();
    await unknown.close();
  });

  it("never makes a preview or the catalog wait on the chain", async () => {
    const chain = new FakeChain();
    chain.hangSummaries = true;
    const summaries = new ReputationSummaries(chain, PROVIDER_AGENT, silentLogger);
    const a = app({ index: sellableIndex(), config: config({ PROVIDER_ADDRESS: PROVIDER }), reputation: summaries, requestTimeoutMs: 2000 });
    const client = await mcpClient(a);
    const started = Date.now();
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } });
    expect(result.isError).toBeFalsy();
    expect((await a.request("/api/v1/catalog")).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(chain.summaryCalls).toBe(1);
    await client.close();
  });

  it("shows each release's record in the catalog view, or null", async () => {
    const withRecord = CatalogView.parse(await (await app({ index: sellableIndex(), reputation: reader({ passBps: 9700, count: 34 }) }).request("/api/v1/catalog")).json());
    expect(withRecord.releases[0]?.reputation).toEqual({ passBps: 9700, count: 34 });
    const without = CatalogView.parse(await (await app({ index: sellableIndex() }).request("/api/v1/catalog")).json());
    expect(without.releases[0]?.reputation).toBeNull();
  });
});

describe("startReputation", () => {
  it("starts nothing and serves no records until configured", () => {
    const runtime = startReputation({ config: REPUTATION_OFF, store: new MemoryStore(), feed: new MemoryOutcomeFeed(), capabilities: [], clock: () => NOW, logger: silentLogger });
    expect(runtime.summaries).toBeUndefined();
    expect(runtime.attester).toBeUndefined();
    runtime.stop();
    // A registration without the attester is not enough either.
    const partial = startReputation({ config: config({ PUBLIC_BASE_URL: BASE, LEMMA_AGENT_ID: "7" }).reputation, store: new MemoryStore(), feed: new MemoryOutcomeFeed(), capabilities: [], clock: () => NOW, logger: silentLogger });
    expect(partial.summaries).toBeUndefined();
  });

  it("refreshes each capability's record in the background once it is five minutes old, not every other time", async () => {
    vi.useFakeTimers();
    try {
      const chain = new FakeChain();
      // A read takes a moment, so each one ends a little after the timer that started it.
      chain.summaryDelayMs = 200;
      const runtime = startReputation({
        config: config(reputationEnv()).reputation,
        store: new MemoryStore(),
        feed: new MemoryOutcomeFeed(),
        capabilities: ["mcp-server.add-payment-gating"],
        clock: () => NOW,
        logger: silentLogger,
        chain,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(chain.summaryCalls).toBe(1);
      // Read at 0.2 s, so due from 5 min 0.2 s: the next background check after that reads it again.
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(chain.summaryCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(chain.summaryCalls).toBe(3);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the attester and warms the capability cache when configured", async () => {
    const chain = new FakeChain();
    chain.summaries.set("7/lemma.adoption/mcp-server.add-payment-gating", { count: 1n, value: 100n, decimals: 0 });
    const events: string[] = [];
    const runtime = startReputation({
      config: config(reputationEnv()).reputation,
      store: new MemoryStore(),
      feed: new MemoryOutcomeFeed(),
      capabilities: ["mcp-server.add-payment-gating"],
      clock: () => NOW,
      logger: { log: (_level, event, fields) => void events.push(`${event} ${JSON.stringify(fields)}`) },
      chain,
    });
    expect(runtime.summaries).toBeDefined();
    expect(runtime.attester).toBeDefined();
    await runtime.summaries?.refresh("mcp-server.add-payment-gating");
    expect(runtime.summaries?.current("mcp-server.add-payment-gating")).toEqual({ passBps: 10_000, count: 1 });
    expect(events.some((e) => e.startsWith("reputation.on") && e.includes(chain.attester))).toBe(true);
    runtime.stop();
  });
});

describe("the register script's arguments", () => {
  it("takes --update and --uri, and never a key", () => {
    expect(parseRegisterArgs([])).toEqual({ update: undefined, uri: undefined });
    expect(parseRegisterArgs(["--update", "12", "--uri", "https://lemma.example/r.json"])).toEqual({ update: "12", uri: "https://lemma.example/r.json" });
    for (const bad of [["--update"], ["--update", "0x0c"], ["--uri", "http://lemma.example/"], ["--key", "x"], ["register"]]) expect(parseRegisterArgs(bad), bad.join(" ")).toHaveProperty("error");
    const key = generatePrivateKey();
    for (const argv of [[key], ["--update", key], [`--key=${key}`]]) {
      const parsed = parseRegisterArgs(argv);
      expect(parsed).toEqual({ error: expect.stringContaining("never an argument") });
      expect(JSON.stringify(parsed)).not.toContain(key.slice(2));
    }
  });

  it("reads a key from the environment and names only the variable when it is wrong", () => {
    const key = generatePrivateKey();
    expect(privateKeyFrom(key, "AGENT_OWNER_PRIVATE_KEY")).toBe(key);
    expect(() => privateKeyFrom(undefined, "AGENT_OWNER_PRIVATE_KEY")).toThrow("AGENT_OWNER_PRIVATE_KEY is not set");
    let message = "";
    try {
      privateKeyFrom(`${key}00`, "AGENT_OWNER_PRIVATE_KEY");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^AGENT_OWNER_PRIVATE_KEY: /);
    expect(message).not.toContain(key.slice(2, 20));
  });
});

describe("the vendored ERC-8004 ABI", () => {
  it("keeps the selectors of the official registries (erc-8004-contracts b9e466c)", () => {
    const selector = (abi: readonly { type: string; name: string }[], name: string) => {
      const item = abi.find((i) => i.name === name) as Parameters<typeof toFunctionSelector>[0];
      return (item as { type: string }).type === "event" ? toEventSelector(item as Parameters<typeof toEventSelector>[0]) : toFunctionSelector(item);
    };
    expect(selector(reputationRegistryAbi, "giveFeedback")).toBe("0x3c036a7e");
    expect(selector(reputationRegistryAbi, "getSummary")).toBe("0x81bbba58");
    expect(selector(reputationRegistryAbi, "NewFeedback")).toBe("0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc");
    expect(selector(identityRegistryAbi, "register")).toBe("0xf2c298be");
    expect(selector(identityRegistryAbi, "setAgentURI")).toBe("0x0af28bd3");
    expect(selector(identityRegistryAbi, "getAgentWallet")).toBe("0x00339509");
    expect(selector(identityRegistryAbi, "Registered")).toBe("0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a");
    // From contracts/IdentityRegistryUpgradeable.sol (not in the upstream abis/ JSON): the rule behind "Self-feedback not allowed".
    expect(selector(identityRegistryAbi, "isAuthorizedOrOwner")).toBe("0xd95e72be");
    for (const abi of [identityRegistryAbi, reputationRegistryAbi]) {
      expect(encodeErrorResult({ abi, errorName: "ERC721NonexistentToken", args: [1n] }).slice(0, 10)).toBe("0x7e273289");
    }
  });
});
