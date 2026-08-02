// Metro config for a pnpm workspace.
//
// pnpm's strict, symlinked node_modules means Metro cannot discover workspace packages or hoisted
// dependencies by walking up from the app directory. Both have to be declared:
//   - watchFolders: so edits in packages/* trigger a rebuild
//   - nodeModulesPaths: so imports resolve through the workspace root store
//   - unstable_enableSymlinks: so the symlinked workspace packages are followed at all
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.unstable_enableSymlinks = true
config.resolver.disableHierarchicalLookup = false

// The workspace packages are written as ESM with explicit `.js` specifiers (`./enums.js`), which is
// what Node and tsc require. Metro resolves against the actual files on disk, which are `.ts`/`.tsx`,
// so a literal `./enums.js` lookup fails. Mapping the extension here keeps ONE import style across
// the backend and the apps instead of maintaining two.
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.replace(/\.js$/, ''), platform)
    } catch {
      // fall through to the untouched specifier below
    }
  }
  return resolve(context, moduleName, platform)
}

module.exports = config
