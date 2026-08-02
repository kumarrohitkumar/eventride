import { Inject, Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaClient } from '@prisma/client'
import { parseConfig, type EventConfig } from '@eventride/shared'
import { TripService } from '../trips/trip.service.js'
import { DispatchService } from './dispatch.service.js'
import { EventsGateway } from '../realtime/events.gateway.js'
import {
  autoQueueable,
  breakDue,
  breaksToEnd,
  dutyCapReached,
  expiredOffers,
  staleLocations,
  waitBreaches,
} from './sweeper-rules.js'

/**
 * The single periodic loop that drives every timer in the system (FR-M26, D32).
 *
 * Each check is a query over CURRENT database state and holds no memory of previous ticks, so a
 * crash mid-sweep is harmless — the next tick simply redoes the work. That is why there is no job
 * queue to reconcile after a restart.
 */
@Injectable()
export class SweeperService {
  private readonly logger = new Logger(SweeperService.name)

  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(TripService) private readonly trips: TripService,
    @Inject(DispatchService) private readonly dispatch: DispatchService,
    @Inject(EventsGateway) private readonly gateway: EventsGateway,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async sweep(): Promise<void> {
    try {
      const config = await this.config()
      const now = new Date()
      let shouldDispatch = false

      shouldDispatch = (await this.expireOffers(config, now)) || shouldDispatch
      shouldDispatch = (await this.autoQueueSilentGuests(config, now)) || shouldDispatch
      shouldDispatch = (await this.endBreaks(config, now)) || shouldDispatch
      await this.markBreaksDue(config)
      await this.enforceDutyCap(config, now)
      await this.raiseWaitAlerts(config, now)
      await this.flagStaleLocations(config, now)
      await this.dispatchDueWaves(now)

      if (shouldDispatch) this.dispatch.trigger('sweeper')
    } catch (error) {
      // A failing sweep must not kill the timer: log and let the next tick retry.
      this.logger.error(`sweep failed: ${String(error)}`)
    }
  }

  /** The re-optimisation tick (FR-M3), separate from the 10 s sweeper. */
  @Cron(CronExpression.EVERY_MINUTE)
  async reoptimise(): Promise<void> {
    await this.dispatch.runRoundSafely('tick')
  }

  private async expireOffers(config: EventConfig, now: Date): Promise<boolean> {
    const offers = await this.prisma.trip.findMany({
      where: { state: 'OFFERED' },
      select: { id: true, offeredAt: true },
    })
    const expired = expiredOffers(
      offers.filter((o) => o.offeredAt).map((o) => ({ tripId: o.id, offeredAt: o.offeredAt! })),
      now,
      config,
    )
    for (const tripId of expired) {
      await this.trips.expireOffer(tripId)
      this.logger.log(`offer expired: ${tripId}`)
    }
    return expired.length > 0
  }

  private async autoQueueSilentGuests(config: EventConfig, now: Date): Promise<boolean> {
    const rows = await this.prisma.tripRequest.findMany({
      where: { state: 'REGISTERED', scheduledAt: { not: null } },
      select: { id: true, scheduledAt: true, readyAt: true },
    })
    const due = autoQueueable(
      rows.map((r) => ({
        requestId: r.id,
        scheduledAt: r.scheduledAt!,
        hasTappedReady: r.readyAt !== null,
      })),
      now,
      config,
    )
    for (const requestId of due) {
      await this.trips.markReady(requestId, 'SYSTEM')
      this.logger.log(`auto-queued silent guest: ${requestId}`)
    }
    return due.length > 0
  }

  private async markBreaksDue(config: EventConfig): Promise<void> {
    const drivers = await this.prisma.driver.findMany({
      where: { breakState: 'NONE' },
      select: {
        id: true,
        drivingMinutesToday: true,
        tripsSinceBreak: true,
        breakState: true,
        breakStartedAt: true,
        shiftStart: true,
      },
    })
    const due = breakDue(drivers.map((d) => ({ ...d, driverId: d.id })), config)
    if (due.length === 0) return
    await this.prisma.driver.updateMany({ where: { id: { in: due } }, data: { breakState: 'DUE' } })
  }

