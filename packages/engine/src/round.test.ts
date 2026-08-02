import { describe, it, expect } from 'vitest'
import { runRound, matchIncremental, planBatch } from './round.js'
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
import type { Decision } from './types.js'

const s = (over = {}) => snapshot(over)
const assigns = (d: Decision[]) => d.filter((x) => x.kind === 'ASSIGN')
const unmatched = (d: Decision[]) => d.filter((x) => x.kind === 'UNMATCHED')

describe('matchIncremental (FR-M2)', () => {
  it('assigns the best driver and records the runner-up (FR-M23)', () => {
    const near = driver({ id: 'near', freeLocation: POI.airport })
    const far = driver({ id: 'far', freeLocation: POI.hotelC })
    const r = request({ origin: POI.airport })
    const { decision } = matchIncremental(r, s({ drivers: [near, far], requests: [r] }))
    expect(decision.kind).toBe('ASSIGN')
    if (decision.kind !== 'ASSIGN') return
    expect(decision.driverId).toBe('near')
    expect(decision.runnerUpDriverId).toBe('far')
  })

  it('returns a typed UNMATCHED reason when nobody is online (FR-A11)', () => {
    const r = request()
    const { decision } = matchIncremental(
      r,
      s({ drivers: [driver({ state: 'OFFLINE' })], requests: [r] }),
    )
    expect(decision).toMatchObject({ kind: 'UNMATCHED', reason: 'NO_DRIVER_ONLINE' })
  })

  it('reports DEADLINE_INFEASIBLE rather than dispatching a driver who would be late', () => {
    const r = request({
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 5),
      origin: POI.airport,
      destination: POI.hotelA,
    })
    const { decision } = matchIncremental(r, s({ requests: [r] }))
    expect(decision).toMatchObject({ kind: 'UNMATCHED', reason: 'DEADLINE_INFEASIBLE' })
  })

  it('returns every rejection so INV-2 can be audited', () => {
    const r = request({ groupSize: 4 })
    const drivers = [driver({ seatCapacity: 1 }), driver({ seatCapacity: 2 })]
    const { rejections } = matchIncremental(r, s({ drivers, requests: [r], fleetMaxSeats: 4 }))
    expect(rejections).toHaveLength(2)
    expect(rejections.every((x) => x.reason === 'NO_CAPACITY')).toBe(true)
  })

  it('respects the excluded-driver set (reserved or already used this round)', () => {
    const only = driver({ id: 'only' })
    const r = request()
    const { decision } = matchIncremental(r, s({ drivers: [only], requests: [r] }), new Set(['only']))
    expect(decision.kind).toBe('UNMATCHED')
  })
})

