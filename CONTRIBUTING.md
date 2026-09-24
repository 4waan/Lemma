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

1. Install with Node 22.
2. Create a local `.env` only when a task requires it.
3. Add or update tests with every behavior change.
4. Run type checking, tests, the production build, and relevant Foundry checks.
5. Review logs and generated artifacts for secrets before committing.

## Documentation expectations

When a public interface changes, update the owning component README and the relevant file under `docs`. Record economic claims with their evidence source and measurement date.

## Pull request checklist

- The change stays within the MVP boundary.
- New input is validated at its trust boundary.
- No secret can reach browser code, model context, logs, or committed fixtures.
- Paid paths remain idempotent and recoverable.
- Unsupported profiles remain free.
- Tests cover success, failure, replay, expiry, and no-match behavior where applicable.
- Documentation describes new assumptions and limitations.
