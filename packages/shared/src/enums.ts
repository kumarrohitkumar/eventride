/**
 * Single source of truth for every enumerated value in the system (LLD §1).
 * Backend, both mobile apps, the engine and the simulator all import from here,
 * so they are physically incapable of disagreeing about legal values.
 */

export const ROLES = ['ADMIN', 'DRIVER', 'GUEST'] as const
export type Role = (typeof ROLES)[number]

export const LOCATION_TYPES = ['AIRPORT', 'STATION', 'ACCOMMODATION', 'VENUE', 'CUSTOM'] as const
export type LocationType = (typeof LOCATION_TYPES)[number]

export const TRIP_TYPES = ['ARRIVAL', 'TO_VENUE', 'FROM_VENUE', 'DEPARTURE', 'AD_HOC'] as const
export type TripType = (typeof TRIP_TYPES)[number]

/** Trip types with a hard deadline (PRD §6.2). Missing these is never allowed silently. */
export const HARD_DEADLINE_TRIP_TYPES: readonly TripType[] = ['TO_VENUE', 'DEPARTURE']

export const REQUEST_SOURCES = ['SCHEDULED', 'WAVE', 'ON_DEMAND'] as const
export type RequestSource = (typeof REQUEST_SOURCES)[number]

export const REQUEST_STATES = [
  'REGISTERED',
  'PENDING_APPROVAL',
  'APPROVED',
  'DECLINED',
  'QUEUED',
  'ASSIGNED',
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED_PICKUP',
  'BOARDED',
  'COMPLETED',
  'UNMATCHED',
  'NO_SHOW',
  'CANCELLED',
] as const
export type RequestState = (typeof REQUEST_STATES)[number]

export const DRIVER_STATES = [
  'OFFLINE',
  'AVAILABLE',
  'OFFERED',
  'EN_ROUTE_TO_PICKUP',
  'AT_PICKUP',
  'ON_TRIP',
  'ON_BREAK',
  'UNAVAILABLE',
] as const
export type DriverState = (typeof DRIVER_STATES)[number]

/**
 * Driver states that mean "already committed to a trip".
 * INV-3: such a driver is never offered a new independent trip — only a detour insertion.
 */
export const DRIVER_COMMITTED_STATES: readonly DriverState[] = [
  'OFFERED',
  'EN_ROUTE_TO_PICKUP',
  'AT_PICKUP',
  'ON_TRIP',
]

export const TRIP_STATES = [
  'OFFERED',
  'ACCEPTED',
  'EN_ROUTE',
  'AT_PICKUP',
  'ON_TRIP',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const
export type TripState = (typeof TRIP_STATES)[number]

/**
 * Trip states that occupy a driver. Backed by a UNIQUE index on the generated column
 * `active_driver_id` in MySQL, which is what enforces INV-5 in the database (HLD §2.2).
 */
export const TRIP_ACTIVE_STATES: readonly TripState[] = [
  'OFFERED',
  'ACCEPTED',
  'EN_ROUTE',
  'AT_PICKUP',
  'ON_TRIP',
]

export const STOP_KINDS = ['PICKUP', 'DROP'] as const
export type StopKind = (typeof STOP_KINDS)[number]

export const STOP_STATES = ['PENDING', 'ARRIVED', 'DONE', 'SKIPPED'] as const
export type StopState = (typeof STOP_STATES)[number]

export const ACTORS = ['ENGINE', 'ADMIN', 'DRIVER', 'GUEST', 'SYSTEM'] as const
export type Actor = (typeof ACTORS)[number]

export const BREAK_STATES = ['NONE', 'DUE', 'ON_BREAK'] as const
export type BreakState = (typeof BREAK_STATES)[number]

/** Typed reasons — FR-A11 requires every non-assignment to be explainable. */
export const UNMATCHED_REASONS = [
  'NO_DRIVER_ONLINE',
  'ALL_DRIVERS_BUSY',
  'NO_CAPACITY',
  'DEADLINE_INFEASIBLE',
  'ALL_DRIVERS_ON_BREAK',
  'GROUP_TOO_LARGE',
  'OUTSIDE_SHIFT_HOURS',
  'COOLDOWN_ONLY_CANDIDATES',
] as const
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number]

export const ALERT_TYPES = [
  'WAIT_WARN',
  'WAIT_CRITICAL',
  'UNMATCHED',
  'FLEET_SHORTFALL',
  'BREAKDOWN',
  'CONSECUTIVE_REJECTS',
  'STALE_LOCATION',
  'DUTY_CAP',
  'APPROVAL_PENDING',
  'DEADLINE_RISK',
] as const
export type AlertType = (typeof ALERT_TYPES)[number]

export const WAVE_STATES = ['PLANNED', 'DISPATCHED', 'CLOSED'] as const
export type WaveState = (typeof WAVE_STATES)[number]
