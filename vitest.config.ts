import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@eventride/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@eventride/engine': resolve(__dirname, 'packages/engine/src/index.ts'),
      '@eventride/routing': resolve(__dirname, 'packages/routing/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/guest/**',
      'apps/portal/**',
      // *.int.test.ts require a real MySQL/Redis — they run via vitest.integration.config.ts.
      '**/*.int.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
  },
})
