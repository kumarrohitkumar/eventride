import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_CONFIG, VirtualClock, addMinutes, IllegalTransitionError } from '@eventride/shared'
import { TripService } from './trip.service.js'
import { MemoryRepositories } from './memory-repos.js'
import { DomainError, type DriverRecord, type RequestRecord, type TripStopRecord } from './ports.js'

const T0 = new Date('2026-03-10T08:00:00.000Z')
const AT = { lat: 12.97, lng: 77.6 }

let repos: MemoryRepositories
let clock: VirtualClock
let service: TripService

const seedDriver = (over: Partial<DriverRecord> = {}): DriverRecord => {
  const driver: DriverRecord = {
    id: over.id ?? 'drv-1',
    state: 'AVAILABLE',
    seatCapacity: 4,
    luggageCapacity: 4,
    breakState: 'NONE',
    breakStartedAt: null,
    drivingMinutesToday: 0,
    tripsSinceBreak: 0,
    shiftStart: T0,
    shiftEnd: addMinutes(T0, 600),
    lastLat: 13.0,
    lastLng: 77.65,
    lastLocationAt: T0,
    predictedFreeAt: null,
    version: 0,
    unavailableReason: null,
    ...over,
  }
  repos.driverRows.set(driver.id, driver)
  return driver
}

const seedRequest = (over: Partial<RequestRecord> = {}): RequestRecord => {
  const request: RequestRecord = {
    id: over.id ?? 'req-1',
    guestId: 'gst-1',
    state: 'QUEUED',
    groupSize: 2,
    luggageCount: 1,
    readyAt: T0,
    scheduledAt: T0,
    deadlineAt: null,
    isHardDeadline: false,
    passedOverCount: 0,
    requeueCount: 0,
    tripId: null,
    originId: 'air',
    originLat: 13.19,
    originLng: 77.7,
    destinationId: 'hA',
    unmatchedReason: null,
    declineReason: null,
    ...over,
  }
  repos.requestRows.set(request.id, request)
  return request
}

const stopsFor = (requestId = 'req-1', seats = 2, luggage = 1): Omit<TripStopRecord, 'id' | 'tripId'>[] => [
  { seq: 0, kind: 'PICKUP', requestId, locationId: 'air', ...AT, state: 'PENDING', plannedAt: addMinutes(T0, 10), arrivedAt: null, seatsDelta: seats, luggageDelta: luggage },
  { seq: 1, kind: 'DROP', requestId, locationId: 'hA', ...AT, state: 'PENDING', plannedAt: addMinutes(T0, 40), arrivedAt: null, seatsDelta: -seats, luggageDelta: -luggage },
]

const assignDefault = () =>
  service.assign({
    driverId: 'drv-1',
    requestIds: ['req-1'],
    stops: stopsFor(),
    plannedPickupAt: addMinutes(T0, 10),
    plannedDropAt: addMinutes(T0, 40),
  })

beforeEach(() => {
  repos = new MemoryRepositories()
  clock = new VirtualClock(T0)
  service = new TripService(repos, clock, DEFAULT_CONFIG)
})

describe('assign (FR-M24, INV-1, INV-5)', () => {
  it('creates an offered trip, marks the driver OFFERED and the request ASSIGNED', async () => {
    seedDriver()
    seedRequest()
    const trip = await assignDefault()

    expect(trip.state).toBe('OFFERED')
    expect(trip.offerExpiresAt?.toISOString()).toBe('2026-03-10T08:01:00.000Z') // 60s expiry
    expect(repos.driverRows.get('drv-1')!.state).toBe('OFFERED')
    expect(repos.requestRows.get('req-1')!.state).toBe('ASSIGNED')
    expect(trip.seatsUsed).toBe(2)
  })

  it('REFUSES a second trip for the same driver (INV-5)', async () => {
    seedDriver()
    seedRequest()
    seedRequest({ id: 'req-2' })
    await assignDefault()

    await expect(
      service.assign({
        driverId: 'drv-1',
        requestIds: ['req-2'],
        stops: stopsFor('req-2'),
        plannedPickupAt: T0,
        plannedDropAt: T0,
      }),
    ).rejects.toThrow(/already has an active trip/)
  })

  it('allows a new trip once the previous one COMPLETED', async () => {
    seedDriver()
    seedRequest()
    const trip = await assignDefault()
    await repos.trips.update(trip.id, { state: 'COMPLETED' })
    await repos.drivers.update('drv-1', { state: 'AVAILABLE' })

    seedRequest({ id: 'req-2' })
    await expect(
      service.assign({
        driverId: 'drv-1',
        requestIds: ['req-2'],
        stops: stopsFor('req-2'),
        plannedPickupAt: T0,
        plannedDropAt: T0,
      }),
    ).resolves.toBeDefined()
  })

  it('REFUSES a capacity-violating assignment (INV-1)', async () => {
    seedDriver({ seatCapacity: 1 })
    seedRequest({ groupSize: 4 })
    await expect(
      service.assign({
        driverId: 'drv-1',
        requestIds: ['req-1'],
        stops: stopsFor('req-1', 4),
        plannedPickupAt: T0,
        plannedDropAt: T0,
      }),
    ).rejects.toMatchObject({ code: 'NO_CAPACITY' })
  })

  it('refuses a driver who is owed a break (FR-M11)', async () => {
    seedDriver({ breakState: 'DUE' })
    seedRequest()
    await expect(assignDefault()).rejects.toMatchObject({ code: 'DRIVER_ON_BREAK' })
  })

  it('writes an audit row for every state change (D36)', async () => {
    seedDriver()
    seedRequest()
    await assignDefault()
    expect(repos.auditRows.map((a) => `${a.entityType}:${a.toState}`)).toEqual([
      'driver:OFFERED',
      'request:ASSIGNED',
    ])
  })
})

