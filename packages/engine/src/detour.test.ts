import { describe, it, expect } from 'vitest'
import { findBestDetour, findBestDetourAcrossTrips } from './detour.js'
import { capacityOkAtEveryStop } from './capacity.js'
import {
  activeTrip,
  driver,
  request,
  snapshot,
  stop,
  tableOracle,
  POI,
  T0,
  withConfig,
} from './testkit.js'
import { addMinutes } from '@eventride/shared'

/**
 * Geography for these tests: the driver is EN ROUTE from the airport to hotel A, currently at a
 * live position that is 2 minutes from a waiting guest who also wants hotel A.
 */
const LIVE = { lat: 13.05, lng: 77.65 }
const NEARBY_GUEST = { lat: 13.055, lng: 77.652 }

const oracle = tableOracle([
  [LIVE, POI.hotelA, 30],
  [LIVE, NEARBY_GUEST, 2],
  [NEARBY_GUEST, POI.hotelA, 29],
  [POI.hotelA, POI.hotelB, 5],
  [NEARBY_GUEST, POI.hotelB, 32],
  [LIVE, POI.hotelC, 45],
  [POI.hotelA, POI.hotelC, 40],
  [NEARBY_GUEST, POI.hotelC, 44],
])

const enRouteDriver = (over = {}) =>
  driver({
    state: 'ON_TRIP',
    seatCapacity: 6,
    luggageCapacity: 6,
    livePosition: LIVE,
    freeLocation: POI.hotelA,
    ...over,
  })

const tripInProgress = (over = {}) =>
  activeTrip({
    id: 'trp-live',
    remainingStops: [
      stop({
        kind: 'DROP',
        requestId: 'req-onboard',
        locationId: 'hA',
        at: POI.hotelA,
        seatsDelta: -2,
        luggageDelta: -2,
      }),
    ],
    requestIds: ['req-onboard'],
    seatsUsed: 2,
    luggageUsed: 2,
    committedDeadlines: [{ requestId: 'req-onboard', deadlineAt: null }],
    ...over,
  })

const waitingGuest = (over = {}) =>
  request({
    origin: NEARBY_GUEST,
    originId: 'curb-1',
    destination: POI.hotelA,
    destinationId: 'hA',
    groupSize: 1,
    luggageCount: 1,
    ...over,
  })

const s = (over = {}) => snapshot({ travel: oracle, ...over })

