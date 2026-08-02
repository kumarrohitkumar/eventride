import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { capacityOkAtEveryStop, loadProfile, buildStopsForRequests } from './capacity.js'
import { driver, request, stop, POI } from './testkit.js'

describe('capacityOkAtEveryStop (INV-1 — the single enforcement point)', () => {
  const d = driver({ seatCapacity: 4, luggageCapacity: 4 })

  it('accepts a simple pickup then drop within capacity', () => {
    const stops = [
      stop({ kind: 'PICKUP', seatsDelta: 2, luggageDelta: 2 }),
      stop({ kind: 'DROP', seatsDelta: -2, luggageDelta: -2 }),
    ]
    expect(capacityOkAtEveryStop(stops, d)).toBe(true)
  })

  it('rejects a single group larger than the vehicle', () => {
    const stops = [
      stop({ kind: 'PICKUP', seatsDelta: 5, luggageDelta: 1 }),
      stop({ kind: 'DROP', seatsDelta: -5, luggageDelta: -1 }),
    ]
    expect(capacityOkAtEveryStop(stops, d)).toBe(false)
  })

  it('rejects luggage overflow even when seats fit', () => {
    const stops = [
      stop({ kind: 'PICKUP', seatsDelta: 1, luggageDelta: 5 }),
      stop({ kind: 'DROP', seatsDelta: -1, luggageDelta: -5 }),
    ]
    expect(capacityOkAtEveryStop(stops, d)).toBe(false)
  })

  it('catches an overflow that only occurs MID-sequence (the real pooling bug)', () => {
    // 3 + 3 = 6 on board between the two pickups, then drops. Peak exceeds 4 even though
    // no single group does — this is exactly why capacity is checked at every stop, not per request.
    const stops = [
      stop({ kind: 'PICKUP', seatsDelta: 3, luggageDelta: 1 }),
      stop({ kind: 'PICKUP', seatsDelta: 3, luggageDelta: 1 }),
      stop({ kind: 'DROP', seatsDelta: -3, luggageDelta: -1 }),
      stop({ kind: 'DROP', seatsDelta: -3, luggageDelta: -1 }),
    ]
    expect(capacityOkAtEveryStop(stops, d)).toBe(false)
  })

  it('accepts the same two groups when the first is dropped before the second boards', () => {
    const stops = [
      stop({ kind: 'PICKUP', seatsDelta: 3, luggageDelta: 1 }),
      stop({ kind: 'DROP', seatsDelta: -3, luggageDelta: -1 }),
      stop({ kind: 'PICKUP', seatsDelta: 3, luggageDelta: 1 }),
      stop({ kind: 'DROP', seatsDelta: -3, luggageDelta: -1 }),
    ]
    expect(capacityOkAtEveryStop(stops, d)).toBe(true)
  })

  it('rejects a malformed sequence that drops before it picks up', () => {
    const stops = [stop({ kind: 'DROP', seatsDelta: -1, luggageDelta: -1 })]
    expect(capacityOkAtEveryStop(stops, d)).toBe(false)
  })

  it('accepts an empty sequence', () => {
    expect(capacityOkAtEveryStop([], d)).toBe(true)
  })

  it('exposes the peak load for diagnostics', () => {
    const stops = [
      stop({ kind: 'PICKUP', seatsDelta: 2, luggageDelta: 3 }),
      stop({ kind: 'PICKUP', seatsDelta: 1, luggageDelta: 1 }),
      stop({ kind: 'DROP', seatsDelta: -3, luggageDelta: -4 }),
    ]
    expect(loadProfile(stops)).toEqual({ peakSeats: 3, peakLuggage: 4, endsEmpty: true })
  })
})

describe('capacity property (INV-1 can never be violated)', () => {
  it('any accepted stop sequence has peak load within capacity, for random fleets and groups', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // seat capacity
        fc.integer({ min: 0, max: 20 }), // luggage capacity
        fc.array(
          fc.record({
            seats: fc.integer({ min: 1, max: 9 }),
            bags: fc.integer({ min: 0, max: 9 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (seatCapacity, luggageCapacity, groups) => {
          const d = driver({ seatCapacity, luggageCapacity })
          // pick everyone up, then drop everyone — the worst case for peak load
          const stops = [
            ...groups.map((g, i) =>
              stop({
                kind: 'PICKUP',
                requestId: `r${i}`,
                seatsDelta: g.seats,
                luggageDelta: g.bags,
              }),
            ),
            ...groups.map((g, i) =>
              stop({
                kind: 'DROP',
                requestId: `r${i}`,
                seatsDelta: -g.seats,
                luggageDelta: -g.bags,
              }),
            ),
          ]
          const ok = capacityOkAtEveryStop(stops, d)
          const { peakSeats, peakLuggage } = loadProfile(stops)
          // The check must agree exactly with the peak-load definition of INV-1.
          return ok === (peakSeats <= seatCapacity && peakLuggage <= luggageCapacity)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('buildStopsForRequests', () => {
  it('emits pickup-then-drop with mirrored deltas', () => {
    const r = request({ groupSize: 2, luggageCount: 3, origin: POI.airport, destination: POI.hotelA })
    const stops = buildStopsForRequests([r])
    expect(stops).toHaveLength(2)
    expect(stops[0]).toMatchObject({ kind: 'PICKUP', seatsDelta: 2, luggageDelta: 3 })
    expect(stops[1]).toMatchObject({ kind: 'DROP', seatsDelta: -2, luggageDelta: -3 })
    expect(loadProfile(stops).endsEmpty).toBe(true)
  })

  it('groups all pickups before drops for a shared ride', () => {
    const a = request({ groupSize: 1, luggageCount: 1 })
    const b = request({ groupSize: 1, luggageCount: 1 })
    const stops = buildStopsForRequests([a, b])
    expect(stops.map((s) => s.kind)).toEqual(['PICKUP', 'PICKUP', 'DROP', 'DROP'])
    expect(capacityOkAtEveryStop(stops, driver({ seatCapacity: 2, luggageCapacity: 2 }))).toBe(true)
  })
})
