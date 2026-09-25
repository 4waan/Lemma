// Fails the bundle if the built dashboard needs anything the server's CSP
// refuses (inline scripts, styles or handlers, data: URIs, other origins),
// references a file the server will not serve, or ships source maps.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The asset names the server serves (apps/server/src/dashboard.ts ASSET); tests pin both to the same rule. */
export const ASSET = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(js|css|svg|png|ico|woff2)$/;

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** Every problem with a built dist directory; empty when the server can serve it under its CSP. */
export function checkDist(dist) {
  const problems = [];
  const files = walk(dist).map((path) => relative(dist, path).split("\\").join("/"));
  for (const file of files) {
    if (file === "index.html") continue;
    const [dir, name, ...rest] = file.split("/");
    if (dir !== "assets" || rest.length > 0 || !ASSET.test(name ?? "")) problems.push(`the server will not serve ${file}`);
    if (file.endsWith(".map")) problems.push(`source map shipped: ${file}`);
  }
  const local = (url) => /^\/assets\/[^/?#]+$/.test(url) && ASSET.test(url.slice("/assets/".length)) && files.includes(url.slice(1));

  const html = readFileSync(join(dist, "index.html"), "utf8");
  const attrs = [...html.matchAll(/\s([a-zA-Z-:]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => ({ name: m[1].toLowerCase(), value: m[3] ?? m[4] ?? m[5] ?? "" }));
  for (const { name, value } of attrs) {
    if (name.startsWith("on")) problems.push(`inline event handler: ${name}`);
    if (name === "style") problems.push("inline style attribute");
    if ((name === "src" || name === "href") && !local(value)) problems.push(`reference outside /assets/ or to a missing asset: ${value}`);
  }
  for (const [, tag = "", body = ""] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/.test(tag) || body.trim() !== "") problems.push("inline script");
  }
  if (/<style\b/i.test(html)) problems.push("inline style element");

  for (const file of files.filter((f) => f.endsWith(".js") || f.endsWith(".css"))) {
    const text = readFileSync(join(dist, file), "utf8");
    if (/sourceMappingURL\s*=/.test(text)) problems.push(`source map reference in ${file}`);
    if (file.endsWith(".css")) {
      if (/@import\b/i.test(text)) problems.push(`@import in ${file}`);
      for (const [, raw] of text.matchAll(/url\(\s*([^)]*?)\s*\)/gi)) {
        const url = raw.replace(/^["']|["']$/g, "");
        if (!local(url) && !local(`/assets/${url.replace(/^\.\//, "")}`)) problems.push(`url(${url}) in ${file} is not a served asset`);
      }
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkDist(fileURLToPath(new URL("../dist", import.meta.url)));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("dist: no inline code or handlers, only served /assets/ references, no source maps");
}
