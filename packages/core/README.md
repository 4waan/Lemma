# Lemma Core

## Purpose and economic role

Core defines the shared language that prevents the server, bridge, dashboard, benchmark, and contract bindings from disagreeing about what was sold. Stable schemas and canonical identifiers are required for payments, signatures, warranties, and reproducible evidence.

## Responsibilities

- Define versioned schemas for repository profiles, releases, previews, resolutions, vouchers, and receipts.
- Define decision, evidence, outcome, and warranty status enums.
- Canonicalize JSON and derive Keccak identifiers.
- Define pricing and spending-policy value types without floating-point currency.
- Provide shared validation and secret-redaction helpers.

## Outside this boundary

- Network requests.
- Database access.
- Filesystem scanning.
- Wallet signing.
- Matching against a concrete catalog.
- User-interface rendering.

## Planned public interface

The package will export Zod schemas, inferred TypeScript types, canonical serialization, identifier derivation, amount parsing, and policy primitives. The current export contains only the initial schema version, decision vocabulary, and scaffold metadata.

## Workspace dependencies

- Zod for runtime validation.
- `json-canonicalize` for deterministic serialization.
- viem utilities for Ethereum-compatible hashes and values.

## Environment variables

None. Core must remain deterministic and environment-independent.

## Development and tests

- `npm run build -w @lemma/core`
- `npm run test -w @lemma/core`

## Security constraints

- Parse untrusted values rather than casting them.
- Reject unknown fields on signed and paid payloads.
- Represent USDC amounts as integers in atomic units.
- Version every signed structure.
- Keep canonicalization test vectors shared with Solidity encoding tests.

## Later completion criteria

Core is complete when every application imports one canonical schema set, cross-language digest vectors match, invalid paid payloads fail closed, and schema migration rules are documented.
