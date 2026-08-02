import {
  addMinutes,
  type ActiveTripView,
  type DriverView,
  type PlannedStop,
  type RequestView,
} from '@eventride/shared'
import { capacityOkAtEveryStop, routeMinutes } from './capacity.js'
import { scorePair } from './score.js'
import type { Snapshot } from './types.js'

export interface DetourOption {
  tripId: string
  driverId: string
  requestId: string
  position: number
  addedMinutes: number
  stops: PlannedStop[]
  scoreTotal: number
}

/**
 * Opportunistic detour insertion (FR-M18, E12) — applies to trips ALREADY IN PROGRESS.
 *
 * Uses the driver's live position, and only considers insertion points after it, so a vehicle
 * that has already passed a location is never asked to double back. Cheapest-insertion, bounded by
 * D24 (one inserted stop per trip) which keeps the search a linear scan over remaining stops —
 * cheap enough to run for every active trip on every 90-second tick.
 */
export function findBestDetour(
  trip: ActiveTripView,
  driver: DriverView,
  request: RequestView,
  s: Snapshot,
): DetourOption | null {
  // E16: an admin-pinned trip is never modified by the engine.
  if (trip.isPinned) return null

  // A VIP's vehicle stays dedicated (D12), in both directions.
  if (request.isVip) return null

  const c = s.config
  const from = driver.livePosition ?? driver.freeLocation
  const remaining = trip.remainingStops.filter((st) => st.state !== 'DONE')
  if (remaining.length === 0) return null

  const baselineMinutes = routeMinutes(from, remaining, s.travel)

  const pickup: PlannedStop = {
    kind: 'PICKUP',
    requestId: request.id,
    locationId: request.originId,
    at: request.origin,
    seatsDelta: request.groupSize,
    luggageDelta: request.luggageCount,
    state: 'PENDING',
  }
  const drop: PlannedStop = {
    kind: 'DROP',
    requestId: request.id,
    locationId: request.destinationId,
    at: request.destination,
    seatsDelta: -request.groupSize,
    luggageDelta: -request.luggageCount,
    state: 'PENDING',
  }

  // Fast reject: is there even room alongside the guests already aboard?
  if (driver.seatCapacity - trip.seatsUsed < request.groupSize) return null
  if (driver.luggageCapacity - trip.luggageUsed < request.luggageCount) return null

  // The full sequence is then validated against full capacity starting from the current load,
  // because the onboard guests' drop stops carry negative deltas.
  const initialLoad = { seats: trip.seatsUsed, luggage: trip.luggageUsed }

  let best: DetourOption | null = null

  for (let pickupPos = 0; pickupPos <= remaining.length; pickupPos++) {
    for (let dropPos = pickupPos + 1; dropPos <= remaining.length + 1; dropPos++) {
      const candidate = [...remaining]
      candidate.splice(pickupPos, 0, pickup)
      candidate.splice(dropPos, 0, drop)

      if (!capacityOkAtEveryStop(candidate, driver, initialLoad)) continue

      const addedMinutes = routeMinutes(from, candidate, s.travel) - baselineMinutes

      // FR-M13: hard cap on what an already-onboard guest is asked to absorb.
      if (addedMinutes > c.detour_max_added_min) continue

      if (breachesCommittedDeadline(candidate, trip, s, from)) continue

      const scoreTotal =
        scorePair(driver, request, s, {
          poolsWithCluster: true,
          addedDelayToCommittedMin: addedMinutes,
        }).total + addedMinutes

      if (!best || scoreTotal < best.scoreTotal) {
        best = {
          tripId: trip.id,
          driverId: driver.id,
          requestId: request.id,
          position: pickupPos,
          addedMinutes,
          stops: candidate,
          scoreTotal,
        }
      }
    }
  }

  return best
}

/** FR-M13: no guest already committed to this trip may be pushed past their deadline. */
function breachesCommittedDeadline(
  candidate: readonly PlannedStop[],
  trip: ActiveTripView,
  s: Snapshot,
  from: { lat: number; lng: number },
): boolean {
  const deadlines = new Map(
    trip.committedDeadlines
      .filter((d) => d.deadlineAt !== null)
      .map((d) => [d.requestId, d.deadlineAt as Date]),
  )
  if (deadlines.size === 0) return false

  let cursor = s.now
  let position = from
  for (const stop of candidate) {
    cursor = addMinutes(cursor, s.travel.minutes(position, stop.at))
    position = stop.at
    if (stop.kind !== 'DROP') continue
    const deadline = deadlines.get(stop.requestId)
    if (deadline && cursor.getTime() > deadline.getTime()) return true
  }
  return false
}

/**
 * Best detour across all active trips for one request. Evaluated before new assignments in a round
 * (LLD §6.9): using a vehicle already going that way beats starting a fresh deadhead trip for both
 * guest wait (G1) and driver idleness (G2).
 */
export function findBestDetourAcrossTrips(
  request: RequestView,
  s: Snapshot,
): DetourOption | null {
  const driversById = new Map(s.drivers.map((d) => [d.id, d]))
  let best: DetourOption | null = null

  for (const trip of s.activeTrips) {
    const driver = driversById.get(trip.driverId)
    if (!driver) continue
    if (driver.state === 'UNAVAILABLE' || driver.state === 'OFFLINE') continue
    const option = findBestDetour(trip, driver, request, s)
    if (option && (!best || option.scoreTotal < best.scoreTotal)) best = option
  }
  return best
}
