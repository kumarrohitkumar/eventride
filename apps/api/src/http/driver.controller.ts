import { Body, Controller, Get, Param, Post, UseGuards, Inject, HttpCode } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { z } from 'zod'
import { minutesBetween, parseConfig } from '@eventride/shared'
import { TripService } from '../trips/trip.service.js'
import { DispatchService } from '../dispatch/dispatch.service.js'
import { AuthGuard, Principal, Roles, RolesGuard } from './guards.js'
import { type AuthPrincipal } from '../auth/rbac.js'
import { DomainError } from '../trips/ports.js'
import { NotificationService, messages } from '../realtime/notification.service.js'
import { EventsGateway } from '../realtime/events.gateway.js'

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  at: z.coerce.date().optional(),
})

/**
 * Driver API (LLD §4.3). Self-scoped like the guest API: the driver id comes from the token.
 *
 * There is deliberately NO endpoint that lists waiting guests, other drivers, or upcoming trips —
 * FR-D3 means one trip at a time, and the absence of those routes is how that is enforced rather
 * than by a UI that chooses not to render them.
 */
@Controller('api/v1/me')
@UseGuards(AuthGuard, RolesGuard)
@Roles('DRIVER')
export class DriverController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(Redis) private readonly redis: Redis,
    @Inject(TripService) private readonly trips: TripService,
    @Inject(DispatchService) private readonly dispatch: DispatchService,
    @Inject(NotificationService) private readonly notify: NotificationService,
    @Inject(EventsGateway) private readonly gateway: EventsGateway,
  ) {}

  @HttpCode(200)
  @Post('duty')
  async duty(@Principal() principal: AuthPrincipal, @Body() body: unknown) {
    const { online } = z.object({ online: z.boolean() }).parse(body)
    await this.trips.setDuty(principal.driverId!, online)
    if (online) this.dispatch.trigger('driver-online')
    return { online }
  }

  /**
   * FR-D3 / FR-D4 — the one active trip, or null.
   *
   * The payload contains guest NAMES and counts but no guest phone numbers: the field is never
   * serialised, so it cannot leak through a debug view or a proxy log (D9).
   */
  @Get('trip')
  async currentTrip(@Principal() principal: AuthPrincipal) {
    const trip = await this.prisma.trip.findFirst({
      where: {
        driverId: principal.driverId,
        state: { in: ['OFFERED', 'ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'] },
      },
      include: {
        stops: { orderBy: { seq: 'asc' }, include: { location: true } },
        requests: { include: { guest: true } },
      },
    })
    if (!trip) return { trip: null }

    return {
      trip: {
        id: trip.id,
        state: trip.state,
        version: trip.version,
        offerExpiresAt: trip.offerExpiresAt,
        plannedPickupAt: trip.plannedPickupAt,
        plannedDropAt: trip.plannedDropAt,
        guestNames: trip.requests.map((r) => r.guest.name),
        guestCount: trip.requests.reduce((sum, r) => sum + r.groupSize, 0),
        luggageCount: trip.requests.reduce((sum, r) => sum + r.luggageCount, 0),
        stops: trip.stops.map((s) => ({
          id: s.id,
          seq: s.seq,
          kind: s.kind,
          label: s.location.label,
          instruction: s.location.pickupInstruction,
          lat: s.lat,
          lng: s.lng,
          state: s.state,
          plannedAt: s.plannedAt,
        })),
      },
    }
  }

  @HttpCode(200)
  @Post('trip/:id/accept')
  async accept(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: { version?: number },
  ) {
    const trip = await this.trips.accept(id, principal.driverId!, body?.version)

    // Only NOW does the guest learn who is coming: naming a driver before they accept means the
    // guest can watch their ride vanish (HLD §6.1).
    const detail = await this.prisma.trip.findUnique({
      where: { id },
      include: { driver: true, requests: true },
    })
    if (detail) {
      const etaMin = detail.plannedPickupAt
        ? (detail.plannedPickupAt.getTime() - Date.now()) / 60_000
        : null
      for (const request of detail.requests) {
        void this.notify.sendToGuest(
          request.guestId,
          messages.tripAssigned(detail.driver.name, detail.driver.vehicleNumber, etaMin),
        )
        this.gateway.tripAssigned(request.guestId, {
          driverName: detail.driver.name,
          vehicleNumber: detail.driver.vehicleNumber,
          vehicleType: detail.driver.vehicleType,
          etaMin,
        })
      }
    }
    return { state: trip.state }
  }

  /** FR-D5: reject with a reason. Cooldown lives in Redis with a TTL, so it expires itself. */
  @HttpCode(200)
  @Post('trip/:id/reject')
  async reject(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { reason } = z.object({ reason: z.string().min(2).max(200) }).parse(body)
    const requests = await this.prisma.tripRequest.findMany({
      where: { tripId: id },
      select: { id: true },
    })

    await this.trips.reject(id, principal.driverId!, reason)

    const config = await this.config()
    const key = `cooldown:${principal.driverId}`
    for (const request of requests) await this.redis.sadd(key, request.id)
    await this.redis.expire(key, config.driver_reject_cooldown_min * 60)

    await this.alertOnRepeatedRejects(principal.driverId!, config.consecutive_rejects_alert)
    this.dispatch.trigger('driver-rejected')
    return { requeued: requests.length }
  }

  @HttpCode(200)
  @Post('trip/:id/stops/:stopId/arrived')
  async arrived(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Param('stopId') stopId: string,
  ) {
    await this.trips.markArrivedAtStop(id, stopId, principal.driverId!)

    // The arrival push is the one a guest most needs while the app is closed.
    const stop = await this.prisma.tripStop.findUnique({
      where: { id: stopId },
      include: { request: true, trip: { include: { driver: true } } },
    })
    if (stop?.kind === 'PICKUP') {
      void this.notify.sendToGuest(
        stop.request.guestId,
        messages.driverArrived(stop.trip.driver.vehicleNumber),
      )
    }
    return { ok: true }
  }

  @HttpCode(200)
  @Post('trip/:id/stops/:stopId/boarded')
  async boarded(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Param('stopId') stopId: string,
  ) {
    await this.trips.markBoarded(id, stopId, principal.driverId!)
    return { ok: true }
  }

  @HttpCode(200)
  @Post('trip/:id/stops/:stopId/dropped')
  async dropped(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Param('stopId') stopId: string,
  ) {
    const result = await this.trips.markDropped(id, stopId, principal.driverId!)
    // A freed driver is immediately useful — trigger a round rather than waiting for the tick.
    if (result.tripCompleted) this.dispatch.trigger('trip-completed')
    return result
  }

  /** FR-D11: only offered after the wait timer; the service enforces the timing. */
  @HttpCode(200)
  @Post('trip/:id/stops/:stopId/guest-not-found')
  async guestNotFound(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Param('stopId') stopId: string,
  ) {
    await this.trips.markNoShow(id, stopId, principal.driverId!)
    this.dispatch.trigger('no-show')
    return { ok: true }
  }

  /**
   * FR-D7: high-frequency, low-value writes go to Redis; MySQL is mirrored every 30 s for the
   * audit trail and as the L2 fallback (HLD §10).
   */
  @HttpCode(200)
  @Post('location')
  async location(@Principal() principal: AuthPrincipal, @Body() body: unknown) {
    const input = locationSchema.parse(body)
    const driverId = principal.driverId!
    const now = input.at ?? new Date()

    await this.redis.set(
      `pos:${driverId}`,
      JSON.stringify({ lat: input.lat, lng: input.lng, at: now }),
      'EX',
      120,
    )

    const config = await this.config()
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { lastLocationAt: true },
    })
    const shouldMirror =
      !driver?.lastLocationAt ||
      minutesBetween(driver.lastLocationAt, now) * 60 >= config.location_ping_idle_sec

    if (shouldMirror) {
      await this.prisma.driver.update({
        where: { id: driverId },
        data: { lastLat: input.lat, lastLng: input.lng, lastLocationAt: now },
      })
      await this.prisma.driverPositionHistory.create({
        data: { driverId, lat: input.lat, lng: input.lng, at: now },
      })
    }
    return { stored: true }
  }

  /** FR-D9: auto-granted when the queue allows it, otherwise it waits for admin. */
  @HttpCode(200)
  @Post('break/request')
  async requestBreak(@Principal() principal: AuthPrincipal) {
    const queued = await this.prisma.tripRequest.count({ where: { state: 'QUEUED' } })
    const available = await this.prisma.driver.count({ where: { state: 'AVAILABLE' } })

    // Auto-grant only if losing this driver will not leave guests stranded.
    if (queued === 0 || available > queued) {
      await this.trips.grantBreak(principal.driverId!)
      return { granted: true }
    }
    await this.prisma.alert.create({
      data: {
        type: 'APPROVAL_PENDING',
        severity: 'warn',
        entityType: 'driver',
        entityId: principal.driverId!,
        message: 'Driver requested a break during a queue backlog',
      },
    })
    return { granted: false, pendingAdmin: true }
  }

  /** FR-D10: shift + next break window only. No upcoming-trip list, by design. */
  @Get('shift')
  async shift(@Principal() principal: AuthPrincipal) {
    const driver = await this.prisma.driver.findUnique({ where: { id: principal.driverId } })
    if (!driver) throw new DomainError('DRIVER_NOT_FOUND', 'Driver not found', 404)
    const config = await this.config()
    return {
      shiftStart: driver.shiftStart,
      shiftEnd: driver.shiftEnd,
      drivingMinutesToday: driver.drivingMinutesToday,
      tripsSinceBreak: driver.tripsSinceBreak,
      breakState: driver.breakState,
      minutesUntilBreakDue: Math.max(
        0,
        config.break_after_driving_min - driver.drivingMinutesToday,
      ),
      tripsUntilBreakDue: Math.max(0, config.break_after_trips - driver.tripsSinceBreak),
      opsHelpdeskPhone: config.ops_helpdesk_phone,
    }
  }

  private async alertOnRepeatedRejects(driverId: string, threshold: number): Promise<void> {
    const recent = await this.prisma.trip.count({
      where: { driverId, state: 'REJECTED' },
      // Consecutive-ish: the most recent window is what ops care about.
    })
    if (recent > 0 && recent % threshold === 0) {
      await this.prisma.alert.create({
        data: {
          type: 'CONSECUTIVE_REJECTS',
          severity: 'warn',
          entityType: 'driver',
          entityId: driverId,
          message: `Driver has rejected ${recent} trips`,
        },
      })
    }
  }

  private async config() {
    const event = await this.prisma.event.findFirst()
    return parseConfig(event?.config ?? {})
  }
}
