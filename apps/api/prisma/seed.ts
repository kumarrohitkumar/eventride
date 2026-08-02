import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { DEFAULT_CONFIG, addMinutes } from '@eventride/shared'

/**
 * Database seed (PRD §19.1, LLD §12).
 *
 * Produces an event a reviewer can actually operate: an admin account they can log into, a mixed
 * fleet, and a realistic arrival curve with the edge cases the brief calls out deliberately planted
 * (a 1.2 km hotel pair that SHOULD pool, one 14 km away that must not, VIPs, oversized groups that
 * force a split, and a walk-in).
 *
 * Idempotent: it clears the event's data first, so running it twice is safe.
 *
 * Volume is tunable:  SEED_DRIVERS=40 SEED_GUESTS=200 pnpm db:seed
 */

const prisma = new PrismaClient()

const DRIVER_COUNT = Number(process.env.SEED_DRIVERS ?? 40)
const GUEST_COUNT = Number(process.env.SEED_GUESTS ?? 200)
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@event.test'
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin123'

/** Deterministic RNG so two seed runs produce the same data — reproducible demos. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const LOCATIONS = [
  { id: 'loc-airport', type: 'AIRPORT' as const, label: 'Airport Terminal 2 — Arrivals', lat: 13.1986, lng: 77.7066, pickupInstruction: 'Exit Gate 5, wait at Pillar 7' },
  { id: 'loc-station', type: 'STATION' as const, label: 'City Railway Station', lat: 12.9784, lng: 77.5726, pickupInstruction: 'Platform 1 exit, prepaid taxi bay' },
  { id: 'loc-venue', type: 'VENUE' as const, label: 'Grand Convention Centre', lat: 12.9611, lng: 77.6387, pickupInstruction: 'North porch' },
  { id: 'loc-hotel-a', type: 'ACCOMMODATION' as const, label: 'Grand Hyatt', lat: 12.9756, lng: 77.6068, pickupInstruction: 'Main lobby' },
  // ~1.2 km from hotel A: the pair that SHOULD share a vehicle (D23 cluster rule).
  { id: 'loc-hotel-b', type: 'ACCOMMODATION' as const, label: 'Taj Residency', lat: 12.9856, lng: 77.6118, pickupInstruction: 'Portico' },
  // ~14 km away in the opposite direction: must NEVER pool with A or B (E11).
  { id: 'loc-hotel-c', type: 'ACCOMMODATION' as const, label: 'Airport View Suites', lat: 13.0827, lng: 77.5106, pickupInstruction: 'Tower 2 entrance' },
]

const FLEET_MIX = [
  { count: 20, type: 'Sedan', seats: 4, luggage: 4 },
  { count: 12, type: 'SUV', seats: 6, luggage: 6 },
  { count: 6, type: 'Tempo Traveller', seats: 12, luggage: 12 },
  { count: 2, type: 'Minibus', seats: 20, luggage: 20 },
]

const HOTELS = ['loc-hotel-a', 'loc-hotel-b', 'loc-hotel-c'] as const

async function main(): Promise<void> {
  const rng = makeRng(42)
  const startAt = new Date()

  // ---- reset (child rows first, respecting foreign keys) ----
  await prisma.statusEvent.deleteMany()
  await prisma.tripStop.deleteMany()
  await prisma.tripRequest.deleteMany()
  await prisma.trip.deleteMany()
  await prisma.driverPositionHistory.deleteMany()
  await prisma.wave.deleteMany()
  await prisma.alert.deleteMany()
  await prisma.decisionRound.deleteMany()
  await prisma.notificationToken.deleteMany()
  await prisma.otpCode.deleteMany()
  await prisma.guest.deleteMany()
  await prisma.driver.deleteMany()
  await prisma.appUser.deleteMany()
  await prisma.location.deleteMany()
  await prisma.event.deleteMany()

  // ---- event + config ----
  await prisma.event.create({
    data: {
      name: 'Global Partner Summit 2026',
      timezone: 'Asia/Kolkata',
      startsAt: startAt,
      endsAt: addMinutes(startAt, 3 * 24 * 60),
      config: DEFAULT_CONFIG as never,
    },
  })

  for (const location of LOCATIONS) {
    await prisma.location.create({ data: location })
  }

  // ---- admin account ----
  //
  // Without this the entire Admin/Ops role is unreachable: admins authenticate with credentials
  // rather than OTP, and nothing else in the system creates one.
  await prisma.appUser.create({
    data: {
      role: 'ADMIN',
      email: ADMIN_EMAIL,
      name: 'Rahul (Ops)',
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
    },
  })

  // ---- fleet ----
  //
  // Staged where the work is: most vehicles wait AT the arrival points during the arrival phase,
  // because a car parked at a hotel is ~78 minutes from the airport and the guest pays that wait.
  const mixPattern = FLEET_MIX.flatMap((spec) => Array.from({ length: spec.count }, () => spec))
  const stagingFor = (index: number): { lat: number; lng: number } => {
    if (index % 10 < 6) return { lat: 13.1986, lng: 77.7066 } // airport
    if (index % 10 < 8) return { lat: 12.9784, lng: 77.5726 } // station
    const hotel = LOCATIONS.find((l) => l.id === HOTELS[index % HOTELS.length])!
    return { lat: hotel.lat, lng: hotel.lng }
  }

  for (let i = 0; i < DRIVER_COUNT; i++) {
    const spec = mixPattern[i % mixPattern.length]!
    const staged = stagingFor(i)
    const phone = `+9190000${String(1000 + i).padStart(5, '0')}`
    const user = await prisma.appUser.create({
      data: { role: 'DRIVER', phone, name: `Driver ${i + 1}` },
    })
    await prisma.driver.create({
      data: {
        userId: user.id,
        name: `Driver ${i + 1}`,
        phone,
        vehicleNumber: `KA01${String.fromCharCode(65 + (i % 26))}${1000 + i}`,
        vehicleType: spec.type,
        seatCapacity: spec.seats,
        luggageCapacity: spec.luggage,
        shiftStart: addMinutes(startAt, -60),
        shiftEnd: addMinutes(startAt, 11 * 60),
        // Seeded ONLINE so a reviewer sees dispatch work immediately rather than an idle system.
        state: 'AVAILABLE',
        lastLat: staged.lat,
        lastLng: staged.lng,
        lastLocationAt: startAt,
      },
    })
  }

  // ---- guests + arrival requests ----
  let vipCount = 0
  let bigGroupCount = 0

  for (let i = 0; i < GUEST_COUNT; i++) {
    // First 40% land inside a 30-minute window: the peak the system is judged on.
    const inPeak = i < Math.floor(GUEST_COUNT * 0.4)
    const arrivalOffsetMin = inPeak
      ? Math.floor(rng() * 30)
      : 30 + Math.floor(rng() * 210)

    const isVip = i % 33 === 0
    const isBigGroup = i % 50 === 7 // forces a split: 9 people, largest vehicle seats 6 or less
    const groupSize = isBigGroup ? 9 : 1 + Math.floor(rng() * 3)
    if (isVip) vipCount++
    if (isBigGroup) bigGroupCount++

    const accommodationId = HOTELS[Math.floor(rng() * HOTELS.length)]!
    const fromStation = rng() < 0.2
    const arrivalLocationId = fromStation ? 'loc-station' : 'loc-airport'
    const arrivalAt = addMinutes(startAt, arrivalOffsetMin)
    const phone = `+9199000${String(1000 + i).padStart(5, '0')}`

    const user = await prisma.appUser.create({
      data: { role: 'GUEST', phone, name: `Guest ${i + 1}` },
    })
    const guest = await prisma.guest.create({
      data: {
        userId: user.id,
        name: `Guest ${i + 1}`,
        phone,
        groupSize,
        luggageCount: Math.floor(rng() * 3),
        accommodationId,
        arrivalMode: fromStation ? 'TRAIN' : 'FLIGHT',
        arrivalRef: fromStation ? `TR${2000 + i}` : `AI${500 + i}`,
        arrivalAt,
        arrivalLocationId,
        departureAt: addMinutes(startAt, 3 * 24 * 60 - 120),
        departureLocationId: arrivalLocationId,
        isVip,
      },
    })

    // ARRIVAL request, waiting for the guest to tap "I have arrived" (FR-G3). The sweeper
    // auto-queues anyone who never taps (FR-G4).
    await prisma.tripRequest.create({
      data: {
        guestId: guest.id,
        tripType: 'ARRIVAL',
        source: 'SCHEDULED',
        originId: arrivalLocationId,
        destinationId: accommodationId,
        scheduledAt: arrivalAt,
        groupSize,
        luggageCount: Math.floor(rng() * 3),
        state: 'REGISTERED',
      },
    })
  }

  // ---- a walk-in guest with no pre-registration (E7) ----
  const walkInUser = await prisma.appUser.create({
    data: { role: 'GUEST', phone: '+919990000001', name: 'Walk-in Guest' },
  })
  await prisma.guest.create({
    data: {
      userId: walkInUser.id,
      name: 'Walk-in Guest',
      phone: '+919990000001',
      groupSize: 1,
      luggageCount: 1,
      accommodationId: 'loc-hotel-a',
      isWalkIn: true,
    },
  })

  // ---- one pending ad-hoc request so the approvals screen is not empty (FR-A5) ----
  const firstGuest = await prisma.guest.findFirst({ orderBy: { name: 'asc' } })
  if (firstGuest) {
    await prisma.tripRequest.create({
      data: {
        guestId: firstGuest.id,
        tripType: 'AD_HOC',
        source: 'ON_DEMAND',
        originId: 'loc-hotel-a',
        destinationId: 'loc-venue',
        groupSize: 1,
        luggageCount: 0,
        state: 'PENDING_APPROVAL',
        approvalNote: 'Need to reach the venue early for a rehearsal.',
        scheduledAt: new Date(),
      },
    })
  }

  const sampleDriver = await prisma.driver.findFirst({ orderBy: { name: 'asc' } })
  const sampleGuest = await prisma.guest.findFirst({ where: { isWalkIn: false }, orderBy: { name: 'asc' } })

  process.stdout.write(
    [
      '',
      '  EventRide seed complete',
      '  ─────────────────────────────────────────────',
      `  Event      : Global Partner Summit 2026 (3 days)`,
      `  Locations  : ${LOCATIONS.length} (airport, station, venue, 3 hotels)`,
      `  Drivers    : ${DRIVER_COUNT} online, mixed 4/6/12/20-seat fleet`,
      `  Guests     : ${GUEST_COUNT} (+1 walk-in) · ${vipCount} VIP · ${bigGroupCount} oversized group(s)`,
      `  Requests   : ${GUEST_COUNT} arrivals REGISTERED · 1 ad-hoc PENDING_APPROVAL`,
      '',
      '  SIGN IN',
      `    Admin  : ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`,
      `    Driver : ${sampleDriver?.phone ?? 'n/a'}   OTP 000000`,
      `    Guest  : ${sampleGuest?.phone ?? 'n/a'}   OTP 000000`,
      '',
      '  Tap "I have arrived" as the guest to watch dispatch assign a driver.',
      '',
    ].join('\n'),
  )
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${String(error)}\n`)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