describe('driver accept / reject (FR-D5, E2, E3)', () => {
  beforeEach(async () => {
    seedDriver()
    seedRequest()
  })

  it('accepts and moves both trip and request forward', async () => {
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    expect(repos.tripRows.get(trip.id)!.state).toBe('ACCEPTED')
    expect(repos.requestRows.get('req-1')!.state).toBe('ACCEPTED')
    expect(repos.driverRows.get('drv-1')!.state).toBe('EN_ROUTE_TO_PICKUP')
  })

  it('REFUSES another driver accepting the trip (row-level RBAC in the service)', async () => {
    const trip = await assignDefault()
    seedDriver({ id: 'drv-2' })
    await expect(service.accept(trip.id, 'drv-2')).rejects.toMatchObject({ code: 'FORBIDDEN_ROW' })
  })

  it('loses the race with 409 TRIP_STALE when the version moved', async () => {
    const trip = await assignDefault()
    await repos.trips.update(trip.id, { version: 5 })
    await expect(service.accept(trip.id, 'drv-1', 0)).rejects.toMatchObject({ code: 'TRIP_STALE' })
  })

  it('re-queues with RAISED priority and PRESERVED readyAt on reject (D8)', async () => {
    const trip = await assignDefault()
    await service.reject(trip.id, 'drv-1', 'too far')

    const request = repos.requestRows.get('req-1')!
    expect(request.state).toBe('QUEUED')
    expect(request.passedOverCount).toBe(1) // moves UP the queue, not down
    expect(request.readyAt?.toISOString()).toBe(T0.toISOString()) // wait clock never reset
    expect(request.tripId).toBeNull()
    expect(repos.driverRows.get('drv-1')!.state).toBe('AVAILABLE')
  })

  it('expires an offer through the identical requeue path (E3)', async () => {
    const trip = await assignDefault()
    await service.expireOffer(trip.id)
    expect(repos.tripRows.get(trip.id)!.state).toBe('EXPIRED')
    expect(repos.requestRows.get('req-1')!.state).toBe('QUEUED')
    expect(repos.driverRows.get('drv-1')!.state).toBe('AVAILABLE')
  })

  it('rejects an illegal transition rather than corrupting state (INV-6)', async () => {
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    await expect(service.accept(trip.id, 'drv-1')).rejects.toThrow(IllegalTransitionError)
  })
})

