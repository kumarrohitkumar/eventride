import { describe, it, expect } from 'vitest'
import { partitionDecisions, validateDecision, type WorldSlice } from './applier.js'
import type { Decision } from '@eventride/engine'
import type { PlannedStop } from '@eventride/shared'

const AT = { lat: 12.97, lng: 77.6 }

const stops = (seats: number, luggage = 1): PlannedStop[] => [
  { kind: 'PICKUP', requestId: 'req-1', locationId: 'air', at: AT, seatsDelta: seats, luggageDelta: luggage },
  { kind: 'DROP', requestId: 'req-1', locationId: 'hA', at: AT, seatsDelta: -seats, luggageDelta: -luggage },
]

const world = (over: Partial<WorldSlice> = {}): WorldSlice => ({
  drivers: new Map([
    ['drv-1', { id: 'drv-1', state: 'AVAILABLE', seatCapacity: 4, luggageCapacity: 4, version: 0, breakState: 'NONE' }],
  ]),
  requests: new Map([['req-1', { id: 'req-1', state: 'QUEUED', groupSize: 2, luggageCount: 1 }]]),
  trips: new Map(),
  ...over,
})

const assign = (over: Partial<Extract<Decision, { kind: 'ASSIGN' }>> = {}): Decision => ({
  kind: 'ASSIGN',
  driverId: 'drv-1',
  requestIds: ['req-1'],
  stops: stops(2),
  score: { total: 10, parts: {} },
  plannedPickupAt: new Date('2026-03-10T08:10:00Z'),
  plannedDropAt: new Date('2026-03-10T08:40:00Z'),
  ...over,
})

describe('validateDecision — ASSIGN', () => {
  it('accepts a decision that still holds', () => {
    expect(validateDecision(assign(), world())).toEqual({ ok: true })
  })

  it('skips when the driver accepted another trip in the meantime (INV-5)', () => {
    const w = world()
    w.drivers.get('drv-1')!.state = 'ON_TRIP'
    expect(validateDecision(assign(), w)).toMatchObject({ ok: false, reason: 'DRIVER_NOT_AVAILABLE' })
  })

  it('skips when the driver went on break between snapshot and commit', () => {
    const w = world()
    w.drivers.get('drv-1')!.breakState = 'DUE'
    expect(validateDecision(assign(), w)).toMatchObject({ ok: false, reason: 'DRIVER_ON_BREAK' })
  })

  it('skips when the driver row disappeared', () => {
    const w = world({ drivers: new Map() })
    expect(validateDecision(assign(), w)).toMatchObject({ ok: false, reason: 'DRIVER_GONE' })
  })

  it('skips when the guest was cancelled or already served', () => {
    const w = world()
    w.requests.get('req-1')!.state = 'CANCELLED'
    expect(validateDecision(assign(), w)).toMatchObject({ ok: false, reason: 'REQUEST_NOT_QUEUED' })
  })

  it('REFUSES a capacity-violating decision even though the engine produced it (INV-1)', () => {
    // This is the whole point of the layer: a bug upstream must not become a bug in the database.
    const w = world()
    w.drivers.get('drv-1')!.seatCapacity = 1
    expect(validateDecision(assign({ stops: stops(4) }), w)).toMatchObject({
      ok: false,
      reason: 'CAPACITY_VIOLATION',
    })
  })

  it('checks EVERY pooled request, not just the first', () => {
    const w = world()
    w.requests.set('req-2', { id: 'req-2', state: 'COMPLETED', groupSize: 1, luggageCount: 0 })
    const decision = assign({ requestIds: ['req-1', 'req-2'] })
    expect(validateDecision(decision, w)).toMatchObject({ ok: false, reason: 'REQUEST_NOT_QUEUED' })
  })
})

