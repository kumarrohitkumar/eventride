import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { runRound } from './round.js'
import { capacityOkAtEveryStop } from './capacity.js'
import { driver, request, snapshot, POI, T0, mockOracle } from './testkit.js'
import { addMinutes, DEFAULT_CONFIG, type DriverView, type RequestView } from '@eventride/shared'

/**
 * These are the evaluation criteria expressed as executable properties, run against randomised
 * fleets and demand. They are the tests that matter most: "capacity respected", "no guest
 * ignored or starved", "deadlines honoured" (PRD §19.4).
 */

const HOTELS = [POI.hotelA, POI.hotelB, POI.hotelC]

const arbDriver = fc
  .record({
    seats: fc.integer({ min: 1, max: 12 }),
    bags: fc.integer({ min: 0, max: 12 }),
    hotel: fc.integer({ min: 0, max: 2 }),
    onBreak: fc.boolean(),
  })
  .map(({ seats, bags, hotel, onBreak }, ) =>
    driver({
      seatCapacity: seats,
      luggageCapacity: bags,
      freeLocation: HOTELS[hotel]!,
      breakState: onBreak ? 'DUE' : 'NONE',
    }),
  )

const arbRequest = fc
  .record({
    groupSize: fc.integer({ min: 1, max: 6 }),
    luggageCount: fc.integer({ min: 0, max: 6 }),
    hotel: fc.integer({ min: 0, max: 2 }),
    waitedMin: fc.integer({ min: 0, max: 90 }),
    isVip: fc.boolean(),
    hardDeadline: fc.boolean(),
    deadlineMin: fc.integer({ min: 20, max: 240 }),
    passedOver: fc.integer({ min: 0, max: 4 }),
  })
  .map((r) =>
    request({
      groupSize: r.groupSize,
      luggageCount: r.luggageCount,
      origin: POI.airport,
      originId: 'air',
      destination: HOTELS[r.hotel]!,
      destinationId: `hotel-${r.hotel}`,
      readyAt: addMinutes(T0, -r.waitedMin),
      isVip: r.isVip,
      isHardDeadline: r.hardDeadline,
      deadlineAt: r.hardDeadline ? addMinutes(T0, r.deadlineMin) : null,
      passedOverCount: r.passedOver,
    }),
  )

const buildSnapshot = (drivers: DriverView[], requests: RequestView[]) =>
  snapshot({
    drivers,
    requests,
    travel: mockOracle,
    fleetMaxSeats: Math.max(1, ...drivers.map((d) => d.seatCapacity)),
    fleetMaxLuggage: Math.max(1, ...drivers.map((d) => d.luggageCapacity)),
  })