describe('planBatch (FR-M1)', () => {
  it('assigns distinct drivers to distinct requests — never double-books (INV-5)', () => {
    const drivers = [driver(), driver(), driver()]
    const requests = [request(), request(), request()]
    const { decisions } = planBatch(requests, s({ drivers, requests }))
    const used = assigns(decisions).map((d) => (d.kind === 'ASSIGN' ? d.driverId : ''))
    expect(new Set(used).size).toBe(used.length)
  })

  it('pools same-destination guests into one vehicle when capacity allows (FR-M15)', () => {
    const one = driver({ id: 'solo', seatCapacity: 4, luggageCapacity: 4, freeLocation: POI.airport })
    const shared = {
      origin: POI.airport,
      originId: 'air',
      destination: POI.hotelA,
      destinationId: 'hA',
      readyAt: T0,
      groupSize: 1,
      luggageCount: 1,
    }
    const requests = [request(shared), request(shared), request(shared)]
    const { decisions } = planBatch(requests, s({ drivers: [one], requests }))
    const assigned = assigns(decisions)
    expect(assigned).toHaveLength(1)
    if (assigned[0]?.kind !== 'ASSIGN') return
    expect(assigned[0].requestIds).toHaveLength(3) // all three share the ride
  })

  it('never pools beyond capacity — the 5th guest is unmatched, not squeezed in (INV-1)', () => {
    const one = driver({ id: 'solo', seatCapacity: 4, luggageCapacity: 4, freeLocation: POI.airport })
    const shared = {
      origin: POI.airport,
      originId: 'air',
      destination: POI.hotelA,
      destinationId: 'hA',
      readyAt: T0,
      groupSize: 1,
      luggageCount: 1,
    }
    const requests = Array.from({ length: 6 }, () => request(shared))
    const { decisions } = planBatch(requests, s({ drivers: [one], requests }))
    const assigned = assigns(decisions)
    if (assigned[0]?.kind !== 'ASSIGN') return
    expect(assigned[0].requestIds.length).toBeLessThanOrEqual(4)
    expect(capacityOkAtEveryStop(assigned[0].stops, one)).toBe(true)
    expect(unmatched(decisions).length).toBeGreaterThan(0)
  })

  it('serves the highest-priority request first when drivers are scarce', () => {
    const one = driver({ id: 'solo' })
    const vip = request({ isVip: true, id: 'vip-req' })
    const normal = request({ id: 'normal-req' })
    const { decisions } = planBatch([normal, vip], s({ drivers: [one], requests: [normal, vip] }))
    const assigned = assigns(decisions)
    expect(assigned).toHaveLength(1)
    if (assigned[0]?.kind !== 'ASSIGN') return
    expect(assigned[0].requestIds).toContain('vip-req')
  })

  it('splits a group larger than any vehicle (FR-M16, E8)', () => {
    const drivers = [driver({ seatCapacity: 6, luggageCapacity: 6 })]
    const big = request({ groupSize: 9, luggageCount: 9 })
    const { decisions } = planBatch([big], s({ drivers, requests: [big], fleetMaxSeats: 6 }))
    const split = decisions.find((d) => d.kind === 'SPLIT')
    expect(split).toBeDefined()
    if (split?.kind !== 'SPLIT') return
    expect(split.parts.map((p) => p.groupSize)).toEqual([6, 3])
    expect(split.parts.reduce((a, p) => a + p.luggageCount, 0)).toBe(9)
  })

  it('refuses to auto-split beyond the configured vehicle cap', () => {
    const drivers = [driver({ seatCapacity: 4 })]
    const huge = request({ groupSize: 20, luggageCount: 4 })
    const cfg = withConfig({ auto_split_max_vehicles: 2 })
    const { decisions } = planBatch(
      [huge],
      s({ drivers, requests: [huge], fleetMaxSeats: 4, config: cfg }),
    )
    expect(decisions.find((d) => d.kind === 'SPLIT')).toBeUndefined()
    expect(unmatched(decisions)[0]).toMatchObject({ reason: 'GROUP_TOO_LARGE' })
  })

  it('marks everyone unmatched when the fleet is entirely offline', () => {
    const requests = [request(), request()]
    const { decisions } = planBatch(requests, s({ drivers: [], requests }))
    expect(unmatched(decisions)).toHaveLength(2)
  })
})

