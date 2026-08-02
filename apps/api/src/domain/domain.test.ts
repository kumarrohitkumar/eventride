import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, addMinutes } from '@eventride/shared'
import { autoQueueDueAt, computeDeadline, waitSeverity } from './deadlines.js'
import {
  allocateVehiclesForWave,
  groupReturnRequests,
  hasMissedWave,
  planVenueWaves,
} from './waves.js'
import {
  autoQueueable,
  breakDue,
  breaksToEnd,
  dutyCapReached,
  expiredOffers,
  noShowEligible,
  staleLocations,
  waitBreaches,
} from '../dispatch/sweeper-rules.js'

const cfg = DEFAULT_CONFIG
const T0 = new Date('2026-03-10T08:00:00.000Z')

describe('computeDeadline (D3, D7, FR-M10)', () => {
  it('works backwards from a flight time using the airport buffer (150 min)', () => {
    const flightAt = new Date('2026-03-10T18:00:00.000Z')
    const result = computeDeadline({
      tripType: 'DEPARTURE',
      referenceAt: flightAt,
      destinationType: 'AIRPORT',
      config: cfg,
    })
    expect(result.isHardDeadline).toBe(true)
    expect(result.bufferMinutes).toBe(150)
    expect(result.deadlineAt?.toISOString()).toBe('2026-03-10T15:30:00.000Z')
  })

  it('uses the much shorter station buffer (45 min) for a train', () => {
    const result = computeDeadline({
      tripType: 'DEPARTURE',
      referenceAt: new Date('2026-03-10T18:00:00.000Z'),
      destinationType: 'STATION',
      config: cfg,
    })
    expect(result.bufferMinutes).toBe(45)
    expect(result.deadlineAt?.toISOString()).toBe('2026-03-10T17:15:00.000Z')
  })

  it('applies the venue buffer for TO_VENUE', () => {
    const result = computeDeadline({
      tripType: 'TO_VENUE',
      referenceAt: new Date('2026-03-10T09:00:00.000Z'),
      destinationType: 'VENUE',
      config: cfg,
    })
    expect(result.bufferKey).toBe('venue_arrival_buffer_min')
    expect(result.deadlineAt?.toISOString()).toBe('2026-03-10T08:45:00.000Z')
  })

  it('gives ARRIVAL and FROM_VENUE no hard deadline (they are soft by definition)', () => {
    for (const tripType of ['ARRIVAL', 'FROM_VENUE', 'AD_HOC'] as const) {
      const result = computeDeadline({
        tripType,
        referenceAt: T0,
        destinationType: 'ACCOMMODATION',
        config: cfg,
      })
      expect(result.isHardDeadline).toBe(false)
      expect(result.deadlineAt).toBeNull()
    }
  })

  it('returns no deadline when the reference time is unknown, rather than inventing one', () => {
    const result = computeDeadline({
      tripType: 'DEPARTURE',
      referenceAt: null,
      destinationType: 'AIRPORT',
      config: cfg,
    })
    expect(result.deadlineAt).toBeNull()
    expect(result.isHardDeadline).toBe(false)
  })

  it('reports which config key produced the number, so the admin UI can explain it', () => {
    const result = computeDeadline({
      tripType: 'DEPARTURE',
      referenceAt: T0,
      destinationType: 'AIRPORT',
      config: cfg,
    })
    expect(result.bufferKey).toBe('airport_departure_buffer_min')
  })
})

describe('waitSeverity / autoQueueDueAt (FR-A4, FR-G4, D8)', () => {
  it('escalates OK → WARN → CRITICAL at the configured thresholds', () => {
    expect(waitSeverity(T0, addMinutes(T0, 5), cfg)).toBe('OK')
    expect(waitSeverity(T0, addMinutes(T0, 20), cfg)).toBe('WARN')
    expect(waitSeverity(T0, addMinutes(T0, 45), cfg)).toBe('CRITICAL')
  })

  it('measures from readyAt, so a reassignment cannot reset a guest’s clock (D8)', () => {
    expect(waitSeverity(T0, addMinutes(T0, 31), cfg)).toBe('CRITICAL')
  })

  it('queues a silent guest 20 minutes after their scheduled time', () => {
    expect(autoQueueDueAt(T0, cfg).toISOString()).toBe('2026-03-10T08:20:00.000Z')
  })
})