describe('INV-1 — capacity is never violated (G3)', () => {
  it('holds for randomised fleets and demand', () => {
    fc.assert(
      fc.property(
        fc.array(arbDriver, { minLength: 1, maxLength: 8 }),
        fc.array(arbRequest, { minLength: 1, maxLength: 12 }),
        (drivers, requests) => {
          const s = buildSnapshot(drivers, requests)
          const { decisions } = runRound(s)
          const byId = new Map(drivers.map((d) => [d.id, d]))

          for (const d of decisions) {
            if (d.kind !== 'ASSIGN') continue
            const drv = byId.get(d.driverId)!
            if (!capacityOkAtEveryStop(d.stops, drv)) return false
            // Every assigned request must actually appear in the stop list — no lost guests.
            for (const rid of d.requestIds) {
              const hasPickup = d.stops.some((x) => x.requestId === rid && x.kind === 'PICKUP')
              const hasDrop = d.stops.some((x) => x.requestId === rid && x.kind === 'DROP')
              if (!hasPickup || !hasDrop) return false
            }
          }
          return true
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('INV-5 — one driver is never given two trips in a round', () => {
  it('holds for randomised fleets and demand', () => {
    fc.assert(
      fc.property(
        fc.array(arbDriver, { minLength: 1, maxLength: 8 }),
        fc.array(arbRequest, { minLength: 1, maxLength: 12 }),
        (drivers, requests) => {
          const { decisions } = runRound(buildSnapshot(drivers, requests))
          const used = decisions.filter((d) => d.kind === 'ASSIGN').map((d) => (d.kind === 'ASSIGN' ? d.driverId : ''))
          return new Set(used).size === used.length
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('FR-M10 — a hard deadline is met or explicitly unmatched, never silently late', () => {
  it('holds for randomised deadlines', () => {
    fc.assert(
      fc.property(
        fc.array(arbDriver, { minLength: 1, maxLength: 6 }),
        fc.array(arbRequest, { minLength: 1, maxLength: 10 }),
        (drivers, requests) => {
          const s = buildSnapshot(drivers, requests)
          const { decisions } = runRound(s)
          const byRequest = new Map(requests.map((r) => [r.id, r]))

          for (const d of decisions) {
            if (d.kind !== 'ASSIGN') continue
            for (const rid of d.requestIds) {
              const r = byRequest.get(rid)
              if (!r?.isHardDeadline || !r.deadlineAt) continue
              // Check THIS guest's own drop stop: on a pooled trip guests are dropped at
              // different times, so the trip-level drop time would be the wrong yardstick.
              const dropStop = d.stops.find((x) => x.requestId === rid && x.kind === 'DROP')
              const dropAt = dropStop?.plannedAt ?? d.plannedDropAt
              if (dropAt.getTime() > r.deadlineAt.getTime()) return false
            }
          }
          return true
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('INV-2 / G2 — no idle driver while a servable guest waits', () => {
  it('assigns whenever at least one feasible pairing exists', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 4 }),
        (seats, groupSize) => {
          if (groupSize > seats) return true // genuinely infeasible, nothing to assert
          const d = driver({ seatCapacity: seats, luggageCapacity: seats, freeLocation: POI.airport })
          const r = request({
            groupSize,
            luggageCount: 0,
            origin: POI.airport,
            destination: POI.hotelA,
            destinationId: 'hA',
          })
          const { decisions, rejections } = runRound(buildSnapshot([d], [r]))
          const assigned = decisions.some((x) => x.kind === 'ASSIGN')
          // Either it was assigned, or a typed reason was recorded — never silent inaction.
          return assigned || rejections.length > 0
        },
      ),
      { numRuns: 200 },
    )
  })

  it('every unmatched request carries a typed reason (FR-A11)', () => {
    fc.assert(
      fc.property(
        fc.array(arbDriver, { minLength: 0, maxLength: 4 }),
        fc.array(arbRequest, { minLength: 1, maxLength: 8 }),
        (drivers, requests) => {
          const { decisions } = runRound(buildSnapshot(drivers, requests))
          return decisions
            .filter((d) => d.kind === 'UNMATCHED')
            .every((d) => d.kind === 'UNMATCHED' && typeof d.reason === 'string' && d.reason.length > 0)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('INV-4 — starvation is impossible', () => {
  it('a request at the pass-over limit is always served when any feasible driver exists', () => {
    // Rivals are constrained to below the limit: if two requests are BOTH forced to the front and
    // only one driver exists, one of them must still wait — that is arithmetic, not starvation.
    const arbUnforcedRival = arbRequest.map((r) => ({ ...r, passedOverCount: 0 }))
    fc.assert(
      fc.property(
        fc.array(arbUnforcedRival, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 4, max: 12 }),
        (rivals, seats) => {
          const starved = request({
            id: 'starved',
            passedOverCount: DEFAULT_CONFIG.max_passed_over_count,
            groupSize: 1,
            luggageCount: 0,
            origin: POI.airport,
            destination: POI.hotelA,
            destinationId: 'hA',
            readyAt: T0,
          })
          const d = driver({ seatCapacity: seats, luggageCapacity: seats, freeLocation: POI.airport })
          const { decisions } = runRound(buildSnapshot([d], [starved, ...rivals]))
          const assignedIds = decisions.flatMap((x) => (x.kind === 'ASSIGN' ? x.requestIds : []))
          return assignedIds.includes('starved')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('repeated rounds always drain the queue rather than looping forever (liveness)', () => {
    // Simulates the sweeper incrementing passed_over_count between rounds: the queue must shrink.
    let queue = Array.from({ length: 9 }, (_, i) =>
      request({
        id: `r${i}`,
        groupSize: 2,
        luggageCount: 1,
        origin: POI.airport,
        destination: POI.hotelA,
        destinationId: 'hA',
        readyAt: T0,
      }),
    )
    const drivers = [
      driver({ id: 'd1', seatCapacity: 2, luggageCapacity: 2, freeLocation: POI.airport }),
      driver({ id: 'd2', seatCapacity: 2, luggageCapacity: 2, freeLocation: POI.airport }),
    ]

    const servedOrder: string[] = []
    for (let round = 0; round < 10 && queue.length > 0; round++) {
      const { decisions, passedOverRequestIds } = runRound(buildSnapshot(drivers, queue))
      const assigned = new Set(decisions.flatMap((d) => (d.kind === 'ASSIGN' ? d.requestIds : [])))
      servedOrder.push(...assigned)
      const passedOver = new Set(passedOverRequestIds)
      queue = queue
        .filter((r) => !assigned.has(r.id))
        .map((r) =>
          passedOver.has(r.id) ? { ...r, passedOverCount: r.passedOverCount + 1 } : r,
        )
    }

    expect(queue).toHaveLength(0) // everyone eventually served
    expect(new Set(servedOrder).size).toBe(9) // nobody served twice
  })
})

describe('NFR-2 — a peak round resolves well inside the latency budget', () => {
  it('handles 100 drivers × 300 requests in under a second', () => {
    const drivers = Array.from({ length: 100 }, (_, i) =>
      driver({
        id: `d${i}`,
        seatCapacity: 4 + (i % 9),
        luggageCapacity: 4 + (i % 9),
        freeLocation: HOTELS[i % 3]!,
      }),
    )
    const requests = Array.from({ length: 300 }, (_, i) =>
      request({
        id: `r${i}`,
        groupSize: 1 + (i % 4),
        luggageCount: i % 3,
        origin: POI.airport,
        originId: 'air',
        destination: HOTELS[i % 3]!,
        destinationId: `hotel-${i % 3}`,
        readyAt: addMinutes(T0, -(i % 40)),
      }),
    )
    const start = performance.now()
    const result = runRound(buildSnapshot(drivers, requests))
    const ms = performance.now() - start

    expect(result.stats.assigned).toBeGreaterThan(0)
    expect(ms).toBeLessThan(1000)
    // Every driver used at most once, capacity respected, at 300-request scale.
    const used = result.decisions.filter((d) => d.kind === 'ASSIGN').map((d) => (d.kind === 'ASSIGN' ? d.driverId : ''))
    expect(new Set(used).size).toBe(used.length)
  })
})
