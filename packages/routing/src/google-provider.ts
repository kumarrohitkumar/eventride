import { estimateMinutes, type LatLng } from '@eventride/shared'
import type { RoutingProvider, TravelResult } from './provider.js'

/** Google Distance Matrix bills per element; 25 origins × 25 destinations is the documented cap. */
const MAX_ELEMENTS_PER_REQUEST = 100

export interface GoogleProviderOptions {
  apiKey: string
  /** Injected so tests can assert batching without touching the network. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface DistanceMatrixResponse {
  status: string
  rows?: {
    elements?: { status: string; duration_in_traffic?: { value: number }; duration?: { value: number } }[]
  }[]
}

/**
 * Live-traffic provider (NFR-4). Three cost-control behaviours are built in:
 *  - requests are batched up to the vendor element cap,
 *  - `duration_in_traffic` is requested with `departure_time=now` so ETAs reflect real conditions,
 *  - any failure degrades to a haversine estimate flagged `estimated` rather than throwing,
 *    which is what keeps dispatch running during an outage (NFR-3 L1).
 */
export class GoogleRoutingProvider implements RoutingProvider {
  readonly name = 'google'
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: GoogleProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  async travelTimes(pairs: readonly (readonly [LatLng, LatLng])[]): Promise<TravelResult[]> {
    const results: TravelResult[] = []
    for (let i = 0; i < pairs.length; i += MAX_ELEMENTS_PER_REQUEST) {
      const chunk = pairs.slice(i, i + MAX_ELEMENTS_PER_REQUEST)
      results.push(...(await this.fetchChunk(chunk)))
    }
    return results
  }

  private async fetchChunk(
    chunk: readonly (readonly [LatLng, LatLng])[],
  ): Promise<TravelResult[]> {
    const origins = chunk.map(([from]) => `${from.lat},${from.lng}`).join('|')
    const destinations = chunk.map(([, to]) => `${to.lat},${to.lng}`).join('|')
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${encodeURIComponent(origins)}` +
      `&destinations=${encodeURIComponent(destinations)}` +
      `&departure_time=now&traffic_model=best_guess&mode=driving` +
      `&key=${this.options.apiKey}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (!response.ok) return this.fallback(chunk)
      const body = (await response.json()) as DistanceMatrixResponse
      if (body.status !== 'OK') return this.fallback(chunk)

      // Origins and destinations are paired positionally, so we read the diagonal.
      return chunk.map(([from, to], index) => {
        const element = body.rows?.[index]?.elements?.[index]
        const seconds = element?.duration_in_traffic?.value ?? element?.duration?.value
        if (element?.status !== 'OK' || seconds === undefined) {
          return { minutes: estimateMinutes(from, to), estimated: true }
        }
        return { minutes: Math.max(1, Math.round(seconds / 60)), estimated: false }
      })
    } catch {
      // Timeout, DNS failure, quota exhaustion — dispatch must keep working (NFR-3 L1).
      return this.fallback(chunk)
    } finally {
      clearTimeout(timer)
    }
  }

  private fallback(chunk: readonly (readonly [LatLng, LatLng])[]): TravelResult[] {
    return chunk.map(([from, to]) => ({ minutes: estimateMinutes(from, to), estimated: true }))
  }

  async routePolyline(from: LatLng, to: LatLng): Promise<string | null> {
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}` +
      `&departure_time=now&mode=driving&key=${this.options.apiKey}`
    try {
      const response = await this.fetchImpl(url)
      if (!response.ok) return null
      const body = (await response.json()) as {
        status: string
        routes?: { overview_polyline?: { points?: string } }[]
      }
      if (body.status !== 'OK') return null
      return body.routes?.[0]?.overview_polyline?.points ?? null
    } catch {
      return null
    }
  }
}
