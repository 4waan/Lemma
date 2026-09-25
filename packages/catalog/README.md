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

## Layout

```text
economics.json                         dated price inputs: chain cost g, price floor, ETH/USD; status placeholder | measured
releases/<releaseId>/<version>/
  manifest.json                        CapabilityRelease; a committed version is never edited
  bundle.json                          PatchBundle packed from payload/ (catalog:pack)
  payload/ops.json                     file ops and declared dependency changes
  payload/files/<path>                 content of each add and modify
  payload/base/<path>                  the file each modify or delete was built against
releases.provisional/<releaseId>/<version>/   testnet-only overlay, loaded only on request (see below)
fixtures/<capability>/<case>.json      frozen compatibility cases (fixtures/README.md)
```

## Public interface

- `loadCatalog({ includeProvisional })` parses every manifest and bundle with the `@lemma/core` schemas. It requires each release at `<releaseId>/<version>`, each bundle's digest to equal the manifest's `payloadDigest`, and each `releaseId@version` once. Releases come back sorted by digest.
- `buildIndex(catalog)` precomputes what the resolver and the read API need, so no request parses anything:
  - the catalog digest
  - releases by capability, with semver ranges parsed
  - releases by digest and bundles by payload digest
  - per-capability interest sets: the dependency names the catalog matches on, which are the only package names the bridge sends
  - base probes: every path the bundle touches, with the base digest of each modify or delete target and null for an add. The bridge can predict drift before paying without ever seeing content.
- `checkCatalog()` runs every rule below and reports all problems at once. A release that fails to load does not stop the checks on the others. It is read-only and independent of the clock. A test runs it on the committed catalog, and the server runs it before serving.
- `packPayload(dir)` and `formatBundle(bundle)` build `bundle.json` from `payload/`.
- `loadFixtures(root, problems)` and `FixtureCase` expose the compatibility cases to the resolver's golden tests and to the benchmark.

## Rules `catalog:check` enforces

- Every `bundle.json` is exactly what its `payload/` packs to, and every file in `payload/files` and `payload/base` is named by an op. A release directory holds only `manifest.json`, `bundle.json` and `payload/`, and `payload/` only `ops.json`, `files/` and `base/`, so nothing unreviewed can ride along.
- No symbolic links, special files, traversal or non-UTF-8 names anywhere under `releases/`, `releases.provisional/` or `fixtures/`: the whole tree is scanned, not only the files the loader reads. Every file is strict UTF-8 text except `payload/base/`, whose files are hashed as bytes, so a patch may modify or delete a binary file. One bad entry is reported without hiding its siblings. `releases/` and `fixtures/` must exist; only the overlay is optional.
- Every dependency range, in supported profiles and in bundle dependency changes, parses with `semver` and is bounded above: every alternative (each side of `||`) has a `<`, `<=` or exact comparator. Dist-tags such as `latest` and open ranges such as `*`, `>=2` or `<2 || >=3` are refused, because they claim or install versions nobody has tested.
- **Evidence ships as a new version.** Evidence sits inside the manifest, so attaching it changes `releaseDigest`.
  - A version without build metadata carries no evidence.
  - Evidence ships as `X+<benchmarkVersion>`, and every evidence entry names that benchmark version.
  - Its `baseReleaseDigest` must equal that of `X` in `releases/`, so it differs from `X` only in version, evidence, price and dates. The price may follow the evidence because the measured saving does not depend on it.
  - Outstanding offers and run records keep pointing at digests that still exist.
- `releases/` never serves `probe-` or `provisional-` evidence.
  - Public evidence also needs a verified benchmark report.
  - Report verification arrives with the benchmark harness. Until then, no public release may carry evidence.
- `releases.provisional/` holds only `X+provisional-N`. It exists because stage 5 needs an offer and stage 6's treatment arm must buy one before frozen evidence exists.
  - Its evidence carries the stage-4 probe numbers at the pre-registered price.
  - The server loads it only when explicitly allowed, and the public deployment never does.
- **Prices.** An evidenced profile needs measured economics, a non-zero `payTo`, and a price within `[priceFloorAtomic, maxPriceFor(evidence, { chainCostAtomic })]`. The upper bound keeps the buyer at the 25% all-in target after gas (`docs/economic-gates.md`).
- **Fixtures.**
  - Every release family (versions sharing a base) has an exact case.
  - Every capability with a release has a near-miss case and an unsupported-language or unsupported-runtime case.
  - Every case references a real release and profile. A capability without releases has only `no-release` cases, and one with releases has none: only a `no-release` case expects `NO_RELEASE_FOR_CAPABILITY`.
  - A case's reasons must be an answer the resolver can give: a reuse is held back by one sale blocker at most, a decline names an unsupported platform, and a build names none.

## Commands

- `npm run catalog:check`: build, then validate the catalog. It exits 1 on any problem.
- `npm run catalog:pack`: print each release's packed payload digest, and the suggested `maxPriceFor` for evidenced profiles.
- `npm run catalog:pack -- --write`: also write `bundle.json`. The file is written through a temporary file and a rename, so a linked `bundle.json` is replaced, never written through. Copy the printed digest into the manifest's `payloadDigest` before committing a new version.

`.gitattributes` turns off line-ending conversion for catalog files, because payload and base files are hashed byte for byte.

## Current releases

`mcp-server-payment-gating@0.1.0-skeleton` and `mcp-client-paying-client@0.1.0-skeleton` fix supported profiles, fixtures and acceptance recipes, so the resolver and preview path can be built. Their payloads are placeholders for the protocol lane to replace.

They have no evidence, a zero price and a zero `payTo`, so they can be previewed but never sold. `node-service.add-payment-facilitator` has no release yet, which pins the `NO_RELEASE_FOR_CAPABILITY` answer.

## Workspace dependencies

- `@lemma/core` for schemas, digests and pricing.
- Zod for catalog validation.
- `semver` for dependency ranges and release ordering.

## Environment variables

None. A catalog build must be reproducible without network access or secrets.

## Development and tests

- `npm run build -w @lemma/catalog`
- `npm run test -w @lemma/catalog` (includes `checkCatalog` on the committed catalog)

## Security constraints

- Require explicit license and provenance fields.
- Reject mutable source references for publishable releases.
- Hash every payload and acceptance recipe.
- Forbid arbitrary command strings, remote downloads, absolute paths, and secret-bearing fixtures.
- Keep benchmark evidence distinct from marketing claims.

## Later completion criteria

The catalog is complete for the MVP when at least two releases have valid manifests, signed payload digests, exact and negative fixtures, deterministic acceptance recipes, provenance reviews, expiry rules, and frozen benchmark evidence.
