import {
  addMinutes,
  minutesBetween,
  VirtualClock,
  type ActiveTripView,
  type PlannedStop,
  type RequestView,
} from '@eventride/shared'
import { capacityOkAtEveryStop, runRound, type Decision, type Snapshot } from '@eventride/engine'
import { buildTravelOracle, createRoutingProvider, type CachingRoutingProvider } from '@eventride/routing'
import { ALL_POIS, type Scenario } from './scenario.js'

/**
 * In-process simulation of the whole dispatch loop (HLD §13).
 *
 * It runs THE REAL ENGINE against a fake world with an injected clock, so a 4-hour arrival curve
 * replays in a second and the behaviour observed here is the behaviour production will exhibit.
 * Nothing about the matching logic is stubbed — only the world (driver movement, guest taps) and
 * the clock.
 */

interface SimTrip {
  id: string
  driverId: string
  requestIds: string[]
  stops: PlannedStop[]
  stopIndex: number
  minutesToNextStop: number
  state: 'OFFERED' | 'ACTIVE'
  offeredAt: Date
  seatsUsed: number
  luggageUsed: number
}

export interface SimEvent {
  at: Date
  kind: string
  detail: string
}

export interface SimResult {
  waitsMin: number[]
  completed: number
  neverServed: string[]
  capacityViolations: number
  maxPassedOverCount: number
  /**
   * Rounds where a request already at the pass-over limit stayed queued while a LOWER-priority
   * request was served. This — not a raw pass-over count — is what INV-4 actually forbids: a
   * counter climbing because the whole fleet is busy is scarcity, not starvation.
   */
  starvationViolations: number
  deadlineMisses: number
  idleDriverMinutesWhileQueueNonEmpty: number
  pooledTrips: number
  detours: number
  splits: number
  /** FR-M17: did the engine quantify the gap when demand exceeded the fleet? */
  shortfallAlerts: number
  rejections: number
  seatUtilisation: number[]
  roundDurationsMs: number[]
  routing: { apiCalls: number; elementsRequested: number; cacheHits: number }
  events: SimEvent[]
  simulatedMinutes: number
}

export interface SimOptions {
  /** Fraction of offers a driver rejects, so the exception paths are exercised too. */
  rejectRate?: number
  /** Trigger one mid-trip breakdown to prove E5 recovery. */
  breakdownAtMinute?: number
  horizonMin?: number
  verbose?: boolean
}

