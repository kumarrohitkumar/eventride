import { describe, it, expect, vi } from 'vitest'
import { MockRoutingProvider } from './mock-provider.js'
import { GoogleRoutingProvider } from './google-provider.js'
import { CachingRoutingProvider, MemoryCacheStore } from './caching-provider.js'
import { buildTravelOracle } from './oracle.js'
import { createRoutingProvider } from './index.js'
import type { LatLng } from '@eventride/shared'

const AIRPORT: LatLng = { lat: 13.1986, lng: 77.7066 }
const HOTEL_A: LatLng = { lat: 12.9756, lng: 77.6068 }
const HOTEL_B: LatLng = { lat: 12.9856, lng: 77.6118 }
const VENUE: LatLng = { lat: 12.9611, lng: 77.6387 }

const okResponse = (seconds: number, count: number) => ({
  ok: true,
  json: async () => ({
    status: 'OK',
    rows: Array.from({ length: count }, () => ({
      elements: Array.from({ length: count }, () => ({
        status: 'OK',
        duration_in_traffic: { value: seconds },
      })),
    })),
  }),
})

describe('MockRoutingProvider (keyless default)', () => {
  it('returns plausible estimates flagged as estimated', async () => {
    const p = new MockRoutingProvider()
    const [result] = await p.travelTimes([[AIRPORT, HOTEL_A]])
    expect(result!.minutes).toBeGreaterThan(50)
    expect(result!.estimated).toBe(true)
  })

  it('is deterministic — identical inputs give identical outputs', async () => {
    const p = new MockRoutingProvider()
    const a = await p.travelTimes([[AIRPORT, HOTEL_A]])
    const b = await p.travelTimes([[AIRPORT, HOTEL_A]])
    expect(a).toEqual(b)
  })
})

describe('GoogleRoutingProvider (NFR-4 batching, NFR-3 L1 fallback)', () => {
  it('uses live traffic duration when available', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(1_800, 1))
    const p = new GoogleRoutingProvider({ apiKey: 'k', fetchImpl: fetchImpl as never })
    const [result] = await p.travelTimes([[AIRPORT, HOTEL_A]])
    expect(result).toEqual({ minutes: 30, estimated: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('departure_time=now')
  })

  it('batches 100 pairs into ONE request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(600, 100))
    const p = new GoogleRoutingProvider({ apiKey: 'k', fetchImpl: fetchImpl as never })
    const pairs = Array.from({ length: 100 }, () => [AIRPORT, HOTEL_A] as [LatLng, LatLng])
    await p.travelTimes(pairs)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('splits beyond the element cap into a second request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(600, 100))
    const p = new GoogleRoutingProvider({ apiKey: 'k', fetchImpl: fetchImpl as never })
    const pairs = Array.from({ length: 150 }, () => [AIRPORT, HOTEL_A] as [LatLng, LatLng])
    const results = await p.travelTimes(pairs)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(150)
  })

  it('falls back to an estimate on HTTP failure instead of throwing (L1)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const p = new GoogleRoutingProvider({ apiKey: 'k', fetchImpl: fetchImpl as never })
    const [result] = await p.travelTimes([[AIRPORT, HOTEL_A]])
    expect(result!.estimated).toBe(true)
    expect(result!.minutes).toBeGreaterThan(0)
  })

  it('falls back on a thrown network error — dispatch must not stop', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const p = new GoogleRoutingProvider({ apiKey: 'k', fetchImpl: fetchImpl as never })
    const [result] = await p.travelTimes([[AIRPORT, HOTEL_A]])
    expect(result!.estimated).toBe(true)
  })

  it('falls back when the API reports OVER_QUERY_LIMIT', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'OVER_QUERY_LIMIT' }) })
    const p = new GoogleRoutingProvider({ apiKey: 'k', fetchImpl: fetchImpl as never })
    const [result] = await p.travelTimes([[AIRPORT, HOTEL_A]])
    expect(result!.estimated).toBe(true)
  })
})

