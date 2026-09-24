# Lemma Design Documents

These documents keep product, economic, security, evaluation, and deployment decisions aligned across the monorepo.

- [architecture.md](architecture.md): Components, trust boundaries, and end-to-end data flow.
- [economics.md](economics.md): What is sold, why it has value, pricing, and warranty incentives.
- [economic-gates.md](economic-gates.md): Unit economics, the money path in code, critical-stage gates with iterate-if rules, and what makes the product scale.
- [security-model.md](security-model.md): Assets, actors, threats, controls, and accepted MVP trust.
- [benchmark-protocol.md](benchmark-protocol.md): Frozen control and treatment experiment.
- [deployment.md](deployment.md): Arbitrum Sepolia, Railway, Postgres, keys, and release checks.
- [demo-script.md](demo-script.md): Submission narrative and live demo sequence.

When implementation changes a public interface or assumption, update the owning component README and the relevant document here in the same change.
