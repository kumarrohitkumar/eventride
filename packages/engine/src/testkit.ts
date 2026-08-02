import {
  DEFAULT_CONFIG,
  estimateMinutes,
  type DriverView,
  type EventConfig,
  type LatLng,
  type RequestView,
  type ActiveTripView,
  type PlannedStop,
} from '@eventride/shared'
import type { Snapshot, TravelOracle } from './types.js'

/** Builders used by the engine test suite. Kept in src so the simulator can reuse them. */

export const T0 = new Date('2026-03-10T08:00:00.000Z')

export const POI = {
  airport: { lat: 13.1986, lng: 77.7066 },
  station: { lat: 12.9784, lng: 77.5726 },
  venue: { lat: 12.9611, lng: 77.6387 },
  hotelA: { lat: 12.9756, lng: 77.6068 },
  /** ~1.2 km from hotelA → same cluster at the 2 km default (D23). */
  hotelB: { lat: 12.9856, lng: 77.6118 },
  /** ~14 km from hotelA, opposite direction → must never pool with it (E11). */
  hotelC: { lat: 13.0827, lng: 77.5106 },
} satisfies Record<string, LatLng>

/** Straight-line oracle: deterministic, no I/O, and identical to the L1 fallback maths. */
export const mockOracle: TravelOracle = {
  minutes: (a, b) => estimateMinutes(a, b),
  isEstimated: () => true,
}

/** Fixed-duration oracle for tests that need exact arithmetic rather than real geography. */
export function fixedOracle(minutes: number): TravelOracle {
  return { minutes: () => minutes, isEstimated: () => false }
}

/** Oracle driven by an explicit lookup table, falling back to haversine. */
export function tableOracle(table: Array<[LatLng, LatLng, number]>): TravelOracle {
  const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
  const map = new Map<string, number>()
  for (const [a, b, m] of table) {
    map.set(`${key(a)}|${key(b)}`, m)
    map.set(`${key(b)}|${key(a)}`, m)
  }
  return {
    minutes: (a, b) => map.get(`${key(a)}|${key(b)}`) ?? estimateMinutes(a, b),
    isEstimated: (a, b) => !map.has(`${key(a)}|${key(b)}`),
  }
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-${++seq}`

export function driver(over: Partial<DriverView> = {}): DriverView {
  return {
    id: nextId('drv'),
    name: 'Suresh',
    vehicleNumber: 'KA01AB1234',
    seatCapacity: 4,
    luggageCapacity: 4,
    state: 'AVAILABLE',
    breakState: 'NONE',
    shiftStart: new Date(T0.getTime() - 3600_000),
    shiftEnd: new Date(T0.getTime() + 12 * 3600_000),
    freeLocation: POI.hotelA,
    predictedFreeAt: null,
    drivingMinutesToday: 0,
    tripsSinceBreak: 0,
    cooldownRequestIds: [],
    livePosition: null,
    ...over,
  }
}

export function request(over: Partial<RequestView> = {}): RequestView {
  return {
    id: nextId('req'),
    guestId: nextId('gst'),
    guestName: 'Priya',
    tripType: 'ARRIVAL',
    source: 'SCHEDULED',
    state: 'QUEUED',
    origin: POI.airport,
    originId: 'loc-airport',
    destination: POI.hotelA,
    destinationId: 'loc-hotelA',
    groupSize: 1,
    luggageCount: 1,
    isVip: false,
    isHardDeadline: false,
    deadlineAt: null,
    readyAt: T0,
    scheduledAt: T0,
    createdAt: T0,
    passedOverCount: 0,
    groupRef: null,
    waveId: null,
    ...over,
  }
}

export function stop(over: Partial<PlannedStop> = {}): PlannedStop {
  return {
    kind: 'PICKUP',
    requestId: nextId('req'),
    locationId: 'loc-airport',
    at: POI.airport,
    seatsDelta: 1,
    luggageDelta: 1,
    state: 'PENDING',
    ...over,
  }
}

export function activeTrip(over: Partial<ActiveTripView> = {}): ActiveTripView {
  return {
    id: nextId('trp'),
    driverId: nextId('drv'),
    remainingStops: [],
    requestIds: [],
    seatsUsed: 0,
    luggageUsed: 0,
    isPinned: false,
    committedDeadlines: [],
    ...over,
  }
}

export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const drivers = over.drivers ?? [driver()]
  return {
    now: T0,
    config: DEFAULT_CONFIG,
    drivers,
    requests: over.requests ?? [request()],
    activeTrips: over.activeTrips ?? [],
    travel: over.travel ?? mockOracle,
    fleetMaxSeats: Math.max(1, ...drivers.map((d) => d.seatCapacity)),
    fleetMaxLuggage: Math.max(1, ...drivers.map((d) => d.luggageCapacity)),
    ...over,
  }
}

export function withConfig(over: Partial<EventConfig>): EventConfig {
  return { ...DEFAULT_CONFIG, ...over }
}
