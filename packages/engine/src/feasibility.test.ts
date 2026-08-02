import { describe, it, expect } from 'vitest'
import { checkFeasible, timingFor } from './feasibility.js'
import { driver, request, snapshot, fixedOracle, POI, T0 } from './testkit.js'
import { addMinutes, DEFAULT_CONFIG } from '@eventride/shared'

const s = (over = {}) => snapshot({ travel: fixedOracle(20), ...over })

describe('checkFeasible (FR-M9…M11) — every rejection is typed (FR-A11)', () => {
  it('accepts an available driver with capacity and no deadline pressure', () => {
    expect(checkFeasible(driver(), request(), s())).toBeNull()
  })

  it('rejects NO_CAPACITY when the group exceeds seats', () => {
    const r = checkFeasible(driver({ seatCapacity: 3 }), request({ groupSize: 4 }), s())
    expect(r?.reason).toBe('NO_CAPACITY')
  })

  it('rejects NO_CAPACITY when luggage exceeds the boot, even if seats fit', () => {
    // The fleet DOES contain a big-boot vehicle, so this is a per-driver rejection,
    // not the fleet-wide GROUP_TOO_LARGE case.
    const small = driver({ seatCapacity: 6, luggageCapacity: 2 })
    const big = driver({ seatCapacity: 6, luggageCapacity: 10 })
    const snap = s({ drivers: [small, big], fleetMaxSeats: 6, fleetMaxLuggage: 10 })
    const r = checkFeasible(small, request({ groupSize: 1, luggageCount: 5 }), snap)
    expect(r?.reason).toBe('NO_CAPACITY')
  })

  it('rejects an offline driver', () => {
    expect(checkFeasible(driver({ state: 'OFFLINE' }), request(), s())?.reason).toBe(
      'NO_DRIVER_ONLINE',
    )
  })

  it('rejects a driver already committed to a trip (INV-3)', () => {
    for (const state of ['OFFERED', 'EN_ROUTE_TO_PICKUP', 'AT_PICKUP', 'ON_TRIP'] as const) {
      // No predictedFreeAt ⇒ we cannot plan around them at all this round.
      expect(checkFeasible(driver({ state }), request(), s())?.reason).toBe('ALL_DRIVERS_BUSY')
    }
  })

  it('rejects a driver whose break is due (FR-M11, D15)', () => {
    expect(checkFeasible(driver({ breakState: 'DUE' }), request(), s())?.reason).toBe(
      'ALL_DRIVERS_ON_BREAK',
    )
    expect(checkFeasible(driver({ state: 'ON_BREAK' }), request(), s())?.reason).toBe(
      'ALL_DRIVERS_ON_BREAK',
    )
  })

  it('rejects a driver still cooling down from rejecting this exact request (D14)', () => {
    const r = request()
    const d = driver({ cooldownRequestIds: [r.id] })
    expect(checkFeasible(d, r, s())?.reason).toBe('COOLDOWN_ONLY_CANDIDATES')
  })

  it('allows that same driver for a DIFFERENT request — cooldown is per pair, not global', () => {
    const rejected = request()
    const other = request()
    const d = driver({ cooldownRequestIds: [rejected.id] })
    expect(checkFeasible(d, other, s())).toBeNull()
  })

  it('rejects when the trip would run past the end of the shift', () => {
    // 20 min to pickup + 20 min to drop = 40 min, but only 15 min of shift remain.
    const d = driver({ shiftEnd: addMinutes(T0, 15) })
    expect(checkFeasible(d, request(), s())?.reason).toBe('OUTSIDE_SHIFT_HOURS')
  })

  it('rejects DEADLINE_INFEASIBLE rather than silently running late (FR-M10)', () => {
    const r = request({
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 30), // needs 40 min of travel
      tripType: 'DEPARTURE',
    })
    expect(checkFeasible(driver(), r, s())?.reason).toBe('DEADLINE_INFEASIBLE')
  })

  it('accepts a hard deadline that IS reachable', () => {
    const r = request({ isHardDeadline: true, deadlineAt: addMinutes(T0, 60) })
    expect(checkFeasible(driver(), r, s())).toBeNull()
  })

  it('refuses to chain a second trip onto a busy driver in a LIVE round (INV-3)', () => {
    // Even with a known free time: a committed driver may only receive a detour insertion.
    // Offering them an independent trip would be rejected by the applier and the guest would
    // silently keep waiting — the exact failure mode that starves a queue.
    const d = driver({ state: 'ON_TRIP', predictedFreeAt: addMinutes(T0, 10) })
    expect(checkFeasible(d, request(), s())?.reason).toBe('ALL_DRIVERS_BUSY')
  })

  it('DOES chain onto a predicted-free driver during pre-day batch planning (FR-M1)', () => {
    const d = driver({ state: 'ON_TRIP', predictedFreeAt: addMinutes(T0, 10) })
    expect(checkFeasible(d, request(), s({ allowCommittedDrivers: true }))).toBeNull()
  })

  it('still rejects a predicted-free driver who cannot make a hard deadline', () => {
    const d = driver({ state: 'ON_TRIP', predictedFreeAt: addMinutes(T0, 45) })
    const r = request({ isHardDeadline: true, deadlineAt: addMinutes(T0, 60) })
    // free at +45, +20 to pickup, +20 to drop = +85 > +60
    expect(checkFeasible(d, r, s({ allowCommittedDrivers: true }))?.reason).toBe(
      'DEADLINE_INFEASIBLE',
    )
  })

  it('rejects a group larger than the entire fleet with GROUP_TOO_LARGE', () => {
    const snap = s({ drivers: [driver({ seatCapacity: 4 })] })
    const r = request({ groupSize: 9 })
    // fleetMaxSeats is 4 → this is a split case, not a per-driver capacity case
    expect(checkFeasible(driver({ seatCapacity: 4 }), r, { ...snap, fleetMaxSeats: 4 })?.reason).toBe(
      'GROUP_TOO_LARGE',
    )
  })
})

