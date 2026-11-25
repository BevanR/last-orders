# syntax=docker/dockerfile:1
# Fly app `last-orders`: the Fastify server plus the built web client. The agent is not in this
# image; it runs on the Sprite (see infra/sprite/deploy-agent.sh).

ARG NODE_IMAGE=node:22-alpine

# ---- build: compile engine, server and web ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Manifests first, so the dependency layer is reused when only sources change.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/agent/package.json apps/agent/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/engine packages/engine
COPY apps/server apps/server
COPY apps/web apps/web
# The engine first: the server and web resolve it through its dist/ types.
RUN npm run build -w @last-orders/engine \
 && npm run build -w @last-orders/server \
 && npm run build -w @last-orders/web

# ---- deps: production node_modules for the engine and server only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
# The workspace list is cut to the engine and server, so the agent's and web client's
# dependencies stay out of the image. Versions still come from package-lock.json.
RUN --mount=type=cache,target=/root/.npm \
    npm pkg set --json workspaces='["packages/engine","apps/server"]' \
 && npm install --omit=dev --no-save --no-audit --no-fund \
 && npm ls --omit=dev --workspaces >/dev/null

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/packages/engine/package.json packages/engine/
COPY --from=build /app/packages/engine/dist packages/engine/dist
# The placeholder case, which CASE_FILE points at until the authored case exists.
COPY --from=build /app/packages/engine/test/fixtures packages/engine/test/fixtures
COPY case case
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
# Applied by the server at startup (apps/server/src/db.ts, migrate()).
COPY --from=build /app/apps/server/migrations apps/server/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "apps/server/dist/main.js"]
