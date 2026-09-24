# Lemma Capability Catalog

## Purpose and economic role

The catalog contains the productive assets Lemma can resolve against. Each Capability Release packages open-source provenance with a narrow supported profile, deterministic adaptation, acceptance evidence, a price, an expiry, and warranty terms.

The catalog is curated during the MVP. Publishing a file is not enough to create a sellable release.

## Responsibilities

- Store versioned Capability Release manifests.
- Store reviewed patch templates and acceptance recipes.
- Store positive, boundary, and negative compatibility fixtures.
- Record upstream source commits, SPDX licenses, attribution, and modification notes.
- Record measured savings evidence and its benchmark version.
- Validate catalog integrity before server startup.

## Outside this boundary

- Open provider onboarding.
- Dynamic pricing.
- Payment settlement.
- Buyer-specific repository content.
- Runtime warranty adjudication.

## Planned public interface

The package will load validated manifests, enumerate releases, retrieve payloads by digest, and expose fixture metadata to the resolver and benchmark. It currently exports scaffold metadata with zero publishable releases.

## Workspace dependencies

- `@lemma/core` for schemas and identifiers.
- Zod for catalog validation.

## Environment variables

None. A catalog build must be reproducible without network access or secrets.

## Development and tests

- `npm run build -w @lemma/catalog`
- `npm run test -w @lemma/catalog`

## Security constraints

- Require explicit license and provenance fields.
- Reject mutable source references for publishable releases.
- Hash every payload and acceptance recipe.
- Forbid arbitrary command strings, remote downloads, absolute paths, and secret-bearing fixtures.
- Keep benchmark evidence distinct from marketing claims.

## Later completion criteria

The catalog is complete for the MVP when at least two releases have valid manifests, signed payload digests, exact and negative fixtures, deterministic acceptance recipes, provenance reviews, expiry rules, and frozen benchmark evidence.
