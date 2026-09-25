import { type LoadedCatalog, buildIndex, loadFixtures } from "@lemma/catalog";
import { CATALOG_ROOT } from "@lemma/catalog";
import {
  type CapabilityRelease,
  LEMMA_TOOLS,
  type PatchBundle,
  PreviewResult,
  type RepositoryProfile,
  bundleDigest,
  releaseDigest,
} from "@lemma/core";
import { describe, expect, it } from "vitest";

import { ConfigError, MAX_BODY_BYTES, MemoryStore, TokenBuckets, clientAddress, loadConfig, normalizeIp, startupProblems } from "../src/index.js";
import { NOW, PROVIDER, app, committedIndex, config, gatingTask, matchingProfile, mcpClient, sellableIndex } from "./helpers.js";
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

const profile = matchingProfile;
const task = gatingTask;

describe("config", () => {
  it("has safe defaults: paid tools off, Arbitrum Sepolia USDC, bounded windows", () => {
    const c = loadConfig({});
    expect(c.paidTools).toBe(false);
    expect(c.allowProvisionalEvidence).toBe(false);
    expect(c.payment).toEqual({ network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 });
    expect(c.offerTtlSeconds).toBe(900);
  });

  it("accepts .env.example's checksummed USDC address and empty placeholders", () => {
    const c = loadConfig({ USDC_ADDRESS: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", PROVIDER_ADDRESS: "", DATABASE_URL: "" });
    expect(c.payment.asset).toBe("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
    expect(c.provider).toBeUndefined();
  });

  it("refuses anything outside the supported chain, asset and bounds", () => {
    const bad: Array<Record<string, string>> = [
      { ARBITRUM_SEPOLIA_CHAIN_ID: "42161" },
      { USDC_ADDRESS: "0x0000000000000000000000000000000000000001" },
      { USDC_ADDRESS: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4D" },
      { OFFER_TTL_SECONDS: "3601" },
      { PAYMENT_TIMEOUT_SECONDS: "601" },
      { PAID_TOOLS: "on" },
      { NODE_ENV: "production" },
      { ALLOW_PROVISIONAL_EVIDENCE: "yes" },
    ];
    for (const env of bad) expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
  });

  it("keeps only the origin of the dashboard URL", () => {
    expect(loadConfig({ DASHBOARD_ORIGIN: "https://lemma.example/app/" }).dashboardOrigin).toBe("https://lemma.example");
  });
});

describe("MCP over stateless Streamable HTTP", () => {
  it("lists the free tools through a real MCP client", async () => {
    const client = await mcpClient(app());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([LEMMA_TOOLS.preview, LEMMA_TOOLS.recoverResolution].sort());
    await client.close();
  });

  it("answers every catalog fixture the way it expects, at the fixture's pinned instant", async () => {
    let now = NOW;
    const client = await mcpClient(app({ clock: () => now }));
    const problems: string[] = [];
    for (const { id, fixture } of loadFixtures(CATALOG_ROOT, problems)) {
      now = new Date(fixture.now);
      const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: { schemaVersion: "1", capability: fixture.capability }, profile: fixture.profile } });
      const { preview } = PreviewResult.parse(result.structuredContent);
      expect({ id, decision: preview.decision, reasons: preview.reasons }).toEqual({ id, decision: fixture.expected.decision, reasons: fixture.expected.reasons });
    }
    expect(problems).toEqual([]);
    await client.close();
  });

  it("stores an offer before returning it", async () => {
    const saved: string[] = [];
    const store = new (class extends MemoryStore {
      override async saveOffer(p: Parameters<MemoryStore["saveOffer"]>[0]) {
        saved.push(p.previewId);
        return super.saveOffer(p);
      }
    })();
    const client = await mcpClient(app({ index: sellableIndex(), store, config: config({ PROVIDER_ADDRESS: PROVIDER }) }));
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task, profile } });
    const { preview } = PreviewResult.parse(result.structuredContent);
    expect(preview.decision === "reuse" && preview.offer?.terms.amount).toBe("250000");
    expect(preview.decision === "reuse" && preview.offer?.validUntil).toBe("2026-10-01T00:15:00.000Z");
    expect(saved).toEqual([preview.previewId]);
    await client.close();
  });

  it("returns a text-only error when the offer cannot be stored", async () => {
    const store = new (class extends MemoryStore {
      override async saveOffer(): Promise<void> {
        throw new Error("database down");
      }
    })();
    const client = await mcpClient(app({ index: sellableIndex(), store }));
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task, profile } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });

  it("recovers nothing before anything is sold, as a text-only error", async () => {
    const client = await mcpClient(app());
    const result = await client.callTool({ name: LEMMA_TOOLS.recoverResolution, arguments: { previewId: `0x${"22".repeat(32)}`, buyer: PROVIDER } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("NOT_FOUND") }] });
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });

  it("rejects invalid arguments instead of guessing", async () => {
    const client = await mcpClient(app());
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task, profile: { ...profile, dependencies: { "@modelcontextprotocol/sdk": "^1" } } } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("refuses to start paid tools without the protocol lane's registrar", async () => {
    const res = await app({ config: config({ PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER }) }).request("/mcp", post(listTools));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });

  it("waits for an async registrar before dispatching, and answers 500 when it fails", async () => {
    const slow = await mcpClient(app({
      config: config({ PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER }),
      // Like a registrar that quotes the named preview from the store before registering.
      registerPaidTools: async (server) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        server.registerTool(LEMMA_TOOLS.buyResolution, { description: "paid" }, async () => ({ content: [] }));
      },
    }));
    expect((await slow.listTools()).tools.map((t) => t.name)).toContain(LEMMA_TOOLS.buyResolution);
    await slow.close();
    const failing = app({
      config: config({ PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER }),
      registerPaidTools: async () => {
        throw new Error("store unavailable");
      },
    });
    const res = await failing.request("/mcp", post(listTools));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });

  it("never dispatches a call after the request timed out while the registrar ran", async () => {
    let ran = 0;
    const slow = app({
      config: config({ PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER }),
      requestTimeoutMs: 50,
      registerPaidTools: async (server) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        server.registerTool(LEMMA_TOOLS.buyResolution, { description: "paid" }, async () => {
          ran++;
          return { content: [] };
        });
      },
    });
    const res = await slow.request("/mcp", post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: LEMMA_TOOLS.buyResolution, arguments: {} } }));
    expect(res.status).toBe(504);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ran).toBe(0);
  });

  it("registers paid tools through the registrar when enabled", async () => {
    const registered: unknown[] = [];
    const client = await mcpClient(app({
      config: config({ PAID_TOOLS: "on", PROVIDER_ADDRESS: PROVIDER }),
      registerPaidTools: (server, _service, request) => {
        // The registrar sees each request's message, so it can quote the preview a paid call names.
        registered.push(request.message);
        server.registerTool(LEMMA_TOOLS.buyResolution, { description: "paid" }, async () => ({ content: [] }));
      },
    }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(LEMMA_TOOLS.buyResolution);
    expect(registered).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", method: "tools/list" }));
    await client.close();
  });
});

