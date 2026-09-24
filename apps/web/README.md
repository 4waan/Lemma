# Lemma Web Dashboard

## Purpose and economic role

The dashboard makes the economic claim inspectable. It will show what a buyer paid for, which profile was covered, what evidence supported the decision, whether the warranty activated, and whether adoption passed or failed.

## Responsibilities

- Explain Capability Releases, Compatibility Resolutions, and Adoption Receipts.
- List curated releases with provenance, licenses, prices, bonds, supported profiles, and evidence.
- Display payment, warranty, outcome, and benchmark records.
- Publish installation instructions and MCP configuration examples.
- Label testnet data, provider attestations, evaluator trust, and experimental measurements clearly.

## Outside this boundary

- Holding any private key.
- Constructing or signing x402 payments.
- Applying patches.
- Evaluating warranty claims.
- Serving as an authorization boundary.

## Planned views

- Product overview and setup.
- Capability catalog.
- Resolution detail.
- Benchmark evidence.
- Public system status and contract links.

The current application is a static scaffold shell only.

## Workspace dependencies

- React and Vite for the client application.
- `@lemma/core` for public read-model types once implemented.

## Environment variables

Only explicitly public service URLs and chain identifiers may enter the web build. Database credentials, private RPC credentials, API keys, and wallet keys are forbidden.

## Development and tests

- `npm run dev -w @lemma/web`
- `npm run build -w @lemma/web`
- `npm run bundle -w @lemma/web`
- `npm run test -w @lemma/web`

## Security constraints

- Render text through React escaping and avoid raw HTML.
- Use a restrictive Content Security Policy in production.
- Do not store bearer credentials or wallet keys in browser storage.
- Treat all API text, transaction metadata, URLs, and release content as untrusted.
- Allow only approved explorer and source links.
- Do not ship production source maps containing internal information.

## Later completion criteria

This component is complete when every demo payment and warranty state can be independently inspected, all claims are evidence-linked and correctly labeled, and no sensitive server configuration is present in the browser bundle.
