# Security Policy

Lemma handles payment authorization, private keys, repository metadata, generated patches, and eventually USDC bond accounting. Treat every boundary as hostile until it is validated.

## Scaffold status

This repository is an unaudited scaffold. It does not currently process funds or expose production services. Do not use it with mainnet assets.

## Secret handling

- Keep all private keys and service credentials in local environment files or the deployment secret manager.
- Never expose server secrets through Vite environment variables, browser bundles, HTML, logs, errors, or source maps.
- Use distinct keys for buyer, provider, facilitator, evaluator, and deployer roles.
- Use throwaway testnet wallets during development.
- Redact payment authorizations, signed transactions, salts, private keys, and full environment values from logs and run records.
- Rotate a secret before removing it from Git history if it is ever committed.

## Repository access

The local bridge will default to reading only approved manifest and lock files. It must not upload source files, environment files, wallet files, SSH material, Git internals, or arbitrary directory content.

Any path supplied to the bridge must be canonicalized and verified to remain inside the configured workspace root. Reject absolute paths, parent traversal, symlinks, binary patch targets, and protected paths.

## Patch application

- Verify the provider signature and payload digest before previewing or applying a resolution.
- Default to preview mode.
- Require an explicit apply request for mutations.
- Detect changes between the previewed base files and current workspace state.
- Apply atomically or leave the workspace unchanged.
- Never execute a command embedded as an arbitrary string in a catalog payload.
- Map acceptance recipe identifiers to reviewed argument arrays and resource limits.

## Web and API security

The server implementation must include strict input schemas, request and response size limits, timeouts, rate limits, secure error handling, a restrictive CORS allowlist, and security headers.

Planned headers include:

- Content Security Policy with scripts and connections restricted to approved origins.
- Strict Transport Security in production.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Cache-Control: no-store` for sensitive responses.

All state-changing browser endpoints will require origin validation and CSRF protection if cookie authentication is introduced. Database access must use parameterized queries through the selected query layer.

## Facilitator and payment safety

- Accept only `eip155:421614`, the exact payment scheme, the configured USDC contract, approved destinations, and bounded amounts.
- Enforce spending limits in bridge code before the buyer signs anything.
- Treat settlement timeouts as indeterminate and reconcile them before retrying.
- Make paid resolution creation and recovery idempotent.
- Never derive payment permission from model text alone.

## Contract safety

The warranty contract must use domain-separated typed signatures, replay protection, expiry, pull-based withdrawals, reentrancy protection, pause controls, and an explicit solvency invariant.

Provider bond accounting must prevent withdrawal of reserved funds. Release deactivation must not invalidate existing warranties.

## Dependency and release checks

Before a public release:

1. Run the TypeScript, Vitest, Foundry, fuzz, and invariant suites.
2. Audit runtime dependencies.
3. Scan the full Git history and staged changes for secrets.
4. Review generated container contents for credentials and development artifacts.
5. Verify deployed bytecode and record contract addresses and compiler settings.

The scaffold currently pins `@cursor/sdk@1.0.32` for benchmarks. Its transitive `undici@5.29.0` has published denial-of-service and HTTP parsing advisories with no compatible upstream fix reported by npm. The SDK is a development-only dependency and is pruned from the production image. Recheck and upgrade it before running benchmarks against untrusted endpoints.

## Reporting a vulnerability

Do not open a public issue containing exploit details or secrets. Contact the project maintainers privately with the affected component, reproduction steps, impact, and suggested containment. No formal bounty program exists during the scaffold phase.
