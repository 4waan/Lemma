# Lemma Bridge

`@lemma/bridge` is the local stdio MCP server used by a coding agent. It is the only Lemma component allowed to inspect the buyer's repository, manage buyer-side state, apply a resolution, or run its acceptance recipe.

The bridge currently supports the complete free preview and post-purchase adoption workflow. The x402 buyer and signing hooks are the remaining payment-lane integration.

## Run locally

Build or watch the bridge from the repository root:

```bash
npm run build -w @lemma/bridge
npm run dev -w @lemma/bridge
```

The built executable is `lemma-mcp` at `dist/main.js`.

Start a Lemma server first, then configure the agent to launch the bridge from the target repository. `LEMMA_WORKSPACE` defaults to the bridge's working directory.

Install the small Cursor rule that prompts an agent to preview before rebuilding a supported capability:

```bash
lemma-mcp install-rule /path/to/repository
```

This writes `rules/lemma.mdc` under the repository's `.cursor/rules` directory without following links. The benchmark treatment arm uses the same rule.

## MCP tools

### `lemma_preview`

Scans allowlisted package metadata and asks the server for a free compatibility decision. The bridge checks the selected release's base probe locally before it presents an offer. File contents and internal dependency names are not uploaded.

Input:

```json
{ "capability": "mcp-server.add-payment-gating", "package": "apps/api" }
```

`package` is optional for a single-package repository. In a monorepo it must identify a real package directory with its own `package.json`.

### `lemma_buy_resolution`

Reserved for the payment registrar. It will validate the stored quote and local spending policy before authorizing x402 settlement. The current build does not register this tool.

### `lemma_apply_resolution`

Selects the newest applicable local purchase for the capability and package.

- `mode: "preview"`, the default, reports the complete file and dependency plan without writing.
- `mode: "apply"` performs an atomic, journaled apply and runs dependency installation with lifecycle scripts disabled.
- Repository drift returns `adapt` and exports the resolution for manual integration instead of forcing a patch.
- An interrupted apply is recovered before another apply begins.

### `lemma_verify_adoption`

Runs the release's acceptance recipe only when the resolution is present and the package still fits the purchased profile. The command runs without a shell, with bounded output, a timeout, a fresh home directory, and wallet-secret checks.

The first started run produces the receipt that counts. Retryable delivery failures are kept in the local inbox and sent again later.

## Normal agent flow

1. Call `lemma_preview` before implementing a supported capability.
2. If the result is preview-only or no-match, build normally and spend nothing.
3. When payments are enabled, call `lemma_buy_resolution` for an acceptable offer.
4. Call `lemma_apply_resolution` in preview mode.
5. Apply directly when exact, or merge the exported files when the result is `adapt`.
6. Call `lemma_verify_adoption`, with `adapted: true` after a manual merge.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEMMA_API_URL` | `http://localhost:3000` | Hosted Lemma server. |
| `LEMMA_WORKSPACE` | Current directory | Repository boundary for scans and writes. |
| `LEMMA_STATE_DIR` | `$XDG_STATE_HOME/lemma` or `~/.local/state/lemma` | Private inbox, manifests, receipts, journals, exports, and recovery data. |
| `LEMMA_ACCEPTANCE_OFFLINE` | unset | Set to `1` on Linux to run acceptance in a network namespace. |
| `LEMMA_BRIDGE_TRACE` | unset | Benchmark-only path for minimal tool-call tracing. |

The state directory must be absolute and outside the workspace. Empty values count as unset.

Payment integration will add the RPC URL, buyer signer, USDC and registry addresses, and local spending caps. Buyer keys must not enter model context, MCP content, logs, receipts, or the acceptance process environment.

## Troubleshooting

- **Preview returns build:** inspect the reason codes. No release, an unsupported runtime, stale evidence, and an unreachable server are distinct outcomes.
- **Apply returns adapt:** the package differs from the release base. Merge the exported resolution and verify with `adapted: true`.
- **Apply says another operation is active:** wait for the owner, or restart the bridge so it can inspect and recover an abandoned journal.
- **Verification does not start:** check the package profile, acceptance script, package manager, active apply journal, Node major, and wallet-secret variables.
- **A receipt remains pending:** restart or verify again. The bridge retries retryable signing and delivery failures without replacing the first receipt.

The filesystem, process, recovery, and acceptance guarantees are documented in [Bridge Runtime](../../docs/bridge-runtime.md). Shared protocol rules live in [Protocol](../../docs/protocol.md).

## Tests

```bash
npm run test -w @lemma/bridge
```

The tests use a real MCP client and the server app in-process. Process identity and offline-network tests require Linux facilities for full coverage.
