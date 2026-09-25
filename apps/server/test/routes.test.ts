import { DemandView, LEMMA_TOOLS, PreviewResult, ResolutionDelivery, deriveResolutionId } from "@lemma/core";
import { describe, expect, it } from "vitest";

import { MemoryStore, ResolutionService, silentLogger } from "../src/index.js";
import { BUYER, NOW, PROVIDER, app, config, gatingTask, matchingProfile, mcpClient, sellableIndex } from "./helpers.js";

/** An app over a sellable catalog with a shared store, so tests can play the payment work's part. */
async function sellableApp() {
  const store = new MemoryStore();
  const index = sellableIndex();
  await store.saveCatalog(index, NOW);
  const service = new ResolutionService(store, () => NOW, silentLogger);
  const a = app({ index, store, service, config: config({ PROVIDER_ADDRESS: PROVIDER }) });
  const client = await mcpClient(a);
  const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } });
  const { preview } = PreviewResult.parse(result.structuredContent);
  return { a, client, store, service, preview };
}

describe("paid path seam over HTTP", () => {
  it("recovers a settled resolution through the free MCP tool, and nothing before settlement", async () => {
    const { client, service, preview } = await sellableApp();
    const recover = () => client.callTool({ name: LEMMA_TOOLS.recoverResolution, arguments: { previewId: preview.previewId, buyer: BUYER } });
    expect((await recover()).isError).toBe(true);
    const prepared = await service.prepare(preview.previewId, { payer: BUYER, nonce: "0x01", validBefore: new Date(NOW.getTime() + 300_000) });
    expect(prepared.ok).toBe(true);
    expect(await recover()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("IN_FLIGHT") }] });
    await service.commit(deriveResolutionId(preview.previewId, BUYER), { nonce: "0x01", settlementRef: "0xsettlement" });
    const delivery = ResolutionDelivery.parse((await recover()).structuredContent);
    expect(delivery.resolution.buyer).toBe(BUYER);
    await client.close();
  });

  it("shows a public view of a resolution without its preview id or buyer", async () => {
    const { a, client, service, preview } = await sellableApp();
    await service.prepare(preview.previewId, { payer: BUYER, nonce: "0x01", validBefore: new Date(NOW.getTime() + 300_000) });
    const id = deriveResolutionId(preview.previewId, BUYER);
    const res = await a.request(`/api/v1/resolutions/${id}`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ resolutionId: id, state: "prepared", receipt: null });
    expect(text).not.toContain(preview.previewId.slice(2));
    expect(text).not.toContain(BUYER.slice(2));
    expect((await a.request("/api/v1/resolutions/0x1234")).status).toBe(400);
    expect((await a.request(`/api/v1/resolutions/0x${"ab".repeat(32)}`)).status).toBe(404);
    await client.close();
  });

  it("accepts the buyer's adoption receipt only for a settled resolution, once", async () => {
    const { a, client, service, preview } = await sellableApp();
    const id = deriveResolutionId(preview.previewId, BUYER);
    const receipt = { schemaVersion: "1", resolutionId: id, outcome: "passed", acceptance: { exitCode: 0, durationMs: 10, outputDigest: null }, recordedAt: "2026-10-01T00:00:00.000Z", signature: null };
    const post = (body: unknown, headers: Record<string, string> = {}) => a.request("/api/v1/adoption-receipts", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const submission = { receipt, previewId: preview.previewId };
    expect((await post(submission)).status).toBe(404);
    await service.prepare(preview.previewId, { payer: BUYER, nonce: "0x01", validBefore: new Date(NOW.getTime() + 300_000) });
    expect((await post(submission)).status).toBe(409);
    await service.commit(id, { nonce: "0x01", settlementRef: "0xsettlement" });
    // The public resolution id alone does not let anyone else take the receipt slot.
    expect((await post({ receipt, previewId: `0x${"99".repeat(32)}` })).status).toBe(404);
    expect((await post(receipt)).status).toBe(400);
    expect((await post(submission)).status).toBe(201);
    expect(await (await post(submission)).json()).toEqual({ result: "DUPLICATE" });
    expect((await post({ ...submission, receipt: { ...receipt, outcome: "bogus" } })).status).toBe(400);
    expect((await post(submission, { origin: "https://evil.example" })).status).toBe(403);
    await client.close();
  });

  it("answers 500, not 400, when the store fails, so the bridge retries a valid receipt", async () => {
    const store = new (class extends MemoryStore {
      override async getResolution(): Promise<undefined> {
        throw Object.assign(new Error("Failed query: select ... params: 0xsecret"), { code: "57P01" });
      }
    })();
    const lines: string[] = [];
    const logger = { log: (_level: string, event: string, fields?: Record<string, unknown>) => void lines.push(JSON.stringify({ event, ...fields })) };
    const a = app({ store, service: new ResolutionService(store, () => NOW, silentLogger), logger });
    const receipt = { schemaVersion: "1", resolutionId: `0x${"aa".repeat(32)}`, outcome: "passed", acceptance: { exitCode: 0, durationMs: 10, outputDigest: null }, recordedAt: "2026-10-01T00:00:00.000Z", signature: null };
    const res = await a.request("/api/v1/adoption-receipts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt, previewId: `0x${"bb".repeat(32)}` }) });
    expect(res.status).toBe(500);
    expect(lines.join("\n")).toContain("57P01");
    expect(lines.join("\n")).not.toContain("0xsecret");
  });
});

