# Capability Releases

This directory will contain one versioned directory per curated Capability Release: `<releaseId>/<version>/` with `manifest.json`, `bundle.json` and `payload/` (see the catalog README for the layout and the commands).

Every release must contain a validated manifest, payload digest, supported repository profiles, patch material, acceptance recipe, upstream provenance, SPDX license, price, warranty terms, evidence references, and expiry.

The first planned releases are:

1. An x402-protected TypeScript MCP server integration (`mcp-server-payment-gating`).
2. An x402-paying MCP client with local spending controls (`mcp-client-paying-client`).
3. A single-network Arbitrum Sepolia facilitator for Node and Hono.

The first two exist as `0.1.0-skeleton` versions with placeholder payloads, no evidence and a zero price.

No release may become purchasable until its exact and negative fixtures pass and its measured savings evidence is frozen. The single exception is the testnet-only overlay in `../releases.provisional/`, which lets stage 5 (paid path) and stage 6 (frozen benchmark) buy a release at its pre-registered price before frozen evidence exists. The public service never loads it.

A committed version is never edited. Evidence ships as a new version `X+<benchmarkVersion>` that differs from `X` only in its version, evidence, price and dates (`catalog:check` enforces this through `baseReleaseDigest`).