describe("HTTP boundary", () => {
  it("never holds an SSE stream: GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app().request("/mcp", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("refuses browser-originated MCP requests", async () => {
    const res = await app().request("/mcp", post(listTools, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("refuses JSON-RPC batches and malformed JSON, so one request is one message", async () => {
    const batch = await app().request("/mcp", post(Array.from({ length: 5 }, (_, i) => ({ ...listTools, id: i }))));
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
    const garbled = await app().request("/mcp", post("{not json"));
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("answers a slow request with 504, not a server error", async () => {
    class SlowStore extends MemoryStore {
      override async saveOffer(): Promise<void> {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const res = await app({ index: sellableIndex(), store: new SlowStore(), requestTimeoutMs: 50 }).request(
      "/mcp",
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: LEMMA_TOOLS.preview, arguments: { task, profile } } }, { "mcp-protocol-version": "2025-06-18" }),
    );
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "request timed out" });
  });

  it("caps the request body", async () => {
    const res = await app().request("/mcp", post("x".repeat(MAX_BODY_BYTES + 1)));
    expect(res.status).toBe(413);
  });

  it("rate-limits per client, trusting only the proxy-appended address", async () => {
    const a = app({ config: config({ RATE_LIMIT_PER_MINUTE: "2", TRUSTED_PROXY_HOPS: "1" }) });
    const from = (xff: string) => a.request("/api/v1/interest", { headers: { "x-forwarded-for": xff } });
    expect((await from("1.1.1.1, 10.0.0.1")).status).toBe(200);
    expect((await from("2.2.2.2, 10.0.0.1")).status).toBe(200);
    const limited = await from("3.3.3.3, 10.0.0.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await from("10.0.0.2")).status).toBe(200);
  });

  it("sends the production security headers and no-store on MCP responses", async () => {
    const res = await app().request("/mcp", post(listTools));
    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps CORS headers on rate-limited reads, so the dashboard can back off", async () => {
    const a = app({ config: config({ DASHBOARD_ORIGIN: "https://dash.example", RATE_LIMIT_PER_MINUTE: "1" }) });
    const get = () => a.request("/api/v1/releases", { headers: { origin: "https://dash.example" } });
    expect((await get()).status).toBe(200);
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-origin")).toBe("https://dash.example");
    expect(limited.headers.get("access-control-expose-headers")).toContain("Retry-After");
  });

  it("allows cross-origin reads only from the dashboard origin", async () => {
    const a = app({ config: config({ DASHBOARD_ORIGIN: "https://dash.example" }) });
    expect((await a.request("/api/v1/releases", { headers: { origin: "https://dash.example" } })).headers.get("access-control-allow-origin")).toBe("https://dash.example");
    expect((await a.request("/api/v1/releases", { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers unknown paths and failures with JSON and no internals", async () => {
    expect(await (await app().request("/nope")).json()).toEqual({ error: "not found" });
  });
});

describe("read API", () => {
  it("serves one interest response for all capabilities, revalidated by catalog digest", async () => {
    const a = app();
    const index = committedIndex();
    const res = await a.request("/api/v1/interest");
    expect(await res.json()).toEqual({ catalogDigest: index.catalogDigest, capabilities: index.interest });
    const etag = res.headers.get("etag");
    expect(etag).toBe(`"${index.catalogDigest}"`);
    expect((await a.request("/api/v1/interest", { headers: { "if-none-match": etag as string } })).status).toBe(304);
  });

  it("lists releases with their digests and source, briefly cacheable", async () => {
    const res = await app().request("/api/v1/releases");
    const body = (await res.json()) as { releases: Array<{ releaseDigest: string; source: string }> };
    expect(body.releases).toHaveLength(2);
    expect(body.releases.every((r) => r.source === "public")).toBe(true);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("serves immutable base probes by release digest", async () => {
    const a = app({ index: sellableIndex() });
    const digest = sellableIndex().releases[0]?.releaseDigest as string;
    const res = await a.request(`/api/v1/releases/${digest}/base-probe`);
    expect(await res.json()).toEqual({ releaseDigest: digest, files: [{ path: "src/x.ts", baseDigest: null }] });
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect((await a.request("/api/v1/releases/0x1234/base-probe")).status).toBe(400);
    expect((await a.request(`/api/v1/releases/0x${"ab".repeat(32)}/base-probe`)).status).toBe(404);
  });

  it("serves a release manifest by digest, from the catalog or, once a redeploy dropped it, from the store", async () => {
    const index = sellableIndex();
    const release = index.releases[0]?.release;
    const digest = index.releases[0]?.releaseDigest as string;
    const res = await app({ index }).request(`/api/v1/releases/${digest}`);
    expect(await res.json()).toEqual({ releaseDigest: digest, release });
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // A later catalog without it: the copy saved at startup still answers, so a bought release is never stranded.
    const store = new MemoryStore();
    await store.saveCatalog(index, NOW);
    expect(await (await app({ store }).request(`/api/v1/releases/${digest}`)).json()).toEqual({ releaseDigest: digest, release });
    expect((await app().request("/api/v1/releases/0x1234")).status).toBe(400);
    expect((await app().request(`/api/v1/releases/0x${"ab".repeat(32)}`)).status).toBe(404);
  });

  it("reports health with the catalog digest", async () => {
    expect(await (await app().request("/healthz")).json()).toEqual({ status: "ok", catalogDigest: committedIndex().catalogDigest });
  });
});

describe("startup checks", () => {
  it("requires every sellable release to pay the configured provider", () => {
    expect(startupProblems(config(), sellableIndex())).toEqual(["gating@1.0.0+bench-1 can be sold, but PROVIDER_ADDRESS is not set"]);
    expect(startupProblems(config({ PROVIDER_ADDRESS: "0x00000000000000000000000000000000000000b1" }), sellableIndex())).toEqual([
      `gating@1.0.0+bench-1 pays ${PROVIDER}, not the configured provider`,
    ]);
    expect(startupProblems(config({ PROVIDER_ADDRESS: PROVIDER }), sellableIndex())).toEqual([]);
    expect(startupProblems(config(), committedIndex())).toEqual([]);
  });
});

describe("clientAddress and TokenBuckets", () => {
  it("keys IPv6 clients by /64, unwraps IPv4-mapped addresses, and ignores non-IP entries", () => {
    expect(normalizeIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8:1:2::ffff")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("not-an-ip")).toBe("unknown");
    expect(clientAddress("x".repeat(10_000), "10.0.0.1", 1)).toBe("10.0.0.1");
    expect(clientAddress("2001:db8:1:2::1", "10.0.0.1", 1)).toBe("2001:db8:1:2::/64");
  });

  it("ignores client-supplied forwarding entries", () => {
    expect(clientAddress("6.6.6.6, 1.1.1.1", "10.0.0.1", 1)).toBe("1.1.1.1");
    expect(clientAddress("6.6.6.6, 1.1.1.1, 10.0.0.9", "10.0.0.1", 2)).toBe("1.1.1.1");
    expect(clientAddress("6.6.6.6", "10.0.0.1", 0)).toBe("10.0.0.1");
    expect(clientAddress(undefined, undefined, 1)).toBe("unknown");
  });

  it("bounds the memory preview store, sweeping expired offers first", async () => {
    let now = NOW;
    const store = new MemoryStore({ clock: () => now, capacity: 2 });
    const offerPreview = (id: string) => ({ previewId: id, offer: { validUntil: "2026-10-01T00:15:00.000Z" } }) as unknown as Parameters<MemoryStore["saveOffer"]>[0];
    await store.saveOffer(offerPreview(`0x${"01".repeat(32)}`));
    await store.saveOffer(offerPreview(`0x${"02".repeat(32)}`));
    await expect(store.saveOffer(offerPreview(`0x${"03".repeat(32)}`))).rejects.toThrow(/full/);
    now = new Date("2026-10-01T00:16:00.000Z");
    await store.saveOffer(offerPreview(`0x${"03".repeat(32)}`));
    expect(store.offerCount).toBe(1);
  });

  it("refills continuously and bounds its key table", () => {
    const b = new TokenBuckets(60, 3);
    expect(b.take("a", 0)).toBe(0);
    for (let i = 0; i < 59; i++) b.take("a", 0);
    expect(b.take("a", 0)).toBe(1);
    expect(b.take("a", 1000)).toBe(0);
    for (const k of ["b", "c", "d", "e"]) b.take(k, 0);
    expect(b.size).toBe(3);
  });
});

it("serves previews at the injected instant", async () => {
  const client = await mcpClient(app());
  const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task, profile } });
  expect(PreviewResult.parse(result.structuredContent).preview.createdAt).toBe(NOW.toISOString());
  await client.close();
});