describe('planVenueWaves (FR-M4, FR-M5, D2)', () => {
  const sessionStartsAt = new Date('2026-03-10T09:00:00.000Z')

  it('spaces waves backwards so the LAST one still arrives before the session', () => {
    const waves = planVenueWaves({
      eventDay: T0,
      origins: [{ id: 'hotel-a', guestCount: 60 }],
      destinationId: 'venue',
      sessionStartsAt,
      config: cfg,
    })
    expect(waves).toHaveLength(3)
    // latest departure = 09:00 − 15 min buffer = 08:45, then −30 and −60
    expect(waves.map((w) => w.departsAt.toISOString())).toEqual([
      '2026-03-10T07:45:00.000Z',
      '2026-03-10T08:15:00.000Z',
      '2026-03-10T08:45:00.000Z',
    ])
  })

  it('covers every guest across the waves', () => {
    const waves = planVenueWaves({
      eventDay: T0,
      origins: [{ id: 'hotel-a', guestCount: 61 }],
      destinationId: 'venue',
      sessionStartsAt,
      config: cfg,
    })
    expect(waves.reduce((sum, w) => sum + w.seatsNeeded, 0)).toBe(61)
  })

  it('plans independently per accommodation (multi-accommodation, E11)', () => {
    const waves = planVenueWaves({
      eventDay: T0,
      origins: [
        { id: 'hotel-a', guestCount: 30 },
        { id: 'hotel-b', guestCount: 20 },
        { id: 'hotel-c', guestCount: 0 },
      ],
      destinationId: 'venue',
      sessionStartsAt,
      config: cfg,
    })
    expect(new Set(waves.map((w) => w.originId))).toEqual(new Set(['hotel-a', 'hotel-b']))
    // An accommodation with no guests gets no waves — no empty buses.
    expect(waves.some((w) => w.originId === 'hotel-c')).toBe(false)
  })

  it('returns nothing for a zero wave count rather than throwing', () => {
    expect(
      planVenueWaves({
        eventDay: T0,
        origins: [{ id: 'a', guestCount: 5 }],
        destinationId: 'v',
        sessionStartsAt,
        waveCount: 0,
        config: cfg,
      }),
    ).toEqual([])
  })
})

describe('allocateVehiclesForWave (FR-M6, FR-M17)', () => {
  const fleet = [
    { id: 'bus', seatCapacity: 20 },
    { id: 'tempo', seatCapacity: 12 },
    { id: 'suv', seatCapacity: 6 },
    { id: 'sedan', seatCapacity: 4 },
  ]

  it('fills largest-first so a wave uses the fewest vehicles', () => {
    const result = allocateVehiclesForWave(30, fleet)
    expect(result.chosen).toEqual(['bus', 'tempo'])
    expect(result.seatsCovered).toBe(32)
    expect(result.seatsShort).toBe(0)
  })

  it('quantifies the shortfall instead of silently under-serving (FR-M17)', () => {
    const result = allocateVehiclesForWave(60, fleet)
    expect(result.seatsShort).toBe(18) // 60 needed, 42 available
  })

  it('uses one vehicle for a small wave', () => {
    expect(allocateVehiclesForWave(3, fleet).chosen).toHaveLength(1)
  })

  it('is deterministic when capacities tie', () => {
    const tied = [
      { id: 'b', seatCapacity: 4 },
      { id: 'a', seatCapacity: 4 },
    ]
    expect(allocateVehiclesForWave(4, tied).chosen).toEqual(['a'])
  })
})

describe('groupReturnRequests / hasMissedWave (FR-M7, FR-M8)', () => {
  it('pools return guests by accommodation within a rolling window', () => {
    const now = addMinutes(T0, 10)
    const groups = groupReturnRequests(
      [
        { destinationId: 'hotel-a', readyAt: T0 },
        { destinationId: 'hotel-a', readyAt: addMinutes(T0, 3) },
        { destinationId: 'hotel-b', readyAt: T0 },
      ],
      now,
      10,
    )
    // Two hotel-a guests share a bucket; hotel-b is separate — never pooled across directions.
    const hotelAGroups = [...groups.entries()].filter(([k]) => k.startsWith('hotel-a:'))
    expect(hotelAGroups).toHaveLength(1)
    expect(hotelAGroups[0]![1]).toHaveLength(2)
    expect([...groups.keys()].some((k) => k.startsWith('hotel-b:'))).toBe(true)
  })

  it('ignores guests who are not ready yet', () => {
    const groups = groupReturnRequests([{ destinationId: 'h', readyAt: addMinutes(T0, 30) }], T0, 10)
    expect(groups.size).toBe(0)
  })

  it('detects a missed wave so the guest falls back to individual matching (FR-M8)', () => {
    expect(hasMissedWave(T0, addMinutes(T0, 3))).toBe(false)
    expect(hasMissedWave(T0, addMinutes(T0, 20))).toBe(true)
  })
})

