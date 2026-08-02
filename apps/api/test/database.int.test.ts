import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { DEFAULT_CONFIG, VirtualClock, addMinutes } from '@eventride/shared'
import { PrismaRepositories } from '../src/prisma/prisma-repos.js'
import { TripService } from '../src/trips/trip.service.js'

/**
 * Integration tests against a REAL MySQL.
 *
 * These cover the two things the in-memory suite cannot prove:
 *   1. the database constraints actually fire (INV-5 via the generated column), and
 *   2. the Prisma adapter maps rows to records correctly, so TripService behaves the same against
 *      Prisma as it does against MemoryRepositories.
 *
 * Requires: docker compose up -d && prisma migrate deploy.
 */

/**
 * SAFETY GUARD.
 *
 * This suite truncates every table. Pointed at a real database it destroys the event — which is
 * exactly what happened once during development, wiping a seeded roster. It therefore refuses to run
 * unless the connection string names a test database.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? ''
if (!/test/i.test(DATABASE_URL)) {
  throw new Error(
    'Refusing to run destructive integration tests: DATABASE_URL must name a database containing ' +
      `"test" (got "${DATABASE_URL.replace(/:[^:@]*@/, ':***@') || '<unset>'}"). ` +
      'Use: DATABASE_URL="mysql://root:root@127.0.0.1:3307/eventride_test?timezone=UTC"',
  )
}

// Passed explicitly so a stray apps/api/.env cannot redirect these writes at the live database.
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
const T0 = new Date('2026-03-10T08:00:00.000Z')
const AT = { lat: 12.97, lng: 77.6 }

let service: TripService
let clock: VirtualClock

const ids = {
  event: '',
  origin: 'it-loc-air',
  destination: 'it-loc-hotel',
  driver: 'it-drv-1',
  driver2: 'it-drv-2',
  guest: 'it-gst-1',
  request: 'it-req-1',
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

/**
 * Runs against a DEDICATED test database (see the DATABASE_URL note in the README), so a full wipe
 * is safe and — unlike prefix matching — cannot leave rows behind.
 *
 * Prefix filtering was the first attempt and it failed: TripService creates trips with generated
 * UUIDs, so `trip.id startsWith 'it-'` never matched them and the surviving rows blocked driver
 * deletion via the foreign key.
 */
async function cleanup(): Promise<void> {
  await prisma.statusEvent.deleteMany()
  await prisma.tripStop.deleteMany()
  await prisma.tripRequest.deleteMany()
  await prisma.trip.deleteMany()
  await prisma.driverPositionHistory.deleteMany()
  await prisma.driver.deleteMany()
  await prisma.guest.deleteMany()
  await prisma.appUser.deleteMany()
  await prisma.location.deleteMany()
}

beforeEach(async () => {
  await cleanup()
  clock = new VirtualClock(T0)
  service = new TripService(new PrismaRepositories(prisma), clock, DEFAULT_CONFIG)

  await prisma.location.createMany({
    data: [
      { id: ids.origin, type: 'AIRPORT', label: 'IT Airport', lat: 13.19, lng: 77.7 },
      { id: ids.destination, type: 'ACCOMMODATION', label: 'IT Hotel', lat: 12.97, lng: 77.6 },
    ],
  })

  for (const [id, name] of [
    [ids.driver, 'IT Driver 1'],
    [ids.driver2, 'IT Driver 2'],
  ] as const) {
    const user = await prisma.appUser.create({ data: { role: 'DRIVER', name } })
    await prisma.driver.create({
      data: {
        id,
        userId: user.id,
        name,
        phone: `+9111${id}`,
        vehicleNumber: `IT-${id}`,
        vehicleType: 'Sedan',
        seatCapacity: 4,
        luggageCapacity: 4,
        shiftStart: addMinutes(T0, -60),
        shiftEnd: addMinutes(T0, 600),
        state: 'AVAILABLE',
        lastLat: 13.05,
        lastLng: 77.66,
        lastLocationAt: T0,
      },
    })
  }

  const guestUser = await prisma.appUser.create({ data: { role: 'GUEST', name: 'IT Guest 1' } })
  await prisma.guest.create({
    data: {
      id: ids.guest,
      userId: guestUser.id,
      name: 'IT Guest 1',
      phone: '+911100000',
      groupSize: 2,
      luggageCount: 1,
      accommodationId: ids.destination,
    },
  })
  await prisma.tripRequest.create({
    data: {
      id: ids.request,
      guestId: ids.guest,
      tripType: 'ARRIVAL',
      source: 'SCHEDULED',
      originId: ids.origin,
      destinationId: ids.destination,
      groupSize: 2,
      luggageCount: 1,
      state: 'QUEUED',
      readyAt: T0,
      scheduledAt: T0,
    },
  })
})

const stops = (requestId = ids.request, seats = 2, luggage = 1) => [
  { seq: 0, kind: 'PICKUP' as const, requestId, locationId: ids.origin, ...AT, state: 'PENDING' as const, plannedAt: addMinutes(T0, 10), arrivedAt: null, seatsDelta: seats, luggageDelta: luggage },
  { seq: 1, kind: 'DROP' as const, requestId, locationId: ids.destination, ...AT, state: 'PENDING' as const, plannedAt: addMinutes(T0, 40), arrivedAt: null, seatsDelta: -seats, luggageDelta: -luggage },
]

