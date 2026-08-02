import { describe, it, expect } from 'vitest'
import { canPoolTogether, tryAddToTrip, dropStopCount, type PlannedTrip } from './pooling.js'
import { buildStopsForRequests, capacityOkAtEveryStop } from './capacity.js'
import { driver, request, snapshot, POI, T0, withConfig, tableOracle } from './testkit.js'
import { addMinutes } from '@eventride/shared'

const s = (over = {}) => snapshot(over)

const tripFor = (reqs: ReturnType<typeof request>[], driverId = 'drv-1'): PlannedTrip => ({
  driverId,
  requests: reqs,
  stops: buildStopsForRequests(reqs),
  plannedPickupAt: T0,
  plannedDropAt: addMinutes(T0, 30),
})

describe('canPoolTogether (FR-M15, D23)', () => {
  const base = { origin: POI.airport, originId: 'loc-air', readyAt: T0 }

  it('pools two guests from the same terminal to the same hotel', () => {
    const a = request({ ...base, destination: POI.hotelA, destinationId: 'hA' })
    const b = request({ ...base, destination: POI.hotelA, destinationId: 'hA' })
    expect(canPoolTogether(a, b, s())).toBeNull()
  })

  it('pools two nearby hotels as one destination cluster (1.2 km apart)', () => {
    const a = request({ ...base, destination: POI.hotelA, destinationId: 'hA' })
    const b = request({ ...base, destination: POI.hotelB, destinationId: 'hB' })
    expect(canPoolTogether(a, b, s())).toBeNull()
  })

  it('REFUSES hotels in opposite directions (E11 — the multi-accommodation case)', () => {
    const a = request({ ...base, destination: POI.hotelA, destinationId: 'hA' })
    const b = request({ ...base, destination: POI.hotelC, destinationId: 'hC' })
    expect(canPoolTogether(a, b, s())).toBe('DIFFERENT_DESTINATION_CLUSTER')
  })

  it('refuses guests outside the ±15 min window', () => {
    const a = request({ ...base, readyAt: T0 })
    const b = request({ ...base, readyAt: addMinutes(T0, 40) })
    expect(canPoolTogether(a, b, s())).toBe('OUTSIDE_TIME_WINDOW')
  })

  it('accepts guests exactly at the window edge', () => {
    const a = request({ ...base, readyAt: T0 })
    const b = request({ ...base, readyAt: addMinutes(T0, 15) })
    expect(canPoolTogether(a, b, s())).toBeNull()
  })

  it('refuses different pickup points (airport vs railway station)', () => {
    const a = request({ origin: POI.airport, originId: 'air', readyAt: T0 })
    const b = request({ origin: POI.station, originId: 'stn', readyAt: T0 })
    expect(canPoolTogether(a, b, s())).toBe('DIFFERENT_PICKUP_POINT')
  })

  it('NEVER pools a VIP, however perfectly they would otherwise match (D12)', () => {
    const vip = request({ ...base, isVip: true, destinationId: 'hA' })
    const other = request({ ...base, destinationId: 'hA' })
    expect(canPoolTogether(vip, other, s())).toBe('VIP_NEVER_POOLED')
    expect(canPoolTogether(other, vip, s())).toBe('VIP_NEVER_POOLED')
  })

  it('honours a widened window from config', () => {
    const cfg = withConfig({ pool_time_window_min: 60 })
    const a = request({ ...base, readyAt: T0 })
    const b = request({ ...base, readyAt: addMinutes(T0, 40) })
    expect(canPoolTogether(a, b, s({ config: cfg }))).toBeNull()
  })
})

