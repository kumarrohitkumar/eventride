import type { Role } from '@eventride/shared'

/**
 * RBAC primitives (HLD §11, NFR-6). Kept as pure functions so the rules are unit-testable without
 * booting Nest, HTTP or a database — role separation is explicitly scored, so it gets tested like
 * the engine does.
 *
 * Three enforcement layers exist; these functions back layers 1 and 2:
 *   1. RolesGuard          — endpoint level: wrong role → 403 before any handler runs
 *   2. Row scoping         — a driver/guest token can only ever resolve its OWN rows
 *   3. Socket room mapping — rooms derived from the token, never from client input
 */

export interface AuthPrincipal {
  userId: string
  role: Role
  /** Present only for DRIVER tokens. */
  driverId?: string
  /** Present only for GUEST tokens. */
  guestId?: string
}

export class ForbiddenRoleError extends Error {
  readonly code = 'FORBIDDEN_ROLE'
  constructor(required: readonly Role[], actual: Role) {
    super(`Requires role ${required.join('|')}, caller is ${actual}`)
  }
}

export class ForbiddenRowError extends Error {
  readonly code = 'FORBIDDEN_ROW'
  constructor(resource: string) {
    super(`Not permitted to access this ${resource}`)
  }
}

export function hasRole(principal: AuthPrincipal, allowed: readonly Role[]): boolean {
  return allowed.includes(principal.role)
}

export function assertRole(principal: AuthPrincipal, allowed: readonly Role[]): void {
  if (!hasRole(principal, allowed)) throw new ForbiddenRoleError(allowed, principal.role)
}

/**
 * Resolve the driver id a request may act on.
 *
 * Note there is no "driverId" parameter: for a DRIVER token the id comes from the TOKEN, so there
 * is nothing for a caller to tamper with. An admin may act on any driver explicitly.
 */
export function resolveDriverScope(principal: AuthPrincipal, requestedId?: string): string {
  if (principal.role === 'ADMIN') {
    if (!requestedId) throw new ForbiddenRowError('driver')
    return requestedId
  }
  if (principal.role !== 'DRIVER' || !principal.driverId) throw new ForbiddenRowError('driver')
  // A driver asking for someone else's data is refused even though the row exists.
  if (requestedId && requestedId !== principal.driverId) throw new ForbiddenRowError('driver')
  return principal.driverId
}

export function resolveGuestScope(principal: AuthPrincipal, requestedId?: string): string {
  if (principal.role === 'ADMIN') {
    if (!requestedId) throw new ForbiddenRowError('guest')
    return requestedId
  }
  if (principal.role !== 'GUEST' || !principal.guestId) throw new ForbiddenRowError('guest')
  if (requestedId && requestedId !== principal.guestId) throw new ForbiddenRowError('guest')
  return principal.guestId
}

/** Ownership check for a fetched row — layer 2 applied after the read. */
export function assertOwnsTrip(principal: AuthPrincipal, trip: { driverId: string }): void {
  if (principal.role === 'ADMIN') return
  if (principal.role !== 'DRIVER' || trip.driverId !== principal.driverId) {
    throw new ForbiddenRowError('trip')
  }
}

export function assertOwnsRequest(principal: AuthPrincipal, request: { guestId: string }): void {
  if (principal.role === 'ADMIN') return
  if (principal.role !== 'GUEST' || request.guestId !== principal.guestId) {
    throw new ForbiddenRowError('request')
  }
}

/**
 * Socket rooms are DERIVED from the token; a client-supplied room list is ignored entirely, so a
 * driver cannot subscribe to the admin feed by crafting a payload (HLD §7).
 */
export function roomsFor(principal: AuthPrincipal): string[] {
  switch (principal.role) {
    case 'ADMIN':
      return ['admins']
    case 'DRIVER':
      return principal.driverId ? [`driver:${principal.driverId}`] : []
    case 'GUEST':
      return principal.guestId ? [`guest:${principal.guestId}`] : []
  }
}

/**
 * Strip fields a role must never receive.
 *
 * D9: the driver sees the guest's NAME but never their phone number. This removes the field from
 * the payload rather than hiding it in the UI — it is never serialised, so it cannot leak through
 * a debug view, a proxy log, or a future screen that forgets to hide it.
 */
export function projectTripForDriver<T extends Record<string, unknown>>(
  trip: T,
): Omit<T, 'guestPhone' | 'guestPhones'> {
  const { guestPhone: _p, guestPhones: _ps, ...safe } = trip as T & {
    guestPhone?: unknown
    guestPhones?: unknown
  }
  return safe
}
