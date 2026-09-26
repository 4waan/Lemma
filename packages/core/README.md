# Lemma Core

`@lemma/core` is the shared protocol package. It keeps the bridge, server, catalog, benchmark, dashboard, and future contract bindings on one versioned definition of what was matched, paid for, delivered, and observed.

Core is deterministic and environment-independent. It performs no network, filesystem, database, or signing work.

## Domain modules

| Domain | Modules | Owns |
| --- | --- | --- |
| Identity | `primitives`, `canonical` | Schema version, addresses, timestamps, safe text, canonical JSON, typed digests. |
| Matching | `task`, `profile`, `reasons`, `preview` | Capability requests, repository profiles, decisions, and offers. |
| Releases | `release`, `bundle` | Supported profiles, evidence, provenance, acceptance recipes, patches, and drift planning. |
| Money | `amounts`, `payment`, `pricing`, `policy` | Atomic USDC, x402 terms, sellability, price bounds, and local spend checks. |
| Outcomes | `receipt`, `run` | Resolutions, adoption receipts, benchmark run records, and derived identifiers. |
| Interfaces | `tools`, `read` | MCP inputs and outputs plus public dashboard read models. |
| Safety | `redact` | Bounded credential redaction for structured and unstructured data. |

The package root re-exports the supported public surface:

```ts
import {
  Preview,
  RepositoryProfile,
  checkPurchase,
  deriveResolutionId,
  profileDigest,
} from "@lemma/core";
```

## Protocol invariants

- Every object schema is strict and carries `schemaVersion: "1"`.
- Digests use Keccak-256 over RFC 8785 canonical JSON with a registered domain kind.
- USDC amounts are decimal strings in six-decimal atomic units, never floating-point values.
- A no-match preview cannot contain an offer.
- Evidence is specific to one supported profile and bound to a benchmark run set.
- A sellable price must pass both the 30 percent saving rule and the all-in reduction bound.
- MCP matching accepts typed capability ids, not free-form task prose.
- Patch bundles cannot modify manifests, lockfiles, workspace policy files, dotfiles, or `node_modules`.
- Recovery requires the secret preview id and buyer. A public resolution id is insufficient.
- Signed and paid objects must be parsed before they are hashed or acted on.

The full cross-component behavior is documented in [Protocol](../../docs/protocol.md). Frozen digest vectors live in `test/vectors/digests.json`.

## Development

```bash
npm run build -w @lemma/core
npm run test -w @lemma/core
```

Add a frozen vector when changing canonical data or derived identifiers. A schema change that affects persisted, paid, or signed data requires an explicit versioning decision before dependent components adopt it.

Core intentionally does not yet define warranty vouchers, settlement records, or contract typed data. The payment and contract work must add those structures here before persisting them elsewhere.
