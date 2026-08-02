# Multi-stage build for the EventRide API.
#
# The runtime stage deliberately contains NO pnpm, NO corepack and NO transpiler — just node, the
# bundled app, and the dependencies it actually requires. The first version of this file ran the app
# through tsx: it worked locally and then failed silently on a small cloud instance, producing no log
# output at all, because transpiling the whole Nest graph at boot was heavier than the box could take.
# It also re-downloaded pnpm through corepack on every container start.
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
# the schema in place that hook fails the whole install.
COPY apps/api/prisma                   apps/api/prisma
RUN pnpm install --frozen-lockfile --filter @eventride/api...

COPY packages ./packages
COPY apps/api ./apps/api

# Bundles the API and the workspace packages into one CJS file (see apps/api/build.mjs for why).
RUN pnpm --filter @eventride/api build


FROM node:20-slim AS runtime

# OpenSSL is required by Prisma's query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /repo/apps/api

# node_modules carries the external dependencies and the generated Prisma client; dist is the bundle;
# prisma/ is needed because migrations run on start.
COPY --from=builder /repo/node_modules            /repo/node_modules
COPY --from=builder /repo/apps/api/node_modules   /repo/apps/api/node_modules
COPY --from=builder /repo/apps/api/dist           /repo/apps/api/dist
COPY --from=builder /repo/apps/api/prisma         /repo/apps/api/prisma
COPY --from=builder /repo/apps/api/package.json   /repo/apps/api/package.json

# Never run as root.
RUN useradd --create-home --shell /usr/sbin/nologin eventride && chown -R eventride:eventride /repo
USER eventride

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The Prisma CLI is invoked through its binary rather than a package manager, so the runtime needs
# neither pnpm nor a corepack download. `migrate deploy` never generates or resets a migration.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/main.cjs"]
