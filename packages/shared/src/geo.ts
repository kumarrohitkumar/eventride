export interface LatLng {
  lat: number
  lng: number
}

const EARTH_RADIUS_KM = 6371

const toRad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in km. T5: at ≤100 drivers this replaces any spatial index. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Fallback travel estimate used when the routing API is unavailable (HLD §8.4, NFR-3 L1).
 * 1.4 road-winding factor over straight-line distance at 30 km/h urban average.
 */
export const ROAD_FACTOR = 1.4
export const URBAN_KMPH = 30

export function estimateMinutes(a: LatLng, b: LatLng): number {
  const km = haversineKm(a, b) * ROAD_FACTOR
  return Math.max(1, Math.round((km / URBAN_KMPH) * 60))
}

/** D23: two accommodations count as one destination cluster within this radius. */
export function isSameCluster(a: LatLng, b: LatLng, radiusKm: number): boolean {
  return haversineKm(a, b) <= radiusKm
}

/** Snap to a ~50 m grid so nearby lookups share one cache entry (HLD §8.2). */
export function snapToGrid(p: LatLng, meters = 50): string {
  const step = meters / 111_320 // degrees per metre at the equator, good enough for a cache key
  const lat = Math.round(p.lat / step) * step
  const lng = Math.round(p.lng / step) * step
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}
