import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildIndex, loadCatalog } from "@lemma/catalog";
import { type Hex32, MAX_FILE_CONTENT, type PatchBundle, bundleDigest, deriveResolutionId, fileDigest } from "@lemma/core";
import { MemoryStore, ResolutionService, createApp, loadConfig, silentLogger } from "@lemma/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRIDGE_INSTRUCTIONS,
  BaseProbeResponse,
  InterestResponse,
  LemmaRemote,
  type PaidToolContext,
  MAX_RULE_CHARS,
  MAX_TOOL_TEXT,
  RULE_PATH,
  ResolutionInbox,
  ScanCache,
  Trace,
  createBridgeServer,
  defaultStateDir,
  driftCheck,
  installRule,
  previewText,
  recoverPending,
  stateDirFor,
} from "../src/index.js";
import { sellableIndexFor } from "./sellable.js";

const SDK = "@modelcontextprotocol/sdk";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const BUYER = "0x00000000000000000000000000000000000000b1";
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

function workspace(extra: Record<string, string> = {}): string {
  const root = temp("lemma-ws-");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module", dependencies: { [SDK]: "^1.30.0" }, devDependencies: { typescript: "7.0.2" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, [`node_modules/${SDK}`]: { version: "1.30.1" } } }),
    ".nvmrc": "22\n",
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

let n = 0;
function serverApp(index = buildIndex(loadCatalog({ includeProvisional: false })), store = new MemoryStore()): { app: Hono; store: MemoryStore; service: ResolutionService } {
  const service = new ResolutionService(store, () => NOW, silentLogger);
  const app = createApp({
    config: loadConfig({ NODE_ENV: "test", PROVIDER_ADDRESS: "0x00000000000000000000000000000000000000a1" }),
    index,
    store,
    service,
    clock: () => NOW,
    newPreviewId: () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex32,
    logger: silentLogger,
  });
  return { app, store, service };
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function bridge(app: Hono, root: string, options: { trace?: string; paid?: boolean; fetch?: (real: Fetch) => Fetch; timeoutMs?: number } = {}) {
  let paidContext: PaidToolContext | undefined;
  const real: Fetch = async (input, init) => app.request(String(input), init);
  const remote = new LemmaRemote(new URL("http://lemma.test"), options.fetch?.(real) ?? real, options.timeoutMs);
  const inbox = new ResolutionInbox(temp("lemma-state-"));
  let clock = 0;
  let wall = NOW.getTime();
  const server = createBridgeServer({
    remote,
    scanner: new ScanCache(),
    inbox,
    trace: new Trace(options.trace),
    root,
    cwd: () => root,
    runningNodeMajor: 22,
    monotonic: () => clock,
    wallClock: () => wall,
    registerPaidTools:
      options.paid === true
        ? (s, ctx) => {
            paidContext = ctx;
            s.registerTool("lemma_buy_resolution", { description: "Buy the offered resolution." }, async () => ({ content: [] }));
          }
        : undefined,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(b);
  const preview = async (capability = "mcp-server.add-payment-gating", pkg?: string) => {
    const result = await client.callTool({ name: "lemma_preview", arguments: pkg === undefined ? { capability } : { capability, package: pkg } });
    return (result.content as Array<{ text: string }>)[0]?.text as string;
  };
  const offer = () => paidContext?.latestOffer("mcp-server.add-payment-gating");
  return { client, remote, inbox, preview, offer, tick: (ms: number) => (clock += ms), sleep: (ms: number) => (wall += ms), paid: () => paidContext };
}

describe("the agent-facing bridge", () => {
  it("keeps its tools and instructions within the context budget", async () => {
    const { client } = await bridge(serverApp().app, workspace());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["lemma_preview"]);
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
    expect(JSON.stringify(tools).length + BRIDGE_INSTRUCTIONS.length).toBeLessThanOrEqual(3000);
    expect(BRIDGE_INSTRUCTIONS.split(/\s+/).length).toBeLessThanOrEqual(60);
  });

  it("answers from the real server with short text, in one request per preview once warm", async () => {
    const { preview, remote } = await bridge(serverApp().app, workspace());
    const first = await preview();
    expect(first).toContain("cannot be sold (PROFILE_NOT_BENCHMARKED)");
    expect(first.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    const warm = remote.requests;
    await preview();
    expect(remote.requests - warm).toBe(1);
    expect(await preview("node-service.add-payment-facilitator")).toContain("no release fits this repository (NO_RELEASE_FOR_CAPABILITY)");
  });

  it("keeps an offer for paid tools only until it expires, by the monotonic clock", async () => {
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    const b = await bridge(app, workspace(), { paid: true });
    await b.preview();
    expect(b.paid()?.latestOffer("mcp-server.add-payment-gating")?.decision).toBe("reuse");
    b.tick(899_999);
    expect(b.paid()?.latestOffer("mcp-server.add-payment-gating")).toBeDefined();
    b.tick(1);
    expect(b.paid()?.latestOffer("mcp-server.add-payment-gating")).toBeUndefined();
  });

  it("also expires an offer by the wall clock, which keeps counting while the machine sleeps", async () => {
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    const b = await bridge(app, workspace(), { paid: true });
    await b.preview();
    b.sleep(899_999);
    expect(b.offer()).toBeDefined();
    b.sleep(1);
    expect(b.offer()).toBeUndefined();
  });

  it("keeps no offer the agent was told not to buy: drift, a failed base probe, or a later failed preview", async () => {
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    const drifted = await bridge(app, workspace({ "src/lemma/gating.ts": "already here\n" }), { paid: true });
    expect(await drifted.preview()).toContain("do not buy it");
    expect(drifted.offer()).toBeUndefined();

    const probeDown = await bridge(app, workspace(), { paid: true, fetch: (real) => async (input, init) => (String(input).includes("/base-probe") ? new Response("", { status: 500 }) : real(input, init)) });
    expect(await probeDown.preview()).toContain("Build it yourself");
    expect(probeDown.offer()).toBeUndefined();

    let up = true;
    const flaky = await bridge(app, workspace(), { paid: true, fetch: (real) => async (input, init) => (up ? real(input, init) : Promise.reject(new TypeError("fetch failed"))) });
    await flaky.preview();
    expect(flaky.offer()).toBeDefined();
    up = false;
    await flaky.remote.close();
    expect(await flaky.preview()).toContain("Build it yourself");
    expect(flaky.offer()).toBeUndefined();
  });

  it("hands out no new offer for a release that is pending or already bought, and recovers on request", async () => {
    const { app, store, service } = serverApp(sellableIndexFor(), new MemoryStore());
    await store.saveCatalog(sellableIndexFor(), NOW);
    const b = await bridge(app, workspace(), { paid: true });
    await b.preview();
    const first = b.offer();
    if (first === undefined || first.decision !== "reuse") throw new Error("expected an open offer");
    b.inbox.markPending(first.previewId, BUYER, NOW, first.release.releaseDigest);
    const again = await b.preview();
    expect(again).toContain("A purchase of it is still settling in this bridge: do not buy it again");
    expect(again).not.toContain("call lemma_buy_resolution");
    expect(b.offer()).toBeUndefined();
    await service.prepare(first.previewId, { payer: BUYER, nonce: "0x01", validBefore: new Date(NOW.getTime() + 300_000) });
    await service.commit(deriveResolutionId(first.previewId, BUYER), { nonce: "0x01", settlementRef: "0xsettlement" });
    expect(await b.paid()?.recover()).toEqual({ recovered: 1, waiting: 0, dropped: 0 });
    expect(b.inbox.pending()).toEqual([]);
    expect(await b.preview()).toContain("It is already bought in this bridge: do not buy it again; use lemma_apply_resolution.");
    expect(b.offer()).toBeUndefined();
  });

  it("holds back every offer while a pending mark from an older bridge names no release", async () => {
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    const b = await bridge(app, workspace(), { paid: true });
    b.inbox.markPending(`0x${"99".repeat(32)}`, BUYER, NOW);
    await b.preview();
    expect(b.offer()).toBeUndefined();
  });

  it("accepts only safe relative base-probe paths, and treats a file too large to patch as drift", async () => {
    const releaseDigest = `0x${"55".repeat(32)}`;
    expect(BaseProbeResponse.safeParse({ releaseDigest, files: [{ path: "../secret.txt", baseDigest: null }] }).success).toBe(false);
    expect(BaseProbeResponse.safeParse({ releaseDigest, files: [{ path: ".env", baseDigest: null }] }).success).toBe(false);
    const root = workspace({ "src/big.ts": "x".repeat(MAX_FILE_CONTENT + 1) });
    const big = readFileSync(join(root, "src/big.ts"));
    expect(driftCheck(root, [{ path: "src/big.ts", baseDigest: fileDigest(big) }])).toBe("likely");
    expect(driftCheck(root, [{ path: "package.json", baseDigest: fileDigest(readFileSync(join(root, "package.json"))) }])).toBe("none");
  });

  it("previews with an empty interest set for a capability an older server does not list", async () => {
    const digest = `0x${"12".repeat(32)}`;
    expect(InterestResponse.parse({ catalogDigest: digest, capabilities: {} }).capabilities["mcp-server.add-payment-gating"]).toBeUndefined();
    const { app } = serverApp();
    const b = await bridge(app, workspace(), {
      fetch: (real) => async (input, init) => {
        const res = await real(input, init);
        if (!String(input).endsWith("/api/v1/interest") || !res.ok) return res;
        const body = (await res.json()) as { capabilities: Record<string, unknown> };
        delete body.capabilities["node-service.add-payment-facilitator"];
        return Response.json(body);
      },
    });
    expect(await b.preview("node-service.add-payment-facilitator")).toContain("no release fits this repository");
    expect(await b.preview()).toContain("cannot be sold");
  });

  it("gives up on a stalled server and tells the agent to build", async () => {
    const stalled = (): Fetch => async (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)));
    const b = await bridge(serverApp().app, workspace(), { fetch: stalled, timeoutMs: 50 });
    expect(await b.preview()).toContain("Build it yourself");
  });

  it("offers a sellable resolution, and warns before any purchase when local files would drift", async () => {
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    const clean = await bridge(app, workspace(), { paid: true });
    const text = await clean.preview();
    expect(text).toContain("Price 0.25 USDC");
    expect(text).toContain("call lemma_buy_resolution");
    const drifted = await bridge(app, workspace({ "src/lemma/gating.ts": "already here\n" }), { paid: true });
    const warned = await drifted.preview();
    expect(warned).toContain("likely need adaptation, so do not buy it");
    expect(warned).not.toContain("call lemma_buy_resolution");
  });

  it("says purchases are off when no paid tools are registered", async () => {
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    expect(await (await bridge(app, workspace())).preview()).toContain("Purchases are not enabled in this bridge");
  });

  it("traces initialize and tool calls for the benchmark harness, and nothing else", async () => {
    const trace = join(temp("lemma-trace-"), "trace.jsonl");
    const { preview } = await bridge(serverApp().app, workspace(), { trace });
    await preview();
    expect(readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ event: "initialize" }, { event: "tool", name: "lemma_preview" }]);
  });

  it("traces tool calls the SDK rejects for their arguments, without recording what was sent", async () => {
    const trace = join(temp("lemma-trace-"), "trace.jsonl");
    const { client } = await bridge(serverApp().app, workspace(), { trace });
    expect((await client.callTool({ name: "lemma_preview", arguments: { capability: "x402 gating" } })).isError).toBe(true);
    expect((await client.callTool({ name: "lemma_preview", arguments: { capability: "mcp-server.add-payment-gating", package: "./apps/api" } })).isError).toBe(true);
    await client.callTool({ name: "secret-token-name", arguments: {} }).catch(() => undefined);
    const lines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ event: "initialize" }, { event: "tool", name: "lemma_preview" }, { event: "tool", name: "lemma_preview" }, { event: "tool", name: "other" }]);
  });

  it("scans a monorepo package named by the agent, and refuses paths out of the workspace", async () => {
    const root = workspace({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "apps/api": {}, [`node_modules/${SDK}`]: { version: "1.30.1" } } }),
      "apps/api/package.json": JSON.stringify({ type: "module", dependencies: { [SDK]: "^1.30.0" } }),
      "apps/api/tsconfig.json": "{}",
    });
    const { client, preview } = await bridge(serverApp().app, root);
    expect(await preview()).toContain("platform is not supported");
    const call = (pkg: string) => client.callTool({ name: "lemma_preview", arguments: { capability: "mcp-server.add-payment-gating", package: pkg } });
    expect(JSON.stringify((await call("apps/api")).content)).toContain("cannot be sold (PROFILE_NOT_BENCHMARKED)");
    for (const bad of ["../outside", "/etc", "apps/../..", ".git"]) expect((await call(bad)).isError).toBe(true);
  });

  it("refuses a named package that is missing or linked instead of scanning the root package", async () => {
    const root = workspace({ "packages/real-api/package.json": JSON.stringify({ dependencies: { [SDK]: "^1.30.0" } }) });
    symlinkSync(join(root, "packages/real-api"), join(root, "apps-link"));
    const { app } = serverApp(sellableIndexFor(), new MemoryStore());
    const b = await bridge(app, root, { paid: true });
    expect(await b.preview()).toContain("Price 0.25 USDC");
    for (const pkg of ["apps/api", "apps-link", "apps-link/src", "packages"]) {
      const text = await b.preview("mcp-server.add-payment-gating", pkg);
      expect(text).toContain(`${pkg} is not a package directory`);
      expect(text).not.toContain("Price");
      expect(b.offer()).toBeUndefined();
    }
  });

  it("says when a missing lockfile may be hiding a match", async () => {
    const root = workspace({ "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }) });
    expect(await (await bridge(serverApp().app, root)).preview()).toContain("could not be read exactly");
  });

  it("fails soft, telling the agent to build, when the server is unreachable", async () => {
    const remote = new LemmaRemote(new URL("http://lemma.test"), async () => {
      throw new TypeError("fetch failed");
    });
    const server = createBridgeServer({ remote, scanner: new ScanCache(), inbox: new ResolutionInbox(temp("lemma-state-")), trace: new Trace(undefined), root: workspace(), cwd: () => "", runningNodeMajor: 22, monotonic: () => 0 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "agent", version: "0" });
    await client.connect(b);
    const result = await client.callTool({ name: "lemma_preview", arguments: { capability: "mcp-server.add-payment-gating" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Build it yourself");
  });
});

describe("text", () => {
  it("never passes catalog prose to the model", () => {
    const index = sellableIndexFor();
    const title = index.releases[0]?.release.title as string;
    const preview = {
      schemaVersion: "1" as const,
      previewId: `0x${"22".repeat(32)}`,
      taskDigest: `0x${"33".repeat(32)}`,
      profileDigest: `0x${"44".repeat(32)}`,
      catalogDigest: `0x${"45".repeat(32)}`,
      createdAt: NOW.toISOString(),
      decision: "reuse" as const,
      release: { releaseId: "gating", version: "1.0.0+bench-1", releaseDigest: `0x${"55".repeat(32)}`, profileIndex: 0 },
      offer: null,
      reasons: ["EVIDENCE_STALE" as const],
    };
    const text = previewText(preview, "unchecked", true);
    expect(text).not.toContain(title);
    expect(text).not.toContain("gating");
  });
});

describe("inbox and recovery", () => {
  it("keeps the state directory absolute and out of the workspace", () => {
    const root = temp("lemma-ws-");
    const home = join(homedir(), ".local", "state", "lemma");
    expect(defaultStateDir({ XDG_STATE_HOME: "" })).toBe(home);
    expect(defaultStateDir({ XDG_STATE_HOME: "state" })).toBe(home);
    expect(defaultStateDir({ XDG_STATE_HOME: "/var/state" })).toBe("/var/state/lemma");
    expect(stateDirFor(root, { LEMMA_STATE_DIR: "" })).toBe(home);
    expect(() => stateDirFor(root, { LEMMA_STATE_DIR: "state" })).toThrow(/absolute/);
    expect(() => stateDirFor(root, { LEMMA_STATE_DIR: root })).toThrow(/outside the workspace/);
    expect(() => stateDirFor(root, { XDG_STATE_HOME: join(root, "xdg") })).toThrow(/outside the workspace/);
    expect(stateDirFor(root, { LEMMA_STATE_DIR: join(tmpdir(), "elsewhere") })).toBe(join(tmpdir(), "elsewhere"));
    // A path through a link into the workspace is still inside it.
    const link = join(temp("lemma-link-"), "ws");
    symlinkSync(root, link);
    expect(() => stateDirFor(realpathSync(root), { LEMMA_STATE_DIR: join(link, ".lemma-state") })).toThrow(/outside the workspace/);
    expect(() => stateDirFor(realpathSync(root), { XDG_STATE_HOME: join(link, "xdg") })).toThrow(/outside the workspace/);
  });

  it("stores only deliveries whose bundle matches, and recovers a lost paid response for free", async () => {
    const { app, store, service } = serverApp(sellableIndexFor(), new MemoryStore());
    await store.saveCatalog(sellableIndexFor(), NOW);
    const b = await bridge(app, workspace(), { paid: true });
    await b.preview();
    const offer = b.paid()?.latestOffer("mcp-server.add-payment-gating");
    if (offer === undefined) throw new Error("expected an open offer");
    const previewId = offer.previewId;
    b.inbox.markPending(previewId, BUYER, NOW);
    expect(await recoverPending(b.inbox, b.remote, NOW)).toEqual({ recovered: 0, waiting: 1, dropped: 0 });
    const prepared = await service.prepare(previewId, { payer: BUYER, nonce: "0x01", validBefore: new Date(NOW.getTime() + 300_000) });
    expect(prepared.ok).toBe(true);
    expect(await recoverPending(b.inbox, b.remote, NOW)).toEqual({ recovered: 0, waiting: 1, dropped: 0 });
    await service.commit(deriveResolutionId(previewId, BUYER), { nonce: "0x01", settlementRef: "0xsettlement" });
    expect(await recoverPending(b.inbox, b.remote, NOW)).toEqual({ recovered: 1, waiting: 0, dropped: 0 });
    expect(b.inbox.pending()).toEqual([]);
    expect(b.inbox.get(deriveResolutionId(previewId, BUYER))?.resolution.buyer).toBe(BUYER);
  });

  it("drops a pending purchase the server never saw once no authorization can still settle", async () => {
    const b = await bridge(serverApp().app, workspace());
    b.inbox.markPending(`0x${"99".repeat(32)}`, BUYER, NOW);
    expect(await recoverPending(b.inbox, b.remote, new Date(NOW.getTime() + 60_000))).toEqual({ recovered: 0, waiting: 1, dropped: 0 });
    expect(await recoverPending(b.inbox, b.remote, new Date(NOW.getTime() + 16 * 60_000))).toEqual({ recovered: 0, waiting: 0, dropped: 1 });
  });

  it("refuses a delivery whose bundle is not the one its resolution names", () => {
    const inbox = new ResolutionInbox(temp("lemma-state-"));
    const bundle: PatchBundle = { schemaVersion: "1", files: [{ path: "src/x.ts", op: "add", baseDigest: null, content: "x\n" }], dependencies: {}, devDependencies: {} };
    const previewId = `0x${"22".repeat(32)}` as Hex32;
    const resolution = {
      schemaVersion: "1",
      resolutionId: deriveResolutionId(previewId, BUYER),
      previewId,
      release: { releaseId: "gating", version: "1.0.0", releaseDigest: `0x${"55".repeat(32)}`, profileIndex: 0 },
      profileDigest: `0x${"44".repeat(32)}`,
      payloadDigest: `0x${"11".repeat(32)}`,
      buyer: BUYER,
      terms: { scheme: "exact", network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", amount: "250000", payTo: "0x00000000000000000000000000000000000000a1", maxTimeoutSeconds: 300 },
      createdAt: NOW.toISOString(),
    };
    expect(() => inbox.put({ resolution, bundle })).toThrow();
    expect(inbox.put({ resolution: { ...resolution, payloadDigest: bundleDigest(bundle) }, bundle }).resolution.buyer).toBe(BUYER);
  });
});

describe("the Lemma rule", () => {
  it("fits its budget and installs without following links", () => {
    expect(readFileSync(RULE_PATH, "utf8").length).toBeLessThanOrEqual(MAX_RULE_CHARS);
    const dir = temp("lemma-proj-");
    const written = installRule(dir);
    expect(readFileSync(written, "utf8")).toBe(readFileSync(RULE_PATH, "utf8"));
  });
});
