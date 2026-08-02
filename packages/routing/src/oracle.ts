import { estimateMinutes, type LatLng } from '@eventride/shared'
import type { RoutingProvider } from './provider.js'

export interface TravelOracleLike {
  minutes(from: LatLng, to: LatLng): number
  isEstimated(from: LatLng, to: LatLng): boolean
}

const key = (p: LatLng): string => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
const pairKey = (a: LatLng, b: LatLng): string => `${key(a)}|${key(b)}`

/**
 * Builds the synchronous oracle the engine consumes (LLD §6.1).
 *
 * This is the boundary that keeps the engine pure (HLD T15): every distance a round could need is
 * resolved HERE, asynchronously and in one batched call, before the engine runs. `minutes()` always
 * answers — anything not pre-resolved degrades to a haversine estimate rather than throwing, so a
 * missing lookup can never crash a matching round.
 */
export async function buildTravelOracle(
  provider: RoutingProvider,
  pairs: readonly (readonly [LatLng, LatLng])[],
): Promise<TravelOracleLike> {
  const resolved = new Map<string, number>()
  const estimated = new Set<string>()

  if (pairs.length > 0) {
    const results = await provider.travelTimes(pairs)
    pairs.forEach((pair, i) => {
      const result = results[i]
      if (!result) return
      // Symmetric: A→B and B→A share an entry. Slightly lossy on one-way systems, and a deliberate
      // halving of API elements (NFR-4).
      resolved.set(pairKey(pair[0], pair[1]), result.minutes)
      resolved.set(pairKey(pair[1], pair[0]), result.minutes)
      if (result.estimated) {
        estimated.add(pairKey(pair[0], pair[1]))
        estimated.add(pairKey(pair[1], pair[0]))
      }
    })
  }

  return {
    minutes: (from, to) => {
      if (key(from) === key(to)) return 0
      return resolved.get(pairKey(from, to)) ?? estimateMinutes(from, to)
    },
    isEstimated: (from, to) =>
      !resolved.has(pairKey(from, to)) || estimated.has(pairKey(from, to)),
  }
}