describe("demand", () => {
  it("records every preview and publishes only closed buckets with five or more repositories and sources", async () => {
    const store = new MemoryStore();
    const a = app({ store, config: config({ TRUSTED_PROXY_HOPS: "1" }) });
    for (let i = 0; i < 5; i++) {
      const client = await mcpClient(a, { "x-forwarded-for": `203.0.113.${i + 1}` });
      await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: { ...matchingProfile, dependencies: { "@modelcontextprotocol/sdk": `1.30.${i + 1}` } } } });
      await client.close();
    }
    // One caller making up five more profiles adds no source, so a bucket it alone fills stays hidden.
    const sybil = await mcpClient(a, { "x-forwarded-for": "198.51.100.7" });
    for (let i = 0; i < 5; i++) {
      await sybil.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: { ...matchingProfile, moduleSystem: "cjs", dependencies: { "@modelcontextprotocol/sdk": `1.30.${i + 1}` } } } });
    }
    await sybil.close();
    const client = await mcpClient(a);
    expect(await (await a.request("/api/v1/demand")).json()).toEqual({ minProfiles: 5, buckets: [] });
    await store.closeDemandDaysBefore("2026-10-02");
    const text = await (await a.request("/api/v1/demand")).text();
    const body = DemandView.parse(JSON.parse(text));
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]).toMatchObject({ day: "2026-10-01", profiles: 5, sources: 5 });
    expect(body.buckets[0]?.key).toEqual({
      capability: "mcp-server.add-payment-gating",
      decision: "reuse",
      release: "mcp-server-payment-gating@0.1.0-skeleton",
      profileIndex: 0,
      reasons: ["PROFILE_NOT_BENCHMARKED"],
      offer: false,
      class: { packageManager: "npm", moduleSystem: "esm", nodeMajor: 22, frameworks: [] },
    });
    expect(text).not.toContain("1.30.");
    await client.close();
  });

  it("answers a preview without waiting on a stalled demand write", async () => {
    const store = new (class extends MemoryStore {
      override recordDemand(): Promise<void> {
        return new Promise(() => undefined);
      }
    })();
    const client = await mcpClient(app({ store, requestTimeoutMs: 2000 }));
    const started = Date.now();
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } });
    expect(result.isError).toBeFalsy();
    expect(Date.now() - started).toBeLessThan(1500);
    await client.close();
  });

  it("never fails a preview because demand could not be recorded", async () => {
    const store = new (class extends MemoryStore {
      override async recordDemand(): Promise<void> {
        throw new Error("database down");
      }
    })();
    const client = await mcpClient(app({ store }));
    const result = await client.callTool({ name: LEMMA_TOOLS.preview, arguments: { task: gatingTask, profile: matchingProfile } });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
