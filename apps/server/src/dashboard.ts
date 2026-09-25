import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Hono } from "hono";

/**
 * The dashboard's Content Security Policy: scripts, styles and API calls from
 * this origin only, no inline script or style, no framing, no forms. The
 * built dashboard has no inline code, so nothing it needs is refused.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Built asset names: Vite's hashed file names, nothing that could climb out of the directory. apps/web/scripts/check-dist.mjs holds the same rule; tests pin both. */
export const ASSET = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(js|css|svg|png|ico|woff2)$/;

/**
 * Serves the built dashboard (apps/web/dist): `index.html` at `/` and the
 * hashed files under `/assets/`. Only regular files with an allowlisted name
 * and extension are served, and never through a link. Hashed assets are
 * cached forever; the page itself is revalidated. The dashboard routes with
 * URL fragments, so no other path is needed.
 */
export function serveDashboard(app: Hono, webRoot: string): void {
  app.get("/", (c) => {
    const html = readRegular(join(webRoot, "index.html"));
    if (html === undefined) return c.json({ error: "dashboard not built" }, 404);
    c.header("Cache-Control", "no-cache");
    return c.html(html.toString("utf8"));
  });
  app.get("/assets/:name", (c) => {
    const name = c.req.param("name");
    const type = ASSET.exec(name);
    const body = type === null ? undefined : readRegular(join(webRoot, "assets", name));
    if (type === null || body === undefined) return c.json({ error: "not found" }, 404);
    c.header("Content-Type", TYPES[`.${type[1]}`] ?? "application/octet-stream");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(new Uint8Array(body));
  });
}

function readRegular(path: string): Buffer | undefined {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : undefined;
  } catch {
    return undefined;
  }
}