describe('trip progress (FR-D6)', () => {
  it('walks arrived → boarded → dropped and completes the trip', async () => {
    seedDriver()
    seedRequest()
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    const stops = await repos.trips.stops(trip.id)

    await service.markArrivedAtStop(trip.id, stops[0]!.id, 'drv-1')
    expect(repos.requestRows.get('req-1')!.state).toBe('ARRIVED_PICKUP')

    await service.markBoarded(trip.id, stops[0]!.id, 'drv-1')
    expect(repos.requestRows.get('req-1')!.state).toBe('BOARDED')

    clock.advanceMinutes(30)
    const result = await service.markDropped(trip.id, stops[1]!.id, 'drv-1')
    expect(result.tripCompleted).toBe(true)
    expect(repos.requestRows.get('req-1')!.state).toBe('COMPLETED')
    expect(repos.driverRows.get('drv-1')!.state).toBe('AVAILABLE')
  })

  it('keeps a POOLED trip active until the last guest is dropped', async () => {
    seedDriver({ seatCapacity: 6, luggageCapacity: 6 })
    seedRequest({ id: 'req-1', groupSize: 1, luggageCount: 1 })
    seedRequest({ id: 'req-2', groupSize: 1, luggageCount: 1 })
    const trip = await service.assign({
      driverId: 'drv-1',
      requestIds: ['req-1', 'req-2'],
      stops: [
        { seq: 0, kind: 'PICKUP', requestId: 'req-1', locationId: 'air', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: 1, luggageDelta: 1 },
        { seq: 1, kind: 'PICKUP', requestId: 'req-2', locationId: 'air', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: 1, luggageDelta: 1 },
        { seq: 2, kind: 'DROP', requestId: 'req-1', locationId: 'hA', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: -1, luggageDelta: -1 },
        { seq: 3, kind: 'DROP', requestId: 'req-2', locationId: 'hB', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: -1, luggageDelta: -1 },
      ],
      plannedPickupAt: T0,
      plannedDropAt: addMinutes(T0, 50),
    })
    await service.accept(trip.id, 'drv-1')
    const stops = await repos.trips.stops(trip.id)
    for (const pickup of stops.slice(0, 2)) {
      await service.markArrivedAtStop(trip.id, pickup.id, 'drv-1')
      await service.markBoarded(trip.id, pickup.id, 'drv-1')
    }

    const first = await service.markDropped(trip.id, stops[2]!.id, 'drv-1')
    expect(first.tripCompleted).toBe(false) // second guest still aboard
    expect(repos.driverRows.get('drv-1')!.state).toBe('ON_TRIP')

    const second = await service.markDropped(trip.id, stops[3]!.id, 'drv-1')
    expect(second.tripCompleted).toBe(true)
  })

  it('marks a break DUE from accumulated trips on completion (FR-D9)', async () => {
    seedDriver({ tripsSinceBreak: DEFAULT_CONFIG.break_after_trips - 1 })
    seedRequest()
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    const stops = await repos.trips.stops(trip.id)
    await service.markArrivedAtStop(trip.id, stops[0]!.id, 'drv-1')
    await service.markBoarded(trip.id, stops[0]!.id, 'drv-1')
    await service.markDropped(trip.id, stops[1]!.id, 'drv-1')
    expect(repos.driverRows.get('drv-1')!.breakState).toBe('DUE')
  })
})

describe('no-show (FR-D11, E4)', () => {
  it('refuses before the wait timer and permits after it', async () => {
    seedDriver()
    seedRequest()
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    const stops = await repos.trips.stops(trip.id)
    await service.markArrivedAtStop(trip.id, stops[0]!.id, 'drv-1')

    await expect(service.markNoShow(trip.id, stops[0]!.id, 'drv-1')).rejects.toMatchObject({
      code: 'TOO_EARLY',
    })

    clock.advanceMinutes(DEFAULT_CONFIG.no_show_wait_min + 1)
    await service.markNoShow(trip.id, stops[0]!.id, 'drv-1')
    expect(repos.requestRows.get('req-1')!.state).toBe('NO_SHOW')
    // Driver is released immediately — one absent guest cannot idle a vehicle.
    expect(repos.driverRows.get('drv-1')!.state).toBe('AVAILABLE')
  })
})

describe('breakdown (E5) — the live-position detail', () => {
  it('re-queues an ONBOARD guest from the driver’s live position, not the original pickup', async () => {
    seedDriver({ lastLat: 13.05, lastLng: 77.66 })
    seedRequest()
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    const stops = await repos.trips.stops(trip.id)
    await service.markArrivedAtStop(trip.id, stops[0]!.id, 'drv-1')
    await service.markBoarded(trip.id, stops[0]!.id, 'drv-1')

    const result = await service.markDriverUnavailable('drv-1', 'flat tyre')
    expect(result.requeued).toEqual(['req-1'])

    const request = repos.requestRows.get('req-1')!
    expect(request.state).toBe('QUEUED')
    // The rescue vehicle must come to where the guest actually IS.
    expect(request.originLat).toBe(13.05)
    expect(request.originLng).toBe(77.66)
    expect(repos.driverRows.get('drv-1')!.state).toBe('UNAVAILABLE')
  })

  it('leaves the origin untouched for a guest not yet picked up', async () => {
    seedDriver({ lastLat: 13.05, lastLng: 77.66 })
    seedRequest({ originLat: 13.19, originLng: 77.7 })
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    await service.markDriverUnavailable('drv-1', 'engine trouble')
    expect(repos.requestRows.get('req-1')!.originLat).toBe(13.19)
  })
})