export async function runSimulation(
  scenario: Scenario,
  options: SimOptions = {},
): Promise<SimResult> {
  const { rejectRate = 0.08, breakdownAtMinute, horizonMin = 420, verbose = false } = options
  const clock = new VirtualClock(scenario.startAt)
  const config = scenario.config

  const routing: CachingRoutingProvider = createRoutingProvider({})
  await routing.warmStaticMatrix(ALL_POIS)

  const drivers = new Map(scenario.drivers.map((d) => [d.id, { ...d }]))
  const requests = new Map<string, RequestView>()
  const pending = new Map<string, { request: RequestView; readyAtMinute: number }>(
    scenario.arrivals.map((a) => [a.request.id, a]),
  )
  const trips = new Map<string, SimTrip>()
  const boardedAt = new Map<string, Date>()

  const result: SimResult = {
    waitsMin: [],
    completed: 0,
    neverServed: [],
    capacityViolations: 0,
    maxPassedOverCount: 0,
    starvationViolations: 0,
    deadlineMisses: 0,
    idleDriverMinutesWhileQueueNonEmpty: 0,
    pooledTrips: 0,
    detours: 0,
    splits: 0,
    shortfallAlerts: 0,
    rejections: 0,
    seatUtilisation: [],
    roundDurationsMs: [],
    routing: { apiCalls: 0, elementsRequested: 0, cacheHits: 0 },
    events: [],
    simulatedMinutes: 0,
  }

  const log = (kind: string, detail: string) => {
    result.events.push({ at: clock.now(), kind, detail })
    if (verbose) process.stdout.write(`[${clock.now().toISOString().slice(11, 16)}] ${kind}: ${detail}\n`)
  }

  // Deterministic driver behaviour: same seed ⇒ same rejections ⇒ reproducible failures.
  let rngState = 12345
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0
    return rngState / 0x1_0000_0000
  }

  let tripSeq = 0
  let brokenDown = false

  for (let minute = 0; minute <= horizonMin; minute++) {
    const now = clock.now()
    result.simulatedMinutes = minute

    // --- 1. guests become ready (FR-G3: the tap that creates demand) ---
    for (const [id, arrival] of pending) {
      if (arrival.readyAtMinute > minute) continue
      requests.set(id, { ...arrival.request, state: 'QUEUED', readyAt: addMinutes(scenario.startAt, arrival.readyAtMinute) })
      pending.delete(id)
    }

    // --- 2. drivers move; stops complete ---
    for (const trip of [...trips.values()]) {
      if (trip.state !== 'ACTIVE') continue
      trip.minutesToNextStop -= 1
      if (trip.minutesToNextStop > 0) continue

      const stop = trip.stops[trip.stopIndex]
      if (!stop) continue
      const driver = drivers.get(trip.driverId)!

      if (stop.kind === 'PICKUP') {
        boardedAt.set(stop.requestId, now)
        const r = requests.get(stop.requestId)
        if (r?.readyAt) result.waitsMin.push(Math.max(0, minutesBetween(r.readyAt, now)))
        if (r) requests.set(r.id, { ...r, state: 'BOARDED' })
      } else {
        const r = requests.get(stop.requestId)
        if (r) {
          if (r.isHardDeadline && r.deadlineAt && now.getTime() > r.deadlineAt.getTime()) {
            result.deadlineMisses += 1
            log('DEADLINE_MISS', `${r.id} dropped at ${now.toISOString()}`)
          }
          requests.set(r.id, { ...r, state: 'COMPLETED' })
          result.completed += 1
        }
      }

      driver.livePosition = stop.at
      trip.stopIndex += 1

      const next = trip.stops[trip.stopIndex]
      if (next) {
        trip.minutesToNextStop = Math.max(1, oracleMinutes(stop.at, next.at))
      } else {
        // Trip complete (FR-D6). The driver heads back to their staging point, so the engine sees
        // them as "free AT the terminal in N minutes" via predictedFreeAt/freeLocation — which is
        // how an event fleet actually behaves and what keeps the arrival point covered.
        trips.delete(trip.id)
        driver.state = 'AVAILABLE'
        driver.livePosition = null
        const stage = scenario.stagingByDriverId[driver.id]
        if (stage) {
          const repositionMin = oracleMinutes(stop.at, stage)
          driver.freeLocation = stage
          driver.predictedFreeAt = repositionMin > 1 ? addMinutes(now, repositionMin) : null
        } else {
          driver.freeLocation = stop.at
          driver.predictedFreeAt = null
        }
        driver.tripsSinceBreak += 1
        driver.drivingMinutesToday += 15
        if (
          driver.drivingMinutesToday >= config.break_after_driving_min ||
          driver.tripsSinceBreak >= config.break_after_trips
        ) {
          driver.breakState = 'DUE'
          log('BREAK_DUE', driver.id)
        }
      }
    }

    // --- 3. one breakdown, to prove E5 recovery ---
    if (breakdownAtMinute === minute && !brokenDown) {
      const victim = [...trips.values()].find((t) => t.state === 'ACTIVE')
      if (victim) {
        brokenDown = true
        const driver = drivers.get(victim.driverId)!
        driver.state = 'UNAVAILABLE'
        // Onboard guests are re-queued FROM THE LIVE POSITION, not the original pickup (E5).
        for (const rid of victim.requestIds) {
          const r = requests.get(rid)
          if (!r || r.state === 'COMPLETED') continue
          requests.set(rid, {
            ...r,
            state: 'QUEUED',
            origin: driver.livePosition ?? r.origin,
            passedOverCount: r.passedOverCount + 1,
          })
        }
        trips.delete(victim.id)
        log('BREAKDOWN', `${driver.id} — ${victim.requestIds.length} guest(s) re-queued`)
      }
    }

    // --- 4. offers expire (sweeper, FR-D5) ---
    for (const trip of [...trips.values()]) {
      if (trip.state !== 'OFFERED') continue
      if (minutesBetween(trip.offeredAt, now) * 60 < config.offer_expiry_sec) continue
      requeue(trip, 'OFFER_EXPIRED')
    }

    // --- 5. break handling ---
    for (const driver of drivers.values()) {
      if (driver.breakState !== 'DUE' || driver.state !== 'AVAILABLE') continue
      driver.state = 'ON_BREAK'
      driver.breakState = 'ON_BREAK'
      driver.predictedFreeAt = addMinutes(now, config.break_duration_min)
    }
    for (const driver of drivers.values()) {
      if (driver.state !== 'ON_BREAK') continue
      if (driver.predictedFreeAt && now >= driver.predictedFreeAt) {
        driver.state = 'AVAILABLE'
        driver.breakState = 'NONE'
        driver.predictedFreeAt = null
        driver.tripsSinceBreak = 0
        driver.drivingMinutesToday = 0
      }
    }

    const queued = [...requests.values()].filter((r) => r.state === 'QUEUED')

    // --- 6. idle-driver accounting: the metric that proves G2 ---
    if (queued.length > 0) {
      const idle = [...drivers.values()].filter(
        (d) => d.state === 'AVAILABLE' && d.breakState === 'NONE',
      ).length
      result.idleDriverMinutesWhileQueueNonEmpty += idle
    }

    // --- 7. matching round on the configured tick ---
    if (minute % Math.max(1, Math.round(config.reoptimise_tick_sec / 60)) === 0 && queued.length > 0) {
      const snapshot = await buildSnapshot(queued)
      const round = runRound(snapshot)
      result.roundDurationsMs.push(round.stats.durationMs)
      applyDecisions(round.decisions)

      // INV-4 audit: a request already at the limit must not be skipped in favour of a
      // lower-priority one. Checked against what the round actually decided.
      const servedThisRound = new Set(
        round.decisions.flatMap((d) =>
          d.kind === 'ASSIGN' ? d.requestIds : d.kind === 'INSERT_DETOUR' ? [d.requestId] : [],
        ),
      )
      const forcedButSkipped = queued.filter(
        (r) => r.passedOverCount >= config.max_passed_over_count && !servedThisRound.has(r.id),
      )
      if (forcedButSkipped.length > 0 && servedThisRound.size > 0) {
        const skippedIds = new Set(forcedButSkipped.map((r) => r.id))
        const lowerPriorityServed = queued.some(
          (r) => servedThisRound.has(r.id) && !skippedIds.has(r.id) && r.passedOverCount < config.max_passed_over_count,
        )
        if (lowerPriorityServed) {
          result.starvationViolations += 1
          log('STARVATION', forcedButSkipped.map((r) => r.id).join(','))
        }
      }

      for (const id of round.passedOverRequestIds) {
        const r = requests.get(id)
        if (!r) continue
        const updated = { ...r, passedOverCount: r.passedOverCount + 1 }
        requests.set(id, updated)
        result.maxPassedOverCount = Math.max(result.maxPassedOverCount, updated.passedOverCount)
      }
    }

    // --- 8. drivers respond to offers (accept / reject) ---
    for (const trip of [...trips.values()]) {
      if (trip.state !== 'OFFERED') continue
      if (rng() < rejectRate) {
        result.rejections += 1
        requeue(trip, 'DRIVER_REJECTED')
        continue
      }
      const driver = drivers.get(trip.driverId)!
      trip.state = 'ACTIVE'
      driver.state = 'ON_TRIP'
      driver.livePosition = driver.freeLocation
      const firstStop = trip.stops[0]!
      // If the driver is still repositioning, that remaining time is real and must be paid before
      // they can reach the pickup — otherwise the simulation would understate guest wait.
      const remainingReposition = driver.predictedFreeAt
        ? Math.max(0, minutesBetween(now, driver.predictedFreeAt))
        : 0
      trip.minutesToNextStop = Math.max(
        1,
        Math.round(remainingReposition + oracleMinutes(driver.freeLocation, firstStop.at)),
      )
      const lastStop = trip.stops[trip.stops.length - 1]!
      driver.predictedFreeAt = lastStop.plannedAt ?? addMinutes(now, 45)
      for (const rid of trip.requestIds) {
        const r = requests.get(rid)
        if (r) requests.set(rid, { ...r, state: 'EN_ROUTE' })
      }
    }

    clock.advanceMinutes(1)

    const outstanding =
      pending.size + [...requests.values()].filter((r) => !['COMPLETED'].includes(r.state)).length
    if (outstanding === 0) break
  }

  result.neverServed = [
    ...pending.keys(),
    ...[...requests.values()].filter((r) => r.state !== 'COMPLETED').map((r) => r.id),
  ]
  const metrics = routing.getMetrics()
  result.routing = {
    apiCalls: metrics.apiCalls,
    elementsRequested: metrics.elementsRequested,
    cacheHits: metrics.cacheHits,
  }
  return result

  // ---------- helpers ----------

  function oracleMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const km = haversine(a, b)
    return Math.max(1, Math.round(((km * 1.4) / 30) * 60))
  }

  function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const toRad = (d: number) => (d * Math.PI) / 180
    const dLat = toRad(b.lat - a.lat)
    const dLng = toRad(b.lng - a.lng)
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)))
  }

  async function buildSnapshot(queued: RequestView[]): Promise<Snapshot> {
    const driverList = [...drivers.values()]
    const activeTrips: ActiveTripView[] = [...trips.values()]
      .filter((t) => t.state === 'ACTIVE')
      .map((t) => ({
        id: t.id,
        driverId: t.driverId,
        remainingStops: t.stops.slice(t.stopIndex),
        requestIds: t.requestIds,
        seatsUsed: t.stops
          .slice(0, t.stopIndex)
          .reduce((sum, st) => sum + st.seatsDelta, 0),
        luggageUsed: t.stops
          .slice(0, t.stopIndex)
          .reduce((sum, st) => sum + st.luggageDelta, 0),
        isPinned: false,
        committedDeadlines: t.requestIds.map((rid) => ({
          requestId: rid,
          deadlineAt: requests.get(rid)?.deadlineAt ?? null,
        })),
      }))

    // Resolve every distance this round could need, in ONE batched call (NFR-4, HLD T15).
    const pairs: [{ lat: number; lng: number }, { lat: number; lng: number }][] = []
    for (const r of queued) {
      pairs.push([r.origin, r.destination])
      for (const d of driverList) pairs.push([d.freeLocation, r.origin])
      for (const t of activeTrips) {
        const driver = drivers.get(t.driverId)
        if (driver?.livePosition) pairs.push([driver.livePosition, r.origin])
      }
    }
    const travel = await buildTravelOracle(routing, pairs)

    return {
      now: clock.now(),
      config,
      drivers: driverList,
      requests: queued,
      activeTrips,
      travel,
      fleetMaxSeats: Math.max(1, ...driverList.map((d) => d.seatCapacity)),
      fleetMaxLuggage: Math.max(1, ...driverList.map((d) => d.luggageCapacity)),
    }
  }

  function applyDecisions(decisions: Decision[]): void {
    for (const decision of decisions) {
      if (decision.kind === 'ASSIGN') {
        const driver = drivers.get(decision.driverId)
        if (!driver || driver.state !== 'AVAILABLE') continue

        // The applier re-validates before committing (HLD §9) — the engine is trusted for
        // quality, never for correctness.
        if (!capacityOkAtEveryStop(decision.stops, driver)) {
          result.capacityViolations += 1
          log('CAPACITY_VIOLATION', `${driver.id} / ${decision.requestIds.join(',')}`)
          continue
        }

        const id = `trp-${++tripSeq}`
        trips.set(id, {
          id,
          driverId: driver.id,
          requestIds: [...decision.requestIds],
          stops: decision.stops.map((s) => ({ ...s })),
          stopIndex: 0,
          minutesToNextStop: 1,
          state: 'OFFERED',
          offeredAt: clock.now(),
          seatsUsed: 0,
          luggageUsed: 0,
        })
        driver.state = 'OFFERED'
        for (const rid of decision.requestIds) {
          const r = requests.get(rid)
          if (r) requests.set(rid, { ...r, state: 'ASSIGNED' })
        }
        if (decision.requestIds.length > 1) result.pooledTrips += 1
        const seats = decision.requestIds.reduce(
          (sum, rid) => sum + (requests.get(rid)?.groupSize ?? 0),
          0,
        )
        result.seatUtilisation.push(seats / driver.seatCapacity)
      }

      if (decision.kind === 'INSERT_DETOUR') {
        const trip = trips.get(decision.tripId)
        const driver = drivers.get(decision.driverId)
        if (!trip || !driver || trip.state !== 'ACTIVE') continue
        const completed = trip.stops.slice(0, trip.stopIndex)
        const merged = [...completed, ...decision.stops]
        if (!capacityOkAtEveryStop(merged, driver)) {
          result.capacityViolations += 1
          continue
        }
        trip.stops = merged
        trip.requestIds.push(decision.requestId)
        const nextStop = trip.stops[trip.stopIndex]
        if (nextStop) {
          trip.minutesToNextStop = Math.max(
            1,
            oracleMinutes(driver.livePosition ?? driver.freeLocation, nextStop.at),
          )
        }
        const r = requests.get(decision.requestId)
        if (r) requests.set(decision.requestId, { ...r, state: 'ASSIGNED' })
        result.detours += 1
        log('DETOUR', `${decision.requestId} into ${decision.tripId} (+${decision.addedMinutes}m)`)
      }

      if (decision.kind === 'SHORTFALL') {
        result.shortfallAlerts += 1
        continue
      }

      if (decision.kind === 'SPLIT') {
        const original = requests.get(decision.requestId)
        if (!original) continue
        requests.delete(decision.requestId)
        decision.parts.forEach((part, i) => {
          const id = `${decision.requestId}-p${i}`
          requests.set(id, {
            ...original,
            id,
            groupSize: part.groupSize,
            luggageCount: part.luggageCount,
            groupRef: decision.requestId,
            state: 'QUEUED',
          })
        })
        result.splits += 1
        log('SPLIT', `${decision.requestId} → ${decision.parts.length} vehicles`)
      }
    }
  }

  function requeue(trip: SimTrip, reason: string): void {
    const driver = drivers.get(trip.driverId)
    if (driver) {
      driver.state = 'AVAILABLE'
      // D14: cooldown so the engine does not immediately re-offer the same trip to the same driver.
      driver.cooldownRequestIds = [...driver.cooldownRequestIds, ...trip.requestIds]
    }
    for (const rid of trip.requestIds) {
      const r = requests.get(rid)
      if (!r) continue
      // readyAt is preserved (D8): a rejection must not reset the guest's accumulated wait.
      requests.set(rid, { ...r, state: 'QUEUED', passedOverCount: r.passedOverCount + 1 })
      result.maxPassedOverCount = Math.max(result.maxPassedOverCount, r.passedOverCount + 1)
    }
    trips.delete(trip.id)
    log(reason, trip.requestIds.join(','))
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]!
}
