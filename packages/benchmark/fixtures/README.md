# Benchmark Fixtures

This directory holds the frozen repositories used by the paired benchmark and the economic probe.

Each task is a directory `<taskId>/` with a `fixture.json` (schema `BenchmarkFixture` in `src/fixture.ts`) and a `repo/` that both arms start from. `fixture.json` defines the initial commit, task prompt, allowed network access, setup and acceptance commands (argv arrays, no shell), expected result, maximum duration, the profile the bridge would send for `repo/`, and the catalog case that profile is. Control and treatment runs begin from identical copies of `repo/`, made outside the repository.

`test/fixtures.test.ts` checks every committed task against the catalog: the profile is its catalog case's, the resolver picks the case's release, and the acceptance command's pinned test files are the committed ones. `apps/bridge/test/scan.test.ts` checks that the bridge scans `repo/` to that same profile.

After the final benchmark freeze, fixture or prompt changes require a new experiment version. Do not overwrite the original run records.

## Tasks

### `weather-mcp-paid-forecast`

A small TypeScript MCP server (`@modelcontextprotocol/sdk` 1.30.1, npm, Node 22, ESM) with two tools over a bundled weather sample. The task is to charge 0.01 USDC per `get_forecast` call with x402 on Arbitrum Sepolia (testnet), with `get_alerts` staying free. It matches the catalog case `mcp-server.add-payment-gating/exact-npm-node22`, so the treatment gets `mcp-server-payment-gating@0.1.0`.

- `test/paid-forecast.test.ts` holds the requirements: the x402 v2 MCP transport, the exact payment requirements, verify before the tool runs and settle after it succeeds, no charge for a failed forecast, no forecast when settlement fails, no double settlement, and a server that refuses to start without a valid `PAYOUT_ADDRESS` and `FACILITATOR_URL`.
- The test pays with a real EIP-3009 signature (viem, a key generated per run) to a local stand-in facilitator that checks the signature against USDC's EIP-712 domain. No network, keys or funds are involved, and the repository starts with no x402 package, as a buyer's would.
- Acceptance first checks the sha256 of both test files, so an agent cannot pass by editing them, then runs `npm test` (a typecheck and Node's test runner).
- It was checked both ways on 2026-09-28, through the harness's own setup and pre-apply and the acceptance command above. The untouched repository fails 7 of the 14 tests: every payment test except the one that lists the tools. With the 0.1.0 bundle pre-applied and wired in by hand (16 changed lines in `src/server.ts` and `src/index.ts`), all 14 pass.
