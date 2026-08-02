import type { RequestState, DriverState, TripState } from './enums.js'

/**
 * Authoritative transition tables (LLD §3). INV-6: no state changes except through these.
 * TripService is the only writer, and it calls assert*Transition before every write.
 */

export const REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  REGISTERED: ['PENDING_APPROVAL', 'QUEUED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'DECLINED', 'CANCELLED'],
  APPROVED: ['QUEUED', 'CANCELLED'],
  DECLINED: [],
  QUEUED: ['ASSIGNED', 'UNMATCHED', 'CANCELLED'],
  // ASSIGNED → QUEUED covers driver reject, offer expiry and admin unassign (E2, E3)
  ASSIGNED: ['ACCEPTED', 'QUEUED', 'UNMATCHED', 'CANCELLED'],
  ACCEPTED: ['EN_ROUTE', 'QUEUED', 'CANCELLED'],
  // the *_PICKUP / BOARDED → QUEUED edges exist for breakdown recovery (E5)
  EN_ROUTE: ['ARRIVED_PICKUP', 'QUEUED', 'CANCELLED'],
  ARRIVED_PICKUP: ['BOARDED', 'NO_SHOW', 'QUEUED', 'CANCELLED'],
  BOARDED: ['COMPLETED', 'QUEUED', 'CANCELLED'],
  COMPLETED: [],
  UNMATCHED: ['QUEUED', 'CANCELLED'],
  NO_SHOW: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
}

export const DRIVER_TRANSITIONS: Record<DriverState, readonly DriverState[]> = {
  OFFLINE: ['AVAILABLE', 'UNAVAILABLE'],
  AVAILABLE: ['OFFERED', 'ON_BREAK', 'OFFLINE', 'UNAVAILABLE'],
  OFFERED: ['EN_ROUTE_TO_PICKUP', 'AVAILABLE', 'UNAVAILABLE'],
  EN_ROUTE_TO_PICKUP: ['AT_PICKUP', 'AVAILABLE', 'UNAVAILABLE'],
  AT_PICKUP: ['ON_TRIP', 'AVAILABLE', 'UNAVAILABLE'],
  // ON_TRIP → ON_TRIP is a legal self-transition: a detour insertion (FR-M18)
  ON_TRIP: ['ON_TRIP', 'AVAILABLE', 'UNAVAILABLE'],
  ON_BREAK: ['AVAILABLE', 'OFFLINE', 'UNAVAILABLE'],
  UNAVAILABLE: ['AVAILABLE', 'OFFLINE'],
}

export const TRIP_TRANSITIONS: Record<TripState, readonly TripState[]> = {
  OFFERED: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE: ['AT_PICKUP', 'CANCELLED'],
  AT_PICKUP: ['ON_TRIP', 'CANCELLED'],
  ON_TRIP: ['ON_TRIP', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
}

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION'
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export function canTransitionRequest(from: RequestState, to: RequestState): boolean {
  return REQUEST_TRANSITIONS[from].includes(to)
}
export function canTransitionDriver(from: DriverState, to: DriverState): boolean {
  return DRIVER_TRANSITIONS[from].includes(to)
}
export function canTransitionTrip(from: TripState, to: TripState): boolean {
  return TRIP_TRANSITIONS[from].includes(to)
}

export function assertRequestTransition(from: RequestState, to: RequestState): void {
  if (!canTransitionRequest(from, to)) throw new IllegalTransitionError('request', from, to)
}
export function assertDriverTransition(from: DriverState, to: DriverState): void {
  if (!canTransitionDriver(from, to)) throw new IllegalTransitionError('driver', from, to)
}
export function assertTripTransition(from: TripState, to: TripState): void {
  if (!canTransitionTrip(from, to)) throw new IllegalTransitionError('trip', from, to)
}
