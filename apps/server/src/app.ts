import { type CatalogIndex } from "@lemma/catalog";
import { Hex32 } from "@lemma/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";

import { clientAddress } from "./client.js";
import type { ServerConfig } from "./config.js";
import type { Logger } from "./log.js";
import { type PaidToolRegistrar, buildMcpServer } from "./mcp.js";
import { TokenBuckets } from "./rate-limit.js";
import { DEMAND_MIN_PROFILES, DemandRecorder } from "./demand.js";
import type { LemmaStore } from "./persistence.js";
import { describeError } from "./errors.js";
import { ReceiptSubmission, type ResolutionService } from "./service.js";

export const MAX_BODY_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;

export interface AppDeps {
  readonly config: ServerConfig;
  readonly index: CatalogIndex;
  /** Offer previews, demand counts, releases, bundles, resolutions and receipts. */
  readonly store: LemmaStore;
  readonly service: ResolutionService;
  readonly clock: () => Date;
  readonly newPreviewId: () => Hex32;
  readonly logger: Logger;
  /** The socket address of the request, when the runtime knows it. */
  readonly socketAddress?: (c: Context) => string | undefined;
  /** Overrides REQUEST_TIMEOUT_MS (tests). */
  readonly requestTimeoutMs?: number;
  readonly registerPaidTools?: PaidToolRegistrar | undefined;
}

