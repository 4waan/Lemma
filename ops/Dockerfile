FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json tsconfig.base.json ./

RUN npm ci
# The packed bridge reaches this server by default (apps/bridge/scripts/pack.mjs).
# Railway passes the service's PUBLIC_BASE_URL to the build; elsewhere it is empty.
ARG PUBLIC_BASE_URL=""
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
# Migrations ship with the server: `node apps/server/dist/migrate.js` applies them
# (deployment step 3), and the server refuses to start while the schema is behind.
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
# The dashboard's built files: the server serves them at / under its own CSP.
COPY --from=build /app/apps/web/dist ./apps/web/dist
# The packed bridge: the server serves it at /dl/ for `npx -y <origin>/dl/lemma-mcp-<version>.tgz`.
COPY --from=build /app/apps/bridge/pack/out ./apps/bridge/pack/out
COPY --from=build /app/packages ./packages

USER node
CMD ["node", "apps/server/dist/main.js"]
