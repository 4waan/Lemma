import { CapabilityId, type Preview } from "@lemma/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { driftCheck } from "./drift.js";
import type { ResolutionInbox } from "./inbox.js";
import { recoverPending } from "./recovery.js";
import type { LemmaRemote } from "./remote.js";
import type { ScanCache } from "./scan/cache.js";
import { packageDirAt } from "./scan/files.js";
import { type DriftCheck, previewText } from "./text.js";
import type { Trace } from "./trace.js";

/**
 * A package inside the workspace, for monorepos: POSIX segments of letters,
 * digits, `.`, `_`, `-` and `@`, no dotfile or parent segments. It must be a
 * real directory with its own package.json, reached without links; otherwise
 * the preview says so rather than scanning a parent package.
 */
export const PackagePath = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_@-][A-Za-z0-9._@-]*(\/[A-Za-z0-9_@-][A-Za-z0-9._@-]*)*$/, "a workspace-relative directory such as apps/api");

/** Kept short on purpose: every word here is in the agent's context on every turn. */
export const BRIDGE_INSTRUCTIONS =
  "Lemma resolves integration tasks with verified, benchmarked releases. Before building an x402 payment integration, call lemma_preview with the capability. It is free and sends no source code. Follow its answer.";

export interface PreviewCacheEntry {
  readonly preview: Preview;
  /** The drift check the agent was told; only "none" leaves the offer open. */
  readonly drift: DriftCheck;
  /** Monotonic milliseconds after which the offer is no longer usable. */
  readonly expiresAtMono: number;
  /** Wall-clock milliseconds after which the offer is no longer usable (the monotonic clock stops while the machine sleeps). */
  readonly expiresAtWall: number;
}

export interface BridgeDeps {
  readonly remote: LemmaRemote;
  readonly scanner: ScanCache;
  readonly inbox: ResolutionInbox;
  readonly trace: Trace;
  /** The workspace root; nothing above it is read. */
  readonly root: string;
  readonly cwd: () => string;
  readonly runningNodeMajor: number;
  /** Monotonic clock in milliseconds (performance.now), immune to wall-clock changes. */
  readonly monotonic: () => number;
  /** Wall clock in milliseconds (default Date.now); an offer expires by whichever clock passes its TTL first. */
  readonly wallClock?: (() => number) | undefined;
  /** Registers the paid tools (payment work) with access to the preview cache and the inbox. */
  readonly registerPaidTools?: ((server: McpServer, ctx: PaidToolContext) => void) | undefined;
  /** Registers apply and verify (their own module). */
  readonly registerAdoptionTools?: ((server: McpServer, ctx: PaidToolContext) => void) | undefined;
}

export interface PaidToolContext {
  readonly inbox: ResolutionInbox;
  readonly remote: LemmaRemote;
  /**
   * The latest preview with a still-open offer for a capability, if any: the
   * last lemma_preview succeeded, found no drift, has not expired, and its
   * release is neither pending nor already stored in the inbox.
   */
  latestOffer(capability: CapabilityId): Preview | undefined;
  /** Recovers pending purchases now; the paid tool calls it after a lost or failed paid response. */
  recover(): Promise<{ recovered: number; waiting: number; dropped: number }>;
  readonly trace: Trace;
}

/**
 * The bridge's MCP server, what the coding agent sees. Its tools declare no
 * outputSchema and return short text built only from enums and numbers: a
 * schema would cost thousands of characters of context on every turn, and
 * catalog prose could carry instructions. The full Preview stays here.
 *
 * Tool calls are traced from the transport, before the SDK validates their
 * arguments, so a rejected call still counts.
 */