describe('findBestDetour (FR-M18, E12) — works on IN-PROGRESS trips', () => {
  it('inserts a guest the moving vehicle passes, using the live position', () => {
    const d = enRouteDriver()
    const result = findBestDetour(tripInProgress({ driverId: d.id }), d, waitingGuest(), s())
    expect(result).not.toBeNull()
    // 2 min detour to the curb + 29 to the hotel vs 30 direct ⇒ ~1 extra minute
    expect(result!.addedMinutes).toBeLessThanOrEqual(2)
    expect(result!.stops.some((st) => st.kind === 'PICKUP')).toBe(true)
  })

  it('keeps capacity valid at every stop, counting the onboard guests (INV-1)', () => {
    const d = enRouteDriver({ seatCapacity: 6, luggageCapacity: 6 })
    const trip = tripInProgress({ driverId: d.id, seatsUsed: 2, luggageUsed: 2 })
    const result = findBestDetour(trip, d, waitingGuest({ groupSize: 3, luggageCount: 3 }), s())
    expect(result).not.toBeNull()
    // 2 aboard + a group of 3 = 5, inside the 6-seat vehicle. Validated from the current load,
    // because the onboard guests' drop stops carry negative deltas.
    expect(
      capacityOkAtEveryStop(
        result!.stops,
        { seatCapacity: 6, luggageCapacity: 6 },
        { seats: 2, luggage: 2 },
      ),
    ).toBe(true)
  })

  it('refuses when the vehicle has no spare seats', () => {
    const d = enRouteDriver({ seatCapacity: 4 })
    const trip = tripInProgress({ driverId: d.id, seatsUsed: 4, luggageUsed: 0 })
    expect(findBestDetour(trip, d, waitingGuest({ groupSize: 1 }), s())).toBeNull()
  })

  it('refuses when no spare luggage space remains, even if seats are free', () => {
    const d = enRouteDriver({ seatCapacity: 6, luggageCapacity: 2 })
    const trip = tripInProgress({ driverId: d.id, seatsUsed: 1, luggageUsed: 2 })
    expect(findBestDetour(trip, d, waitingGuest({ luggageCount: 1 }), s())).toBeNull()
  })

  it('ACCEPTS a detour at the 10-minute limit but REFUSES one past it (FR-M13)', () => {
    const d = enRouteDriver()
    const trip = tripInProgress({ driverId: d.id })

    // hotelC is 45 min away from the live position: a huge detour, must be refused.
    const farGuest = waitingGuest({ origin: POI.hotelC, originId: 'far', destination: POI.hotelA })
    expect(findBestDetour(trip, d, farGuest, s())).toBeNull()

    // Same geography but with the cap raised to 60 min ⇒ now allowed. Proves the cap is what refused it.
    const relaxed = s({ config: withConfig({ detour_max_added_min: 60 }) })
    expect(findBestDetour(trip, d, farGuest, relaxed)).not.toBeNull()
  })

  it('refuses if the insertion would make an onboard guest miss a hard deadline (FR-M13)', () => {
    const d = enRouteDriver()
    // Onboard guest must reach hotel A within 30 min; the detour would land them at ~31.
    const trip = tripInProgress({
      driverId: d.id,
      committedDeadlines: [{ requestId: 'req-onboard', deadlineAt: addMinutes(T0, 30) }],
    })
    expect(findBestDetour(trip, d, waitingGuest(), s())).toBeNull()
  })

  it('allows the same insertion when the onboard guest has deadline room', () => {
    const d = enRouteDriver()
    const trip = tripInProgress({
      driverId: d.id,
      committedDeadlines: [{ requestId: 'req-onboard', deadlineAt: addMinutes(T0, 60) }],
    })
    expect(findBestDetour(trip, d, waitingGuest(), s())).not.toBeNull()
  })

  it('never modifies an admin-pinned trip (E16)', () => {
    const d = enRouteDriver()
    const trip = tripInProgress({ driverId: d.id, isPinned: true })
    expect(findBestDetour(trip, d, waitingGuest(), s())).toBeNull()
  })

  it('never inserts a VIP into a shared vehicle (D12)', () => {
    const d = enRouteDriver()
    const trip = tripInProgress({ driverId: d.id })
    expect(findBestDetour(trip, d, waitingGuest({ isVip: true }), s())).toBeNull()
  })

  it('returns null for a trip with no remaining stops', () => {
    const d = enRouteDriver()
    const trip = tripInProgress({ driverId: d.id, remainingStops: [] })
    expect(findBestDetour(trip, d, waitingGuest(), s())).toBeNull()
  })

  it('produces a stop sequence that still drops everyone (no lost guests)', () => {
    const d = enRouteDriver()
    const trip = tripInProgress({ driverId: d.id })
    const guest = waitingGuest()
    const result = findBestDetour(trip, d, guest, s())!
    const dropped = result.stops.filter((st) => st.kind === 'DROP').map((st) => st.requestId)
    expect(dropped).toContain('req-onboard')
    expect(dropped).toContain(guest.id)
  })

  it('picks up before dropping the new guest (a coherent sequence)', () => {
    const d = enRouteDriver()
    const guest = waitingGuest()
    const result = findBestDetour(tripInProgress({ driverId: d.id }), d, guest, s())!
    const pickupIdx = result.stops.findIndex((st) => st.requestId === guest.id && st.kind === 'PICKUP')
    const dropIdx = result.stops.findIndex((st) => st.requestId === guest.id && st.kind === 'DROP')
    expect(pickupIdx).toBeGreaterThanOrEqual(0)
    expect(dropIdx).toBeGreaterThan(pickupIdx)
  })
})

describe('findBestDetourAcrossTrips', () => {
  it('chooses the trip that is genuinely closest', () => {
    const near = enRouteDriver({ id: 'drv-near', livePosition: LIVE })
    const far = enRouteDriver({ id: 'drv-far', livePosition: POI.hotelC })
    const trips = [
      tripInProgress({ id: 'trp-near', driverId: 'drv-near' }),
      tripInProgress({ id: 'trp-far', driverId: 'drv-far' }),
    ]
    const result = findBestDetourAcrossTrips(
      waitingGuest(),
      s({ drivers: [near, far], activeTrips: trips }),
    )
    expect(result?.tripId).toBe('trp-near')
  })

  it('skips trips whose driver has broken down (E5)', () => {
    const broken = enRouteDriver({ id: 'drv-broken', state: 'UNAVAILABLE' })
    const trips = [tripInProgress({ id: 'trp-broken', driverId: 'drv-broken' })]
    expect(
      findBestDetourAcrossTrips(waitingGuest(), s({ drivers: [broken], activeTrips: trips })),
    ).toBeNull()
  })

  it('returns null when there are no active trips at all', () => {
    expect(findBestDetourAcrossTrips(waitingGuest(), s({ activeTrips: [] }))).toBeNull()
  })
})
