# Multi-stage build for the EventRide API.
#
# Stage 1 installs the whole workspace (the API imports packages/* by source, so a partial install
# would fail), builds, then stage 2 keeps only production dependencies and the compiled output.
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /repo
# Manifests first so the dependency layer caches independently of source changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/engine/package.json      packages/engine/
COPY packages/routing/package.json     packages/routing/
COPY packages/api-client/package.json  packages/api-client/
COPY apps/api/package.json             apps/api/
# The schema must exist before install: apps/api has a `postinstall: prisma generate`, and without
# the schema in place that hook fails the whole install. Copied here rather than with the rest of
# the source so the dependency layer still caches independently of application code.
COPY apps/api/prisma                   apps/api/prisma
RUN pnpm install --frozen-lockfile --filter @eventride/api...

COPY packages ./packages
COPY apps/api ./apps/api
# No compile step: the workspace packages are consumed as TypeScript source (main: ./src/index.ts),
# which tsx, Metro and vitest all handle but plain `node` cannot — a tsc build of the API alone
# emits JS that still imports `packages/shared/src/index.ts` and dies at boot.
#
# Trade-off taken deliberately: the container runs the API through tsx rather than pre-compiling.
# It costs a few hundred ms of startup transpilation and ships a transpiler in the image. The
# alternative — emitting dist/ for every workspace package with dual exports maps — buys marginal
# runtime benefit and would fragment how the same source is loaded by the apps and the test suite.
RUN pnpm --filter @eventride/api exec prisma generate

FROM node:20-slim AS runtime

# OpenSSL is required by Prisma's query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

ENV NODE_ENV=production
WORKDIR /repo

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/api ./apps/api
COPY --from=builder /repo/package.json /repo/pnpm-workspace.yaml /repo/tsconfig.base.json ./

# Never run as root.
RUN useradd --create-home --shell /usr/sbin/nologin eventride && chown -R eventride:eventride /repo
USER eventride

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/apps/api
# migrate deploy (never `migrate dev`) so a container start can never generate or reset a migration.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec tsx src/main.ts"]
