# Lemma Local MCP Bridge

## Purpose and economic role

The bridge is the user-facing MCP server installed beside a coding agent. It injects verified prior work into the agent's workflow while keeping repository access, wallet authority, spending limits, and patch application under local control.

The bridge is what turns a hosted resolution service into a useful agent capability. A plain remote MCP connection would not safely hold the buyer wallet or inspect local compatibility.

## Responsibilities

- Run as a local stdio MCP server.
- Read an allowlisted repository profile from the configured workspace.
- Expose preview, purchase, apply, and verification tools.
- Connect to the hosted MCP endpoint as an x402-capable client.
- Enforce per-resolution and daily spending limits before signing.
- Verify resolution signatures and payload digests.
- Preview or atomically apply safe patch bundles.
- Run catalog-pinned acceptance recipes under limits.
- Sign Adoption Receipts with the buyer wallet.
- Activate onchain warranty vouchers and recover interrupted purchases.

## Outside this boundary

- Deciding that an unsupported profile is compatible.
- Sending arbitrary source files to the server.
- Accepting payment instructions from untrusted prose.
- Executing shell strings supplied by a Capability Release.
- Holding provider, facilitator, evaluator, or deployer keys.

## Planned MCP tools

- `lemma_preview`
- `lemma_buy_resolution`
- `lemma_apply_resolution`
- `lemma_verify_adoption`

Patch application will default to preview mode. Recovery will run automatically when a paid response is lost.

## Workspace dependencies

- `@lemma/core` for shared schemas and digests.
- The MCP SDK for the local stdio server and hosted client.
- x402 packages for payment creation and response handling.
- viem for buyer signing and warranty activation.

## Environment variables

The bridge will use `LEMMA_API_URL`, `ARBITRUM_SEPOLIA_RPC_URL`, `BUYER_PRIVATE_KEY`, `LEMMA_MAX_USDC_PER_RESOLUTION`, `LEMMA_DAILY_USDC_CAP`, `USDC_ADDRESS`, and the registry address.

The buyer key must stay inside the bridge process. It must never appear in MCP content, model context, logs, receipts, or remote requests.

## Development and tests

- `npm run dev -w @lemma/bridge`
- `npm run build -w @lemma/bridge`
- `npm run test -w @lemma/bridge`

The compiled package will expose the `lemma-mcp` executable after implementation.

## Security constraints

- Canonicalize every filesystem path and keep it inside the workspace root.
- Reject symlinks, absolute paths, parent traversal, protected files, and binary mutations.
- Read only reviewed manifest and lockfile names during profile creation.
- Validate network, token, recipient, amount, expiry, and local budgets before signing.
- Apply patches atomically and fail on base-file drift.
- Spawn acceptance commands without a shell, with an allowlisted environment, timeout, and output limit.
- Scrub all sensitive values from errors and receipts.

## Later completion criteria

This component is complete when a supported coding agent can install it, receive a free preview, make one policy-compliant testnet purchase, recover it after an injected connection failure, preview and apply the signed patch, run the acceptance recipe, and submit a signed receipt without exposing repository source or keys.