describe('admin actions (FR-A5, FR-A9, FR-M25)', () => {
  it('approval queues the request and hands it to the engine, choosing no driver', async () => {
    seedRequest({ state: 'PENDING_APPROVAL', readyAt: null })
    await service.approveRequest('req-1', 'admin-user')
    const request = repos.requestRows.get('req-1')!
    expect(request.state).toBe('QUEUED')
    expect(request.readyAt).not.toBeNull()
    expect(repos.auditRows.some((a) => a.toState === 'APPROVED' && a.actor === 'ADMIN')).toBe(true)
  })

  it('decline requires a reason and shows it to the guest', async () => {
    seedRequest({ state: 'PENDING_APPROVAL' })
    await expect(service.declineRequest('req-1', '  ', 'admin')).rejects.toMatchObject({
      code: 'DECLINE_REASON_REQUIRED',
    })
    await service.declineRequest('req-1', 'not an event guest', 'admin')
    expect(repos.requestRows.get('req-1')!.declineReason).toBe('not an event guest')
  })

  it('override pins the trip and records the reason', async () => {
    seedDriver()
    seedRequest()
    const trip = await service.overrideAssign(
      'req-1',
      'drv-1',
      'VIP escalation',
      'admin-user',
      stopsFor(),
      T0,
      addMinutes(T0, 30),
    )
    expect(trip.isPinned).toBe(true)
    expect(trip.overrideReason).toBe('VIP escalation')
  })

  it('override REQUIRES a reason (FR-A9)', async () => {
    seedDriver()
    seedRequest()
    await expect(
      service.overrideAssign('req-1', 'drv-1', '', 'admin', stopsFor(), T0, T0),
    ).rejects.toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' })
  })

  it('override still cannot break an invariant — it bypasses the ENGINE, not INV-1', async () => {
    seedDriver({ seatCapacity: 1 })
    seedRequest({ groupSize: 4 })
    await expect(
      service.overrideAssign('req-1', 'drv-1', 'ops decision', 'admin', stopsFor('req-1', 4), T0, T0),
    ).rejects.toMatchObject({ code: 'NO_CAPACITY' })
  })
})

describe('breaks and duty (FR-D9, FR-D2)', () => {
  it('grants a break with an end time and blocks assignment while on it', async () => {
    seedDriver({ breakState: 'DUE' })
    seedRequest()
    await service.grantBreak('drv-1')
    const driver = repos.driverRows.get('drv-1')!
    expect(driver.state).toBe('ON_BREAK')
    expect(driver.predictedFreeAt?.toISOString()).toBe('2026-03-10T08:30:00.000Z')
    await expect(assignDefault()).rejects.toMatchObject({ code: 'DRIVER_NOT_AVAILABLE' })
  })

  it('ends a break and resets the counters', async () => {
    seedDriver({ state: 'ON_BREAK', breakState: 'ON_BREAK', tripsSinceBreak: 6, drivingMinutesToday: 250 })
    await service.endBreak('drv-1')
    expect(repos.driverRows.get('drv-1')!).toMatchObject({
      state: 'AVAILABLE',
      breakState: 'NONE',
      tripsSinceBreak: 0,
      drivingMinutesToday: 0,
    })
  })

  it('toggles duty and refuses an illegal toggle mid-trip', async () => {
    seedDriver()
    await service.setDuty('drv-1', false)
    expect(repos.driverRows.get('drv-1')!.state).toBe('OFFLINE')

    await service.setDuty('drv-1', true)
    seedRequest()
    const trip = await assignDefault()
    await service.accept(trip.id, 'drv-1')
    await service.markArrivedAtStop(trip.id, (await repos.trips.stops(trip.id))[0]!.id, 'drv-1')
    await service.markBoarded(trip.id, (await repos.trips.stops(trip.id))[0]!.id, 'drv-1')
    // ON_TRIP → OFFLINE is not a legal transition: finish the trip or be overridden.
    await expect(service.setDuty('drv-1', false)).rejects.toThrow(IllegalTransitionError)
  })
})

