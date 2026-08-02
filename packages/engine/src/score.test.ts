import { describe, it, expect } from 'vitest'
import { scorePair, breakPressure } from './score.js'
import { driver, request, snapshot, tableOracle, POI, T0, withConfig } from './testkit.js'
import { addMinutes, DEFAULT_CONFIG } from '@eventride/shared'

/**
 * Two drivers, one near the airport and one far, so "nearer wins" is unambiguous.
 * tableOracle is symmetric, so each pair is declared exactly once.
 */
const oracle = tableOracle([
  [POI.hotelA, POI.airport, 50], // far driver's deadhead, and the ride length
  [POI.hotelB, POI.airport, 10], // near driver's deadhead
  [POI.hotelA, POI.hotelB, 5],
])

const s = (over = {}) => snapshot({ travel: oracle, ...over })

describe('scorePair — lower is better (PRD §11.5)', () => {
  it('prefers the nearer driver (deadhead minimisation, FR-M20)', () => {
    const near = driver({ freeLocation: POI.hotelB })
    const far = driver({ freeLocation: POI.hotelA })
    const r = request({ origin: POI.airport, destination: POI.hotelA })
    expect(scorePair(near, r, s()).total).toBeLessThan(scorePair(far, r, s()).total)
  })

  it('penalises sending a 12-seater for a single guest (capacity waste)', () => {
    const small = driver({ freeLocation: POI.hotelB, seatCapacity: 4 })
    const huge = driver({ freeLocation: POI.hotelB, seatCapacity: 20 })
    const r = request({ groupSize: 1, origin: POI.airport })
    expect(scorePair(small, r, s()).total).toBeLessThan(scorePair(huge, r, s()).total)
  })

  it('does NOT penalise the big vehicle when the group actually needs it', () => {
    const huge = driver({ freeLocation: POI.hotelB, seatCapacity: 20 })
    const r1 = request({ groupSize: 1, origin: POI.airport })
    const r18 = request({ groupSize: 18, origin: POI.airport })
    // `parts` is an open record, so under noUncheckedIndexedAccess each entry is possibly undefined.
    expect(scorePair(huge, r18, s()).parts.waste ?? 0).toBeLessThan(scorePair(huge, r1, s()).parts.waste ?? 0)
  })

  it('improves the score for a VIP so they win contested drivers (D12)', () => {
    const d = driver({ freeLocation: POI.hotelB })
    const vip = request({ isVip: true, origin: POI.airport })
    const normal = request({ isVip: false, origin: POI.airport })
    expect(scorePair(d, vip, s()).total).toBeLessThan(scorePair(d, normal, s()).total)
  })

  it('improves the score for a long-waiting guest (aging, FR-M12)', () => {
    const d = driver({ freeLocation: POI.hotelB })
    const waited = request({ readyAt: addMinutes(T0, -40), origin: POI.airport })
    const fresh = request({ readyAt: T0, origin: POI.airport })
    expect(scorePair(d, waited, s()).parts.age ?? 0).toBeLessThan(scorePair(d, fresh, s()).parts.age ?? 0)
  })

  it('adds a lateness penalty only when deadline slack is thin (FR-M10 pressure)', () => {
    const d = driver({ freeLocation: POI.hotelB })
    const tight = request({
      origin: POI.airport,
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 15), // pickup at +10 leaves 5 min slack
    })
    const roomy = request({
      origin: POI.airport,
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 180),
    })
    expect(scorePair(d, tight, s()).parts.late).toBeGreaterThan(0)
    expect(scorePair(d, roomy, s()).parts.late).toBe(0)
  })

  it('penalises a driver under break pressure (driver welfare, D15)', () => {
    const fresh = driver({ freeLocation: POI.hotelB, drivingMinutesToday: 0, tripsSinceBreak: 0 })
    const tired = driver({ freeLocation: POI.hotelB, drivingMinutesToday: 230, tripsSinceBreak: 5 })
    const r = request({ origin: POI.airport })
    expect(scorePair(tired, r, s()).total).toBeGreaterThan(scorePair(fresh, r, s()).total)
  })

  it('rewards pooling when the driver is already heading to that destination cluster (FR-M15)', () => {
    const r = request({ origin: POI.airport, destination: POI.hotelA })
    const plain = driver({ freeLocation: POI.hotelB })
    const s1 = s()
    const withPool = scorePair(plain, r, s1, { poolsWithCluster: true })
    const withoutPool = scorePair(plain, r, s1, { poolsWithCluster: false })
    expect(withPool.total).toBeLessThan(withoutPool.total)
  })

  it('exposes every named part so an assignment can be explained (FR-M23)', () => {
    const b = scorePair(driver({ freeLocation: POI.hotelB }), request({ origin: POI.airport }), s())
    expect(Object.keys(b.parts).sort()).toEqual(
      ['age', 'break', 'deadhead', 'detour', 'late', 'pool', 'vip', 'waste', 'wait'].sort(),
    )
    const sum = Object.values(b.parts).reduce<number>((a, x) => a + (x ?? 0), 0)
    expect(b.total).toBeCloseTo(sum, 9)
  })

  it('is fully driven by config weights — zeroing a weight removes its influence', () => {
    const cfg = withConfig({ w_deadhead: 0, w_wait: 0 })
    const near = driver({ freeLocation: POI.hotelB })
    const far = driver({ freeLocation: POI.hotelA })
    const r = request({ origin: POI.airport })
    const snap = s({ config: cfg })
    expect(scorePair(near, r, snap).total).toBeCloseTo(scorePair(far, r, snap).total, 9)
  })
})

describe('breakPressure', () => {
  it('is zero for a fresh driver and rises toward the threshold', () => {
    expect(breakPressure(driver({ drivingMinutesToday: 0 }), DEFAULT_CONFIG)).toBe(0)
    const half = breakPressure(driver({ drivingMinutesToday: 120 }), DEFAULT_CONFIG)
    const nearly = breakPressure(driver({ drivingMinutesToday: 230 }), DEFAULT_CONFIG)
    expect(nearly).toBeGreaterThan(half)
  })

  it('caps at 1 so it can never dominate the whole cost function', () => {
    expect(
      breakPressure(driver({ drivingMinutesToday: 9999, tripsSinceBreak: 99 }), DEFAULT_CONFIG),
    ).toBeLessThanOrEqual(1)
  })

  it('also responds to trip count, not just minutes (either trigger, D15)', () => {
    const byTrips = breakPressure(
      driver({ drivingMinutesToday: 0, tripsSinceBreak: 5 }),
      DEFAULT_CONFIG,
    )
    expect(byTrips).toBeGreaterThan(0)
  })
})