describe('sweeper rules (FR-M26, D32, LLD §7)', () => {
  it('expires an offer after the configured window (FR-D5, E3)', () => {
    const offers = [
      { tripId: 'fresh', offeredAt: addMinutes(T0, -0.5) },
      { tripId: 'stale', offeredAt: addMinutes(T0, -2) },
    ]
    expect(expiredOffers(offers, T0, cfg)).toEqual(['stale'])
  })

  it('auto-queues a guest who never tapped ready, but not one who did (FR-G4)', () => {
    const rows = [
      { requestId: 'silent', scheduledAt: addMinutes(T0, -30), hasTappedReady: false },
      { requestId: 'tapped', scheduledAt: addMinutes(T0, -30), hasTappedReady: true },
      { requestId: 'too-early', scheduledAt: addMinutes(T0, -5), hasTappedReady: false },
    ]
    expect(autoQueueable(rows, T0, cfg)).toEqual(['silent'])
  })

  it('allows a no-show only after the 10-minute wait (FR-D11, E4)', () => {
    const rows = [
      { tripId: 't1', requestId: 'waited', arrivedAt: addMinutes(T0, -12) },
      { tripId: 't2', requestId: 'just-arrived', arrivedAt: addMinutes(T0, -2) },
    ]
    expect(noShowEligible(rows, T0, cfg)).toEqual(['waited'])
  })

  it('marks a break due on EITHER trigger — minutes or trips (FR-D9, D15)', () => {
    const rows = [
      { driverId: 'by-minutes', drivingMinutesToday: 245, tripsSinceBreak: 1, breakState: 'NONE' as const, breakStartedAt: null, shiftStart: T0 },
      { driverId: 'by-trips', drivingMinutesToday: 30, tripsSinceBreak: 6, breakState: 'NONE' as const, breakStartedAt: null, shiftStart: T0 },
      { driverId: 'fresh', drivingMinutesToday: 30, tripsSinceBreak: 1, breakState: 'NONE' as const, breakStartedAt: null, shiftStart: T0 },
      { driverId: 'already-on-break', drivingMinutesToday: 999, tripsSinceBreak: 9, breakState: 'ON_BREAK' as const, breakStartedAt: T0, shiftStart: T0 },
    ]
    expect(breakDue(rows, cfg)).toEqual(['by-minutes', 'by-trips'])
  })

  it('ends a break once its duration has elapsed', () => {
    const rows = [
      { driverId: 'done', drivingMinutesToday: 0, tripsSinceBreak: 0, breakState: 'ON_BREAK' as const, breakStartedAt: addMinutes(T0, -31), shiftStart: T0 },
      { driverId: 'resting', drivingMinutesToday: 0, tripsSinceBreak: 0, breakState: 'ON_BREAK' as const, breakStartedAt: addMinutes(T0, -5), shiftStart: T0 },
    ]
    expect(breaksToEnd(rows, T0, cfg)).toEqual(['done'])
  })

  it('enforces the 10-hour duty cap regardless of queue pressure (D15 safety rule)', () => {
    const rows = [
      { driverId: 'over', drivingMinutesToday: 0, tripsSinceBreak: 0, breakState: 'NONE' as const, breakStartedAt: null, shiftStart: addMinutes(T0, -11 * 60) },
      { driverId: 'within', drivingMinutesToday: 0, tripsSinceBreak: 0, breakState: 'NONE' as const, breakStartedAt: null, shiftStart: addMinutes(T0, -4 * 60) },
    ]
    expect(dutyCapReached(rows, T0, cfg)).toEqual(['over'])
  })

  it('separates warn from critical wait breaches (FR-A4)', () => {
    const rows = [
      { requestId: 'ok', readyAt: addMinutes(T0, -5) },
      { requestId: 'warn', readyAt: addMinutes(T0, -20) },
      { requestId: 'critical', readyAt: addMinutes(T0, -45) },
    ]
    expect(waitBreaches(rows, T0, cfg)).toEqual({ warn: ['warn'], critical: ['critical'] })
  })

  it('flags a driver whose location froze mid-trip, including one that never reported (E20)', () => {
    const rows = [
      { driverId: 'stale', onActiveTrip: true, lastLocationAt: addMinutes(T0, -5) },
      { driverId: 'never-reported', onActiveTrip: true, lastLocationAt: null },
      { driverId: 'live', onActiveTrip: true, lastLocationAt: addMinutes(T0, -1) },
      { driverId: 'idle-and-stale', onActiveTrip: false, lastLocationAt: addMinutes(T0, -60) },
    ]
    // Only drivers on an ACTIVE trip matter — an idle driver's stale ping is not an incident.
    expect(staleLocations(rows, T0, cfg)).toEqual(['stale', 'never-reported'])
  })
})
