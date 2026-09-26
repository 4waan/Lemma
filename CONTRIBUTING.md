# Contributing

Lemma is currently optimized for a narrow, evidence-driven hackathon build. Changes should preserve that scope.

## Principles

- Keep compatibility decisions typed and deterministic before introducing model-based ranking.
- Never turn unsupported input into a paid recommendation.
- Keep raw repository source local by default.
- Treat payment and outcome receipts as evidence, not proof of economic value.
- Prefer one end-to-end path over broad marketplace features.
- Keep the old experiment outside `Lemma/` unchanged.

## Workspace boundaries

- Shared domain types belong in `packages/core`.
- Curated releases and fixtures belong in `packages/catalog`.
- Experimental measurement belongs in `packages/benchmark`.
- Remote network behavior belongs in `apps/server`.
- Local wallet and repository behavior belongs in `apps/bridge`.
- Presentation belongs in `apps/web`.
- Settlement guarantees belong in `contracts`.

Do not duplicate a schema independently across applications.

## Development workflow

1. Install with Node 22 (`nvm use` reads `.nvmrc`), then run `npm ci` and `npm run hooks:install` once per clone.
2. Create a local `.env` only when a task requires it.
3. Add or update tests with every behavior change.
4. Run `npm run verify` (type checking, tests, and the production build) and the relevant Foundry checks.
5. Review logs and generated artifacts for secrets before committing. The pre-commit hook runs gitleaks on staged changes when it is installed locally, `npm run secrets:scan` scans your history, and CI scans every commit.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. It has three jobs: `verify` (typecheck, tests, build on the Node version in `.nvmrc`), `contracts` (`forge build` and `forge test`), and `secrets` (gitleaks over full history with `.gitleaks.toml`). Third-party actions are pinned to commit SHAs, and gitleaks is pinned by version and checksum. Update a pin only in a dedicated change.

## Branches and pull requests

Use one branch per pull request, named `<area>/<topic>` (for example `core/schemas-v1`, `catalog/manifests-and-fixtures`). Base each branch on `main`. When a change depends on an unmerged branch, say so in the description and rebase once the dependency merges.

## Documentation expectations

When a public interface changes, update the owning component README and the cross-component document listed in `docs/README.md`. Record economic claims with their evidence source and measurement date. Keep the root README focused on product orientation, current status, and the developer entry path.

## Pull request checklist

- The change stays within the MVP boundary.
- New input is validated at its trust boundary.
- No secret can reach browser code, model context, logs, or committed fixtures.
- Paid paths remain idempotent and recoverable.
- Unsupported profiles remain free.
- Tests cover success, failure, replay, expiry, and no-match behavior where applicable.
- Documentation describes new assumptions and limitations.
