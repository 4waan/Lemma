import { LEMMA_TOOLS } from "@lemma/core";
import { describe, expect, it } from "vitest";

import { ConfigError, DemandRecorder, MemoryStore, ResolutionService, StoreError, describeError, loadConfig, schemaIsCurrent, silentLogger } from "../src/index.js";
import { NOW, app, mcpClient } from "./helpers.js";

// Built at runtime, so secret scanners do not mistake test values for real connection strings.
const SCHEME = "postgres";
const dbUrl = (password: string) => `${SCHEME}://lemma:${password}@db.internal:5432/lemma`;

describe("database configuration and errors", () => {
  it("refuses a malformed DATABASE_URL without repeating it", () => {
    // No "//" after the scheme: not a connection string postgres.js reads.
    const secret = dbUrl("Xy7#kQ9secret").replace("://", ":");
    let message = "";
    try {
      loadConfig({ NODE_ENV: "test", DATABASE_URL: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("kQ9secret");
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://u:p@h/db" })).toThrow(ConfigError);
    expect(loadConfig({ NODE_ENV: "test", DATABASE_URL: dbUrl("p%23w") }).databaseUrl).toBeDefined();
    // postgres.js parses these itself: multi-host failover, and a host-less URL that uses PGHOST or a unix socket.
    expect(loadConfig({ NODE_ENV: "test", DATABASE_URL: `${SCHEME}://lemma@10.0.0.1:5432,10.0.0.2:5432/lemma` }).databaseUrl).toBeDefined();
    expect(loadConfig({ NODE_ENV: "test", DATABASE_URL: `${SCHEME}ql:///lemma` }).databaseUrl).toBeDefined();
  });

  it("describes database errors by name and SQLSTATE, never by message or parameters", () => {
    const wrapped = Object.assign(new Error("Failed query: insert into demand_salts ... params: 2026-10-01,SECRET-SALT"), { name: "DrizzleQueryError", cause: Object.assign(new Error("duplicate key"), { code: "23505" }) });
    expect(describeError(wrapped)).toBe("DrizzleQueryError 23505");
    expect(describeError(new TypeError(`Invalid URL: ${dbUrl("pw")}`))).toBe("TypeError");
    expect(describeError("text")).toBe("string");
    // Connection codes carry no secrets and say what failed.
    expect(describeError(Object.assign(new Error(`connect ECONNREFUSED ${dbUrl("pw")}`), { code: "ECONNREFUSED" }))).toBe("Error ECONNREFUSED");
    expect(describeError(Object.assign(new Error("write CONNECT_TIMEOUT db.internal:5432"), { code: "CONNECT_TIMEOUT" }))).toBe("Error CONNECT_TIMEOUT");
    expect(describeError(Object.assign(new Error("x"), { code: "has spaces: secret" }))).toBe("Error");
  });

  it("gives the payment work store failures as a StoreError with the code only", async () => {
    const store = new (class extends MemoryStore {
      override async getPreview(): Promise<undefined> {
        throw Object.assign(new Error("Failed query: select body from previews params: 0xsecretpreview"), { cause: { code: "57014" } });
      }
    })();
    const service = new ResolutionService(store, () => NOW, silentLogger);
    const failure = await service.quote(`0x${"22".repeat(32)}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as StoreError).code).toBe("57014");
    expect(String((failure as Error).message)).not.toContain("secretpreview");
    expect(JSON.stringify(failure)).not.toContain("secretpreview");
    await expect(service.prepare(`0x${"22".repeat(32)}`, { payer: "0x00000000000000000000000000000000000000b1", nonce: "0x01", validBefore: NOW })).rejects.toBeInstanceOf(StoreError);
  });

  it("requires DEMAND_SOURCE_KEY in production and never stores a client address the database could reverse", async () => {
    const prod = { NODE_ENV: "production", DATABASE_URL: dbUrl("p") };
    expect(() => loadConfig(prod)).toThrow(/DEMAND_SOURCE_KEY/);
    expect(() => loadConfig({ ...prod, DEMAND_SOURCE_KEY: "short" })).toThrow(ConfigError);
    expect(loadConfig({ ...prod, DEMAND_SOURCE_KEY: "k".repeat(32) }).demandSourceKey).toHaveLength(32);

    const sources: string[] = [];
    const store = new (class extends MemoryStore {
      override async recordDemand(day: string, bucket: string, digest: `0x${string}`, source: string): Promise<void> {
        sources.push(source);
        return super.recordDemand(day, bucket, digest, source);
      }
    })();
    const key = new TextEncoder().encode("k".repeat(32));
    const preview = { decision: "build", reasons: [], profileDigest: `0x${"33".repeat(32)}` } as never;
    const profile = { packageManager: { name: "npm" }, moduleSystem: "esm", runtime: { major: 22 }, frameworks: [] } as never;
    await new DemandRecorder(store, silentLogger, key).record(preview, "cap", profile, NOW, "198.51.100.7");
    await new DemandRecorder(store, silentLogger, key).record(preview, "cap", profile, NOW, "198.51.100.7");
    await new DemandRecorder(store, silentLogger, new TextEncoder().encode("j".repeat(32))).record(preview, "cap", profile, NOW, "198.51.100.7");
    expect(sources[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(sources[0]).not.toContain("198.51");
    // Stable under one key (so one address counts once across restarts), different under another.
    expect(sources[1]).toBe(sources[0]);
    expect(sources[2]).not.toBe(sources[0]);
  });

  it("reads only a missing migrations table as 'not migrated', and reports anything else", async () => {
    const failing = (code: string) => ({ execute: async () => Promise.reject(Object.assign(new Error("boom"), { cause: { code } })) }) as never;
    expect(await schemaIsCurrent(failing("42P01"))).toMatchObject({ current: false, applied: null });
    expect(await schemaIsCurrent(failing("3F000"))).toMatchObject({ current: false, applied: null });
    await expect(schemaIsCurrent(failing("28P01"))).rejects.toThrow();
    await expect(schemaIsCurrent(failing("42501"))).rejects.toThrow();
  });

  it("answers recovery with a fixed text when the store fails, without SQL or parameters", async () => {
    const store = new (class extends MemoryStore {
      override async getResolution(): Promise<undefined> {
        throw new Error('Failed query: select "resolution_id", "preview_id" from resolutions params: 0xsecretpreview');
      }
    })();
    const client = await mcpClient(app({ store, service: new ResolutionService(store, () => NOW, silentLogger) }));
    const result = await client.callTool({ name: LEMMA_TOOLS.recoverResolution, arguments: { previewId: `0x${"11".repeat(32)}`, buyer: "0x00000000000000000000000000000000000000b1" } });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("UNAVAILABLE");
    expect(text).not.toContain("secretpreview");
    expect(text).not.toContain("select");
    await client.close();
  });
});