describe('validateDecision — INSERT_DETOUR', () => {
  const detour = (over: Partial<Extract<Decision, { kind: 'INSERT_DETOUR' }>> = {}): Decision => ({
    kind: 'INSERT_DETOUR',
    tripId: 'trp-1',
    driverId: 'drv-1',
    requestId: 'req-1',
    position: 0,
    addedMinutes: 4,
    stops: [
      { kind: 'PICKUP', requestId: 'req-1', locationId: 'curb', at: AT, seatsDelta: 2, luggageDelta: 1 },
      { kind: 'DROP', requestId: 'onboard', locationId: 'hA', at: AT, seatsDelta: -1, luggageDelta: -1 },
      { kind: 'DROP', requestId: 'req-1', locationId: 'hA', at: AT, seatsDelta: -2, luggageDelta: -1 },
    ],
    score: { total: 5, parts: {} },
    ...over,
  })

  const withTrip = (over: Partial<WorldSlice['trips'] extends Map<string, infer T> ? T : never> = {}) => {
    const w = world()
    w.drivers.get('drv-1')!.state = 'ON_TRIP'
    w.trips.set('trp-1', {
      id: 'trp-1',
      driverId: 'drv-1',
      state: 'ON_TRIP',
      isPinned: false,
      seatsUsed: 1,
      luggageUsed: 1,
      ...over,
    })
    return w
  }

  it('accepts a valid insertion into a live trip', () => {
    expect(validateDecision(detour(), withTrip())).toEqual({ ok: true })
  })

  it('counts the guests already aboard when checking capacity', () => {
    // 1 aboard + a group of 2 = 3, inside a 4-seater.
    expect(validateDecision(detour(), withTrip({ seatsUsed: 1 }))).toEqual({ ok: true })
    // 3 aboard + 2 more = 5, over the 4-seater.
    const tooFull = withTrip({ seatsUsed: 3, luggageUsed: 3 })
    expect(validateDecision(detour(), tooFull)).toMatchObject({ reason: 'CAPACITY_VIOLATION' })
  })

  it('never modifies an admin-pinned trip (E16)', () => {
    expect(validateDecision(detour(), withTrip({ isPinned: true }))).toMatchObject({
      ok: false,
      reason: 'TRIP_PINNED',
    })
  })

  it('skips when the trip finished between snapshot and commit', () => {
    expect(validateDecision(detour(), withTrip({ state: 'COMPLETED' }))).toMatchObject({
      ok: false,
      reason: 'TRIP_NOT_ACTIVE',
    })
  })

  it('skips when the trip row is gone', () => {
    expect(validateDecision(detour(), world())).toMatchObject({ ok: false, reason: 'TRIP_GONE' })
  })
})

describe('partitionDecisions', () => {
  it('applies the valid ones and reports the rest with reasons — one stale decision never aborts a round', () => {
    const w = world()
    w.requests.set('req-2', { id: 'req-2', state: 'CANCELLED', groupSize: 1, luggageCount: 0 })
    // A second driver, so the skip is attributable to the cancelled guest rather than to the
    // first decision having already reserved drv-1.
    w.drivers.set('drv-2', {
      id: 'drv-2',
      state: 'AVAILABLE',
      seatCapacity: 4,
      luggageCapacity: 4,
      version: 0,
      breakState: 'NONE',
    })
    const outcome = partitionDecisions(
      [
        assign(),
        assign({ driverId: 'drv-2', requestIds: ['req-2'] }),
        { kind: 'UNMATCHED', requestId: 'req-3', reason: 'NO_CAPACITY' },
      ],
      w,
    )
    expect(outcome.applied).toHaveLength(2) // the good ASSIGN and the UNMATCHED bookkeeping
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0]!.reason).toBe('REQUEST_NOT_QUEUED')
  })

  it('prevents two decisions in the SAME round from claiming one driver (INV-5)', () => {
    const w = world()
    w.requests.set('req-2', { id: 'req-2', state: 'QUEUED', groupSize: 1, luggageCount: 0 })
    const outcome = partitionDecisions(
      [assign(), assign({ requestIds: ['req-2'], stops: stops(1) })],
      w,
    )
    expect(outcome.applied).toHaveLength(1)
    expect(outcome.skipped[0]!.reason).toBe('DRIVER_NOT_AVAILABLE')
  })

  it('passes bookkeeping decisions through untouched', () => {
    const outcome = partitionDecisions(
      [{ kind: 'SHORTFALL', seatsShort: 12, guestsAffected: 5, horizonMin: 60 }],
      world(),
    )
    expect(outcome.applied).toHaveLength(1)
    expect(outcome.skipped).toHaveLength(0)
  })
})