/**
 * The HTTP application. Every dependency is injected, so tests drive it with
 * `app.request()` and fixed clocks and ids.
 *
 * - `POST /mcp`: stateless Streamable HTTP with JSON responses. A new MCP
 *   server and transport per request; `GET` and `DELETE` are 405, so no idle
 *   SSE stream is ever held. Requests that carry an `Origin` header come from a
 *   browser, which never has a reason to call it, and are refused.
 * - `/api/v1/*`: read-only catalog data for the bridge and the dashboard.
 * - `/healthz`.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const buckets = new TokenBuckets(deps.config.rateLimitPerMinute);
  const mcpDeps = {
    config: deps.config,
    index: deps.index,
    previews: deps.store,
    resolutions: deps.service,
    demand: new DemandRecorder(deps.store, deps.logger, deps.config.demandSourceKey),
    service: deps.service,
    clock: deps.clock,
    newPreviewId: deps.newPreviewId,
    logger: deps.logger,
    registerPaidTools: deps.registerPaidTools,
  };

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // Deliberate HTTP answers (the request timeout's 504) keep their status.
      deps.logger.log("warn", "request.http_error", { path: c.req.path, status: error.status });
      return c.json({ error: error.status === 504 ? "request timed out" : "request failed" }, error.status);
    }
    deps.logger.log("error", "request.failed", { path: c.req.path, error: describeError(error) });
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      xFrameOptions: "DENY",
      referrerPolicy: "no-referrer",
      xContentTypeOptions: "nosniff",
    }),
  );
  app.use("*", timeout(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS));

  const limit = async (c: Context, next: () => Promise<void>) => {
    const key = clientAddress(c.req.header("x-forwarded-for"), deps.socketAddress?.(c), deps.config.trustedProxyHops);
    const wait = buckets.take(key, Date.now());
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate limited" }, 429);
    }
    await next();
  };
  // CORS runs before the limiter, so a 429 still carries CORS headers and the
  // dashboard can read Retry-After; preflights are answered without a token.
  app.use(
    "/api/v1/*",
    cors({ origin: deps.config.dashboardOrigin ?? [], allowMethods: ["GET"], exposeHeaders: ["Retry-After", "ETag"], maxAge: 600 }),
  );
  app.use("/mcp", limit);
  app.use("/api/v1/*", limit);
  app.use("/api/v1/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }));

  app.post(
    "/mcp",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }),
    async (c) => {
      if (c.req.header("origin") !== undefined) return c.json({ error: "browser requests are not accepted" }, 403);
      const deadline = Date.now() + (deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      // One JSON-RPC message per request: batching left MCP in protocol 2025-06-18,
      // the bridge never batches, and a batch would multiply the rate limit.
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text()) as unknown;
      } catch {
        return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
      }
      if (Array.isArray(body)) return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "batches are not accepted" }, id: null }, 400);
      const source = clientAddress(c.req.header("x-forwarded-for"), deps.socketAddress?.(c), deps.config.trustedProxyHops);
      // The paid-tool registrar may be async (it quotes from the store); it finishes before the request is dispatched,
      // and a failure in it reaches onError as a 500.
      const server = await buildMcpServer({ ...mcpDeps, source, request: body });
      // The client already got 504 while a slow registrar ran: never dispatch (a paid call) after that.
      if (Date.now() >= deadline) {
        await server.close();
        return c.json({ error: "request timed out" }, 504);
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(c.req.raw, { parsedBody: body });
        response.headers.set("Cache-Control", "no-store");
        return response;
      } finally {
        await server.close();
      }
    },
  );
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "this server is stateless: use POST" }, 405);
  });

  app.get("/healthz", (c) => c.json({ status: "ok", catalogDigest: deps.index.catalogDigest }));

  app.get("/api/v1/releases", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      catalogDigest: deps.index.catalogDigest,
      releases: deps.index.releases.map((r) => ({
        releaseDigest: r.releaseDigest,
        baseReleaseDigest: r.baseReleaseDigest,
        source: r.source,
        release: r.release,
      })),
    });
  });

  app.get("/api/v1/interest", (c) => {
    const etag = `"${deps.index.catalogDigest}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "public, max-age=60");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.json({ catalogDigest: deps.index.catalogDigest, capabilities: deps.index.interest });
  });

  // A release manifest by digest: from the catalog, else from the store, so a redeploy never strands a bought release.
  // The buyer's bridge checks the digest itself and reads the acceptance recipe from it.
  app.get("/api/v1/releases/:digest", async (c) => {
    const digest = Hex32.safeParse(c.req.param("digest"));
    if (!digest.success) return c.json({ error: "expected a release digest" }, 400);
    const release = deps.index.byDigest.get(digest.data)?.release ?? (await deps.store.getRelease(digest.data));
    if (release === undefined) return c.json({ error: "unknown release" }, 404);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.json({ releaseDigest: digest.data, release });
  });

  app.get("/api/v1/releases/:digest/base-probe", (c) => {
    const digest = Hex32.safeParse(c.req.param("digest"));
    if (!digest.success) return c.json({ error: "expected a release digest" }, 400);
    const release = deps.index.byDigest.get(digest.data);
    if (release === undefined) return c.json({ error: "unknown release" }, 404);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.json({ releaseDigest: release.releaseDigest, files: release.baseProbe });
  });

  // A public view by resolution id: never the preview id (the recovery secret), the buyer or the bundle.
  app.get("/api/v1/resolutions/:id", async (c) => {
    const id = Hex32.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "expected a resolution id" }, 400);
    const view = await deps.service.publicResolution(id.data);
    if (view === undefined) return c.json({ error: "unknown resolution" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(view);
  });

  // The buyer's bridge posts { receipt, previewId }; the preview id (the recovery secret) proves it is the buyer.
  app.post("/api/v1/adoption-receipts", async (c) => {
    if (c.req.header("origin") !== undefined) return c.json({ error: "browser requests are not accepted" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON receipt submission" }, 400);
    }
    const submission = ReceiptSubmission.safeParse(body);
    if (!submission.success) return c.json({ error: "expected { receipt: AdoptionReceipt, previewId }" }, 400);
    // A store failure is not the client's fault: it reaches onError, is logged, and answers 500 so the bridge retries.
    const result = await deps.service.acceptReceipt(submission.data);
    const status = { ACCEPTED: 201, DUPLICATE: 409, NOT_SETTLED: 409, TOO_EARLY: 425, UNKNOWN_RESOLUTION: 404, MISMATCH: 422 } as const;
    return c.json({ result }, status[result]);
  });

  // Unmet and met demand, only for buckets with enough distinct repositories to publish (k-anonymity).
  app.get("/api/v1/demand", async (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ minProfiles: DEMAND_MIN_PROFILES, buckets: await deps.store.demandBuckets(DEMAND_MIN_PROFILES) });
  });

  return app;
}
