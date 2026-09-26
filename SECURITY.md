# Security Policy

Lemma handles repository metadata, generated patches, acceptance commands, payment authorization, private keys, and eventually provider bond accounting. Treat every component boundary as hostile until typed validation and local policy approve the operation.

## Supported environment

Lemma is an unaudited testnet MVP. The free preview, catalog, persistence, local apply, verification, dashboard, and benchmark surfaces are implemented. Real payment signing, the x402 facilitator, and the warranty contract are not complete.

Do not use Lemma with mainnet assets or production signing keys. Use disposable Arbitrum Sepolia identities and public or synthetic repositories while developing the paid path.

## Implemented controls

### Repository access

- The bridge reads an allowlist of package manifests and lockfiles to create a typed profile.
- Catalog interest sets limit which dependency names leave the machine.
- Paths are canonicalized and confined to the configured workspace.
- Parent traversal, absolute paths, symbolic links, protected files, unsafe package paths, and unsupported binary writes are rejected.
- Base probes detect local drift before purchase without uploading file contents.

### Patch application

- Release manifests and bundles are parsed and checked by digest.
- Preview mode is the default and performs no writes.
- Exact application uses a durable journal, staged content, base-file checks, and rollback.
- A competing or unfinished apply blocks new work in the same lockfile-owning repository.
- Dependency installs disable lifecycle scripts and remove wallet and Lemma secrets from their environment.
- Acceptance recipes map to reviewed package scripts and safe argument arrays. They never execute catalog-provided shell strings.
- Acceptance output is bounded and digested rather than returned to the model.

See [Bridge Runtime](docs/bridge-runtime.md) for the process and crash-recovery model.

### Server and browser

- MCP, API, catalog, and persisted data cross strict schemas.
- Request bodies, request duration, and per-client rate are bounded.
- Browser origins are refused on the MCP endpoint. Dashboard API CORS uses a configured allowlist.
- The server returns typed public views without buyer addresses, preview secrets, bundles, or internal errors.
- Database access uses Drizzle and parameterized queries.
- Security headers and a same-origin Content Security Policy protect the dashboard.
- The dashboard parses every response and uses React escaping only. Outbound links are reconstructed from validated GitHub provenance.
- The production bundle check rejects inline code, foreign assets, and source maps.

### Catalog and evidence

- Catalog startup fails on invalid schemas, mutable provenance, digest drift, unsafe files, unbounded dependency ranges, incomplete fixtures, or invalid pricing.
- Public releases cannot carry provisional evidence.
- Evidence is bound to a run-set digest and base release.
- No-match and unsupported profiles cannot carry an offer.

### Secrets and supply chain

- CI typechecks source and tests, runs the test suite and production build, builds and tests Foundry, and scans Git history with gitleaks.
- The local hook scans staged changes when gitleaks is installed.
- GitHub Actions and the scanner are pinned.
- Container builds exclude environment files, Git history, run records, local build output, and development dependencies.
- Redaction helpers scrub credential-shaped values from errors and run records.

## Secret handling

- Keep private keys and service credentials in a scoped secret manager or signer process.
- Use separate buyer, provider, facilitator, evaluator, and deployer identities.
- Never place credentials in prompts, MCP content, command arguments, browser variables, dashboard data, logs, benchmark records, source maps, catalog fixtures, or container layers.
- Do not keep a buyer key in the bridge environment. Child installs and tests may read their ancestor's startup environment through operating-system process interfaces.
- A file readable by the same user is not isolation from an acceptance test. Prefer a hardware signer, remote signer, or process running as another user.
- Rotate a leaked secret before removing it from Git history.

## Pending payment controls

The paid path must preserve these requirements before it is enabled:

- Accept only x402 v2 on `eip155:421614` with the configured Arbitrum Sepolia USDC contract and provider address.
- Compare every payment challenge field with the stored quote.
- Enforce the per-resolution cap, daily cap, authorization lifetime, and committed-spend reservation before signing.
- Derive an EIP-3009 nonce from secret and public resolution inputs rather than using the public resolution id alone.
- Treat settlement timeouts as indeterminate and reconcile before retrying.
- Keep resolution preparation, settlement, delivery, and recovery idempotent.
- Verify buyer receipt signatures before using them for compatibility history or warranty outcomes.

## Pending contract controls

The warranty registry must include EIP-712 domain separation, replay protection, expiry, pause controls, pull-based withdrawals, and reentrancy protection.

Provider withdrawals cannot consume bond reserved for active resolutions. Release deactivation cannot invalidate an active warranty. The accounting invariant is:

```text
USDC balance >= available bond + reserved bond + withdrawal credits
```

Unit, fuzz, and invariant tests must cover six-decimal accounting and the complete activation, pass, failure, expiry, and withdrawal state machine before deployment.

## Dependency and release checks

Before a public release:

1. Run `npm run verify`, catalog validation, and the Foundry unit, fuzz, and invariant suites.
2. Run gitleaks over full history and staged changes.
3. Audit runtime dependencies and review unresolved advisories.
4. Inspect the final container and dashboard bundle for credentials and development artifacts.
5. Verify deployed bytecode and publish compiler settings, constructor arguments, addresses, transaction hashes, and the source commit.
6. Exercise free preview, payment, lost-response recovery, warranty activation, pass, failure refund, and withdrawal on testnet.

The benchmark SDK is a development-only dependency and is pruned from the production image. Run benchmarks only against trusted endpoints and review its transitive advisories before every measured experiment.

## Reporting a vulnerability

Do not open a public issue containing exploit details, repository data, or secrets. Contact the maintainers privately with the affected component, reproduction steps, impact, and suggested containment. Lemma does not currently offer a vulnerability bounty.