describe('CachingRoutingProvider (NFR-4 — the API budget made measurable)', () => {
  const build = () => {
    const upstream = new MockRoutingProvider()
    const spy = vi.spyOn(upstream, 'travelTimes')
    const provider = new CachingRoutingProvider(upstream, new MemoryCacheStore())
    return { provider, spy }
  }

  it('serves a repeated lookup from cache with no upstream call', async () => {
    const { provider, spy } = build()
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(provider.getMetrics().cacheHits).toBe(1)
  })

  it('shares one cache entry between drivers ~30 m apart (grid snapping)', async () => {
    const { provider, spy } = build()
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    const nudged = { lat: AIRPORT.lat + 0.00003, lng: AIRPORT.lng + 0.00002 }
    await provider.travelTimes([[nudged, HOTEL_A]])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('makes exactly ONE upstream call for a batch of misses', async () => {
    const { provider, spy } = build()
    await provider.travelTimes([
      [AIRPORT, HOTEL_A],
      [AIRPORT, HOTEL_B],
      [AIRPORT, VENUE],
      [HOTEL_A, VENUE],
      [HOTEL_B, VENUE],
    ])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(provider.getMetrics().apiCalls).toBe(1)
    expect(provider.getMetrics().elementsRequested).toBe(5)
  })

  it('pre-computes the whole POI matrix in one call (6 POIs → 30 elements → 1 call)', async () => {
    const { provider, spy } = build()
    const pois = [
      { id: 'air', at: AIRPORT },
      { id: 'stn', at: { lat: 12.9784, lng: 77.5726 } },
      { id: 'ven', at: VENUE },
      { id: 'hA', at: HOTEL_A },
      { id: 'hB', at: HOTEL_B },
      { id: 'hC', at: { lat: 13.0827, lng: 77.5106 } },
    ]
    const elements = await provider.warmStaticMatrix(pois)
    expect(elements).toBe(30) // 6 × 5 ordered pairs
    expect(spy).toHaveBeenCalledTimes(1)
    expect(provider.staticMinutes('air', 'hA')).toBeGreaterThan(0)
    expect(provider.staticMinutes('air', 'nope')).toBeNull()
  })

  it('separates cache entries across traffic buckets so ETAs stay fresh', async () => {
    const upstream = new MockRoutingProvider()
    const spy = vi.spyOn(upstream, 'travelTimes')
    let clock = new Date('2026-03-10T08:00:00Z')
    const provider = new CachingRoutingProvider(upstream, new MemoryCacheStore(), {
      now: () => clock,
      trafficBucketMinutes: 15,
      ttlSeconds: 3_600,
    })
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    clock = new Date('2026-03-10T08:20:00Z') // next bucket
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('reports metrics that CI can assert a ceiling against', async () => {
    const { provider } = build()
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    await provider.travelTimes([[AIRPORT, HOTEL_A]])
    const m = provider.getMetrics()
    expect(m).toMatchObject({ apiCalls: 1, elementsRequested: 2, cacheHits: 1, cacheMisses: 1 })
    provider.resetMetrics()
    expect(provider.getMetrics().apiCalls).toBe(0)
  })
})

describe('buildTravelOracle (the engine-purity boundary, HLD T15)', () => {
  it('answers synchronously from pre-resolved pairs', async () => {
    const provider = new MockRoutingProvider()
    const oracle = await buildTravelOracle(provider, [[AIRPORT, HOTEL_A]])
    expect(oracle.minutes(AIRPORT, HOTEL_A)).toBeGreaterThan(0)
  })

  it('is symmetric, halving the elements we pay for', async () => {
    const oracle = await buildTravelOracle(new MockRoutingProvider(), [[AIRPORT, HOTEL_A]])
    expect(oracle.minutes(HOTEL_A, AIRPORT)).toBe(oracle.minutes(AIRPORT, HOTEL_A))
  })

  it('returns 0 for the same point', async () => {
    const oracle = await buildTravelOracle(new MockRoutingProvider(), [])
    expect(oracle.minutes(AIRPORT, AIRPORT)).toBe(0)
  })

  it('NEVER throws for an unresolved pair — a missing lookup cannot crash a round', async () => {
    const oracle = await buildTravelOracle(new MockRoutingProvider(), [])
    expect(oracle.minutes(AIRPORT, VENUE)).toBeGreaterThan(0)
    expect(oracle.isEstimated(AIRPORT, VENUE)).toBe(true)
  })
})

describe('createRoutingProvider', () => {
  it('defaults to the keyless mock so the system runs with no credentials', async () => {
    const provider = createRoutingProvider({})
    expect(provider.name).toBe('caching(mock)')
    const [r] = await provider.travelTimes([[AIRPORT, HOTEL_A]])
    expect(r!.minutes).toBeGreaterThan(0)
  })

  it('fails loudly if google is selected without a key, rather than silently degrading', () => {
    expect(() => createRoutingProvider({ provider: 'google' })).toThrow(/GOOGLE_MAPS_API_KEY/)
  })

  it('wraps google in the caching layer when configured', () => {
    expect(createRoutingProvider({ provider: 'google', apiKey: 'k' }).name).toBe('caching(google)')
  })
})
