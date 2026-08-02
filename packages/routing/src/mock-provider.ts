import { estimateMinutes, type LatLng } from '@eventride/shared'
import type { RoutingProvider, TravelResult } from './provider.js'

/**
 * Keyless, deterministic provider used by every test and by the peak simulation (HLD T11, D34).
 *
 * This is why a reviewer can clone the repo with no Google account and still run the whole system,
 * and why CI costs nothing. Same maths as the L1 degradation fallback, so the fallback path is
 * exercised constantly rather than only during an outage.
 */
export class MockRoutingProvider implements RoutingProvider {
  readonly name = 'mock'

  constructor(
    /** Optional fixed overrides, keyed "lat,lng|lat,lng", for scripted scenarios. */
    private readonly overrides = new Map<string, number>(),
  ) {}

  async travelTimes(pairs: readonly (readonly [LatLng, LatLng])[]): Promise<TravelResult[]> {
    return pairs.map(([from, to]) => {
      const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`
      const override = this.overrides.get(key)
      return override !== undefined
        ? { minutes: override, estimated: false }
        : { minutes: estimateMinutes(from, to), estimated: true }
    })
  }

  async routePolyline(): Promise<string | null> {
    return null // no geometry without a real provider; the UI falls back to a straight line
  }
}
