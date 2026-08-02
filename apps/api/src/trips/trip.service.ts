import {
  TRIP_ACTIVE_STATES,
  addMinutes,
  addSeconds,
  assertDriverTransition,
  assertRequestTransition,
  assertTripTransition,
  minutesBetween,
  type Clock,
  type EventConfig,
} from '@eventride/shared'
import { capacityOkAtEveryStop } from '@eventride/engine'
import {
  DomainError,
  type Repositories,
  type RequestRecord,
  type TripRecord,
  type TripStopRecord,
} from './ports.js'

/**
 * Adapts stored stop rows (flat lat/lng) to the engine's PlannedStop shape (nested `at`), so the
 * SAME capacity primitive validates both engine proposals and database rows — INV-1 has one
 * implementation, not two that can drift apart.
 */
function toPlannedStops(
  stops: readonly Omit<TripStopRecord, 'id' | 'tripId'>[],
): { kind: 'PICKUP' | 'DROP'; requestId: string; locationId: string; at: { lat: number; lng: number }; seatsDelta: number; luggageDelta: number }[] {
  return stops.map((s) => ({
    kind: s.kind,
    requestId: s.requestId,
    locationId: s.locationId,
    at: { lat: s.lat, lng: s.lng },
    seatsDelta: s.seatsDelta,
    luggageDelta: s.luggageDelta,
  }))
}

export interface AssignInput {
  driverId: string
  requestIds: string[]
  stops: Omit<TripStopRecord, 'id' | 'tripId'>[]
  plannedPickupAt: Date
  plannedDropAt: Date
  /** Set by an admin override; pins the trip so the engine will not re-optimise it (E16). */
  pinned?: boolean
  overrideReason?: string
}

/**
 * The ONLY writer of trip / request / driver state (HLD §4 rule 1).
 *
 * Driver actions, admin overrides, engine decisions and sweeper timeouts all come through here, so
 * the state machine (INV-6), capacity (INV-1), one-trip-per-driver (INV-5) and the audit trail are
 * enforced in exactly one place instead of being re-implemented per caller.
 */
