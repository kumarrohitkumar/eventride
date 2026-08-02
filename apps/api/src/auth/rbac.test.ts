import { describe, it, expect } from 'vitest'
import {
  assertOwnsRequest,
  assertOwnsTrip,
  assertRole,
  ForbiddenRoleError,
  ForbiddenRowError,
  hasRole,
  projectTripForDriver,
  resolveDriverScope,
  resolveGuestScope,
  roomsFor,
  type AuthPrincipal,
} from './rbac.js'

const admin: AuthPrincipal = { userId: 'u1', role: 'ADMIN' }
const driverA: AuthPrincipal = { userId: 'u2', role: 'DRIVER', driverId: 'drv-A' }
const driverB: AuthPrincipal = { userId: 'u3', role: 'DRIVER', driverId: 'drv-B' }
const guestA: AuthPrincipal = { userId: 'u4', role: 'GUEST', guestId: 'gst-A' }
const guestB: AuthPrincipal = { userId: 'u5', role: 'GUEST', guestId: 'gst-B' }

describe('layer 1 — endpoint role guard', () => {
  it('permits the matching role', () => {
    expect(hasRole(admin, ['ADMIN'])).toBe(true)
    expect(hasRole(driverA, ['DRIVER'])).toBe(true)
  })

  it('refuses a driver on admin-only endpoints', () => {
    expect(() => assertRole(driverA, ['ADMIN'])).toThrow(ForbiddenRoleError)
  })

  it('refuses a guest on admin-only endpoints', () => {
    expect(() => assertRole(guestA, ['ADMIN'])).toThrow(ForbiddenRoleError)
  })

  it('refuses an admin on driver-only endpoints (admins act via override, not impersonation)', () => {
    expect(() => assertRole(admin, ['DRIVER'])).toThrow(ForbiddenRoleError)
  })

  it('names the required role in the error, for a usable 403 body', () => {
    expect(() => assertRole(driverA, ['ADMIN'])).toThrow(/ADMIN/)
  })
})

describe('layer 2 — row scoping (a driver only ever sees their own data)', () => {
  it('derives the driver id from the TOKEN, so there is nothing to tamper with', () => {
    expect(resolveDriverScope(driverA)).toBe('drv-A')
  })

  it('refuses driver B asking for driver A explicitly', () => {
    expect(() => resolveDriverScope(driverB, 'drv-A')).toThrow(ForbiddenRowError)
  })

  it('allows a driver to name their own id (idempotent, not an escalation)', () => {
    expect(resolveDriverScope(driverA, 'drv-A')).toBe('drv-A')
  })

  it('lets an admin act on any driver explicitly', () => {
    expect(resolveDriverScope(admin, 'drv-A')).toBe('drv-A')
  })

  it('refuses an admin with no target — admin scope must be explicit, never implicit', () => {
    expect(() => resolveDriverScope(admin)).toThrow(ForbiddenRowError)
  })

  it('refuses a guest token on driver scope entirely', () => {
    expect(() => resolveDriverScope(guestA)).toThrow(ForbiddenRowError)
  })

  it('applies the same rules to guest scope', () => {
    expect(resolveGuestScope(guestA)).toBe('gst-A')
    expect(() => resolveGuestScope(guestB, 'gst-A')).toThrow(ForbiddenRowError)
    expect(resolveGuestScope(admin, 'gst-A')).toBe('gst-A')
    expect(() => resolveGuestScope(driverA)).toThrow(ForbiddenRowError)
  })
})

describe('layer 2 — ownership of a fetched row', () => {
  it("refuses driver B reading driver A's trip", () => {
    expect(() => assertOwnsTrip(driverB, { driverId: 'drv-A' })).toThrow(ForbiddenRowError)
  })

  it('permits a driver reading their own trip', () => {
    expect(() => assertOwnsTrip(driverA, { driverId: 'drv-A' })).not.toThrow()
  })

  it('permits an admin reading any trip', () => {
    expect(() => assertOwnsTrip(admin, { driverId: 'drv-A' })).not.toThrow()
  })

  it("refuses a guest reading another guest's request", () => {
    expect(() => assertOwnsRequest(guestB, { guestId: 'gst-A' })).toThrow(ForbiddenRowError)
  })

  it('refuses a DRIVER reading a guest request row', () => {
    expect(() => assertOwnsRequest(driverA, { guestId: 'gst-A' })).toThrow(ForbiddenRowError)
  })
})

describe('layer 3 — socket rooms are derived from the token', () => {
  it('puts an admin in the admin feed only', () => {
    expect(roomsFor(admin)).toEqual(['admins'])
  })

  it('confines a driver to their own room — never the admin feed', () => {
    expect(roomsFor(driverA)).toEqual(['driver:drv-A'])
    expect(roomsFor(driverA)).not.toContain('admins')
  })

  it('confines a guest to their own room', () => {
    expect(roomsFor(guestA)).toEqual(['guest:gst-A'])
  })

  it('grants no rooms to a malformed token rather than defaulting to something', () => {
    expect(roomsFor({ userId: 'x', role: 'DRIVER' })).toEqual([])
    expect(roomsFor({ userId: 'x', role: 'GUEST' })).toEqual([])
  })
})

describe('D9 — the driver payload never contains a guest phone number', () => {
  it('strips the field entirely rather than hiding it client-side', () => {
    const projected = projectTripForDriver({
      id: 'trp-1',
      guestNames: ['Priya'],
      guestCount: 2,
      guestPhone: '+91-99999-11111',
    })
    expect(projected).not.toHaveProperty('guestPhone')
    expect(Object.keys(projected)).toEqual(['id', 'guestNames', 'guestCount'])
  })

  it('keeps the information the driver genuinely needs', () => {
    const projected = projectTripForDriver({
      guestNames: ['Priya', 'Rahul'],
      guestCount: 3,
      luggageCount: 4,
      pickupInstruction: 'Terminal 2, Gate 5',
    })
    expect(projected).toMatchObject({
      guestNames: ['Priya', 'Rahul'],
      guestCount: 3,
      pickupInstruction: 'Terminal 2, Gate 5',
    })
  })
})
