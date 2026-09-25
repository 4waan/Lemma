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

## MCP tools

Implemented:

- `lemma_preview({ capability, package? })`
  - It scans the workspace and asks the server for a free preview.
  - It checks drift locally against the release's base probe before any purchase. Local files are hashed here, and none are sent. Probe paths must be safe relative paths (core `PatchPath`), and a file larger than a patch may carry counts as drift without being read.
  - `package` names the package directory in a monorepo (for example `apps/api`). It must be a plain relative path to a real directory with its own `package.json`: links, parent segments and dotfiles are refused, and a missing package is reported rather than replaced by a parent package.
  - Every server request gives up after 10 seconds, so a stalled server ends in the "build it yourself" answer.

Registered by their own modules through `createBridgeServer`'s registrars:

- `lemma_buy_resolution` (payment work): it reads the open offer with `latestOffer`, marks the purchase pending with `inbox.markPending(previewId, buyer, now, releaseDigest)`, and stores the delivery with `inbox.put`. After a lost or failed paid response it must call `ctx.recover()`, never pay again. `latestOffer` gives an offer only while the last preview for that capability succeeded, found no drift and has not expired (by the monotonic or the wall clock), and while no purchase of that release is pending or stored.
- `lemma_apply_resolution` and `lemma_verify_adoption` (apply and verify).

The tools declare no `outputSchema` and answer in at most 600 characters built from enums and numbers, so no catalog prose reaches the model. Tool definitions plus instructions stay under 3,000 characters. A test enforces both limits, because every character is in the agent's context on every turn.

Recovery runs automatically:

- A purchase is marked pending before the paid call.
- At startup, and whenever the paid tool calls `ctx.recover()`, the bridge calls the server's free `lemma_recover_resolution` for each pending mark.
- A mark the server never saw is dropped after 15 minutes, once no authorization could still settle.

## Repository profile

`scanWorkspace` builds the privacy-safe profile:

- **Package.** The nearest `package.json` at or above the working directory, or the named package.
- **Lockfile.** The nearest lockfile at or above the package, which covers npm, pnpm and yarn workspaces. `npm-shrinkwrap.json` wins over `package-lock.json`, as in npm. When `packageManager` names a manager, only its lockfile is read. If that lockfile is absent, or several managers' lockfiles are present and `packageManager` does not choose, no version is resolved and that is noted.
- **Dependencies.** Declared dependencies and devDependencies in the catalog's interest set for the capability, each at the exact version the lockfile installed. Only registry ranges are looked up: `npm:` aliases and git, file, link and workspace specifiers are left out, and so is a locked version outside the declared range.

  | Lockfile | How the version is found |
  | --- | --- |
  | npm v2 and v3 | `packages["<rel>/node_modules/<name>"]`, walking up like Node's resolution, only for a package the lockfile records; aliased, git and file entries give nothing (v1: the root's `dependencies` tree only) |
  | pnpm v5.4, v6 and v9 | a line scan of the importer's block under `importers:`, or of the top-level blocks of a single-project lockfile, without peer suffixes |
  | yarn classic and berry | the block whose header names the declared specifier |

  No YAML parser is used. Anything unresolved is left out and noted, never guessed.
- **Other fields.** The Node major comes from `.nvmrc` or `.node-version` (a version or an LTS codename such as `lts/iron`), else the running Node, noted. A pin that names no major (`lts/*`, `node`) is noted as incomplete. The module system comes from `type`, and the language from `tsconfig.json` or a `typescript` dependency. Frameworks come from declared dependencies.

The scanner reads only allowlisted file names, capped at 32 MB each. It refuses symlinks on every path segment, including a linked package directory or lockfile, and anything outside the workspace. A workspace root reached through a link is resolved to its real path at startup. Results are cached until a scanned file's size or modification time changes.

## The Lemma rule

`rules/lemma.mdc` (under 600 characters) tells an agent to call `lemma_preview` before building an x402 integration. `lemma-mcp install-rule [dir]` writes it to `<dir>/.cursor/rules/lemma.mdc` without following links. The benchmark's treatment arm receives exactly this file.

## Workspace dependencies

- `@lemma/core` for shared schemas and digests.
- The MCP SDK for the local stdio server and hosted client.
- x402 packages for payment creation and response handling.
- viem for buyer signing and warranty activation.

## Environment variables

The bridge uses `LEMMA_API_URL` (default `http://localhost:3000`), `LEMMA_WORKSPACE` (default: the working directory) and `LEMMA_STATE_DIR` (default `$XDG_STATE_HOME/lemma`, else `~/.local/state/lemma`, where the resolution inbox lives, private to the user). An empty value counts as unset; a relative one, or one inside the workspace, stops the bridge at startup. `LEMMA_BRIDGE_TRACE` is for the benchmark harness only: it appends one line per initialize and tool call, including calls rejected for their arguments, with the tool name (or `other`) and nothing else.

The payment work adds `ARBITRUM_SEPOLIA_RPC_URL`, `BUYER_PRIVATE_KEY`, `LEMMA_MAX_USDC_PER_RESOLUTION`, `LEMMA_DAILY_USDC_CAP`, `USDC_ADDRESS`, and the registry address.

The buyer key must stay inside the bridge process. It must never appear in MCP content, model context, logs, receipts, or remote requests.

## Development and tests

- `npm run dev -w @lemma/bridge`
- `npm run build -w @lemma/bridge`
- `npm run test -w @lemma/bridge`

The compiled package exposes the `lemma-mcp` executable (`dist/main.js`). The tests drive the bridge through a real MCP client against the real server app in-process. They count requests (one per preview once warm) and enforce the context budgets.

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