export function createBridgeServer(deps: BridgeDeps): McpServer {
  const server = new McpServer({ name: "lemma-bridge", version: "0.1.0" }, { instructions: BRIDGE_INSTRUCTIONS });
  const cache = new Map<CapabilityId, PreviewCacheEntry>();
  const wallClock = deps.wallClock ?? Date.now;
  // Reuse and adapt offers alike are checked for drift and for an earlier purchase.
  const blocked = (preview: Preview) => "release" in preview && deps.inbox.blocksOffer(preview.release.releaseDigest, preview.profileDigest);
  /** Per capability, the latest preview started: an earlier one that finishes later never replaces its answer. */
  const latest = new Map<CapabilityId, number>();
  let sequence = 0;
  const ctx: PaidToolContext = {
    inbox: deps.inbox,
    remote: deps.remote,
    trace: deps.trace,
    latestOffer(capability) {
      const entry = cache.get(capability);
      if (entry === undefined || entry.drift !== "none") return undefined;
      if (deps.monotonic() >= entry.expiresAtMono || wallClock() >= entry.expiresAtWall) return undefined;
      return "offer" in entry.preview && entry.preview.offer !== null && !blocked(entry.preview) ? entry.preview : undefined;
    },
    recover: () => recoverPending(deps.inbox, deps.remote, new Date(wallClock())),
  };
  server.server.oninitialized = () => deps.trace.event("initialize");
  // Protocol.connect calls a transport's existing onmessage before its own handling.
  const connect = server.connect.bind(server);
  server.connect = (transport) => {
    const next = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("method" in message && message.method === "tools/call") deps.trace.event("tool", toolName(message.params));
      next?.(message, extra);
    };
    return connect(transport);
  };

  server.registerTool(
    "lemma_preview",
    {
      description: "Free check for a verified integration. Sends only allowlisted package metadata, never source. In a monorepo, pass the package directory.",
      inputSchema: z.strictObject({ capability: CapabilityId, package: PackagePath.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ capability, package: pkg }) => {
      // An earlier offer never outlives a later preview, even one that fails or finishes first.
      cache.delete(capability);
      const call = ++sequence;
      latest.set(capability, call);
      try {
        const cwd = pkg === undefined ? deps.cwd() : packageDirAt(deps.root, pkg);
        if (cwd === undefined) {
          return { isError: true, content: [{ type: "text", text: `Lemma: ${pkg} is not a package directory in this workspace (it needs its own package.json, reached without links). Check the path and ask again; nothing is charged.` }] };
        }
        const { preview, packageDir, incomplete } = await previewFor(deps, capability, cwd);
        const receivedMono = deps.monotonic();
        const receivedWall = wallClock();
        const ttlMs = "offer" in preview && preview.offer !== null ? Date.parse(preview.offer.validUntil) - Date.parse(preview.createdAt) : 0;
        const drift =
          "release" in preview && preview.offer !== null ? driftCheck(packageDir, await deps.remote.baseProbe(preview.release.releaseDigest)) : "unchecked";
        if (latest.get(capability) === call) cache.set(capability, { preview, drift, expiresAtMono: receivedMono + ttlMs, expiresAtWall: receivedWall + ttlMs });
        return { content: [{ type: "text", text: previewText(preview, drift, deps.registerPaidTools !== undefined, incomplete, blocked(preview)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Lemma preview failed (${error instanceof Error ? error.name : "error"}). Build it yourself; nothing is charged.` }] };
      }
    },
  );

  deps.registerPaidTools?.(server, ctx);
  deps.registerAdoptionTools?.(server, ctx);
  return server;
}

/** The called tool's name for the trace: a Lemma tool name, or "other" for anything an agent could put there. */
function toolName(params: unknown): string {
  const name = typeof params === "object" && params !== null ? (params as { name?: unknown }).name : undefined;
  return typeof name === "string" && /^lemma_[a-z_]{1,40}$/.test(name) ? name : "other";
}

/**
 * Scans with the current interest set and asks for a preview. If the answer
 * comes from a different catalog than the interest set, the interest set is
 * revalidated and the preview asked once more, so a dependency the new catalog
 * matches on is not missing from the profile.
 */
async function previewFor(deps: BridgeDeps, capability: CapabilityId, cwd: string): Promise<{ preview: Preview; packageDir: string; incomplete: boolean }> {
  let interest = await deps.remote.interest();
  for (let attempt = 0; ; attempt++) {
    const { profile, notes } = deps.scanner.scan({ root: deps.root, cwd, interest: interest.capabilities[capability] ?? [], runningNodeMajor: deps.runningNodeMajor });
    const preview = await deps.remote.preview({ task: { schemaVersion: "1", capability }, profile });
    if (preview.catalogDigest === interest.catalogDigest || attempt > 0) {
      return { preview, packageDir: deps.scanner.packageDir(deps.root, cwd), incomplete: notes.some((n) => !n.startsWith("no .nvmrc")) };
    }
    interest = await deps.remote.interest(true);
  }
}
