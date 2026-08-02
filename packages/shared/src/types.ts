import type { LatLng } from './geo.js'
import type {
  BreakState,
  DriverState,
  RequestSource,
  RequestState,
  StopKind,
  StopState,
  TripType,
  UnmatchedReason,
} from './enums.js'

/**
 * Views the engine consumes (LLD §6.1). These are deliberately flat, plain data:
 * the engine must never hold a Prisma entity, a Date-less string, or anything with behaviour.
 */

export interface DriverView {
  id: string
  name: string
  vehicleNumber: string
  seatCapacity: number
  luggageCapacity: number
  state: DriverState
  breakState: BreakState
  shiftStart: Date
  shiftEnd: Date
  /** Where the driver will be when free — current position if idle, last drop if busy. */
  freeLocation: LatLng
  /** null ⇒ free right now. */
  predictedFreeAt: Date | null
  drivingMinutesToday: number
  tripsSinceBreak: number
  /** Requests this driver was recently offered and rejected (D14 cooldown). */
  cooldownRequestIds: readonly string[]
  /** Set when the driver is mid-trip — the live position used for detour insertion (FR-M18). */
  livePosition?: LatLng | null
}

export interface RequestView {
  id: string
  guestId: string
  guestName: string
  tripType: TripType
  source: RequestSource
  state: RequestState
  origin: LatLng
  originId: string
  destination: LatLng
  destinationId: string
  groupSize: number
  luggageCount: number
  isVip: boolean
  isHardDeadline: boolean
  deadlineAt: Date | null
  readyAt: Date | null
  scheduledAt: Date | null
  createdAt: Date
  passedOverCount: number
  groupRef: string | null
  waveId: string | null
}

export interface PlannedStop {
  kind: StopKind
  requestId: string
  locationId: string
  at: LatLng
  seatsDelta: number
  luggageDelta: number
  state?: StopState
  plannedAt?: Date | null
}

export interface ActiveTripView {
  id: string
  driverId: string
  /** Only stops not yet completed — insertion may only happen after the live position. */
  remainingStops: PlannedStop[]
  requestIds: readonly string[]
  seatsUsed: number
  luggageUsed: number
  isPinned: boolean
  /** Deadlines of guests already committed to this trip, used by FR-M13. */
  committedDeadlines: readonly { requestId: string; deadlineAt: Date | null }[]
}

export interface ScoreBreakdown {
  total: number
  parts: Record<string, number>
}

export interface Rejection {
  requestId: string
  driverId: string
  reason: UnmatchedReason
}
