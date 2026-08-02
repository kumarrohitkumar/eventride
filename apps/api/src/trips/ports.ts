import type {
  Actor,
  BreakState,
  DriverState,
  RequestState,
  TripState,
  UnmatchedReason,
} from '@eventride/shared'

/**
 * Repository ports (hexagonal boundary). TripService depends on these interfaces, not on Prisma,
 * so the state machine and every invariant can be tested against an in-memory implementation with
 * no MySQL — and the Prisma implementation is then a thin, boring adapter.
 */

export interface RequestRecord {
  id: string
  guestId: string
  state: RequestState
  groupSize: number
  luggageCount: number
  readyAt: Date | null
  scheduledAt: Date | null
  deadlineAt: Date | null
  isHardDeadline: boolean
  passedOverCount: number
  requeueCount: number
  tripId: string | null
  originId: string
  originLat: number | null
  originLng: number | null
  destinationId: string
  unmatchedReason: UnmatchedReason | null
  declineReason: string | null
}

export interface DriverRecord {
  id: string
  state: DriverState
  seatCapacity: number
  luggageCapacity: number
  breakState: BreakState
  breakStartedAt: Date | null
  drivingMinutesToday: number
  tripsSinceBreak: number
  shiftStart: Date
  shiftEnd: Date
  lastLat: number | null
  lastLng: number | null
  lastLocationAt: Date | null
  predictedFreeAt: Date | null
  version: number
  unavailableReason: string | null
}

export interface TripStopRecord {
  id: string
  tripId: string
  seq: number
  kind: 'PICKUP' | 'DROP'
  requestId: string
  locationId: string
  lat: number
  lng: number
  state: 'PENDING' | 'ARRIVED' | 'DONE' | 'SKIPPED'
  plannedAt: Date | null
  arrivedAt: Date | null
  seatsDelta: number
  luggageDelta: number
}

export interface TripRecord {
  id: string
  driverId: string
  state: TripState
  offeredAt: Date | null
  offerExpiresAt: Date | null
  acceptedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  seatsUsed: number
  luggageUsed: number
  plannedPickupAt: Date | null
  plannedDropAt: Date | null
  isPinned: boolean
  overrideReason: string | null
  rejectReason: string | null
  version: number
}

export interface StatusEventRecord {
  entityType: 'request' | 'driver' | 'trip'
  entityId: string
  fromState: string | null
  toState: string
  actor: Actor
  actorUserId?: string | null
  reason?: string | null
  meta?: Record<string, unknown>
  at: Date
}

export interface Repositories {
  requests: {
    find(id: string): Promise<RequestRecord | null>
    update(id: string, patch: Partial<RequestRecord>): Promise<RequestRecord>
    findByTrip(tripId: string): Promise<RequestRecord[]>
  }
  drivers: {
    find(id: string): Promise<DriverRecord | null>
    update(id: string, patch: Partial<DriverRecord>): Promise<DriverRecord>
  }
  trips: {
    find(id: string): Promise<TripRecord | null>
    create(trip: Omit<TripRecord, 'version'>, stops: Omit<TripStopRecord, 'id'>[]): Promise<TripRecord>
    update(id: string, patch: Partial<TripRecord>): Promise<TripRecord>
    activeForDriver(driverId: string): Promise<TripRecord | null>
    stops(tripId: string): Promise<TripStopRecord[]>
    updateStop(id: string, patch: Partial<TripStopRecord>): Promise<TripStopRecord>
    replaceStops(tripId: string, stops: Omit<TripStopRecord, 'id'>[]): Promise<TripStopRecord[]>
  }
  audit: {
    append(event: StatusEventRecord): Promise<void>
  }
}

/** Domain errors carry the LLD §10 codes so the exception filter maps them to HTTP directly. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