  private async endBreaks(config: EventConfig, now: Date): Promise<boolean> {
    const drivers = await this.prisma.driver.findMany({
      where: { state: 'ON_BREAK' },
      select: {
        id: true,
        drivingMinutesToday: true,
        tripsSinceBreak: true,
        breakState: true,
        breakStartedAt: true,
        shiftStart: true,
      },
    })
    const finished = breaksToEnd(drivers.map((d) => ({ ...d, driverId: d.id })), now, config)
    for (const driverId of finished) {
      await this.trips.endBreak(driverId)
      this.gateway.breakGranted(driverId, { ended: true })
    }
    return finished.length > 0
  }

  private async enforceDutyCap(config: EventConfig, now: Date): Promise<void> {
    const drivers = await this.prisma.driver.findMany({
      where: { state: { in: ['AVAILABLE', 'ON_BREAK'] } },
      select: {
        id: true,
        drivingMinutesToday: true,
        tripsSinceBreak: true,
        breakState: true,
        breakStartedAt: true,
        shiftStart: true,
      },
    })
    const over = dutyCapReached(drivers.map((d) => ({ ...d, driverId: d.id })), now, config)
    for (const driverId of over) {
      await this.trips.setDuty(driverId, false)
      await this.alert('DUTY_CAP', 'warn', `Driver ${driverId} hit the duty cap`, driverId, 'driver')
    }
  }

  private async raiseWaitAlerts(config: EventConfig, now: Date): Promise<void> {
    const queued = await this.prisma.tripRequest.findMany({
      where: { state: 'QUEUED', readyAt: { not: null } },
      select: { id: true, readyAt: true },
    })
    const { warn, critical } = waitBreaches(
      queued.map((r) => ({ requestId: r.id, readyAt: r.readyAt! })),
      now,
      config,
    )
    for (const requestId of critical) {
      await this.alert('WAIT_CRITICAL', 'critical', `Guest waiting over ${config.guest_wait_critical_min} min`, requestId, 'request')
    }
    for (const requestId of warn) {
      await this.alert('WAIT_WARN', 'warn', `Guest waiting over ${config.guest_wait_warn_min} min`, requestId, 'request')
    }
  }

  private async flagStaleLocations(config: EventConfig, now: Date): Promise<void> {
    const drivers = await this.prisma.driver.findMany({
      where: { state: { in: ['EN_ROUTE_TO_PICKUP', 'AT_PICKUP', 'ON_TRIP'] } },
      select: { id: true, lastLocationAt: true },
    })
    const stale = staleLocations(
      drivers.map((d) => ({ driverId: d.id, onActiveTrip: true, lastLocationAt: d.lastLocationAt })),
      now,
      config,
    )
    for (const driverId of stale) {
      await this.alert('STALE_LOCATION', 'warn', 'Driver location has gone stale mid-trip', driverId, 'driver')
    }
  }

  private async dispatchDueWaves(now: Date): Promise<void> {
    const due = await this.prisma.wave.findMany({
      where: { state: 'PLANNED', departsAt: { lte: now } },
      include: { requests: true },
    })
    for (const wave of due) {
      for (const request of wave.requests) {
        if (request.state === 'REGISTERED') await this.trips.markReady(request.id, 'SYSTEM')
      }
      await this.prisma.wave.update({ where: { id: wave.id }, data: { state: 'DISPATCHED' } })
      this.dispatch.trigger('wave-due')
    }
  }

  /** De-duplicated: an unacknowledged alert of the same type for the same entity is not repeated. */
  private async alert(
    type: string,
    severity: string,
    message: string,
    entityId: string,
    entityType: string,
  ): Promise<void> {
    const existing = await this.prisma.alert.findFirst({
      where: { type, entityId, acknowledgedAt: null },
    })
    if (existing) return
    const created = await this.prisma.alert.create({
      data: { type, severity, message, entityId, entityType },
    })
    this.gateway.alertRaised(created)
  }

  private async config(): Promise<EventConfig> {
    const event = await this.prisma.event.findFirst()
    return parseConfig(event?.config ?? {})
  }
}
