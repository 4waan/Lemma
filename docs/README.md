# Lemma Documentation

Use this page to find the document that owns a decision. Component READMEs cover local development; these documents cover behavior that crosses component boundaries.

## Understand the product

- [Root README](../README.md): product, current implementation, quickstart, repository map, and submission roadmap.
- [Economics](economics.md): what Lemma sells, why a resolution has value, pricing, warranties, and the business model.
- [Demo Script](demo-script.md): the final three-minute narrative and claims that require evidence.

## Understand the system

- [Architecture](architecture.md): components, trust boundaries, data flow, persistence, and failure behavior.
- [Protocol](protocol.md): releases, previews, resolutions, receipts, canonical identifiers, pricing, and payment boundaries.
- [Security Model](security-model.md): assets, actors, threats, controls, and accepted MVP trust.
- [Security Policy](../SECURITY.md): safe usage, current limitations, secret handling, and vulnerability reporting.

## Work on a runtime

- [Bridge Runtime](bridge-runtime.md): repository profiling, resolution selection, atomic apply, crash recovery, dependency installs, and acceptance runs.
- [Server Runtime](server-runtime.md): request handling, persistence, payment seams, demand privacy, startup gates, and operational failures.
- [Deployment](deployment.md): target environment, role separation, migrations, release checks, rollout, and rollback.

## Produce evidence

- [Benchmark Protocol](benchmark-protocol.md): frozen control and treatment experiment and its success criteria.
- [Economic Gates and Iterations](economic-gates.md): build order, go-or-iterate decisions, unit economics, and scale requirements.

## Component guides

- [Bridge](../apps/bridge/README.md)
- [Server](../apps/server/README.md)
- [Dashboard](../apps/web/README.md)
- [Core protocol package](../packages/core/README.md)
- [Capability catalog](../packages/catalog/README.md)
- [Benchmark harness](../packages/benchmark/README.md)
- [Warranty contract](../contracts/README.md)
- [Operations](../ops/README.md)

When a public interface changes, update the owning component guide and the cross-component document that explains the behavior. Do not duplicate detailed rules in the root README.