describe('timingFor', () => {
  it('computes pickup and drop from the driver free time', () => {
    const t = timingFor(driver(), request(), s())
    expect(t.pickupAt.getTime()).toBe(addMinutes(T0, 20).getTime())
    expect(t.dropAt.getTime()).toBe(addMinutes(T0, 40).getTime())
    expect(t.deadheadMin).toBe(20)
  })

  it('starts from predictedFreeAt when the driver is still busy', () => {
    const d = driver({ state: 'ON_TRIP', predictedFreeAt: addMinutes(T0, 30) })
    const t = timingFor(d, request(), s())
    expect(t.pickupAt.getTime()).toBe(addMinutes(T0, 50).getTime())
  })

  it('never plans in the past when predictedFreeAt has already elapsed', () => {
    const d = driver({ predictedFreeAt: addMinutes(T0, -60) })
    const t = timingFor(d, request(), s())
    expect(t.pickupAt.getTime()).toBe(addMinutes(T0, 20).getTime())
  })

  it('reports guest wait measured from readyAt, not from assignment (D8)', () => {
    const r = request({ readyAt: addMinutes(T0, -25) })
    const t = timingFor(driver(), r, s())
    // waited 25 min already + 20 min for the driver to arrive
    expect(t.waitMin).toBe(45)
  })

  it('reports zero wait for a guest who is not ready yet', () => {
    const r = request({ readyAt: addMinutes(T0, 60) })
    expect(timingFor(driver(), r, s()).waitMin).toBe(0)
  })

  it('uses the real oracle distances when given POIs', () => {
    const snap = snapshot({})
    const r = request({ origin: POI.airport, destination: POI.hotelA })
    const t = timingFor(driver({ freeLocation: POI.hotelA }), r, snap)
    expect(t.deadheadMin).toBeGreaterThan(40) // hotel → airport is a real drive
    expect(DEFAULT_CONFIG.candidate_topk_for_live_eta).toBe(5)
  })
})
