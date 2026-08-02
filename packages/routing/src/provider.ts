import type { LatLng } from '@eventride/shared'

export interface TravelResult {
  minutes: number
  /** True when this came from a fallback estimate rather than live routing (NFR-3 L1). */
  estimated: boolean
}

/**
 * The only interface the rest of the system knows about (HLD T11, D34).
 * Swapping vendors, adding caching or metering, and running tests with zero API spend are all
 * done by composing implementations of this one interface.
 */
export interface RoutingProvider {
  /** Travel time for a batch of origin→destination pairs. Batched because vendors bill per element. */
  travelTimes(pairs: readonly (readonly [LatLng, LatLng])[]): Promise<TravelResult[]>
  /** Encoded polyline for drawing a route, fetched once per trip and cached (NFR-4). */
  routePolyline?(from: LatLng, to: LatLng): Promise<string | null>
  readonly name: string
}

export interface RoutingMetrics {
  /** Upstream API calls actually made — the number NFR-4 caps and CI asserts. */
  apiCalls: number
  /** Individual origin→destination lookups requested by the application. */
  elementsRequested: number
  cacheHits: number
  cacheMisses: number
  estimatedFallbacks: number
}
