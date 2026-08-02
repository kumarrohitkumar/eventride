import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(here, '../..')

/**
 * Bundles the API into a single CommonJS file for the container.
 *
 * Why this exists: the workspace packages are consumed as TypeScript SOURCE
 * (`main: ./src/index.ts`). tsx, Metro and vitest all handle that, but a plain `tsc` build of the API
 * emits JS that still imports `packages/shared/src/index.ts`, which `node` cannot load. Running the
 * container through tsx worked locally and then died silently on a small cloud instance — no output
 * at all, because transpiling the whole Nest graph at boot is far heavier than the box could take.
 *
 * So: bundle the local TypeScript (including the workspace packages) and leave every real dependency
 * external. The result boots as plain `node dist/main.cjs` — no transpiler, no pnpm, no corepack
 * download on start.
 *
 * Decorator metadata is NOT emitted by esbuild, and that is fine here only because every Nest
 * constructor uses an explicit `@Inject(...)` token rather than relying on reflected parameter types.
 * If someone adds a constructor without @Inject, DI will fail at runtime — hence the check below.
 */

const workspacePackages = ['@eventride/shared', '@eventride/engine', '@eventride/routing']

/** Resolves @eventride/* to its TypeScript entry point so it gets bundled instead of externalised. */
const bundleWorkspacePackages = {
  name: 'bundle-workspace-packages',
  setup(pluginBuild) {
    const filter = new RegExp(`^(${workspacePackages.join('|')})$`)
    pluginBuild.onResolve({ filter }, (args) => {
      const name = args.path.replace('@eventride/', '')
      const entry = resolve(workspaceRoot, 'packages', name, 'src/index.ts')
      return { path: entry }
    })
  },
}

// Guard the assumption that makes esbuild viable: no reflected-type DI anywhere.
// app.module.ts is excluded on purpose: its only constructor belongs to RedisCacheStore, which is
// constructed by hand with `new` and never resolved by the injector, so it needs no @Inject token.
const sources = [
  'src/http/guest.controller.ts',
  'src/http/driver.controller.ts',
  'src/http/admin.controller.ts',
  'src/http/health.controller.ts',
  'src/http/push.controller.ts',
  'src/auth/auth.controller.ts',
  'src/dispatch/dispatch.service.ts',
  'src/dispatch/sweeper.service.ts',
]
for (const file of sources) {
  const text = readFileSync(resolve(here, file), 'utf8')
  const constructors = text.match(/constructor\(([\s\S]*?)\)\s*\{/g) ?? []
  for (const ctor of constructors) {
    // A constructor parameter typed as a class but without @Inject would rely on emitted metadata,
    // which esbuild does not produce.
    const params = ctor.replace(/constructor\(|\)\s*\{/g, '')
    if (params.trim() && /private|public|readonly/.test(params) && !params.includes('@Inject')) {
      throw new Error(
        `${file}: constructor injects without an explicit @Inject token. esbuild emits no decorator ` +
          `metadata, so this would fail at runtime. Add @Inject(Token) to each parameter.`,
      )
    }
  }
}

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'dist/main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // Everything in node_modules stays external — Nest and Prisma both do dynamic requires that do
  // not survive bundling.
  packages: 'external',
  plugins: [bundleWorkspacePackages],
  tsconfig: resolve(here, 'tsconfig.json'),
  logLevel: 'info',
})

process.stdout.write('bundled -> apps/api/dist/main.cjs\n')
