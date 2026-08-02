import {
  addMinutes,
  DEFAULT_CONFIG,
  type EventConfig,
  type DriverView,
  type LatLng,
  type RequestView,
} from '@eventride/shared'

/**
 * Seed scenario (PRD §19.1, LLD §12). Deliberately includes the edge cases the brief calls out:
 * a 1.2 km hotel pair (cluster pooling), a hotel 14 km the other way (must NOT pool), VIPs,
 * oversized groups that force splits, and mixed vehicle capacities.
 */

export const LOCATIONS = {
  airport: { id: 'loc-airport', label: 'Airport T2 Arrivals', at: { lat: 13.1986, lng: 77.7066 } },
  station: { id: 'loc-station', label: 'City Railway Station', at: { lat: 12.9784, lng: 77.5726 } },
  venue: { id: 'loc-venue', label: 'Convention Centre', at: { lat: 12.9611, lng: 77.6387 } },
  hotelA: { id: 'loc-hotel-a', label: 'Grand Hyatt', at: { lat: 12.9756, lng: 77.6068 } },
  hotelB: { id: 'loc-hotel-b', label: 'Taj Residency', at: { lat: 12.9856, lng: 77.6118 } },
  hotelC: { id: 'loc-hotel-c', label: 'Airport View Suites', at: { lat: 13.0827, lng: 77.5106 } },
} satisfies Record<string, { id: string; label: string; at: LatLng }>

export const ALL_POIS = Object.values(LOCATIONS)
const HOTELS = [LOCATIONS.hotelA, LOCATIONS.hotelB, LOCATIONS.hotelC]

/** Vehicle mix — mirrors a real event fleet rather than a uniform set of identical cars. */
const FLEET_MIX = [
  { count: 20, type: 'Sedan', seats: 4, luggage: 4 },
  { count: 12, type: 'SUV', seats: 6, luggage: 6 },
  { count: 6, type: 'Tempo Traveller', seats: 12, luggage: 12 },
  { count: 2, type: 'Minibus', seats: 20, luggage: 20 },
]

export interface Scenario {
  config: EventConfig
  startAt: Date
  drivers: DriverView[]
  /** Requests with the wall-clock minute at which the guest becomes ready. */
  arrivals: { request: RequestView; readyAtMinute: number }[]
  /**
   * Where each driver returns to when free (their staging point).
   *
   * Without this, a fleet drains: every driver ends each trip at a hotel and the arrival point is
   * left empty, so later guests wait for a ~78-minute repositioning drive. Real event fleets hold
   * at the terminal between runs, and the engine models it through predicted-free-at/-location.
   */
  stagingByDriverId: Record<string, LatLng>
}

/**
 * Deterministic pseudo-random generator. The engine forbids Math.random (it must be replayable),
 * and the simulation needs the same property: a failing run has to be reproducible from its seed.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

export interface ScenarioOptions {
  driverCount?: number
  guestCount?: number
  /** Guests arriving inside the peak window (PRD §19.1: 80 within 30 minutes). */
  peakGuests?: number
  peakWindowMin?: number
  totalWindowMin?: number
  seed?: number
  config?: Partial<EventConfig>
}

export function buildScenario(options: ScenarioOptions = {}): Scenario {
  const {
    driverCount = 40,
    guestCount = 200,
    peakGuests = 80,
    peakWindowMin = 30,
    totalWindowMin = 240,
    seed = 42,
  } = options

  const rng = makeRng(seed)
  const startAt = new Date('2026-03-10T02:00:00.000Z')
  const config = { ...DEFAULT_CONFIG, ...options.config }

  // --- fleet ---
  //
  // Staging matters more than any algorithm during an arrival peak: a vehicle parked at a hotel is
  // ~78 minutes from the airport, so a guest's wait would be dominated by deadhead no matter how
  // good the matching is. Real event ops stage most of the fleet AT the arrival points during the
  // arrival phase, and that is what is modelled here.
  const drivers: DriverView[] = []
  const stagingByDriverId: Record<string, LatLng> = {}
  let driverIndex = 0
  const stagingFor = (index: number): LatLng => {
    if (index % 10 < 6) return LOCATIONS.airport.at // 60% staged at the airport
    if (index % 10 < 8) return LOCATIONS.station.at // 20% at the railway station
    return HOTELS[index % HOTELS.length]!.at // 20% covering hotel-side work
  }

  // Cycle the mix so any fleet size keeps the same vehicle proportions.
  const mixPattern = FLEET_MIX.flatMap((spec) => Array.from({ length: spec.count }, () => spec))
  while (drivers.length < driverCount) {
    {
      const spec = mixPattern[driverIndex % mixPattern.length]!
      const home = { at: stagingFor(driverIndex) }
      const driverId = `drv-${String(driverIndex).padStart(3, '0')}`
      stagingByDriverId[driverId] = home.at
      drivers.push({
        id: driverId,
        name: `Driver ${driverIndex + 1}`,
        vehicleNumber: `KA01${String.fromCharCode(65 + (driverIndex % 26))}${1000 + driverIndex}`,
        seatCapacity: spec.seats,
        luggageCapacity: spec.luggage,
        state: 'AVAILABLE',
        breakState: 'NONE',
        shiftStart: startAt,
        shiftEnd: addMinutes(startAt, 12 * 60),
        freeLocation: home.at,
        predictedFreeAt: null,
        drivingMinutesToday: 0,
        tripsSinceBreak: 0,
        cooldownRequestIds: [],
        livePosition: null,
      })
      driverIndex++
    }
  }

  // --- demand ---
  const arrivals: Scenario['arrivals'] = []
  for (let i = 0; i < guestCount; i++) {
    const inPeak = i < peakGuests
    // The peak is the scored scenario: 80 guests ready inside a 30-minute window.
    const readyAtMinute = inPeak
      ? Math.floor(rng() * peakWindowMin)
      : peakWindowMin + Math.floor(rng() * (totalWindowMin - peakWindowMin))

    const hotel = HOTELS[Math.floor(rng() * HOTELS.length)]!
    const fromStation = rng() < 0.2
    const origin = fromStation ? LOCATIONS.station : LOCATIONS.airport

    // A few oversized parties (force splits, E8) and a few VIPs (never pooled, D12).
    const isBigGroup = i % 50 === 7
    const groupSize = isBigGroup ? 9 : 1 + Math.floor(rng() * 3)
    const isVip = i % 33 === 0

    const readyAt = addMinutes(startAt, readyAtMinute)
    arrivals.push({
      readyAtMinute,
      request: {
        id: `req-${String(i).padStart(3, '0')}`,
        guestId: `gst-${String(i).padStart(3, '0')}`,
        guestName: `Guest ${i + 1}`,
        tripType: 'ARRIVAL',
        source: 'SCHEDULED',
        state: 'REGISTERED',
        origin: origin.at,
        originId: origin.id,
        destination: hotel.at,
        destinationId: hotel.id,
        groupSize,
        luggageCount: Math.floor(rng() * 3),
        isVip,
        isHardDeadline: false,
        deadlineAt: null,
        readyAt,
        scheduledAt: readyAt,
        createdAt: startAt,
        passedOverCount: 0,
        groupRef: null,
        waveId: null,
      },
    })
  }

  return { config, startAt, drivers, arrivals, stagingByDriverId }
}