describe('tryAddToTrip', () => {
  const airportToA = { origin: POI.airport, originId: 'air', destination: POI.hotelA, destinationId: 'hA' }

  it('adds a compatible guest and keeps capacity valid at every stop (INV-1)', () => {
    const d = driver({ seatCapacity: 4, luggageCapacity: 4, freeLocation: POI.airport })
    const first = request({ ...airportToA, groupSize: 2, luggageCount: 2 })
    const second = request({ ...airportToA, groupSize: 2, luggageCount: 2 })
    const res = tryAddToTrip(tripFor([first]), second, d, s())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.trip.requests).toHaveLength(2)
    expect(capacityOkAtEveryStop(res.trip.stops, d)).toBe(true)
  })

  it('refuses when the shared load would exceed seats', () => {
    const d = driver({ seatCapacity: 3, freeLocation: POI.airport })
    const first = request({ ...airportToA, groupSize: 2, luggageCount: 1 })
    const second = request({ ...airportToA, groupSize: 2, luggageCount: 1 })
    const res = tryAddToTrip(tripFor([first]), second, d, s())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.refusal).toBe('CAPACITY')
  })

  it('refuses a third distinct drop location (max 2 drop stops, D23)', () => {
    const d = driver({ seatCapacity: 8, luggageCapacity: 8, freeLocation: POI.airport })
    const a = request({ ...airportToA, destinationId: 'hA', destination: POI.hotelA })
    const b = request({ ...airportToA, destinationId: 'hB', destination: POI.hotelB })
    const withTwo = tryAddToTrip(tripFor([a]), b, d, s())
    expect(withTwo.ok).toBe(true)
    if (!withTwo.ok) return
    expect(dropStopCount(withTwo.trip.stops)).toBe(2)

    // A third hotel inside the cluster radius would still exceed the drop-stop cap.
    const cHotel = { lat: POI.hotelA.lat + 0.005, lng: POI.hotelA.lng + 0.005 }
    const third = request({ ...airportToA, destinationId: 'hD', destination: cHotel })
    const res = tryAddToTrip(withTwo.trip, third, d, s())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.refusal).toBe('TOO_MANY_DROP_STOPS')
  })

  it('refuses when the added detour exceeds the configured limit (FR-M13)', () => {
    // Second guest's drop is far enough away that adding them costs more than 10 minutes.
    const d = driver({ seatCapacity: 6, luggageCapacity: 6, freeLocation: POI.airport })
    const oracle = tableOracle([
      [POI.airport, POI.hotelA, 30],
      [POI.hotelA, POI.hotelB, 25], // a 25-minute hop between the two drops
      [POI.airport, POI.hotelB, 30],
    ])
    const a = request({ ...airportToA, destinationId: 'hA', destination: POI.hotelA })
    const b = request({ ...airportToA, destinationId: 'hB', destination: POI.hotelB })
    const res = tryAddToTrip(tripFor([a]), b, d, s({ travel: oracle }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.refusal).toBe('ADDED_DELAY_TOO_HIGH')
  })

  it('refuses when pooling would push a guest past a hard deadline (FR-M13)', () => {
    // Drops follow pickup order, so the guest added SECOND is dropped last and absorbs the detour.
    const d = driver({ seatCapacity: 6, luggageCapacity: 6, freeLocation: POI.airport })
    const oracle = tableOracle([
      [POI.airport, POI.hotelA, 20],
      [POI.hotelA, POI.hotelB, 8], // second drop lands at ~28 min
      [POI.airport, POI.hotelB, 22],
    ])
    const noDeadline = request({ ...airportToA, destinationId: 'hA', destination: POI.hotelA })
    const tightDeadline = request({
      ...airportToA,
      destinationId: 'hB',
      destination: POI.hotelB,
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 25), // 28 > 25 ⇒ must be refused
    })
    const res = tryAddToTrip(tripFor([noDeadline]), tightDeadline, d, s({ travel: oracle }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.refusal).toBe('DEADLINE_BREACH')
  })

  it('ALLOWS the same pooling when the deadline has enough room (no false refusals)', () => {
    const d = driver({ seatCapacity: 6, luggageCapacity: 6, freeLocation: POI.airport })
    const oracle = tableOracle([
      [POI.airport, POI.hotelA, 20],
      [POI.hotelA, POI.hotelB, 8],
      [POI.airport, POI.hotelB, 22],
    ])
    const noDeadline = request({ ...airportToA, destinationId: 'hA', destination: POI.hotelA })
    const roomyDeadline = request({
      ...airportToA,
      destinationId: 'hB',
      destination: POI.hotelB,
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 45),
    })
    const res = tryAddToTrip(tripFor([noDeadline]), roomyDeadline, d, s({ travel: oracle }))
    expect(res.ok).toBe(true)
  })

  it('reports the added minutes so the driver UI can show "+N min" (FR-D8)', () => {
    const d = driver({ seatCapacity: 6, luggageCapacity: 6, freeLocation: POI.airport })
    const a = request({ ...airportToA, destinationId: 'hA', destination: POI.hotelA })
    const b = request({ ...airportToA, destinationId: 'hA', destination: POI.hotelA })
    const res = tryAddToTrip(tripFor([a]), b, d, s())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Same origin and same destination ⇒ effectively no detour at all.
    expect(res.addedMinutes).toBeLessThanOrEqual(2)
  })
})
