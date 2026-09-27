# Lemma Bridge

`@lemma/bridge` is the local stdio MCP server used by a coding agent. It is the only Lemma component allowed to inspect the buyer's repository, manage buyer-side state, apply a resolution, or run its acceptance recipe.

The bridge supports the complete workflow: free preview, purchase through x402 and a separate buyer signer, apply, and adoption verification.

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

Buys the resolution the last `lemma_preview` offered, within this machine's spending limits. It is registered only when `lemma-signer` answers and the spending policy is set; otherwise the bridge says on stderr why purchases are off.

Input:

```json
{ "capability": "mcp-server.add-payment-gating", "package": "apps/api" }
```

The bridge checks the offer against its spend ledger, reserves the price, has the signer sign a USDC authorization for the preview's own terms, and pays in one MCP call. It stores the delivery only if it is the resolution the offer sold. A lost or unclear answer is recovered for free, never paid again. The steps are in [Bridge Runtime](../../docs/bridge-runtime.md#purchasing).

### `lemma_apply_resolution`

Selects the newest applicable local purchase for the capability and package.

- `mode: "preview"`, the default, reports the complete file and dependency plan without writing.
- `mode: "apply"` performs an atomic, journaled apply and runs dependency installation with lifecycle scripts disabled.
- Repository drift returns `adapt` and exports the resolution for manual integration instead of forcing a patch.
- An interrupted apply is recovered before another apply begins.

### `lemma_verify_adoption`

Runs the release's acceptance recipe only when the resolution is present and the package still fits the purchased profile. The command runs without a shell, with bounded output, a timeout, a fresh home directory, and wallet-secret checks.

The first started run produces the receipt that counts. Retryable delivery failures are kept in the local inbox and sent again later. `lemma-signer` signs the receipt when it answers; without a signer, the receipt is sent unsigned and the server keeps it unverified.

## Normal agent flow

1. Call `lemma_preview` before implementing a supported capability.
2. If the result is preview-only or no-match, build normally and spend nothing.
3. When payments are enabled, call `lemma_buy_resolution` for an acceptable offer.
4. Call `lemma_apply_resolution` in preview mode.
5. Apply directly when exact, or merge the exported files when the result is `adapt`.
6. Call `lemma_verify_adoption`, with `adapted: true` after a manual merge.

## Buyer signer

`lemma-signer` (`dist/signer/main.js`) holds the buyer key in a separate process, so the bridge and the tests it runs never do:

```bash
lemma-signer init
lemma-signer serve
```

`init` creates the key file (mode 0600) and prints the address to fund with test USDC; the buyer needs no ETH. `serve` signs over a Unix socket, within its own copy of the spending policy and its own ledger, because any process of the user can reach the socket. For isolation from acceptance tests, run it as another user (see [Buyer setup](../../docs/deployment.md#buyer-setup)). A hardware or remote signer can take its place behind the same `Signer` interface.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEMMA_API_URL` | `http://localhost:3000` | Hosted Lemma server. |
| `LEMMA_WORKSPACE` | Current directory | Repository boundary for scans and writes. |
| `LEMMA_STATE_DIR` | `$XDG_STATE_HOME/lemma` or `~/.local/state/lemma` | Private inbox, manifests, receipts, journals, exports, and recovery data. |
| `LEMMA_ACCEPTANCE_OFFLINE` | unset | Set to `1` on Linux to run acceptance in a network namespace. |
| `LEMMA_BRIDGE_TRACE` | unset | Benchmark-only path for minimal tool-call tracing. |
| `LEMMA_SIGNER_SOCKET` | `<state>/signer/signer.sock` | Socket of `lemma-signer`. Purchases stay off while no signer answers there. |
| `LEMMA_MAX_USDC_PER_RESOLUTION` | unset | Most one purchase may cost, in atomic USDC (`250000` is 0.25 USDC). |
| `LEMMA_DAILY_USDC_CAP` | unset | Most spent in a rolling 24 hours, in atomic USDC. |
| `LEMMA_ALLOWED_PAY_TO` | unset | Comma-separated recipient addresses the buyer will pay. |
| `LEMMA_REFUND_TO` | Buyer address | Where warranty credits are paid. Withdrawing a credit shows this address next to the public resolution id on chain. |

The state directory must be absolute and outside the workspace. Empty values count as unset.

Purchases need a signer and all three policy variables; decimal amounts are refused. The network and asset are fixed to Arbitrum Sepolia USDC, and authorizations to at most 600 seconds. The signer reads the same policy variables, plus `LEMMA_SIGNER_KEY_FILE` (default `<state>/signer/key`) and `LEMMA_SIGNER_SOCKET_MODE` (`600`, or `660` for a signer run as another user). Set those two only in the signer's environment.

The bridge needs no RPC URL and never holds the buyer key. The key must not enter model context, MCP content, logs, receipts, the bridge's environment, or the acceptance process environment. The bridge reports a wallet secret it finds in its environment, and verify refuses to run tests while one is there.

## Troubleshooting

- **Preview returns build:** inspect the reason codes. No release, an unsupported runtime, stale evidence, and an unreachable server are distinct outcomes.
- **Apply returns adapt:** the package differs from the release base. Merge the exported resolution and verify with `adapted: true`.
- **Apply says another operation is active:** wait for the owner, or restart the bridge so it can inspect and recover an abandoned journal.
- **Verification does not start:** check the package profile, acceptance script, package manager, active apply journal, Node major, and wallet-secret variables.
- **A receipt remains pending:** restart or verify again. The bridge retries retryable signing and delivery failures without replacing the first receipt.
- **Purchases are off:** the bridge's stderr says why at startup: no signer answers at the socket, the socket's directory can be written by others, or a spending policy variable is missing or not atomic USDC.
- **A purchase answer was lost:** call `lemma_apply_resolution` a minute later. The bridge recovers the purchase for free and never pays again.

The filesystem, process, recovery, and acceptance guarantees are documented in [Bridge Runtime](../../docs/bridge-runtime.md). Shared protocol rules live in [Protocol](../../docs/protocol.md).

## Tests

```bash
npm run test -w @lemma/bridge
```

The tests use a real MCP client and the server app in-process. Purchase tests pay that app's real x402 facilitator through an in-process signer and the server's in-memory USDC. Process identity and offline-network tests require Linux facilities for full coverage.
