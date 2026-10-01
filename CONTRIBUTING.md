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
5. `npm test` runs from a fresh clone, before any build: tests that start a child process run it with `node --conditions=source --import tsx`, and each workspace's `source` export condition points that child at `src/`, never at a stale `dist/`.
6. Linux is the reference platform, and CI runs every test there. On macOS or in a sandbox, tests that need Linux (`/proc`, network and pid namespaces, `unshare` and `ip` for offline acceptance, byte file names the filesystem refuses, or a `ps` that can see other processes) are skipped with a comment saying why; variables the OS adds to every process (macOS `__CF_USER_TEXT_ENCODING`) are ignored in exact environment checks.
7. Review logs and generated artifacts for secrets before committing. The pre-commit hook runs gitleaks on staged changes when it is installed locally, `npm run secrets:scan` scans your history, and CI scans every commit.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request, on pushes to `main`, and once a day on `main` (and by hand, `workflow_dispatch`), so a test that comes to depend on the date fails the day it starts to, not on someone's next pull request. Its jobs are `verify` (typecheck, tests, build on the Node version in `.nvmrc`), `macos` (the same `npm run verify` on macOS, where the tests that need Linux skip), `postgres` (the store's race and migration tests against Postgres), `contracts` (`forge build`, `forge test`, the ABI check and a deploy rehearsal), `stylus` (the Stylus engine's tests, ABI and reproducible wasm), `e2e` (`npm run e2e` on anvil), and `secrets` (gitleaks over full history with `.gitleaks.toml`). The daily run also sets `LEMMA_DATE_GUARDS=1`, which switches on `packages/catalog/test/expiry-guard.test.ts`: it fails 60 days before a committed release's `expiresAt` and 14 days before a profile's evidence goes stale (`staleAfter`), naming what to renew; pull requests never run it, so the calendar never blocks one. Third-party actions are pinned to commit SHAs, and gitleaks is pinned by version and checksum. Update a pin only in a dedicated change.

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