describe('detour insertion (FR-M18)', () => {
  it('replaces the pending tail and assigns the new guest', async () => {
    seedDriver({ seatCapacity: 6, luggageCapacity: 6 })
    seedRequest({ id: 'req-1', groupSize: 1, luggageCount: 1 })
    seedRequest({ id: 'req-2', groupSize: 1, luggageCount: 1 })
    const trip = await service.assign({
      driverId: 'drv-1',
      requestIds: ['req-1'],
      stops: stopsFor('req-1', 1, 1),
      plannedPickupAt: T0,
      plannedDropAt: addMinutes(T0, 30),
    })
    await service.accept(trip.id, 'drv-1')
    const stops = await repos.trips.stops(trip.id)
    await service.markArrivedAtStop(trip.id, stops[0]!.id, 'drv-1')
    await service.markBoarded(trip.id, stops[0]!.id, 'drv-1')

    await service.insertDetour(trip.id, 'req-2', [
      { seq: 0, kind: 'PICKUP', requestId: 'req-2', locationId: 'curb', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: 1, luggageDelta: 1 },
      { seq: 1, kind: 'DROP', requestId: 'req-1', locationId: 'hA', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: -1, luggageDelta: -1 },
      { seq: 2, kind: 'DROP', requestId: 'req-2', locationId: 'hA', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: -1, luggageDelta: -1 },
    ])

    expect(repos.requestRows.get('req-2')!.state).toBe('ASSIGNED')
    const after = await repos.trips.stops(trip.id)
    // The completed pickup is retained; the pending tail is the new sequence.
    expect(after.filter((s) => s.state === 'DONE')).toHaveLength(1)
    expect(after).toHaveLength(4)
  })

  it('refuses to touch an admin-pinned trip (E16)', async () => {
    seedDriver({ seatCapacity: 6 })
    seedRequest()
    seedRequest({ id: 'req-2' })
    const trip = await service.overrideAssign('req-1', 'drv-1', 'ops', 'admin', stopsFor(), T0, T0)
    await service.accept(trip.id, 'drv-1')
    await expect(service.insertDetour(trip.id, 'req-2', stopsFor('req-2'))).rejects.toMatchObject({
      code: 'TRIP_PINNED',
    })
  })

  it('refuses a detour that would exceed capacity with guests aboard (INV-1)', async () => {
    seedDriver({ seatCapacity: 2, luggageCapacity: 2 })
    seedRequest({ id: 'req-1', groupSize: 2, luggageCount: 2 })
    seedRequest({ id: 'req-2', groupSize: 2, luggageCount: 2 })
    const trip = await service.assign({
      driverId: 'drv-1',
      requestIds: ['req-1'],
      stops: stopsFor('req-1', 2, 2),
      plannedPickupAt: T0,
      plannedDropAt: T0,
    })
    await service.accept(trip.id, 'drv-1')
    await expect(
      service.insertDetour(trip.id, 'req-2', [
        { seq: 0, kind: 'PICKUP', requestId: 'req-2', locationId: 'curb', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: 2, luggageDelta: 2 },
        { seq: 1, kind: 'DROP', requestId: 'req-2', locationId: 'hA', ...AT, state: 'PENDING', plannedAt: null, arrivedAt: null, seatsDelta: -2, luggageDelta: -2 },
      ]),
    ).rejects.toMatchObject({ code: 'NO_CAPACITY' })
  })
})

describe('guest ready (FR-G3, FR-G4, D8)', () => {
  it('sets readyAt on the first tap', async () => {
    seedRequest({ state: 'REGISTERED', readyAt: null })
    clock.advanceMinutes(15)
    await service.markReady('req-1')
    expect(repos.requestRows.get('req-1')!.readyAt?.toISOString()).toBe('2026-03-10T08:15:00.000Z')
  })

  it('NEVER overwrites an existing readyAt — the wait clock survives requeues (D8)', async () => {
    seedRequest({ state: 'UNMATCHED', readyAt: T0 })
    clock.advanceMinutes(40)
    await service.markReady('req-1', 'SYSTEM')
    expect(repos.requestRows.get('req-1')!.readyAt?.toISOString()).toBe(T0.toISOString())
  })

  it('records a typed unmatched reason (FR-A11)', async () => {
    seedRequest()
    await service.markUnmatched('req-1', 'DEADLINE_INFEASIBLE')
    expect(repos.requestRows.get('req-1')!).toMatchObject({
      state: 'UNMATCHED',
      unmatchedReason: 'DEADLINE_INFEASIBLE',
    })
  })
})

describe('not-found handling', () => {
  it('returns 404-shaped domain errors rather than throwing raw', async () => {
    await expect(service.accept('nope', 'drv-1')).rejects.toMatchObject({
      code: 'TRIP_NOT_FOUND',
      status: 404,
    })
    expect(new DomainError('X', 'y').status).toBe(409)
  })
})
