# Lemma

Lemma is a compatibility and reuse layer for coding agents. It helps an agent decide whether verified prior integration work fits the repository in front of it, purchase the exact resolution through x402, and adopt it with evidence and bounded financial recourse.

> Current status: compile-ready scaffold. Payment, matching, persistence, MCP tools, and warranty contracts are intentionally not implemented yet.

## Product thesis

Open-source code makes implementations available, but availability does not answer whether a release fits a specific repository, whether it still works with pinned dependencies, or whether adapting it will cost less than rebuilding it. Lemma sells that missing compatibility resolution.

The product has three economic objects:

1. **Capability Release:** A versioned reusable integration capability with supported profiles, evidence, provenance, license terms, acceptance tests, price, and expiry.
2. **Compatibility Resolution:** A context-bound recommendation and executable integration bundle for one task, repository profile, buyer, and release.
3. **Adoption Receipt:** A signed passed, failed, or abandoned outcome that updates compatibility history and can trigger warranty settlement.

The buyer is not paying for ownership of open-source code. The buyer pays for verified applicability, a ready integration path, reduced agent work, and a bonded warranty for eligible failures.

## Planned flow

1. A user connects the local Lemma MCP bridge to a coding agent.
2. The bridge reads a privacy-safe repository profile and requests a free preview.
3. The resolver returns `reuse`, `adapt`, `build`, or `decline` with evidence and expected savings.
4. A local spend policy decides whether a quoted resolution may be purchased.
5. The bridge pays through x402 using Arbitrum Sepolia USDC.
6. The server returns a signed Compatibility Resolution and recoverable patch bundle.
7. The bridge previews or applies the patch and runs its pinned acceptance recipe.
8. Adoption evidence is recorded. A confirmed eligible failure is refunded from the provider bond.

## Architecture

- `apps/server` will host the remote MCP server, deterministic resolver, x402 facilitator, receipt API, and dashboard API.
- `apps/bridge` will be the local stdio MCP process. It will hold the buyer signer, scan safe repository metadata, enforce spending policy, and apply verified patches.
- `apps/web` will present releases, resolutions, warranties, receipts, and benchmark evidence.
- `packages/core` will own schemas, canonical hashing, identifiers, and shared policies.
- `packages/catalog` will own curated Capability Release manifests and compatibility fixtures.
- `packages/benchmark` will run the frozen control and treatment experiment through the Codex SDK.
- `contracts` will contain the Arbitrum Sepolia warranty registry.
- `docs` records the decisions that must remain consistent across those components.
- `ops` contains the container and Railway deployment scaffold.

## Repository map

```text
apps/       Deployable and locally executed applications
packages/   Shared domain, catalog, and benchmark libraries
contracts/  Isolated Foundry project for warranty settlement
docs/       Architecture, economics, security, benchmark, and demo specifications
ops/        Container and Railway configuration
```

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Foundry for Solidity builds and tests
- Docker or another Compose-compatible runtime for local Postgres
- An Arbitrum Sepolia RPC URL when chain work begins

## Install and verify

From this directory:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run contracts:build
npm run contracts:test
```

The initial scaffold does not require environment variables for compilation or tests.

## Common scripts

- `npm run build`: Compile every TypeScript project and produce the Vite bundle.
- `npm run typecheck`: Validate all TypeScript project references.
- `npm test`: Run all scaffold tests with Vitest.
- `npm run dev:server`: Watch the server scaffold.
- `npm run dev:bridge`: Watch the local bridge scaffold.
- `npm run dev:web`: Start the Vite development server.
- `npm run benchmark`: Run the compiled benchmark entrypoint after the harness exists.
- `npm run contracts:build`: Build the isolated Foundry package.
- `npm run contracts:test`: Run Foundry tests.

## Environment setup

Copy `.env.example` to `.env` locally and fill only the roles needed for the component you are running. Never commit `.env`.

The planned system uses separate buyer, provider, facilitator, evaluator, and deployer roles. A production deployment must not reuse one private key across those roles. Browser code must never receive private keys, database credentials, RPC secrets, or the Codex SDK key.

Local Postgres can be started from `compose.yaml`. The included username and password are public local-development defaults and must not be used outside a developer machine.

## MVP boundary

The hackathon MVP will include:

- A curated catalog of TypeScript MCP and x402 integration releases.
- A deterministic compatibility resolver.
- A local MCP bridge with code-enforced spending limits.
- A self-hosted x402 facilitator for Arbitrum Sepolia.
- USDC resolution payments and a bonded warranty contract.
- A dashboard and a paired Codex SDK benchmark.

It will not include:

- A tradable token or NFT.
- Open provider registration.
- Auctions, dynamic pricing, or retroactive rewards.
- A Jev runtime dependency.
- Uploading private repository source by default.
- Arbitrary remote execution of buyer repositories.
- Production custody or claims of production security.

## Planned capability releases

The first catalog will cover:

1. Adding x402 payment gating to a TypeScript MCP server.
2. Adding an x402-paying MCP client with hard spending limits.
3. Adding an Arbitrum Sepolia x402 facilitator to a Node and Hono service.

Only profiles backed by a compatible fixture and acceptance recipe may be sold. Unsupported profiles must return a free no-match decision.

## Hackathon build sequence

1. Freeze shared schemas, repository profiles, and capability fixtures.
2. Implement the deterministic resolver and the first two releases.
3. Implement and test the warranty registry.
4. Implement the facilitator and paid remote MCP path.
5. Implement the local bridge, spend controls, recovery, and patch safety.
6. Add adoption verification and evaluator attestations.
7. Deploy the contract, server, database, and dashboard.
8. Run the frozen benchmark and one public-repository pilot.
9. Publish evidence and record the final demo.

## Documentation

Start with [docs/README.md](docs/README.md). Security-sensitive work must also follow [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md).
