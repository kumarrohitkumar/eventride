import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Integration tests: run against a REAL MySQL and Redis.
 *
 * Kept in a separate config (and out of the default `pnpm test` run) so the unit suite stays
 * infrastructure-free and fast. These are what prove the behaviours that cannot be asserted in
 * memory — database constraints, transactions, and the Prisma adapter itself.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@eventride/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@eventride/engine': resolve(__dirname, 'packages/engine/src/index.ts'),
      '@eventride/routing': resolve(__dirname, 'packages/routing/src/index.ts'),
    },
  },
  test: {
    include: ['apps/api/test/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Rounds and DB constraints are shared state; parallel files would fight over the same rows.
    fileParallelism: false,
  },
})
