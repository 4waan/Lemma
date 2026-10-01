# Lemma Documentation

Use this page to find the document that owns a decision. Component READMEs cover local development; these documents cover behavior that crosses component boundaries.

## Understand the product

- [Root README](../README.md): product, current implementation, quickstart, repository map, and submission roadmap.
- [Economics](economics.md): what Lemma sells, why a resolution has value, pricing, warranties, and the business model.
- [Arbitrum](arbitrum.md): why Lemma settles on Arbitrum, what is built on it, the integration options, what past winners and facilitators show, and an analysis of using Arbitrum beyond payments (ERC-8004 reputation, bounded spending, a Stylus confidence engine, ZK proofs) with verdicts and UX rules.
- [Arbitrum roadmap](arbitrum-roadmap.md): the two roadmap items from that analysis in depth, bounded spending with ERC-7715 and ERC-7710 and zero-knowledge compatibility proofs, each with its UX gaps and a checklist for starting.
- [Demo Script](demo-script.md): the final three-minute narrative and claims that require evidence.

## Understand the system

- [Architecture](architecture.md): components, trust boundaries, data flow, persistence, and failure behavior.
- [Protocol](protocol.md): releases, previews, resolutions, receipts, canonical identifiers, pricing, payment boundaries, the warranty's voucher and outcome typed data and verdicts, and the public ERC-8004 adoption record.
- [Reputation and Confidence](reputation-and-confidence.md): how a paid resolution becomes public records (the warranty outcome, the engine record, and ERC-8004 feedback), what each number means, the damper and distinct-buyer counts, what is public and what never is, and what the numbers trust.
- [Security Model](security-model.md): assets, actors, threats, controls, and accepted MVP trust.
- [Security Policy](../SECURITY.md): safe usage, current limitations, secret handling, and vulnerability reporting.

## Work on a runtime

- [Bridge Runtime](bridge-runtime.md): repository profiling, the adoption record in previews, purchasing with the buyer signer and spend ledger, resolution selection, atomic apply, crash recovery, dependency installs, acceptance runs, receipt delivery with the opt-in agent id, and warranty refunds.
- [Server Runtime](server-runtime.md): request handling, persistence, the x402 payment seam and its background jobs, demand privacy, ERC-8004 reputation (the attester and the summary cache), the warranty outcome pipeline (its jobs, outbox, indexer, credit relay route, and operator decisions), startup gates, and operational failures.
- [Deployment](deployment.md): target environment, role separation, migrations, release checks, enabling paid tools, turning on ERC-8004 reputation, the Arbitrum Sepolia runbook for the warranty, engine, and reputation with its local rehearsal, rollout, rollback, and buyer setup.

## Produce evidence

- [Benchmark Protocol](benchmark-protocol.md): frozen control and treatment experiment and its success criteria.
- [Economic Gates and Iterations](economic-gates.md): build order, go-or-iterate decisions, unit economics, and scale requirements.
- [Warranty Registry Review](warranty-registry-review.md): tests, static analysis, checklists, and dated gas figures for the unaudited registry contract.

## Component guides

- [Bridge](../apps/bridge/README.md)
- [Server](../apps/server/README.md)
- [Dashboard](../apps/web/README.md)
- [Core protocol package](../packages/core/README.md)
- [Capability catalog](../packages/catalog/README.md)
- [Benchmark harness](../packages/benchmark/README.md)
- [Compatibility confidence package](../packages/confidence/README.md)
- [Warranty contract](../contracts/README.md)
- [Stylus confidence engine](../contracts/README.md#stylus-compatibility-confidence-engine)
- [Operations](../ops/README.md)
- [End-to-end run](../e2e/README.md)

When a public interface changes, update the owning component guide and the cross-component document that explains the behavior. Do not duplicate detailed rules in the root README.
