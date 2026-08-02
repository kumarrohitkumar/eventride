export * from './provider.js'
export * from './mock-provider.js'
export * from './google-provider.js'
export * from './caching-provider.js'
export * from './oracle.js'

import { GoogleRoutingProvider } from './google-provider.js'
import { MockRoutingProvider } from './mock-provider.js'
import { CachingRoutingProvider, MemoryCacheStore, type CacheStore } from './caching-provider.js'
import type { RoutingProvider } from './provider.js'

export interface RoutingFactoryOptions {
  provider?: string
  apiKey?: string
  store?: CacheStore
}

/**
 * Composes the stack from configuration (HLD §8.1):
 *   caching( google | mock )
 *
 * Defaults to `mock` deliberately: the system must be fully runnable with no API key and no billing
 * account, so a reviewer can clone and run it, and CI costs nothing.
 */
export function createRoutingProvider(
  options: RoutingFactoryOptions = {},
): CachingRoutingProvider {
  const store = options.store ?? new MemoryCacheStore()
  let upstream: RoutingProvider

  if (options.provider === 'google') {
    if (!options.apiKey) {
      throw new Error('ROUTING_PROVIDER=google requires GOOGLE_MAPS_API_KEY')
    }
    upstream = new GoogleRoutingProvider({ apiKey: options.apiKey })
  } else {
    upstream = new MockRoutingProvider()
  }

  return new CachingRoutingProvider(upstream, store)
}
