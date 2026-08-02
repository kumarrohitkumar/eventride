import { addMinutes, type EventConfig } from '@eventride/shared'

/**
 * Wave dispatch for the venue surge (FR-M4…M8, PRD D2).
 *
 * 200 guests going to one venue in one 30-minute window is a SHUTTLE problem, not 200 hails.
 * The key design decision: a wave is a TAG (`waveId`) on ordinary TripRequests — not a new entity
 * and not a second pipeline. Everything downstream (priority, bundling, capacity, assignment) is
 * the code that already exists and is already tested.
 */

export interface WavePlanInput {
  eventDay: Date
  /** Accommodations guests are departing from. */
  origins: { id: string; guestCount: number }[]
  destinationId: string
  /** Session start — the last wave must land before this, minus the venue buffer. */
  sessionStartsAt: Date
  /** Minutes between waves from the same accommodation. */
  headwayMin?: number
  waveCount?: number
  config: EventConfig
}

export interface PlannedWave {
  originId: string
  destinationId: string
  departsAt: Date
  seatsNeeded: number
}

/**
 * Generate the TO_VENUE waves for one event day (FR-M5).
 * Waves are spaced backwards from the latest safe departure so the LAST wave still arrives before
 * the session, rather than forwards from an arbitrary start.
 */
export function planVenueWaves(input: WavePlanInput): PlannedWave[] {
  const { origins, destinationId, sessionStartsAt, config } = input
  const headwayMin = input.headwayMin ?? 30
  const waveCount = input.waveCount ?? 3
  if (waveCount < 1) return []

  // Latest a wave may leave: session start − venue buffer. Earlier waves step back by the headway.
  const latestDeparture = addMinutes(sessionStartsAt, -config.venue_arrival_buffer_min)

  const waves: PlannedWave[] = []
  for (const origin of origins) {
    if (origin.guestCount <= 0) continue
    // Spread this accommodation's guests evenly across its waves.
    const perWave = Math.ceil(origin.guestCount / waveCount)
    let remaining = origin.guestCount

    for (let i = waveCount - 1; i >= 0; i--) {
      const seats = Math.min(perWave, remaining)
      if (seats <= 0) continue
      remaining -= seats
      waves.push({
        originId: origin.id,
        destinationId,
        departsAt: addMinutes(latestDeparture, -headwayMin * i),
        seatsNeeded: seats,
      })
    }
  }

  return waves.sort((a, b) => a.departsAt.getTime() - b.departsAt.getTime())
}

/**
 * How many vehicles a wave needs, largest-first (FR-M6).
 * Returns the chosen vehicles and any seat shortfall, so ops gets a quantified escalation
 * (FR-M17) instead of a silent under-service.
 */
export function allocateVehiclesForWave(
  seatsNeeded: number,
  availableVehicles: readonly { id: string; seatCapacity: number }[],
): { chosen: string[]; seatsCovered: number; seatsShort: number } {
  const byLargest = [...availableVehicles].sort(
    (a, b) => b.seatCapacity - a.seatCapacity || a.id.localeCompare(b.id),
  )

  const chosen: string[] = []
  let covered = 0
  for (const vehicle of byLargest) {
    if (covered >= seatsNeeded) break
    chosen.push(vehicle.id)
    covered += vehicle.seatCapacity
  }

  return { chosen, seatsCovered: covered, seatsShort: Math.max(0, seatsNeeded - covered) }
}

/**
 * FR-M7: FROM_VENUE is guest-PULL, not schedule-push — sessions never end on time. Guests tap
 * "ready to leave" and are pooled by accommodation over a rolling window.
 */
export function groupReturnRequests<T extends { destinationId: string; readyAt: Date }>(
  requests: readonly T[],
  now: Date,
  windowMin = 10,
): Map<string, T[]> {
  // Grouped by a ROLLING window, not by fixed time buckets. Fixed buckets split guests who are
  // seconds apart whenever they straddle a boundary — exactly the guests who should share a car.
  const byDestination = new Map<string, T[]>()
  for (const request of requests) {
    if (request.readyAt.getTime() > now.getTime()) continue // not ready yet
    const existing = byDestination.get(request.destinationId)
    if (existing) existing.push(request)
    else byDestination.set(request.destinationId, [request])
  }

  const groups = new Map<string, T[]>()
  for (const [destinationId, members] of byDestination) {
    const ordered = [...members].sort((a, b) => a.readyAt.getTime() - b.readyAt.getTime())
    let groupIndex = 0
    let current: T[] = []
    let anchor: Date | null = null

    for (const request of ordered) {
      if (anchor === null || (request.readyAt.getTime() - anchor.getTime()) / 60_000 <= windowMin) {
        if (anchor === null) anchor = request.readyAt
        current.push(request)
      } else {
        groups.set(`${destinationId}:${groupIndex++}`, current)
        current = [request]
        anchor = request.readyAt
      }
    }
    if (current.length > 0) groups.set(`${destinationId}:${groupIndex}`, current)
  }

  return groups
}

/** FR-M8: a guest who misses their wave falls back to ordinary individual matching. */
export function hasMissedWave(waveDepartsAt: Date, now: Date, graceMin = 5): boolean {
  return now.getTime() > addMinutes(waveDepartsAt, graceMin).getTime()
}
