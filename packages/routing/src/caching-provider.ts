import { snapToGrid, type LatLng } from '@eventride/shared'
import type { RoutingMetrics, RoutingProvider, TravelResult } from './provider.js'

export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

/** In-process store used in tests and single-instance dev; Redis implements the same interface. */
export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>()
  constructor(private readonly clock: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    const hit = this.map.get(key)
    if (!hit) return null
    if (hit.expiresAt <= this.clock()) {
      // Kept rather than deleted: an expired entry is still useful when upstream is down (L1).
      return null
    }
    return hit.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, expiresAt: this.clock() + ttlSeconds * 1000 })
  }

  /** Stale read for the degraded path: better a 6-minute-old ETA than no ETA (NFR-3 L1). */
  async getStale(key: string): Promise<string | null> {
    return this.map.get(key)?.value ?? null
  }
}

export interface CachingOptions {
  ttlSeconds?: number
  /** Snap origins to a grid so nearby drivers share one entry (HLD §8.2). */
  gridMeters?: number
  /** Bucket width for the traffic-time component of the key. */
  trafficBucketMinutes?: number
  now?: () => Date
}

/**
 * Caching + metering decorator (HLD §8.1) — the component that makes NFR-4 a measured fact.
 *
 * Cache key = (origin snapped to ~50 m, destination snapped to ~50 m, 15-minute traffic bucket).
 * Two drivers 30 m and 3 minutes apart therefore share a single upstream lookup.
 */
export class CachingRoutingProvider implements RoutingProvider {
  readonly name: string
  private readonly ttl: number
  private readonly grid: number
  private readonly bucket: number
  private readonly now: () => Date
  private readonly staticMatrix = new Map<string, number>()

  private readonly metrics: RoutingMetrics = {
    apiCalls: 0,
    elementsRequested: 0,
    cacheHits: 0,
    cacheMisses: 0,
    estimatedFallbacks: 0,
  }

  constructor(
    private readonly upstream: RoutingProvider,
    private readonly store: CacheStore,
    options: CachingOptions = {},
  ) {
    this.name = `caching(${upstream.name})`
    this.ttl = options.ttlSeconds ?? 300
    this.grid = options.gridMeters ?? 50
    this.bucket = options.trafficBucketMinutes ?? 15
    this.now = options.now ?? (() => new Date())
  }

  getMetrics(): RoutingMetrics {
    return { ...this.metrics }
  }

  resetMetrics(): void {
    Object.assign(this.metrics, {
      apiCalls: 0,
      elementsRequested: 0,
      cacheHits: 0,
      cacheMisses: 0,
      estimatedFallbacks: 0,
    })
  }

  /**
   * Pre-computed POI×POI matrix (NFR-4): 6 POIs → 36 elements → ONE upstream request for the whole
   * event. Every airport/station/hotel/venue pair is free from then on, permanently.
   */
  async warmStaticMatrix(pois: readonly { id: string; at: LatLng }[]): Promise<number> {
    const pairs: [LatLng, LatLng][] = []
    const keys: string[] = []
    for (const a of pois) {
      for (const b of pois) {
        if (a.id === b.id) continue
        pairs.push([a.at, b.at])
        keys.push(`${a.id}->${b.id}`)
      }
    }
    if (pairs.length === 0) return 0
    this.metrics.apiCalls += 1
    this.metrics.elementsRequested += pairs.length
    const results = await this.upstream.travelTimes(pairs)
    results.forEach((r, i) => this.staticMatrix.set(keys[i]!, r.minutes))
    return pairs.length
  }

  staticMinutes(fromId: string, toId: string): number | null {
    return this.staticMatrix.get(`${fromId}->${toId}`) ?? null
  }

  private key(from: LatLng, to: LatLng): string {
    const minutes = this.now().getTime() / 60_000
    const trafficBucket = Math.floor(minutes / this.bucket)
    return `rt:${snapToGrid(from, this.grid)}:${snapToGrid(to, this.grid)}:${trafficBucket}`
  }

  async travelTimes(pairs: readonly (readonly [LatLng, LatLng])[]): Promise<TravelResult[]> {
    this.metrics.elementsRequested += pairs.length
    const results = new Array<TravelResult | undefined>(pairs.length)
    const misses: { index: number; pair: readonly [LatLng, LatLng]; key: string }[] = []

    await Promise.all(
      pairs.map(async (pair, index) => {
        const key = this.key(pair[0], pair[1])
        const cached = await this.store.get(key)
        if (cached !== null) {
          this.metrics.cacheHits += 1
          results[index] = JSON.parse(cached) as TravelResult
        } else {
          this.metrics.cacheMisses += 1
          misses.push({ index, pair, key })
        }
      }),
    )

    if (misses.length > 0) {
      // One upstream call for ALL misses — this is the batching NFR-4 requires.
      this.metrics.apiCalls += 1
      const fetched = await this.upstream.travelTimes(misses.map((m) => m.pair))
      await Promise.all(
        fetched.map(async (result, i) => {
          const miss = misses[i]!
          results[miss.index] = result
          if (result.estimated) this.metrics.estimatedFallbacks += 1
          await this.store.set(miss.key, JSON.stringify(result), this.ttl)
        }),
      )
    }

    return results.map((r) => r ?? { minutes: 1, estimated: true })
  }

  async routePolyline(from: LatLng, to: LatLng): Promise<string | null> {
    if (!this.upstream.routePolyline) return null
    const key = `poly:${snapToGrid(from, this.grid)}:${snapToGrid(to, this.grid)}`
    const cached = await this.store.get(key)
    if (cached !== null) {
      this.metrics.cacheHits += 1
      return cached === 'null' ? null : cached
    }
    this.metrics.cacheMisses += 1
    this.metrics.apiCalls += 1
    const polyline = await this.upstream.routePolyline(from, to)
    await this.store.set(key, polyline ?? 'null', this.ttl)
    return polyline
  }
}
