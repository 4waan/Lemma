# Operations

## Purpose

This directory holds the production container scaffold and Railway configuration for the hosted Lemma service. Postgres development configuration remains at the monorepo root in `compose.yaml`.

## Responsibilities

- Build the TypeScript workspaces and Vite dashboard in a repeatable Node 22 image.
- Start the compiled server entrypoint.
- Provide Railway build and restart configuration.
- Keep secrets outside the image and source tree.

## Outside this boundary

- Contract deployment.
- Database migrations.
- Key generation or faucet funding.
- Runtime secret creation.
- Automatic production promotion.

## Files

- `Dockerfile`: Multi-stage build from the monorepo root.
- `railway.toml`: Railway Dockerfile path and restart policy.
- `../.dockerignore`: Excludes secrets, local dependencies, build output, and run records from the container context.

Railway must use `Lemma/` as the service root so Docker copy paths resolve correctly.

## Environment variables

Configure server-only variables from `.env.example` in Railway. Do not add `BUYER_PRIVATE_KEY` or `CURSOR_API_KEY` to the hosted product service unless a separately scoped benchmark job explicitly requires them.

## Security constraints

- Build without copying `.env` files.
- Run as the unprivileged Node user.
- Disable production source maps.
- Keep one facilitator replica until pending settlement state is shared.
- Scope the database user to the Lemma database.
- Restrict public ingress to the intended HTTP port.
- Store no credential in image layers, build arguments, or Railway configuration files.

## Later completion criteria

Operations is complete when the image serves the production API and static dashboard, Railway health checks pass, database and RPC failures degrade safely, and deployment evidence contains no secrets.
