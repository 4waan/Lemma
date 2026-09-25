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
import { buildMcpServer } from "./mcp.js";
import { TokenBuckets } from "./rate-limit.js";
import type { PreviewStore, ResolutionReader } from "./store.js";

export const MAX_BODY_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;

export interface AppDeps {
  readonly config: ServerConfig;
  readonly index: CatalogIndex;
  readonly previews: PreviewStore;
  readonly resolutions: ResolutionReader;
  readonly clock: () => Date;
  readonly newPreviewId: () => Hex32;
  readonly logger: Logger;
  /** The socket address of the request, when the runtime knows it. */
  readonly socketAddress?: (c: Context) => string | undefined;
  /** Overrides REQUEST_TIMEOUT_MS (tests). */
  readonly requestTimeoutMs?: number;
  readonly registerPaidTools?: ((server: McpServer) => void) | undefined;
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

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // Deliberate HTTP answers (the request timeout's 504) keep their status.
      deps.logger.log("warn", "request.http_error", { path: c.req.path, status: error.status });
      return c.json({ error: error.status === 504 ? "request timed out" : "request failed" }, error.status);
    }
    deps.logger.log("error", "request.failed", { path: c.req.path, error: String(error) });
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

  app.post(
    "/mcp",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }),
    async (c) => {
      if (c.req.header("origin") !== undefined) return c.json({ error: "browser requests are not accepted" }, 403);
      // One JSON-RPC message per request: batching left MCP in protocol 2025-06-18,
      // the bridge never batches, and a batch would multiply the rate limit.
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text()) as unknown;
      } catch {
        return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
      }
      if (Array.isArray(body)) return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "batches are not accepted" }, id: null }, 400);
      const server = buildMcpServer(deps);
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

  app.get("/api/v1/releases/:digest/base-probe", (c) => {
    const digest = Hex32.safeParse(c.req.param("digest"));
    if (!digest.success) return c.json({ error: "expected a release digest" }, 400);
    const release = deps.index.byDigest.get(digest.data);
    if (release === undefined) return c.json({ error: "unknown release" }, 404);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.json({ releaseDigest: release.releaseDigest, files: release.baseProbe });
  });

  return app;
}
