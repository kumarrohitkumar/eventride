import {
  addMinutes,
  haversineKm,
  isSameCluster,
  minutesBetween,
  type DriverView,
  type PlannedStop,
  type RequestView,
} from '@eventride/shared'
import { capacityOkAtEveryStop, routeMinutes } from './capacity.js'
import type { Snapshot } from './types.js'

export interface PlannedTrip {
  driverId: string
  requests: RequestView[]
  stops: PlannedStop[]
  plannedPickupAt: Date
  plannedDropAt: Date
}

export type PoolRefusal =
  | 'VIP_NEVER_POOLED'
  | 'DIFFERENT_PICKUP_POINT'
  | 'OUTSIDE_TIME_WINDOW'
  | 'DIFFERENT_DESTINATION_CLUSTER'
  | 'TOO_MANY_DROP_STOPS'
  | 'CAPACITY'
  | 'ADDED_DELAY_TOO_HIGH'
  | 'DEADLINE_BREACH'

/** Distinct drop locations in a stop sequence — capped at pool_max_drop_stops (D23). */
export function dropStopCount(stops: readonly PlannedStop[]): number {
  return new Set(stops.filter((s) => s.kind === 'DROP').map((s) => s.locationId)).size
}

/**
 * Can these two requests share a vehicle? (FR-M15, D23)
 *
 * Deliberately strict: same pickup point, close in time, and destinations in one cluster.
 * Capping drop stops at 2 is what keeps stop ordering trivial — no travelling-salesman step —
 * while still demonstrating real multi-accommodation handling (E11).
 */
export function canPoolTogether(
  a: RequestView,
  b: RequestView,
  s: Snapshot,
): PoolRefusal | null {
  const c = s.config

  // D12/D23: a VIP gets a dedicated vehicle. Checked first — it is a policy rule, not a geometry one.
  if (a.isVip || b.isVip) return 'VIP_NEVER_POOLED'

  if (a.originId !== b.originId && haversineKm(a.origin, b.origin) > 0.2) {
    return 'DIFFERENT_PICKUP_POINT'
  }

  const aTime = a.readyAt ?? a.scheduledAt ?? a.createdAt
  const bTime = b.readyAt ?? b.scheduledAt ?? b.createdAt
  if (Math.abs(minutesBetween(aTime, bTime)) > c.pool_time_window_min) return 'OUTSIDE_TIME_WINDOW'

  if (
    a.destinationId !== b.destinationId &&
    !isSameCluster(a.destination, b.destination, c.pool_cluster_radius_km)
  ) {
    return 'DIFFERENT_DESTINATION_CLUSTER'
  }

  return null
}

/**
 * Attempt to add `r` to an already-planned trip (FR-M15).
 * Returns the extended trip, or the typed reason it was refused.
 */
export function tryAddToTrip(
  trip: PlannedTrip,
  r: RequestView,
  d: DriverView,
  s: Snapshot,
): { ok: true; trip: PlannedTrip; addedMinutes: number } | { ok: false; refusal: PoolRefusal } {
  const c = s.config

  for (const existing of trip.requests) {
    const refusal = canPoolTogether(existing, r, s)
    if (refusal) return { ok: false, refusal }
  }

  // All pickups then all drops, drops in pickup order — see buildStopsForRequests.
  const pickups = [...trip.stops.filter((x) => x.kind === 'PICKUP')]
  const drops = [...trip.stops.filter((x) => x.kind === 'DROP')]
  const candidate: PlannedStop[] = [
    ...pickups,
    {
      kind: 'PICKUP',
      requestId: r.id,
      locationId: r.originId,
      at: r.origin,
      seatsDelta: r.groupSize,
      luggageDelta: r.luggageCount,
      state: 'PENDING',
    },
    ...drops,
    {
      kind: 'DROP',
      requestId: r.id,
      locationId: r.destinationId,
      at: r.destination,
      seatsDelta: -r.groupSize,
      luggageDelta: -r.luggageCount,
      state: 'PENDING',
    },
  ]

  if (dropStopCount(candidate) > c.pool_max_drop_stops) {
    return { ok: false, refusal: 'TOO_MANY_DROP_STOPS' }
  }
  if (!capacityOkAtEveryStop(candidate, d)) return { ok: false, refusal: 'CAPACITY' }

  const before = routeMinutes(d.freeLocation, trip.stops, s.travel)
  const after = routeMinutes(d.freeLocation, candidate, s.travel)
  const addedMinutes = after - before

  // FR-M13: nobody already committed absorbs more than the configured detour.
  if (addedMinutes > c.detour_max_added_min) {
    return { ok: false, refusal: 'ADDED_DELAY_TOO_HIGH' }
  }

  // FR-M13: and no committed guest may be pushed past a hard deadline.
  // The driver reaches the FIRST stop at plannedPickupAt, so timing walks from there — adding the
  // deadhead again would inflate every projected drop time.
  const first = candidate[0]
  if (!first) return { ok: false, refusal: 'CAPACITY' }
  let cursor = trip.plannedPickupAt
  let position = first.at
  for (const stop of candidate.slice(1)) {
    cursor = addMinutes(cursor, s.travel.minutes(position, stop.at))
    position = stop.at
    if (stop.kind !== 'DROP') continue
    const req = [...trip.requests, r].find((x) => x.id === stop.requestId)
    if (req?.isHardDeadline && req.deadlineAt && cursor.getTime() > req.deadlineAt.getTime()) {
      return { ok: false, refusal: 'DEADLINE_BREACH' }
    }
  }

  return {
    ok: true,
    addedMinutes,
    trip: {
      ...trip,
      requests: [...trip.requests, r],
      stops: candidate,
      plannedDropAt: addMinutes(trip.plannedPickupAt, after),
    },
  }
}
