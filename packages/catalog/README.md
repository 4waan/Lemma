# Lemma Catalog

`@lemma/catalog` stores and validates the integration releases Lemma can resolve. A release becomes sellable only when its payload, supported profile, evidence, price, provenance, and fixtures pass the catalog checks.

The resolver, loader, packer, index, and integrity checks are implemented. The two committed releases are preview-only skeletons with placeholder payloads, zero price, and no benchmark evidence.

## Layout

```text
economics.json
releases/<releaseId>/<version>/
  manifest.json
  bundle.json
  payload/ops.json
  payload/files/<path>
  payload/base/<path>
releases.provisional/<releaseId>/<version>/
fixtures/<capability>/<case>.json
```

- `economics.json` holds dated chain-cost and price-floor inputs.
- `releases/` contains immutable public release versions.
- `releases.provisional/` is an explicit testnet-only overlay for the paid-path and benchmark stages.
- `fixtures/` freezes exact, boundary, near-miss, and unsupported resolver cases.

See [Capability Releases](releases/README.md), [Provisional Overlay](releases.provisional/README.md), and [Compatibility Fixtures](fixtures/README.md) before authoring catalog data.

## Author a release

1. Choose a narrow capability id and supported repository profile.
2. Record immutable GitHub provenance, a full source commit, and an SPDX license expression.
3. Add reviewed file operations, base files, replacement files, dependency changes, and an acceptance recipe under `payload/`.
4. Pack the payload and copy the reported digest into `manifest.json`.
5. Add exact, boundary, near-miss, and unsupported fixtures with frozen expected outcomes.
6. Run the catalog check and review every reported problem before committing.

Commands:

```bash
npm run catalog:pack
npm run catalog:check
```

The packer's write mode replaces `bundle.json` through a temporary file and rename. Catalog content is hashed byte for byte, and `.gitattributes` disables line-ending conversion for those paths.

## Resolution behavior

`loadCatalog` parses every release and bundle. `buildIndex` precomputes releases by capability and digest, catalog interest sets, and base probes. `resolve` is pure: its clock, preview id, and payment settings are injected.

Every supported profile is checked. Matches are ordered by current sellability, expected net saving, semantic version, release id, digest, and profile index. A match becomes `reuse`; local drift becomes `adapt` later in the bridge. Without a match, unsupported platforms return `decline` and other gaps return `build`.

## Integrity gates

`catalog:check` fails closed on:

- schema, digest, version, directory-layout, or UTF-8 errors;
- symbolic links, special files, traversal, undeclared payload files, or unsafe patch paths;
- mutable provenance, unbounded dependency ranges, or dist-tags;
- evidence that is not bound to a benchmark version and base release;
- public provisional evidence or evidence without a verified report;
- prices outside the measured floor and `maxPriceFor` ceiling;
- missing fixture coverage or fixture results that differ from the resolver.

The complete economic gate is [Economic Gates and Iterations](../../docs/economic-gates.md).

## Current catalog

- `mcp-server-payment-gating@0.1.0`: x402 payment gating for a TypeScript MCP server, paid in USDC on Arbitrum Sepolia (testnet). The payload adds one module, `src/x402-payment-gating.ts`, on `@x402/core`, `@x402/evm` and `@x402/mcp` 2.27 (Apache-2.0), and the buyer's agent wires it into its tools. It replaced `0.1.0-skeleton`, which had the same profiles and a placeholder payload.
- `mcp-client-paying-client@0.1.0`: an x402-paying MCP client with spending limits, paying in USDC on Arbitrum Sepolia (testnet). The payload adds one module, `src/x402-paying-client.ts`, on `@x402/core`, `@x402/evm`, `@x402/mcp` 2.27 and `viem`: it picks the exact USDC requirement on Arbitrum Sepolia, refuses prices over a per-call limit or the remaining budget before signing, reserves the budget so concurrent calls cannot overspend it, pays at most once per call, and counts only settled payments. It replaced `0.1.0-skeleton`, which had the same profiles and a placeholder payload.

Neither release has measured evidence, so both are previewed and never sold. The first economic probe measures the server release (`weather-mcp-paid-forecast` in `packages/benchmark/fixtures/`) and the second the client release (`market-brief-paid-tools`). `node-service.add-payment-facilitator` intentionally has no release so the no-release path remains covered.

## Development

```bash
npm run build -w @lemma/catalog
npm run test -w @lemma/catalog
```

Catalog tests replay every fixture and run the committed catalog through the full integrity checker.