describe('INV-5 enforced by the DATABASE (generated column + unique index)', () => {
  it('rejects a second ACTIVE trip for the same driver at the SQL level', async () => {
    await prisma.trip.create({
      data: { id: 'it-trp-1', driverId: ids.driver, state: 'OFFERED', seatsUsed: 0, luggageUsed: 0 },
    })

    // This must fail even though application code is bypassed entirely.
    await expect(
      prisma.trip.create({
        data: { id: 'it-trp-2', driverId: ids.driver, state: 'ACCEPTED', seatsUsed: 0, luggageUsed: 0 },
      }),
    ).rejects.toThrow(/Unique constraint|Duplicate entry/i)
  })

  it('frees the driver once the trip reaches a terminal state', async () => {
    await prisma.trip.create({
      data: { id: 'it-trp-1', driverId: ids.driver, state: 'OFFERED', seatsUsed: 0, luggageUsed: 0 },
    })
    await prisma.trip.update({ where: { id: 'it-trp-1' }, data: { state: 'COMPLETED' } })

    // active_driver_id is NULL for a completed trip, so the unique index no longer blocks.
    await expect(
      prisma.trip.create({
        data: { id: 'it-trp-2', driverId: ids.driver, state: 'OFFERED', seatsUsed: 0, luggageUsed: 0 },
      }),
    ).resolves.toBeDefined()
  })

  it('computes active_driver_id from state, not from application code', async () => {
    await prisma.trip.create({
      data: { id: 'it-trp-1', driverId: ids.driver, state: 'ON_TRIP', seatsUsed: 0, luggageUsed: 0 },
    })
    const [active] = await prisma.$queryRawUnsafe<{ active_driver_id: string | null }[]>(
      "SELECT active_driver_id FROM trip WHERE id = 'it-trp-1'",
    )
    expect(active?.active_driver_id).toBe(ids.driver)

    await prisma.trip.update({ where: { id: 'it-trp-1' }, data: { state: 'REJECTED' } })
    const [inactive] = await prisma.$queryRawUnsafe<{ active_driver_id: string | null }[]>(
      "SELECT active_driver_id FROM trip WHERE id = 'it-trp-1'",
    )
    expect(inactive?.active_driver_id).toBeNull()
  })

  it('allows two DIFFERENT drivers to hold active trips simultaneously', async () => {
    await prisma.trip.create({
      data: { id: 'it-trp-1', driverId: ids.driver, state: 'OFFERED', seatsUsed: 0, luggageUsed: 0 },
    })
    await expect(
      prisma.trip.create({
        data: { id: 'it-trp-2', driverId: ids.driver2, state: 'OFFERED', seatsUsed: 0, luggageUsed: 0 },
      }),
    ).resolves.toBeDefined()
  })
})