describe('runRound orchestration (LLD §6.9)', () => {
  it('prefers a detour on an in-progress trip over a fresh deadhead assignment', () => {
    const LIVE = { lat: 13.05, lng: 77.65 }
    const CURB = { lat: 13.052, lng: 77.651 }
    const oracle = tableOracle([
      [LIVE, POI.hotelA, 30],
      [LIVE, CURB, 2],
      [CURB, POI.hotelA, 29],
      [POI.hotelC, CURB, 40], // the idle driver is far away
      [POI.hotelC, POI.hotelA, 45],
    ])
    const enRoute = driver({
      id: 'enroute',
      state: 'ON_TRIP',
      seatCapacity: 6,
      luggageCapacity: 6,
      livePosition: LIVE,
      freeLocation: POI.hotelA,
    })
    const idle = driver({ id: 'idle', freeLocation: POI.hotelC })
    const trip = activeTrip({
      id: 'trp-1',
      driverId: 'enroute',
      remainingStops: [
        stop({ kind: 'DROP', requestId: 'onboard', at: POI.hotelA, locationId: 'hA', seatsDelta: -2, luggageDelta: -2 }),
      ],
      requestIds: ['onboard'],
      seatsUsed: 2,
      luggageUsed: 2,
      committedDeadlines: [{ requestId: 'onboard', deadlineAt: null }],
    })
    const waiting = request({ origin: CURB, originId: 'curb', destination: POI.hotelA, destinationId: 'hA' })

    const result = runRound(
      s({ drivers: [enRoute, idle], requests: [waiting], activeTrips: [trip], travel: oracle }),
    )
    expect(result.stats.detours).toBe(1)
    expect(result.stats.assigned).toBe(0)
  })

  it('inserts at most one detour per trip per round (D24)', () => {
    const LIVE = { lat: 13.05, lng: 77.65 }
    const CURB = { lat: 13.052, lng: 77.651 }
    const oracle = tableOracle([
      [LIVE, POI.hotelA, 30],
      [LIVE, CURB, 2],
      [CURB, POI.hotelA, 29],
    ])
    const d = driver({
      id: 'enroute',
      state: 'ON_TRIP',
      seatCapacity: 8,
      luggageCapacity: 8,
      livePosition: LIVE,
      freeLocation: POI.hotelA,
    })
    const trip = activeTrip({
      id: 'trp-1',
      driverId: 'enroute',
      remainingStops: [
        stop({ kind: 'DROP', requestId: 'onboard', at: POI.hotelA, locationId: 'hA', seatsDelta: -1, luggageDelta: -1 }),
      ],
      seatsUsed: 1,
      luggageUsed: 1,
      committedDeadlines: [{ requestId: 'onboard', deadlineAt: null }],
    })
    const waiting = [
      request({ origin: CURB, originId: 'curb', destination: POI.hotelA, destinationId: 'hA' }),
      request({ origin: CURB, originId: 'curb', destination: POI.hotelA, destinationId: 'hA' }),
    ]
    const result = runRound(s({ drivers: [d], requests: waiting, activeTrips: [trip], travel: oracle }))
    expect(result.stats.detours).toBe(1)
  })

  it('uses the batch path for a burst and the incremental path for a trickle', () => {
    const drivers = Array.from({ length: 10 }, () => driver())
    const burst = Array.from({ length: 8 }, () => request())
    const burstResult = runRound(s({ drivers, requests: burst }))
    expect(burstResult.stats.assigned).toBeGreaterThan(0)

    const trickle = [request()]
    const trickleResult = runRound(s({ drivers, requests: trickle }))
    expect(trickleResult.stats.assigned).toBe(1)
  })

  it('never assigns one driver to two separate trips in a round (INV-5)', () => {
    const one = driver({ id: 'solo' })
    const requests = Array.from({ length: 5 }, () =>
      request({ destinationId: `h${Math.random()}`, destination: POI.hotelC }),
    )
    const result = runRound(s({ drivers: [one], requests }))
    const driverIds = assigns(result.decisions).map((d) => (d.kind === 'ASSIGN' ? d.driverId : ''))
    expect(new Set(driverIds).size).toBe(driverIds.length)
  })

  it('records pass-overs so a skipped guest cannot be skipped forever (INV-4)', () => {
    // A pass-over is specifically a HIGHER-priority request left waiting while a LOWER-priority
    // one is served. Here the long-waiting group of 4 is blocked (its only big-enough vehicle is
    // cooling down from rejecting it), while a fresh single guest gets the small car.
    const bigVehicle = driver({ id: 'big', seatCapacity: 4, freeLocation: POI.airport })
    const smallVehicle = driver({ id: 'small', seatCapacity: 2, freeLocation: POI.airport })

    const starving = request({
      id: 'starving',
      groupSize: 4,
      luggageCount: 1,
      readyAt: addMinutes(T0, -60), // waited an hour ⇒ highest priority
      origin: POI.airport,
      destination: POI.hotelA,
      destinationId: 'hA',
    })
    const fresh = request({
      id: 'fresh',
      groupSize: 1,
      readyAt: T0,
      origin: POI.airport,
      destination: POI.hotelA,
      destinationId: 'hA',
    })

    const result = runRound(
      s({
        drivers: [{ ...bigVehicle, cooldownRequestIds: [starving.id] }, smallVehicle],
        requests: [starving, fresh],
        fleetMaxSeats: 4,
      }),
    )

    const assignedIds = assigns(result.decisions).flatMap((d) =>
      d.kind === 'ASSIGN' ? d.requestIds : [],
    )
    expect(assignedIds).toContain('fresh')
    expect(assignedIds).not.toContain('starving')
    expect(result.passedOverRequestIds).toContain('starving')
  })

  it('forces a request to the front once it has been passed over too often (INV-4)', () => {
    const one = driver({ id: 'solo', freeLocation: POI.airport })
    const starved = request({
      id: 'starved',
      passedOverCount: 3, // at the configured limit
      readyAt: T0,
      origin: POI.airport,
      destination: POI.hotelA,
      destinationId: 'hA',
    })
    // A VIP who waited an hour would normally win outright.
    const privileged = request({
      id: 'vip',
      isVip: true,
      readyAt: addMinutes(T0, -60),
      origin: POI.airport,
      destination: POI.hotelA,
      destinationId: 'hA',
    })
    const result = runRound(s({ drivers: [one], requests: [privileged, starved] }))
    const assignedIds = assigns(result.decisions).flatMap((d) =>
      d.kind === 'ASSIGN' ? d.requestIds : [],
    )
    expect(assignedIds).toContain('starved')
  })

  it('raises a quantified SHORTFALL when demand exceeds the fleet (FR-M17)', () => {
    const requests = [request({ groupSize: 3 }), request({ groupSize: 4 })]
    const result = runRound(s({ drivers: [], requests }))
    const shortfall = result.decisions.find((d) => d.kind === 'SHORTFALL')
    expect(shortfall).toMatchObject({ kind: 'SHORTFALL', seatsShort: 7, guestsAffected: 2 })
  })

  it('holds the only feasible driver for an imminent hard deadline (FR-M22)', () => {
    const only = driver({ id: 'only', freeLocation: POI.hotelA })
    const softNow = request({ id: 'soft', origin: POI.hotelA, destination: POI.hotelC })
    const hardSoon = request({
      id: 'hard',
      state: 'REGISTERED',
      origin: POI.hotelA,
      originId: 'hA',
      destination: POI.venue,
      destinationId: 'ven',
      isHardDeadline: true,
      scheduledAt: addMinutes(T0, 10),
      deadlineAt: addMinutes(T0, 45),
      tripType: 'TO_VENUE',
    })
    const result = runRound(
      s({ drivers: [only], requests: [softNow], upcoming: [hardSoon] }),
    )
    expect(result.decisions.find((d) => d.kind === 'RESERVE')).toMatchObject({
      driverId: 'only',
      requestId: 'hard',
    })
    // ...and the soft request must NOT have taken that driver.
    expect(assigns(result.decisions)).toHaveLength(0)
  })

  it('is deterministic — the same snapshot yields identical decisions (HLD §5.2)', () => {
    const drivers = Array.from({ length: 6 }, (_, i) => driver({ id: `d${i}` }))
    const requests = Array.from({ length: 6 }, (_, i) => request({ id: `r${i}` }))
    const snap = s({ drivers, requests })
    const a = runRound(snap)
    const b = runRound(snap)
    const strip = (d: Decision[]) => JSON.stringify(d)
    expect(strip(a.decisions)).toBe(strip(b.decisions))
  })

  it('reports stats for observability (NFR-7)', () => {
    const result = runRound(s({ drivers: [driver()], requests: [request()] }))
    expect(result.stats.requestsConsidered).toBe(1)
    expect(result.stats.driversConsidered).toBe(1)
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('handles an empty queue without producing decisions', () => {
    const result = runRound(s({ drivers: [driver()], requests: [] }))
    expect(result.decisions).toHaveLength(0)
  })
})
