import type {
  ActiveTripView,
  DriverView,
  EventConfig,
  LatLng,
  PlannedStop,
  Rejection,
  RequestView,
  ScoreBreakdown,
  UnmatchedReason,
} from '@eventride/shared'

/**
 * Pre-resolved travel times (LLD §6.1). The engine is synchronous and does no I/O (HLD T15):
 * SnapshotBuilder resolves every distance the round could need *before* calling the engine.
 * `minutes()` must therefore always answer — the oracle falls back to a haversine estimate.
 */
export interface TravelOracle {
  minutes(from: LatLng, to: LatLng): number
  isEstimated(from: LatLng, to: LatLng): boolean
}

export interface Snapshot {
  now: Date
  config: EventConfig
  /** Assignable drivers plus drivers on trips (the latter only for detour insertion). */
  drivers: readonly DriverView[]
  /** QUEUED requests, plus UNMATCHED ones being retried. */
  requests: readonly RequestView[]
  /**
   * Not-yet-queued requests scheduled inside the reservation horizon (FR-M22).
   * The engine may hold a driver for one of these rather than send them on a long soft trip.
   */
  upcoming?: readonly RequestView[]
  activeTrips: readonly ActiveTripView[]
  /**
   * Allow chaining a new trip onto a driver who is still busy but has a known free time.
   *
   * FALSE for live rounds — INV-3 says a committed driver may only receive a detour insertion,
   * never a second independent trip, and offering one would be dropped by the applier anyway.
   * TRUE only for pre-day batch planning (FR-M1), where nobody is actually driving yet and
   * "predicted free at" is the whole basis of the plan.
   */
  allowCommittedDrivers?: boolean
  travel: TravelOracle
  /** Largest seat capacity in the whole fleet — used to decide when a group must be split. */
  fleetMaxSeats: number
  fleetMaxLuggage: number
}

export type Decision =
  | {
      kind: 'ASSIGN'
      driverId: string
      requestIds: string[]
      stops: PlannedStop[]
      score: ScoreBreakdown
      runnerUpDriverId?: string
      plannedPickupAt: Date
      plannedDropAt: Date
    }
  | {
      kind: 'INSERT_DETOUR'
      tripId: string
      driverId: string
      requestId: string
      position: number
      addedMinutes: number
      stops: PlannedStop[]
      score: ScoreBreakdown
    }
  | { kind: 'RESERVE'; driverId: string; requestId: string; untilAt: Date; reason: string }
  | { kind: 'SPLIT'; requestId: string; parts: { groupSize: number; luggageCount: number }[] }
  | { kind: 'UNMATCHED'; requestId: string; reason: UnmatchedReason }
  | { kind: 'SHORTFALL'; seatsShort: number; guestsAffected: number; horizonMin: number }

export interface RoundResult {
  decisions: Decision[]
  rejections: Rejection[]
  /** Requests that stayed queued while a lower-priority one was served (INV-4 bookkeeping). */
  passedOverRequestIds: string[]
  stats: {
    requestsConsidered: number
    driversConsidered: number
    assigned: number
    detours: number
    unmatched: number
    durationMs: number
  }
}