export class TripService {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly config: EventConfig,
  ) {}

  // ---------------------------------------------------------------- assignment

  async assign(input: AssignInput): Promise<TripRecord> {
    const now = this.clock.now()
    const driver = await this.mustFindDriver(input.driverId)

    // INV-5, enforced here as well as by the DB unique index — a clear error beats a constraint
    // violation surfacing as a 500.
    const existing = await this.repos.trips.activeForDriver(driver.id)
    if (existing) {
      throw new DomainError('DRIVER_BUSY', `Driver ${driver.id} already has an active trip`)
    }
    if (driver.state !== 'AVAILABLE') {
      throw new DomainError('DRIVER_NOT_AVAILABLE', `Driver is ${driver.state}`)
    }
    if (driver.breakState !== 'NONE') {
      throw new DomainError('DRIVER_ON_BREAK', `Driver break state is ${driver.breakState}`)
    }

    // INV-1 — checked even on the admin-override path. Override bypasses the ENGINE, never an
    // invariant (LLD §10).
    if (!capacityOkAtEveryStop(toPlannedStops(input.stops), driver)) {
      throw new DomainError('NO_CAPACITY', 'Stop sequence exceeds vehicle capacity', 422)
    }

    const requests = await Promise.all(input.requestIds.map((id) => this.mustFindRequest(id)))
    for (const request of requests) assertRequestTransition(request.state, 'ASSIGNED')

    const seatsUsed = input.stops
      .filter((s) => s.kind === 'PICKUP')
      .reduce((sum, s) => sum + s.seatsDelta, 0)
    const luggageUsed = input.stops
      .filter((s) => s.kind === 'PICKUP')
      .reduce((sum, s) => sum + s.luggageDelta, 0)

    const trip = await this.repos.trips.create(
      {
        id: crypto.randomUUID(),
        driverId: driver.id,
        state: 'OFFERED',
        offeredAt: now,
        offerExpiresAt: addSeconds(now, this.config.offer_expiry_sec),
        acceptedAt: null,
        startedAt: null,
        completedAt: null,
        seatsUsed,
        luggageUsed,
        plannedPickupAt: input.plannedPickupAt,
        plannedDropAt: input.plannedDropAt,
        isPinned: input.pinned ?? false,
        overrideReason: input.overrideReason ?? null,
        rejectReason: null,
      },
      input.stops.map((s, i) => ({ ...s, tripId: '', seq: i })),
    )

    assertDriverTransition(driver.state, 'OFFERED')
    await this.repos.drivers.update(driver.id, { state: 'OFFERED' })
    await this.audit('driver', driver.id, driver.state, 'OFFERED', input.pinned ? 'ADMIN' : 'ENGINE')

    for (const request of requests) {
      await this.repos.requests.update(request.id, { state: 'ASSIGNED', tripId: trip.id })
      await this.audit('request', request.id, request.state, 'ASSIGNED', input.pinned ? 'ADMIN' : 'ENGINE', input.overrideReason)
    }

    return trip
  }

  // ---------------------------------------------------------------- driver actions

  async accept(tripId: string, driverId: string, expectedVersion?: number): Promise<TripRecord> {
    const trip = await this.mustFindTrip(tripId)
    this.assertDriverOwns(trip, driverId)
    // Optimistic lock: a driver accepting a trip that was reassigned meanwhile loses (HLD §9).
    if (expectedVersion !== undefined && trip.version !== expectedVersion) {
      throw new DomainError('TRIP_STALE', 'Trip changed since it was offered')
    }
    assertTripTransition(trip.state, 'ACCEPTED')

    const now = this.clock.now()
    const updated = await this.repos.trips.update(trip.id, {
      state: 'ACCEPTED',
      acceptedAt: now,
      version: trip.version + 1,
    })
    await this.repos.drivers.update(driverId, { state: 'EN_ROUTE_TO_PICKUP' })
    await this.audit('trip', trip.id, trip.state, 'ACCEPTED', 'DRIVER')

    for (const request of await this.repos.requests.findByTrip(trip.id)) {
      await this.repos.requests.update(request.id, { state: 'ACCEPTED' })
      await this.audit('request', request.id, request.state, 'ACCEPTED', 'DRIVER')
    }
    return updated
  }

  /**
   * Driver rejection (FR-D5, E2). The guest's `readyAt` is deliberately preserved and
   * `passedOverCount` incremented, so a rejection cannot reset their accumulated wait (D8) and
   * pushes them UP the queue rather than down.
   */
  async reject(tripId: string, driverId: string, reason: string): Promise<void> {
    const trip = await this.mustFindTrip(tripId)
    this.assertDriverOwns(trip, driverId)
    assertTripTransition(trip.state, 'REJECTED')

    await this.repos.trips.update(trip.id, { state: 'REJECTED', rejectReason: reason })
    await this.repos.drivers.update(driverId, { state: 'AVAILABLE' })
    await this.audit('trip', trip.id, trip.state, 'REJECTED', 'DRIVER', reason)
    await this.requeueRequestsOf(trip, 'DRIVER', reason)
  }

  /** Offer timeout (E3) — identical requeue path, different actor, so behaviour cannot diverge. */
  async expireOffer(tripId: string): Promise<void> {
    const trip = await this.mustFindTrip(tripId)
    assertTripTransition(trip.state, 'EXPIRED')
    await this.repos.trips.update(trip.id, { state: 'EXPIRED' })
    await this.repos.drivers.update(trip.driverId, { state: 'AVAILABLE' })
    await this.audit('trip', trip.id, trip.state, 'EXPIRED', 'SYSTEM', 'offer expired')
    await this.requeueRequestsOf(trip, 'SYSTEM', 'offer expired')
  }

  async markArrivedAtStop(tripId: string, stopId: string, driverId: string): Promise<void> {
    const trip = await this.mustFindTrip(tripId)
    this.assertDriverOwns(trip, driverId)
    const stop = await this.mustFindStop(tripId, stopId)
    const now = this.clock.now()

    if (trip.state === 'ACCEPTED') {
      await this.repos.trips.update(trip.id, { state: 'EN_ROUTE', startedAt: now })
      // The trip starting moves its requests ACCEPTED → EN_ROUTE too. Without this the request
      // would try to jump straight to ARRIVED_PICKUP, which the state machine rightly refuses.
      for (const pending of await this.repos.requests.findByTrip(trip.id)) {
        if (pending.state !== 'ACCEPTED') continue
        assertRequestTransition(pending.state, 'EN_ROUTE')
        await this.repos.requests.update(pending.id, { state: 'EN_ROUTE' })
        await this.audit('request', pending.id, pending.state, 'EN_ROUTE', 'DRIVER')
      }
    }
    await this.repos.trips.updateStop(stop.id, { state: 'ARRIVED', arrivedAt: now })
    await this.repos.drivers.update(driverId, { state: 'AT_PICKUP' })

    const request = await this.mustFindRequest(stop.requestId)
    if (stop.kind === 'PICKUP' && request.state !== 'ARRIVED_PICKUP') {
      assertRequestTransition(request.state, 'ARRIVED_PICKUP')
      await this.repos.requests.update(request.id, { state: 'ARRIVED_PICKUP' })
      await this.audit('request', request.id, request.state, 'ARRIVED_PICKUP', 'DRIVER')
    }
  }

  async markBoarded(tripId: string, stopId: string, driverId: string): Promise<void> {
    const trip = await this.mustFindTrip(tripId)
    this.assertDriverOwns(trip, driverId)
    const stop = await this.mustFindStop(tripId, stopId)
    if (stop.kind !== 'PICKUP') throw new DomainError('ILLEGAL_TRANSITION', 'Not a pickup stop')

    const request = await this.mustFindRequest(stop.requestId)
    assertRequestTransition(request.state, 'BOARDED')
    await this.repos.trips.updateStop(stop.id, { state: 'DONE' })
    await this.repos.requests.update(request.id, { state: 'BOARDED' })
    await this.repos.trips.update(trip.id, { state: 'ON_TRIP' })
    await this.repos.drivers.update(driverId, { state: 'ON_TRIP' })
    await this.audit('request', request.id, request.state, 'BOARDED', 'DRIVER')
  }

  /**
   * Drop completion. The trip only completes when the LAST stop is done — a pooled trip with a
   * second guest still aboard must stay active.
   */
  async markDropped(tripId: string, stopId: string, driverId: string): Promise<{ tripCompleted: boolean }> {
    const trip = await this.mustFindTrip(tripId)
    this.assertDriverOwns(trip, driverId)
    const stop = await this.mustFindStop(tripId, stopId)
    if (stop.kind !== 'DROP') throw new DomainError('ILLEGAL_TRANSITION', 'Not a drop stop')

    const request = await this.mustFindRequest(stop.requestId)
    assertRequestTransition(request.state, 'COMPLETED')
    await this.repos.trips.updateStop(stop.id, { state: 'DONE' })
    await this.repos.requests.update(request.id, { state: 'COMPLETED' })
    await this.audit('request', request.id, request.state, 'COMPLETED', 'DRIVER')

    const stops = await this.repos.trips.stops(tripId)
    const allDone = stops.every((s) => s.state === 'DONE' || s.state === 'SKIPPED')
    if (!allDone) return { tripCompleted: false }

    const now = this.clock.now()
    await this.repos.trips.update(trip.id, { state: 'COMPLETED', completedAt: now })
    const driver = await this.mustFindDriver(driverId)

    // Counters feed the break rules (FR-D9): actual driving time, not an estimate.
    const drivenMinutes = trip.startedAt ? Math.round(minutesBetween(trip.startedAt, now)) : 0
    const drivingMinutesToday = driver.drivingMinutesToday + drivenMinutes
    const tripsSinceBreak = driver.tripsSinceBreak + 1
    const breakDue =
      drivingMinutesToday >= this.config.break_after_driving_min ||
      tripsSinceBreak >= this.config.break_after_trips

    await this.repos.drivers.update(driverId, {
      state: 'AVAILABLE',
      drivingMinutesToday,
      tripsSinceBreak,
      breakState: breakDue ? 'DUE' : driver.breakState,
      predictedFreeAt: null,
    })
    await this.audit('trip', trip.id, trip.state, 'COMPLETED', 'DRIVER')
    return { tripCompleted: true }
  }

  /** FR-D11 / E4: guest absent after the wait timer — the driver is released immediately. */
  async markNoShow(tripId: string, stopId: string, driverId: string): Promise<void> {
    const trip = await this.mustFindTrip(tripId)
    this.assertDriverOwns(trip, driverId)
    const stop = await this.mustFindStop(tripId, stopId)
    if (!stop.arrivedAt) throw new DomainError('TOO_EARLY', 'Driver has not arrived yet')
    if (minutesBetween(stop.arrivedAt, this.clock.now()) < this.config.no_show_wait_min) {
      throw new DomainError('TOO_EARLY', `Must wait ${this.config.no_show_wait_min} minutes`)
    }

    const request = await this.mustFindRequest(stop.requestId)
    assertRequestTransition(request.state, 'NO_SHOW')
    await this.repos.requests.update(request.id, { state: 'NO_SHOW', tripId: null })

    // Skip EVERY stop belonging to this guest, not just the pickup — otherwise the driver would
    // still be routed to their drop-off with nobody aboard.
    for (const owned of await this.repos.trips.stops(tripId)) {
      if (owned.requestId !== request.id) continue
      if (owned.state === 'DONE') continue
      await this.repos.trips.updateStop(owned.id, { state: 'SKIPPED' })
    }
    await this.audit('request', request.id, request.state, 'NO_SHOW', 'DRIVER')

    const remaining = (await this.repos.trips.stops(tripId)).filter((s) => s.state === 'PENDING')
    if (remaining.length === 0) {
      await this.repos.trips.update(trip.id, { state: 'COMPLETED', completedAt: this.clock.now() })
      await this.repos.drivers.update(driverId, { state: 'AVAILABLE' })
    }
  }

  /**
   * Breakdown (E5). The critical detail: onboard guests are re-queued with the driver's LIVE
   * position as their new origin. Re-dispatching to the original pickup point would send the
   * rescue vehicle to the wrong place.
   */
  async markDriverUnavailable(driverId: string, reason: string): Promise<{ requeued: string[] }> {
    const driver = await this.mustFindDriver(driverId)
    const trip = await this.repos.trips.activeForDriver(driverId)
    const requeued: string[] = []

    if (trip) {
      await this.repos.trips.update(trip.id, { state: 'CANCELLED' })
      for (const request of await this.repos.requests.findByTrip(trip.id)) {
        if (request.state === 'COMPLETED') continue
        assertRequestTransition(request.state, 'QUEUED')
        const boarded = request.state === 'BOARDED'
        await this.repos.requests.update(request.id, {
          state: 'QUEUED',
          tripId: null,
          passedOverCount: request.passedOverCount + 1,
          requeueCount: request.requeueCount + 1,
          originLat: boarded ? driver.lastLat : request.originLat,
          originLng: boarded ? driver.lastLng : request.originLng,
        })
        await this.audit('request', request.id, request.state, 'QUEUED', 'DRIVER', `breakdown: ${reason}`)
        requeued.push(request.id)
      }
    }

    assertDriverTransition(driver.state, 'UNAVAILABLE')
    await this.repos.drivers.update(driverId, { state: 'UNAVAILABLE', unavailableReason: reason })
    await this.audit('driver', driverId, driver.state, 'UNAVAILABLE', 'DRIVER', reason)
    return { requeued }
  }

  // ---------------------------------------------------------------- detour

  /** FR-M18: replace the pending tail of a live trip with the engine's new sequence. */
  async insertDetour(
    tripId: string,
    requestId: string,
    stops: Omit<TripStopRecord, 'id' | 'tripId'>[],
  ): Promise<void> {
    const trip = await this.mustFindTrip(tripId)
    if (!TRIP_ACTIVE_STATES.includes(trip.state)) {
      throw new DomainError('TRIP_NOT_ACTIVE', `Trip is ${trip.state}`)
    }
    if (trip.isPinned) throw new DomainError('TRIP_PINNED', 'Admin override pins this trip')

    const driver = await this.mustFindDriver(trip.driverId)
    const withinCapacity = capacityOkAtEveryStop(toPlannedStops(stops), driver, {
      seats: trip.seatsUsed,
      luggage: trip.luggageUsed,
    })
    if (!withinCapacity) throw new DomainError('NO_CAPACITY', 'Detour exceeds capacity', 422)

    const request = await this.mustFindRequest(requestId)
    assertRequestTransition(request.state, 'ASSIGNED')

    const completed = (await this.repos.trips.stops(tripId)).filter((s) => s.state !== 'PENDING')
    await this.repos.trips.replaceStops(tripId, [
      ...completed.map(({ id: _id, ...rest }) => rest),
      ...stops.map((s, i) => ({ ...s, tripId, seq: completed.length + i })),
    ])
    await this.repos.requests.update(requestId, { state: 'ASSIGNED', tripId })
    await this.audit('request', requestId, request.state, 'ASSIGNED', 'ENGINE', 'detour insertion')
  }

  // ---------------------------------------------------------------- guest & admin

  async markReady(requestId: string, actor: 'GUEST' | 'SYSTEM' = 'GUEST'): Promise<void> {
    const request = await this.mustFindRequest(requestId)
    assertRequestTransition(request.state, 'QUEUED')
    await this.repos.requests.update(requestId, {
      state: 'QUEUED',
      // readyAt is set once and never overwritten — it is the basis of every wait metric (D8).
      readyAt: request.readyAt ?? this.clock.now(),
    })
    await this.audit('request', requestId, request.state, 'QUEUED', actor)
  }

  async markUnmatched(
    requestId: string,
    reason: NonNullable<RequestRecord['unmatchedReason']>,
  ): Promise<void> {
    const request = await this.mustFindRequest(requestId)

    // A request that is ALREADY unmatched and still cannot be served is not a state transition —
    // it is the same state with a possibly-different reason. Asserting a transition here made every
    // round log an error and, worse, left the reason stale: ops would keep seeing the first
    // explanation ("all drivers busy") long after the real one had become "no capacity".
    if (request.state === 'UNMATCHED') {
      if (request.unmatchedReason !== reason) {
        await this.repos.requests.update(requestId, { unmatchedReason: reason })
        await this.audit('request', requestId, 'UNMATCHED', 'UNMATCHED', 'ENGINE', `reason now: ${reason}`)
      }
      return
    }

    assertRequestTransition(request.state, 'UNMATCHED')
    await this.repos.requests.update(requestId, { state: 'UNMATCHED', unmatchedReason: reason })
    await this.audit('request', requestId, request.state, 'UNMATCHED', 'ENGINE', reason)
  }

  async approveRequest(requestId: string, adminUserId: string): Promise<void> {
    const request = await this.mustFindRequest(requestId)
    assertRequestTransition(request.state, 'APPROVED')
    await this.repos.requests.update(requestId, { state: 'APPROVED' })
    await this.audit('request', requestId, request.state, 'APPROVED', 'ADMIN', undefined, adminUserId)
    // Approval gates ENTRY to the engine, never the driver choice (FR-M25).
    await this.markReady(requestId, 'SYSTEM')
  }

  async declineRequest(requestId: string, reason: string, adminUserId: string): Promise<void> {
    if (!reason.trim()) throw new DomainError('DECLINE_REASON_REQUIRED', 'Reason is required', 422)
    const request = await this.mustFindRequest(requestId)
    assertRequestTransition(request.state, 'DECLINED')
    await this.repos.requests.update(requestId, { state: 'DECLINED', declineReason: reason })
    await this.audit('request', requestId, request.state, 'DECLINED', 'ADMIN', reason, adminUserId)
  }

  /** FR-A9: reason mandatory, logged, and it must work even when the engine is down. */
  async overrideAssign(
    requestId: string,
    driverId: string,
    reason: string,
    adminUserId: string,
    stops: Omit<TripStopRecord, 'id' | 'tripId'>[],
    plannedPickupAt: Date,
    plannedDropAt: Date,
  ): Promise<TripRecord> {
    if (!reason.trim()) throw new DomainError('OVERRIDE_REASON_REQUIRED', 'Reason is required', 422)
    const trip = await this.assign({
      driverId,
      requestIds: [requestId],
      stops,
      plannedPickupAt,
      plannedDropAt,
      pinned: true,
      overrideReason: reason,
    })
    await this.audit('trip', trip.id, null, 'OFFERED', 'ADMIN', reason, adminUserId)
    return trip
  }

  async grantBreak(driverId: string): Promise<void> {
    const driver = await this.mustFindDriver(driverId)
    assertDriverTransition(driver.state, 'ON_BREAK')
    const now = this.clock.now()
    await this.repos.drivers.update(driverId, {
      state: 'ON_BREAK',
      breakState: 'ON_BREAK',
      breakStartedAt: now,
      predictedFreeAt: addMinutes(now, this.config.break_duration_min),
    })
    await this.audit('driver', driverId, driver.state, 'ON_BREAK', 'SYSTEM')
  }

  async endBreak(driverId: string): Promise<void> {
    const driver = await this.mustFindDriver(driverId)
    assertDriverTransition(driver.state, 'AVAILABLE')
    await this.repos.drivers.update(driverId, {
      state: 'AVAILABLE',
      breakState: 'NONE',
      breakStartedAt: null,
      predictedFreeAt: null,
      tripsSinceBreak: 0,
      drivingMinutesToday: 0,
    })
    await this.audit('driver', driverId, driver.state, 'AVAILABLE', 'SYSTEM', 'break complete')
  }

  async setDuty(driverId: string, online: boolean): Promise<void> {
    const driver = await this.mustFindDriver(driverId)
    const next = online ? 'AVAILABLE' : 'OFFLINE'
    assertDriverTransition(driver.state, next)
    await this.repos.drivers.update(driverId, { state: next })
    await this.audit('driver', driverId, driver.state, next, 'DRIVER')
  }

  // ---------------------------------------------------------------- helpers

  private async requeueRequestsOf(trip: TripRecord, actor: 'DRIVER' | 'SYSTEM', reason: string) {
    for (const request of await this.repos.requests.findByTrip(trip.id)) {
      assertRequestTransition(request.state, 'QUEUED')
      await this.repos.requests.update(request.id, {
        state: 'QUEUED',
        tripId: null,
        // Raised priority, preserved readyAt: a rejection moves the guest up, never back.
        passedOverCount: request.passedOverCount + 1,
        requeueCount: request.requeueCount + 1,
      })
      await this.audit('request', request.id, request.state, 'QUEUED', actor, reason)
    }
  }

  private assertDriverOwns(trip: TripRecord, driverId: string): void {
    // Row-level authorisation, enforced in the service and not only in the controller (NFR-6).
    if (trip.driverId !== driverId) {
      throw new DomainError('FORBIDDEN_ROW', 'Not your trip', 403)
    }
  }

  private async mustFindTrip(id: string): Promise<TripRecord> {
    const trip = await this.repos.trips.find(id)
    if (!trip) throw new DomainError('TRIP_NOT_FOUND', `Trip ${id} not found`, 404)
    return trip
  }

  private async mustFindDriver(id: string) {
    const driver = await this.repos.drivers.find(id)
    if (!driver) throw new DomainError('DRIVER_NOT_FOUND', `Driver ${id} not found`, 404)
    return driver
  }

  private async mustFindRequest(id: string) {
    const request = await this.repos.requests.find(id)
    if (!request) throw new DomainError('REQUEST_NOT_FOUND', `Request ${id} not found`, 404)
    return request
  }

  private async mustFindStop(tripId: string, stopId: string): Promise<TripStopRecord> {
    const stop = (await this.repos.trips.stops(tripId)).find((s) => s.id === stopId)
    if (!stop) throw new DomainError('STOP_NOT_FOUND', `Stop ${stopId} not found`, 404)
    return stop
  }

  private async audit(
    entityType: 'request' | 'driver' | 'trip',
    entityId: string,
    fromState: string | null,
    toState: string,
    actor: 'ENGINE' | 'ADMIN' | 'DRIVER' | 'GUEST' | 'SYSTEM',
    reason?: string,
    actorUserId?: string,
  ): Promise<void> {
    await this.repos.audit.append({
      entityType,
      entityId,
      fromState,
      toState,
      actor,
      reason: reason ?? null,
      actorUserId: actorUserId ?? null,
      at: this.clock.now(),
    })
  }
}
