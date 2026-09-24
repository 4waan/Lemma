# Lemma: guide for coding agents

Lemma is a compatibility and reuse layer for coding agents. A free `lemma_preview` matches a typed task and a privacy-safe repository profile against a curated catalog of Capability Releases and returns `reuse | adapt | build | decline`. A buyer can then pay through x402 (USDC, Arbitrum Sepolia) for a signed Compatibility Resolution, apply it, run its acceptance recipe, and sign an Adoption Receipt. A provider bond backs a warranty. Read `README.md` and `docs/` before changing behavior.

## Commands (repository root, Node 22)

- `npm install`: install all workspaces (the web session-start hook does this).
- `npm run verify`: typecheck (sources and tests), test, and build. Run it before every commit.
- `npm test`: Vitest across all workspaces, through the root `vitest.config.ts`. It resolves `@lemma/*` to workspace sources and never collects fixtures, benchmark runs or `contracts/`. Run one file with `npx vitest run packages/core/test/amounts.test.ts`.
- `npm run typecheck`: `tsc -b` over project references. `npm run typecheck:tests` also typechecks test files, which `tsc -b` skips.
- `npm run contracts:build` and `npm run contracts:test`: Foundry. `forge` may be missing locally, in which case CI runs these.
- `npm run secrets:scan`: gitleaks over history with `.gitleaks.toml`.

## Where things go

- Shared schemas, digests, amounts, and policy primitives go in `packages/core` and nowhere else. Never redefine a schema in an app.
- Releases, fixtures, and the catalog loader go in `packages/catalog`.
- The benchmark harness and run records go in `packages/benchmark` (raw runs stay in the git-ignored `runs/`).
- Remote MCP, the resolver, the facilitator, and APIs go in `apps/server`. The local stdio bridge, wallet, profile scan, and patch apply go in `apps/bridge`. The dashboard goes in `apps/web`. Settlement goes in `contracts/`.
- Ownership: contracts, x402 payment and facilitator code, EIP-712 layouts, and signing belong to the protocol owner. Leave typed seams and a handoff note instead of implementing them in other lanes.

## Rules that must not regress

- Money is atomic USDC in integer strings or `bigint`, never floating point.
- A no-match preview (`build` or `decline`) never carries a price or an offer. Unsupported profiles are always free.
- An offer must satisfy the sale rule (`price <= 30%` of measured expected raw saving). With no frozen benchmark evidence, a release can be previewed but not sold.
- Matching is deterministic. No model prose reaches matching, pricing, or payment decisions.
- The bridge sends allowlisted metadata only, never repository source or paths.
- Acceptance recipes are argv arrays without a shell. Credentials never reach them.
- Every signed, paid, or persisted object is a strict, versioned schema from core. Changing one is a schema change: update `packages/core/test/vectors/digests.json` deliberately (`LEMMA_WRITE_VECTORS=1`) and note it in the PR.
- No secret in code, fixtures, logs, run records, prompts, or command-line arguments. Build fake credentials in tests from pieces so scanners stay quiet.

## Workflow

- One branch per PR, named `<area>/<topic>`, based on `main`. Use the PR template.
- When a public interface changes, update the owning README and the relevant `docs/` file in the same change.
- Economic claims name their evidence source and measurement date. Label testnet amounts as testnet.

## Project skills

`.claude/skills/` holds vetted, commit-pinned skills: `mcp-builder` and `build-mcp-server` (MCP server and bridge design), `hono` (the server's HTTP layer), `property-based-testing` (fast-check invariants for schemas and amounts), and `gha-security-review` (workflow changes). `SOURCES.md` records each skill's upstream commit, license and local edits. Add or update a skill only by the steps in that file.
