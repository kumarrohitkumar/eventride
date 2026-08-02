import type { DriverView, PlannedStop, RequestView } from '@eventride/shared'

/**
 * INV-1: seats and luggage are never exceeded at ANY point of a trip's stop sequence.
 *
 * This is a prefix sum over stop deltas — the exact formalisation of the invariant. It is used by
 * the engine when proposing, by the applier inside its transaction, and by the test suite, so a
 * single bug cannot produce a capacity violation (HLD §9).
 */
export interface InitialLoad {
  seats: number
  luggage: number
}

export function capacityOkAtEveryStop(
  stops: readonly PlannedStop[],
  d: Pick<DriverView, 'seatCapacity' | 'luggageCapacity'>,
  /**
   * Passengers already aboard. Non-zero for a trip in progress (FR-M18): their drop stops carry
   * negative deltas, so starting the prefix sum at zero would make a valid sequence look malformed.
   */
  initial: InitialLoad = { seats: 0, luggage: 0 },
): boolean {
  if (initial.seats > d.seatCapacity || initial.luggage > d.luggageCapacity) return false
  let seats = initial.seats
  let bags = initial.luggage
  for (const s of stops) {
    seats += s.seatsDelta
    bags += s.luggageDelta
    // Negative load means a drop without its pickup — a malformed sequence, not just over capacity.
    if (seats < 0 || bags < 0) return false
    if (seats > d.seatCapacity || bags > d.luggageCapacity) return false
  }
  return true
}

export interface LoadProfile {
  peakSeats: number
  peakLuggage: number
  endsEmpty: boolean
}

/** Peak occupancy over a stop sequence — used for diagnostics and utilisation metrics (G3). */
export function loadProfile(stops: readonly PlannedStop[]): LoadProfile {
  let seats = 0
  let bags = 0
  let peakSeats = 0
  let peakLuggage = 0
  for (const s of stops) {
    seats += s.seatsDelta
    bags += s.luggageDelta
    peakSeats = Math.max(peakSeats, seats)
    peakLuggage = Math.max(peakLuggage, bags)
  }
  return { peakSeats, peakLuggage, endsEmpty: seats === 0 && bags === 0 }
}

/**
 * Canonical stop sequence for one or more pooled requests: every pickup, then every drop.
 * Drop order follows pickup order, which keeps a 2-drop pooled trip (D23) trivially ordered
 * with no TSP step.
 */
export function buildStopsForRequests(requests: readonly RequestView[]): PlannedStop[] {
  const pickups: PlannedStop[] = requests.map((r) => ({
    kind: 'PICKUP',
    requestId: r.id,
    locationId: r.originId,
    at: r.origin,
    seatsDelta: r.groupSize,
    luggageDelta: r.luggageCount,
    state: 'PENDING',
  }))
  const drops: PlannedStop[] = requests.map((r) => ({
    kind: 'DROP',
    requestId: r.id,
    locationId: r.destinationId,
    at: r.destination,
    seatsDelta: -r.groupSize,
    luggageDelta: -r.luggageCount,
    state: 'PENDING',
  }))
  return [...pickups, ...drops]
}

/**
 * Stamp each stop with the time the driver is expected to reach it.
 *
 * Needed because a pooled trip drops guests at different times: a single trip-level drop time
 * cannot express whether an individual guest's deadline is met (FR-M10), and the applier writes
 * these onto trip_stop.planned_at for the driver and guest UIs.
 */
export function assignPlannedTimes(
  stops: readonly PlannedStop[],
  from: { lat: number; lng: number },
  startAt: Date,
  travel: { minutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number },
): PlannedStop[] {
  let cursor = startAt
  let position = from
  return stops.map((s) => {
    cursor = new Date(cursor.getTime() + travel.minutes(position, s.at) * 60_000)
    position = s.at
    return { ...s, plannedAt: cursor }
  })
}

/** Total travel time of a stop sequence starting from a given position. */
export function routeMinutes(
  from: { lat: number; lng: number },
  stops: readonly PlannedStop[],
  travel: { minutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number },
): number {
  let total = 0
  let cursor = from
  for (const s of stops) {
    total += travel.minutes(cursor, s.at)
    cursor = s.at
  }
  return total
}
