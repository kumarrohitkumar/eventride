import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import {
  DEFAULT_CONFIG,
  haversineKm,
  parseConfig,
  systemClock,
  type DriverView,
  type EventConfig,
  type LatLng,
  type RequestView,
  type ActiveTripView,
} from '@eventride/shared'
import { runRound, type Decision, type RoundResult, type Snapshot } from '@eventride/engine'
import { buildTravelOracle, type CachingRoutingProvider } from '@eventride/routing'
import { TripService } from '../trips/trip.service.js'
import { partitionDecisions, type WorldSlice } from './applier.js'
import { EventsGateway } from '../realtime/events.gateway.js'
import { NotificationService, messages } from '../realtime/notification.service.js'

const ROUND_LOCK_KEY = 'lock:matching-round'
const ROUND_LOCK_TTL_SEC = 30

/**
 * Runs matching rounds (HLD §5.1).
 *
 * Shape of a round: acquire lock → build snapshot (the ONLY place routing is called) → run the pure
 * engine → re-validate and apply → release. A round already in flight makes the next trigger a
 * no-op, which is what prevents two rounds double-booking a driver (FR-M24).
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name)
  private debounceTimer: NodeJS.Timeout | null = null

  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(Redis) private readonly redis: Redis,
    @Inject(TripService) private readonly trips: TripService,
    @Inject('ROUTING') private readonly routing: CachingRoutingProvider,
    @Inject(EventsGateway) private readonly gateway: EventsGateway,
    @Inject(NotificationService) private readonly notify: NotificationService,
  ) {}

  /**
   * Debounced trigger (HLD §5.1). A burst of 80 simultaneous arrivals produces ONE good batch
   * round instead of 80 greedy ones — the difference between pooling working and not.
   */
  trigger(reason: string): void {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runRoundSafely(reason)
    }, DEFAULT_CONFIG.round_debounce_ms)
  }

  async runRoundSafely(trigger: string): Promise<{ ran: boolean; decisions: number }> {
    // NX lock: if another instance or tick holds it, this round is a deliberate no-op.
    const acquired = await this.redis.set(ROUND_LOCK_KEY, '1', 'EX', ROUND_LOCK_TTL_SEC, 'NX')
    if (acquired !== 'OK') {
      this.logger.debug(`round skipped (${trigger}): another round in flight`)
      return { ran: false, decisions: 0 }
    }

    const startedAt = new Date()
    try {
      const config = await this.loadConfig()
      const snapshot = await this.buildSnapshot(config)
      if (snapshot.requests.length === 0) return { ran: true, decisions: 0 }

      const round = runRound(snapshot)
      await this.applyDecisions(round.decisions, snapshot)
      await this.recordPassOvers(round.passedOverRequestIds)

      // Persist the whole round, including every rejection with its reason (FR-M23) — this is
      // what makes "why wasn't this guest assigned" answerable after the fact.
      await this.prisma.decisionRound.create({
        data: {
          trigger,
          startedAt,
          durationMs: Math.round(round.stats.durationMs),
          decisions: round.decisions as never,
          rejections: round.rejections as never,
          routingCalls: this.routing.getMetrics().apiCalls,
        },
      })

      return { ran: true, decisions: round.decisions.length }
    } catch (error) {
      // A failed round must never take the process down: in-progress trips continue, and the next
      // tick retries from current DB state (NFR-3 L3).
      this.logger.error(`round failed (${trigger}): ${String(error)}`)
      return { ran: false, decisions: 0 }
    } finally {
      await this.redis.del(ROUND_LOCK_KEY)
    }
  }

  /**
   * FR-A13 preview: run the engine over the current snapshot and return the decisions WITHOUT
   * applying any of them.
   *
   * Safe because the engine is pure — it produces a proposal and touches nothing. This is the one
   * place that property pays off directly in a product feature rather than only in testing.
   */
  async previewRound(): Promise<RoundResult> {
    const config = await this.loadConfig()
    const snapshot = await this.buildSnapshot(config)
    return runRound(snapshot)
  }

  private async loadConfig(): Promise<EventConfig> {
    const event = await this.prisma.event.findFirst()
    return parseConfig(event?.config ?? {})
  }

  /** The only component that performs routing calls, so the API budget is enforceable (NFR-4). */
  private async buildSnapshot(config: EventConfig): Promise<Snapshot> {
    const now = systemClock.now()

    const [queuedRows, driverRows, activeTripRows] = await Promise.all([
      this.prisma.tripRequest.findMany({
        where: { state: { in: ['QUEUED', 'UNMATCHED'] } },
        include: { guest: true, origin: true, destination: true },
        orderBy: { readyAt: 'asc' },
      }),
      this.prisma.driver.findMany({
        where: { state: { in: ['AVAILABLE', 'ON_TRIP', 'AT_PICKUP', 'EN_ROUTE_TO_PICKUP'] } },
      }),
      this.prisma.trip.findMany({
        where: { state: { in: ['ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'] } },
        include: { stops: { orderBy: { seq: 'asc' } }, requests: true },
      }),
    ])

    const livePositions = await this.livePositions(driverRows.map((d) => d.id))

    const requests: RequestView[] = queuedRows.map((r) => ({
      id: r.id,
      guestId: r.guestId,
      guestName: r.guest.name,
      tripType: r.tripType,
      source: r.source,
      state: r.state,
      // originLat/Lng override the POI when a breakdown re-queued the guest mid-journey (E5).
      origin: { lat: r.originLat ?? r.origin.lat, lng: r.originLng ?? r.origin.lng },
      originId: r.originId,
      destination: { lat: r.destination.lat, lng: r.destination.lng },
      destinationId: r.destinationId,
      groupSize: r.groupSize,
      luggageCount: r.luggageCount,
      isVip: r.guest.isVip,
      isHardDeadline: r.isHardDeadline,
      deadlineAt: r.deadlineAt,
      readyAt: r.readyAt,
      scheduledAt: r.scheduledAt,
      createdAt: r.createdAt,
      passedOverCount: r.passedOverCount,
      groupRef: r.groupRef,
      waveId: r.waveId,
    }))

    const cooldowns = await this.cooldowns(driverRows.map((d) => d.id))

    const drivers: DriverView[] = driverRows.map((d) => ({
      id: d.id,
      name: d.name,
      vehicleNumber: d.vehicleNumber,
      seatCapacity: d.seatCapacity,
      luggageCapacity: d.luggageCapacity,
      state: d.state,
      breakState: d.breakState,
      shiftStart: d.shiftStart,
      shiftEnd: d.shiftEnd,
      freeLocation: {
        lat: d.predictedFreeLat ?? d.lastLat ?? 0,
        lng: d.predictedFreeLng ?? d.lastLng ?? 0,
      },
      predictedFreeAt: d.predictedFreeAt,
      drivingMinutesToday: d.drivingMinutesToday,
      tripsSinceBreak: d.tripsSinceBreak,
      cooldownRequestIds: cooldowns.get(d.id) ?? [],
      livePosition: livePositions.get(d.id) ?? (d.lastLat && d.lastLng ? { lat: d.lastLat, lng: d.lastLng } : null),
    }))

    const activeTrips: ActiveTripView[] = activeTripRows.map((t) => ({
      id: t.id,
      driverId: t.driverId,
      remainingStops: t.stops
        .filter((s) => s.state === 'PENDING')
        .map((s) => ({
          kind: s.kind,
          requestId: s.requestId,
          locationId: s.locationId,
          at: { lat: s.lat, lng: s.lng },
          seatsDelta: s.seatsDelta,
          luggageDelta: s.luggageDelta,
          state: s.state,
          plannedAt: s.plannedAt,
        })),
      requestIds: t.requests.map((r) => r.id),
      seatsUsed: t.seatsUsed,
      luggageUsed: t.luggageUsed,
      isPinned: t.isPinned,
      committedDeadlines: t.requests.map((r) => ({ requestId: r.id, deadlineAt: r.deadlineAt })),
    }))

    // Resolve every distance the round could need in ONE batched call, before the engine runs:
    // this is what keeps the engine synchronous and pure (HLD T15).
    const pairs = this.pairsToResolve(requests, drivers, activeTrips, config)
    const travel = await buildTravelOracle(this.routing, pairs)

    return {
      now,
      config,
      drivers,
      requests,
      activeTrips,
      travel,
      fleetMaxSeats: Math.max(1, ...drivers.map((d) => d.seatCapacity)),
      fleetMaxLuggage: Math.max(1, ...drivers.map((d) => d.luggageCapacity)),
      allowCommittedDrivers: false, // live round — INV-3
    }
  }

  /**
   * NFR-4: only the top-K nearest candidates per request get a real lookup. Everything else falls
   * back to the oracle's haversine estimate, so the call count stays bounded no matter how big the
   * fleet gets.
   */
  private pairsToResolve(
    requests: readonly RequestView[],
    drivers: readonly DriverView[],
    activeTrips: readonly ActiveTripView[],
    config: EventConfig,
  ): [LatLng, LatLng][] {
    const pairs: [LatLng, LatLng][] = []
    const driversById = new Map(drivers.map((d) => [d.id, d]))

    for (const request of requests) {
      pairs.push([request.origin, request.destination])
      const nearest = [...drivers]
        .sort(
          (a, b) =>
            haversineKm(a.freeLocation, request.origin) - haversineKm(b.freeLocation, request.origin),
        )
        .slice(0, config.candidate_topk_for_live_eta)
      for (const driver of nearest) pairs.push([driver.freeLocation, request.origin])

      for (const trip of activeTrips) {
        const position = driversById.get(trip.driverId)?.livePosition
        if (position) pairs.push([position, request.origin])
      }
    }
    return pairs
  }

  private async livePositions(driverIds: string[]): Promise<Map<string, LatLng>> {
    const positions = new Map<string, LatLng>()
    if (driverIds.length === 0) return positions
    try {
      const raw = await this.redis.mget(driverIds.map((id) => `pos:${id}`))
      raw.forEach((value, i) => {
        if (!value) return
        const parsed = JSON.parse(value) as LatLng
        positions.set(driverIds[i]!, parsed)
      })
    } catch {
      // L2 degradation: Redis down ⇒ fall back to the 30s-sampled column already on the driver row.
      this.logger.warn('redis unavailable; using last_location from MySQL')
    }
    return positions
  }

  private async cooldowns(driverIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    try {
      for (const id of driverIds) {
        const members = await this.redis.smembers(`cooldown:${id}`)
        if (members.length > 0) map.set(id, members)
      }
    } catch {
      this.logger.warn('redis unavailable; cooldowns ignored this round')
    }
    return map
  }

  private async applyDecisions(decisions: Decision[], snapshot: Snapshot): Promise<void> {
    const world = this.toWorldSlice(snapshot)
    const { applied, skipped } = partitionDecisions(decisions, world)

    for (const skip of skipped) {
      this.logger.warn(`decision skipped (${skip.reason}): ${skip.detail}`)
    }

    for (const decision of applied) {
      try {
        await this.applyOne(decision, snapshot)
      } catch (error) {
        // One decision failing must not abort the rest of the round.
        this.logger.warn(`apply failed for ${decision.kind}: ${String(error)}`)
      }
    }
  }

  private async applyOne(decision: Decision, snapshot: Snapshot): Promise<void> {
    switch (decision.kind) {
      case 'ASSIGN':
        await this.trips.assign({
          driverId: decision.driverId,
          requestIds: decision.requestIds,
          stops: decision.stops.map((s, i) => ({
            seq: i,
            kind: s.kind,
            requestId: s.requestId,
            locationId: s.locationId,
            lat: s.at.lat,
            lng: s.at.lng,
            state: 'PENDING' as const,
            plannedAt: s.plannedAt ?? null,
            arrivedAt: null,
            seatsDelta: s.seatsDelta,
            luggageDelta: s.luggageDelta,
          })),
          plannedPickupAt: decision.plannedPickupAt,
          plannedDropAt: decision.plannedDropAt,
        })
        await this.announceOffer(decision.driverId, decision.requestIds, decision.stops[0]?.locationId)
        break

      case 'INSERT_DETOUR':
        await this.trips.insertDetour(
          decision.tripId,
          decision.requestId,
          decision.stops.map((s, i) => ({
            seq: i,
            kind: s.kind,
            requestId: s.requestId,
            locationId: s.locationId,
            lat: s.at.lat,
            lng: s.at.lng,
            state: 'PENDING' as const,
            plannedAt: s.plannedAt ?? null,
            arrivedAt: null,
            seatsDelta: s.seatsDelta,
            luggageDelta: s.luggageDelta,
          })),
        )
        await this.announceDetour(decision.tripId, decision.driverId, decision.requestId, decision.addedMinutes)
        break

      case 'UNMATCHED':
        await this.trips.markUnmatched(decision.requestId, decision.reason)
        await this.raiseAlert('UNMATCHED', 'critical', `Request ${decision.requestId}: ${decision.reason}`, {
          requestId: decision.requestId,
        })
        break

      case 'SHORTFALL':
        // FR-M17 / FR-A14: quantified so ops can escalate the fleet before the queue explodes.
        await this.raiseAlert(
          'FLEET_SHORTFALL',
          'critical',
          `${decision.guestsAffected} guests / ${decision.seatsShort} seats short in the next ${decision.horizonMin} min`,
          decision,
        )
        break

      case 'SPLIT':
        await this.splitRequest(decision, snapshot)
        break

      case 'RESERVE':
        // A reservation is an in-round instruction, not persisted state: the driver is simply left
        // unassigned this round. Recorded for explainability.
        await this.raiseAlert('DEADLINE_RISK', 'info', `Driver ${decision.driverId} held for ${decision.requestId}`, decision)
        break
    }
  }

  /** FR-M16 / E8: a party larger than any vehicle becomes linked sub-requests. */
  private async splitRequest(
    decision: Extract<Decision, { kind: 'SPLIT' }>,
    _snapshot: Snapshot,
  ): Promise<void> {
    const original = await this.prisma.tripRequest.findUnique({ where: { id: decision.requestId } })
    if (!original) return

    await this.prisma.$transaction(async (tx) => {
      await tx.tripRequest.update({
        where: { id: original.id },
        data: { state: 'CANCELLED', groupRef: original.id },
      })
      for (const part of decision.parts) {
        await tx.tripRequest.create({
          data: {
            guestId: original.guestId,
            tripType: original.tripType,
            source: original.source,
            originId: original.originId,
            destinationId: original.destinationId,
            originLat: original.originLat,
            originLng: original.originLng,
            scheduledAt: original.scheduledAt,
            readyAt: original.readyAt, // preserve the wait clock across the split (D8)
            deadlineAt: original.deadlineAt,
            isHardDeadline: original.isHardDeadline,
            groupSize: part.groupSize,
            luggageCount: part.luggageCount,
            state: 'QUEUED',
            groupRef: original.id,
          },
        })
      }
    })
  }

  private async recordPassOvers(requestIds: string[]): Promise<void> {
    if (requestIds.length === 0) return
    // INV-4 bookkeeping: after max_passed_over_count the engine forces these to the front.
    await this.prisma.tripRequest.updateMany({
      where: { id: { in: requestIds } },
      data: { passedOverCount: { increment: 1 } },
    })
  }

  private toWorldSlice(snapshot: Snapshot): WorldSlice {
    return {
      drivers: new Map(
        snapshot.drivers.map((d) => [
          d.id,
          {
            id: d.id,
            state: d.state,
            seatCapacity: d.seatCapacity,
            luggageCapacity: d.luggageCapacity,
            version: 0,
            breakState: d.breakState,
          },
        ]),
      ),
      requests: new Map(
        snapshot.requests.map((r) => [
          r.id,
          { id: r.id, state: r.state, groupSize: r.groupSize, luggageCount: r.luggageCount },
        ]),
      ),
      trips: new Map(
        snapshot.activeTrips.map((t) => [
          t.id,
          {
            id: t.id,
            driverId: t.driverId,
            state: 'ON_TRIP' as const,
            isPinned: t.isPinned,
            seatsUsed: t.seatsUsed,
            luggageUsed: t.luggageUsed,
          },
        ]),
      ),
    }
  }

  private async raiseAlert(
    type: string,
    severity: string,
    message: string,
    meta: unknown,
  ): Promise<void> {
    const alert = await this.prisma.alert.create({
      data: { type, severity, message, meta: meta as never },
    })
    // An alert that only reaches a database table is an alert nobody sees.
    this.gateway.alertRaised(alert)
    if (severity === 'critical') void this.notify.sendToAdmins(messages.criticalAlert(message))
  }

  /** FR-D5: the driver has 60 seconds, so this needs a high-priority push, not just a socket event. */
  private async announceOffer(
    driverId: string,
    requestIds: string[],
    pickupLocationId: string | undefined,
  ): Promise<void> {
    const trip = await this.prisma.trip.findFirst({
      where: { driverId, state: 'OFFERED' },
      include: { requests: true, stops: { include: { location: true } } },
      orderBy: { offeredAt: 'desc' },
    })
    if (!trip) return

    const guestCount = trip.requests.reduce((sum, r) => sum + r.groupSize, 0)
    const pickupLabel =
      trip.stops.find((s) => s.locationId === pickupLocationId)?.location.label ??
      trip.stops[0]?.location.label ??
      'the pickup point'

    this.gateway.tripOffered(driverId, {
      tripId: trip.id,
      version: trip.version,
      expiresAt: trip.offerExpiresAt,
      guestCount,
      pickupLabel,
    })
    void this.notify.sendToDriver(driverId, messages.tripOffered(guestCount, pickupLabel))

    for (const requestId of requestIds) {
      const request = trip.requests.find((r) => r.id === requestId)
      if (request) this.gateway.requestState(request.guestId, { requestId, state: 'ASSIGNED' })
    }
  }

  /** FR-D8 / FR-G8: both sides of an inserted stop need telling. */
  private async announceDetour(
    tripId: string,
    driverId: string,
    requestId: string,
    addedMinutes: number,
  ): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { requests: true, stops: { orderBy: { seq: 'asc' } } },
    })
    if (!trip) return

    this.gateway.tripUpdated(driverId, { tripId, addedMinutes, stops: trip.stops })
    void this.notify.sendToDriver(driverId, messages.detourForDriver(Math.round(addedMinutes)))

    // Guests already aboard absorb the delay (FR-M13 caps it at +10 min), so they are told.
    for (const request of trip.requests) {
      if (request.id === requestId) continue
      const dropStop = trip.stops.find((s) => s.requestId === request.id && s.kind === 'DROP')
      const etaMin = dropStop?.plannedAt
        ? (dropStop.plannedAt.getTime() - Date.now()) / 60_000
        : addedMinutes
      void this.notify.sendToGuest(request.guestId, messages.detourAdded(etaMin))
    }
  }
}