describe('TripService against Prisma (same behaviour as against MemoryRepositories)', () => {
  it('assigns, creating the trip and its stops in one transaction', async () => {
    const trip = await service.assign({
      driverId: ids.driver,
      requestIds: [ids.request],
      stops: stops(),
      plannedPickupAt: addMinutes(T0, 10),
      plannedDropAt: addMinutes(T0, 40),
    })

    expect(trip.state).toBe('OFFERED')
    expect(await prisma.tripStop.count({ where: { tripId: trip.id } })).toBe(2)
    expect((await prisma.driver.findUnique({ where: { id: ids.driver } }))?.state).toBe('OFFERED')
    expect((await prisma.tripRequest.findUnique({ where: { id: ids.request } }))?.state).toBe('ASSIGNED')
  })

  it('refuses a second assignment for a busy driver with a clear error, not a raw constraint failure', async () => {
    await service.assign({
      driverId: ids.driver,
      requestIds: [ids.request],
      stops: stops(),
      plannedPickupAt: T0,
      plannedDropAt: T0,
    })

    const guestUser = await prisma.appUser.create({ data: { role: 'GUEST', name: 'IT Guest 2' } })
    await prisma.guest.create({
      data: { id: 'it-gst-2', userId: guestUser.id, name: 'IT Guest 2', phone: '+911100001', groupSize: 1, luggageCount: 0 },
    })
    await prisma.tripRequest.create({
      data: {
        id: 'it-req-2',
        guestId: 'it-gst-2',
        tripType: 'ARRIVAL',
        source: 'SCHEDULED',
        originId: ids.origin,
        destinationId: ids.destination,
        groupSize: 1,
        luggageCount: 0,
        state: 'QUEUED',
        readyAt: T0,
      },
    })

    await expect(
      service.assign({
        driverId: ids.driver,
        requestIds: ['it-req-2'],
        stops: stops('it-req-2', 1, 0),
        plannedPickupAt: T0,
        plannedDropAt: T0,
      }),
    ).rejects.toMatchObject({ code: 'DRIVER_BUSY' })
  })

  it('refuses a capacity-violating assignment against real rows (INV-1)', async () => {
    await prisma.driver.update({ where: { id: ids.driver }, data: { seatCapacity: 1 } })
    await expect(
      service.assign({
        driverId: ids.driver,
        requestIds: [ids.request],
        stops: stops(ids.request, 4, 1),
        plannedPickupAt: T0,
        plannedDropAt: T0,
      }),
    ).rejects.toMatchObject({ code: 'NO_CAPACITY' })
  })

  it('walks the full lifecycle and writes an append-only audit trail', async () => {
    const trip = await service.assign({
      driverId: ids.driver,
      requestIds: [ids.request],
      stops: stops(),
      plannedPickupAt: addMinutes(T0, 10),
      plannedDropAt: addMinutes(T0, 40),
    })
    await service.accept(trip.id, ids.driver)

    const tripStops = await prisma.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { seq: 'asc' } })
    await service.markArrivedAtStop(trip.id, tripStops[0]!.id, ids.driver)
    await service.markBoarded(trip.id, tripStops[0]!.id, ids.driver)
    clock.advanceMinutes(30)
    const result = await service.markDropped(trip.id, tripStops[1]!.id, ids.driver)

    expect(result.tripCompleted).toBe(true)
    expect((await prisma.tripRequest.findUnique({ where: { id: ids.request } }))?.state).toBe('COMPLETED')

    const driver = await prisma.driver.findUnique({ where: { id: ids.driver } })
    expect(driver?.state).toBe('AVAILABLE')
    // Real driving minutes came from the clock, not an estimate.
    expect(driver?.drivingMinutesToday).toBeGreaterThan(0)
    expect(driver?.tripsSinceBreak).toBe(1)

    // Ordered by seq: the virtual clock stamps several of these with the same millisecond, so
    // `at` alone cannot express the sequence an auditor needs.
    const audit = await prisma.statusEvent.findMany({
      where: { entityId: { in: [ids.request, ids.driver, trip.id] } },
      orderBy: { seq: 'asc' },
    })
    expect(audit.map((a) => a.toState)).toEqual([
      'OFFERED',
      'ASSIGNED',
      'ACCEPTED',
      'ACCEPTED',
      'EN_ROUTE',
      'ARRIVED_PICKUP',
      'BOARDED',
      'COMPLETED',
      'COMPLETED',
    ])
  })

  it('re-queues an onboard guest from the driver’s LIVE position on breakdown (E5)', async () => {
    const trip = await service.assign({
      driverId: ids.driver,
      requestIds: [ids.request],
      stops: stops(),
      plannedPickupAt: T0,
      plannedDropAt: addMinutes(T0, 40),
    })
    await service.accept(trip.id, ids.driver)
    const tripStops = await prisma.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { seq: 'asc' } })
    await service.markArrivedAtStop(trip.id, tripStops[0]!.id, ids.driver)
    await service.markBoarded(trip.id, tripStops[0]!.id, ids.driver)

    await prisma.driver.update({
      where: { id: ids.driver },
      data: { lastLat: 13.11, lastLng: 77.68 },
    })
    const outcome = await service.markDriverUnavailable(ids.driver, 'flat tyre')

    expect(outcome.requeued).toEqual([ids.request])
    const request = await prisma.tripRequest.findUnique({ where: { id: ids.request } })
    expect(request?.state).toBe('QUEUED')
    // The rescue must be dispatched to where the guest actually is.
    expect(request?.originLat).toBeCloseTo(13.11, 5)
    expect(request?.originLng).toBeCloseTo(77.68, 5)
    expect(request?.passedOverCount).toBe(1)
  })

  it('preserves readyAt across a driver rejection, so the wait clock never resets (D8)', async () => {
    const trip = await service.assign({
      driverId: ids.driver,
      requestIds: [ids.request],
      stops: stops(),
      plannedPickupAt: T0,
      plannedDropAt: T0,
    })
    clock.advanceMinutes(20)
    await service.reject(trip.id, ids.driver, 'too far')

    const request = await prisma.tripRequest.findUnique({ where: { id: ids.request } })
    expect(request?.readyAt?.toISOString()).toBe(T0.toISOString())
    expect(request?.passedOverCount).toBe(1)
    expect((await prisma.driver.findUnique({ where: { id: ids.driver } }))?.state).toBe('AVAILABLE')
  })
})

describe('UTC discipline (NFR-9)', () => {
  it('the MySQL session is UTC — every deadline in the system depends on it', async () => {
    const [row] = await prisma.$queryRawUnsafe<{ offset: string }[]>(
      'SELECT CAST(TIMEDIFF(NOW(), UTC_TIMESTAMP()) AS CHAR) AS offset',
    )
    expect(String(row?.offset)).toMatch(/^00:00:00/)
  })

  it('round-trips a timestamp without shifting it', async () => {
    await prisma.tripRequest.update({ where: { id: ids.request }, data: { deadlineAt: T0 } })
    const stored = await prisma.tripRequest.findUnique({ where: { id: ids.request } })
    expect(stored?.deadlineAt?.toISOString()).toBe(T0.toISOString())
  })
})
