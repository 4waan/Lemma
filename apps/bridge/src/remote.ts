import { type Address, type Hex32, LEMMA_TOOLS, PatchPath, type Preview, type PreviewInput, PreviewResult, ResolutionDelivery } from "@lemma/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

const Hex = z.string().regex(/^0x[0-9a-f]{64}$/);

/** A capability the server does not list (an older server) has an empty interest set; it does not fail every preview. */
export const InterestResponse = z.object({
  catalogDigest: Hex,
  capabilities: z.record(z.string().max(100), z.array(z.string().max(214)).max(500)),
});

export type InterestResponse = z.infer<typeof InterestResponse>;

export const BaseProbeResponse = z.object({
  releaseDigest: Hex,
  // The drift check reads these paths under the package: the same safe relative paths a patch may use.
  files: z.array(z.object({ path: PatchPath, baseDigest: Hex.nullable() })).max(200),
});

export type BaseProbeEntry = z.infer<typeof BaseProbeResponse>["files"][number];

export class RemoteError extends Error {
  override name = "RemoteError";
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The bridge's view of the Lemma server. Every response is validated with a
 * schema before use, and the cheap parts are cached so a preview costs one
 * request in steady state:
 *
 * - the interest set, revalidated with its ETag (the catalog digest)
 * - base probes per release digest, which never change
 * - one MCP connection (initialize once; the server is stateless)
 *
 * Every request gives up after `timeoutMs`, so a stalled server ends in the
 * preview's "build it yourself" answer rather than the agent's own timeout.
 */
export class LemmaRemote {
  /** HTTP requests made, for the round-trip budget. */
  requests = 0;
  private client: Client | undefined;
  private interestCache: InterestResponse | undefined;
  private readonly probes = new Map<Hex32, BaseProbeEntry[]>();
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly baseUrl: URL,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 10_000,
  ) {
    this.fetchImpl = (input, init) => {
      this.requests++;
      return fetchImpl(input, init);
    };
  }

  /** The interest set, fetched once and revalidated only when asked (after a catalog change). */
  async interest(revalidate = false): Promise<InterestResponse> {
    if (this.interestCache !== undefined && !revalidate) return this.interestCache;
    const headers: Record<string, string> = {};
    if (this.interestCache !== undefined) headers["if-none-match"] = `"${this.interestCache.catalogDigest}"`;
    const res = await this.fetchImpl(new URL("/api/v1/interest", this.baseUrl), { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 304 && this.interestCache !== undefined) return this.interestCache;
    if (!res.ok) throw new RemoteError(`interest request failed with ${res.status}`);
    this.interestCache = InterestResponse.parse(await res.json());
    return this.interestCache;
  }

  async preview(input: PreviewInput): Promise<Preview> {
    const result = await (await this.mcp()).callTool({ name: LEMMA_TOOLS.preview, arguments: input }, undefined, { timeout: this.timeoutMs });
    if (result.isError === true) throw new RemoteError(textOf(result.content) || "the preview failed");
    return PreviewResult.parse(result.structuredContent).preview;
  }

  async baseProbe(releaseDigest: Hex32): Promise<BaseProbeEntry[]> {
    const cached = this.probes.get(releaseDigest);
    if (cached !== undefined) return cached;
    const res = await this.fetchImpl(new URL(`/api/v1/releases/${releaseDigest}/base-probe`, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new RemoteError(`base probe request failed with ${res.status}`);
    const body = BaseProbeResponse.parse(await res.json());
    if (body.releaseDigest !== releaseDigest) throw new RemoteError("the server answered for another release");
    this.probes.set(releaseDigest, body.files);
    return body.files;
  }

  /** Free recovery of a settled resolution (server tool `lemma_recover_resolution`). */
  async recover(previewId: Hex32, buyer: Address): Promise<ResolutionDelivery | "IN_FLIGHT" | "NOT_FOUND"> {
    const result = await (await this.mcp()).callTool({ name: LEMMA_TOOLS.recoverResolution, arguments: { previewId, buyer } }, undefined, { timeout: this.timeoutMs });
    if (result.isError === true) {
      const text = textOf(result.content);
      if (text.startsWith("IN_FLIGHT")) return "IN_FLIGHT";
      if (text.startsWith("NOT_FOUND")) return "NOT_FOUND";
      throw new RemoteError(text || "recovery failed");
    }
    return ResolutionDelivery.parse(result.structuredContent);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private async mcp(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.baseUrl), { fetch: (input, init) => this.fetchImpl(input, init) });
    const client = new Client({ name: "lemma-bridge", version: "0.1.0" });
    // The SDK's transport class declares optional members without `| undefined`,
    // which exactOptionalPropertyTypes rejects; the runtime object is a Transport.
    await client.connect(transport as unknown as Transport, { timeout: this.timeoutMs });
    this.client = client;
    return client;
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) => (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join(" ")
    .trim();
}
