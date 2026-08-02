import {
  canTransitionRequest,
  TRIP_ACTIVE_STATES,
  type DriverState,
  type RequestState,
  type TripState,
} from '@eventride/shared'
import { capacityOkAtEveryStop, type Decision } from '@eventride/engine'

/**
 * Decision validation (HLD §4 rule 4, §9).
 *
 * The engine is trusted for QUALITY, never for CORRECTNESS. Between building a snapshot and
 * committing a decision, reality can move: the driver accepted another trip, went on break, or
 * broke down. Every decision is therefore re-checked inside the applier's transaction against
 * freshly-read rows, and a decision that no longer holds is SKIPPED and logged rather than forced.
 *
 * These checks are pure so they can be unit-tested without a database, and are the third of the
 * three places INV-1 is enforced (engine filter → here → DB constraint).
 */

export interface DriverRow {
  id: string
  state: DriverState
  seatCapacity: number
  luggageCapacity: number
  version: number
  breakState: 'NONE' | 'DUE' | 'ON_BREAK'
}

export interface RequestRow {
  id: string
  state: RequestState
  groupSize: number
  luggageCount: number
}

export interface TripRow {
  id: string
  driverId: string
  state: TripState
  isPinned: boolean
  seatsUsed: number
  luggageUsed: number
}

export interface WorldSlice {
  drivers: Map<string, DriverRow>
  requests: Map<string, RequestRow>
  trips: Map<string, TripRow>
}

export type SkipReason =
  | 'DRIVER_GONE'
  | 'DRIVER_NOT_AVAILABLE'
  | 'DRIVER_ON_BREAK'
  | 'REQUEST_GONE'
  | 'REQUEST_NOT_QUEUED'
  | 'ILLEGAL_TRANSITION'
  | 'CAPACITY_VIOLATION'
  | 'TRIP_GONE'
  | 'TRIP_NOT_ACTIVE'
  | 'TRIP_PINNED'

export type Validation = { ok: true } | { ok: false; reason: SkipReason; detail: string }

const ok: Validation = { ok: true }
const fail = (reason: SkipReason, detail: string): Validation => ({ ok: false, reason, detail })

export function validateDecision(decision: Decision, world: WorldSlice): Validation {
  switch (decision.kind) {
    case 'ASSIGN':
      return validateAssign(decision, world)
    case 'INSERT_DETOUR':
      return validateDetour(decision, world)
    case 'RESERVE':
      return world.drivers.has(decision.driverId) ? ok : fail('DRIVER_GONE', decision.driverId)
    case 'SPLIT':
      return world.requests.has(decision.requestId) ? ok : fail('REQUEST_GONE', decision.requestId)
    case 'UNMATCHED':
    case 'SHORTFALL':
      // Bookkeeping only — nothing to double-book, so nothing to re-validate.
      return ok
  }
}

function validateAssign(
  decision: Extract<Decision, { kind: 'ASSIGN' }>,
  world: WorldSlice,
): Validation {
  const driver = world.drivers.get(decision.driverId)
  if (!driver) return fail('DRIVER_GONE', decision.driverId)

  // INV-3/INV-5: only a genuinely free driver may be handed a new trip. The DB unique index on
  // the generated active_driver_id column is the last line of defence behind this check.
  if (driver.state !== 'AVAILABLE') {
    return fail('DRIVER_NOT_AVAILABLE', `${driver.id} is ${driver.state}`)
  }
  if (driver.breakState !== 'NONE') {
    return fail('DRIVER_ON_BREAK', `${driver.id} break=${driver.breakState}`)
  }

  for (const requestId of decision.requestIds) {
    const request = world.requests.get(requestId)
    if (!request) return fail('REQUEST_GONE', requestId)
    if (request.state !== 'QUEUED') {
      return fail('REQUEST_NOT_QUEUED', `${requestId} is ${request.state}`)
    }
    if (!canTransitionRequest(request.state, 'ASSIGNED')) {
      return fail('ILLEGAL_TRANSITION', `${requestId}: ${request.state} → ASSIGNED`)
    }
  }

  // INV-1, re-checked against the rows we just read rather than the snapshot's copy.
  if (!capacityOkAtEveryStop(decision.stops, driver)) {
    return fail('CAPACITY_VIOLATION', `${driver.id} cannot carry this stop sequence`)
  }

  return ok
}

function validateDetour(
  decision: Extract<Decision, { kind: 'INSERT_DETOUR' }>,
  world: WorldSlice,
): Validation {
  const trip = world.trips.get(decision.tripId)
  if (!trip) return fail('TRIP_GONE', decision.tripId)
  if (!TRIP_ACTIVE_STATES.includes(trip.state)) {
    return fail('TRIP_NOT_ACTIVE', `${trip.id} is ${trip.state}`)
  }
  // E16: an admin override pins a trip, and the engine must not undo a human's decision.
  if (trip.isPinned) return fail('TRIP_PINNED', trip.id)

  const driver = world.drivers.get(decision.driverId)
  if (!driver) return fail('DRIVER_GONE', decision.driverId)

  const request = world.requests.get(decision.requestId)
  if (!request) return fail('REQUEST_GONE', decision.requestId)
  if (request.state !== 'QUEUED') {
    return fail('REQUEST_NOT_QUEUED', `${request.id} is ${request.state}`)
  }

  // The onboard load is the starting point: the remaining stops carry negative deltas for guests
  // who are already in the vehicle.
  const withinCapacity = capacityOkAtEveryStop(decision.stops, driver, {
    seats: trip.seatsUsed,
    luggage: trip.luggageUsed,
  })
  if (!withinCapacity) return fail('CAPACITY_VIOLATION', `${trip.id} + ${request.id}`)

  return ok
}

export interface ApplyOutcome {
  applied: Decision[]
  skipped: { decision: Decision; reason: SkipReason; detail: string }[]
}

/**
 * Partition a round's decisions into those still valid and those reality has overtaken.
 *
 * Skips are returned rather than thrown: one stale decision must never abort a round, and the
 * skipped ones are logged so "why wasn't this guest assigned" always has an answer (FR-M23).
 */
export function partitionDecisions(decisions: readonly Decision[], world: WorldSlice): ApplyOutcome {
  const outcome: ApplyOutcome = { applied: [], skipped: [] }

  for (const decision of decisions) {
    const result = validateDecision(decision, world)
    if (result.ok) {
      outcome.applied.push(decision)
      // Reserve the driver within this batch so two decisions in the SAME round cannot both
      // claim them — the in-memory equivalent of the row lock the transaction takes.
      if (decision.kind === 'ASSIGN') {
        const driver = world.drivers.get(decision.driverId)
        if (driver) driver.state = 'OFFERED'
        for (const id of decision.requestIds) {
          const request = world.requests.get(id)
          if (request) request.state = 'ASSIGNED'
        }
      }
    } else {
      outcome.skipped.push({ decision, reason: result.reason, detail: result.detail })
    }
  }

  return outcome
}
