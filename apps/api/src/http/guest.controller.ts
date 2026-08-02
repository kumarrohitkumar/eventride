import { Body, Controller, Get, Param, Post, UseGuards, Inject } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { DomainError } from '../trips/ports.js'
import { TripService } from '../trips/trip.service.js'
import { DispatchService } from '../dispatch/dispatch.service.js'
import { AuthGuard, Principal, Roles, RolesGuard } from './guards.js'
import { assertOwnsRequest, type AuthPrincipal } from '../auth/rbac.js'

const adHocSchema = z.object({
  originId: z.string().min(1),
  destinationId: z.string().min(1),
  people: z.number().int().positive().max(20),
  luggage: z.number().int().nonnegative().max(20),
  reason: z.string().min(3).max(500),
  when: z.enum(['NOW', 'LATER']).default('NOW'),
  scheduledAt: z.coerce.date().optional(),
})

/**
 * Guest API (LLD §4.2). Every route is SELF-SCOPED: the guest id comes from the token, so no
 * endpoint takes a guest id and there is nothing for a caller to tamper with (NFR-6).
 */
@Controller('api/v1/me')
@UseGuards(AuthGuard, RolesGuard)
@Roles('GUEST')
export class GuestController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(TripService) private readonly trips: TripService,
    @Inject(DispatchService) private readonly dispatch: DispatchService,
  ) {}

  /** FR-G12 — the guest's own trips for the event. */
  @Get('itinerary')
  async itinerary(@Principal() principal: AuthPrincipal) {
    const rows = await this.prisma.tripRequest.findMany({
      where: { guestId: principal.guestId },
      include: { origin: true, destination: true },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    })
    return rows.map((r) => ({
      requestId: r.id,
      tripType: r.tripType,
      state: r.state,
      scheduledAt: r.scheduledAt,
      from: r.origin.label,
      to: r.destination.label,
      groupSize: r.groupSize,
      luggageCount: r.luggageCount,
    }))
  }

  /**
   * FR-G2 / FR-G5 / FR-G8 — one flattened view-model so the home screen is a single request with
   * no client-side joins.
   *
   * Driver details appear only once the driver has ACCEPTED (HLD §6.1): showing a driver who then
   * rejects would make the guest watch their ride vanish.
   */
  @Get('current')
  async current(@Principal() principal: AuthPrincipal) {
    const request = await this.prisma.tripRequest.findFirst({
      where: {
        guestId: principal.guestId,
        state: { notIn: ['COMPLETED', 'CANCELLED', 'DECLINED', 'NO_SHOW'] },
      },
      include: {
        origin: true,
        destination: true,
        trip: { include: { driver: true, stops: { orderBy: { seq: 'asc' } }, requests: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    if (!request) return { request: null }

    const trip = request.trip
    const driverVisible =
      trip && ['ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'].includes(trip.state)

    const coPassengers = trip ? Math.max(0, trip.requests.length - 1) : 0
    const myPickupSeq = trip?.stops.find(
      (s) => s.requestId === request.id && s.kind === 'PICKUP',
    )?.seq
    const stopsBeforeMine =
      trip && myPickupSeq !== undefined
        ? trip.stops.filter((s) => s.seq < myPickupSeq && s.state === 'PENDING').length
        : 0

    return {
      request: {
        id: request.id,
        state: request.state,
        tripType: request.tripType,
        pickup: {
          label: request.origin.label,
          instruction: request.origin.pickupInstruction,
          lat: request.originLat ?? request.origin.lat,
          lng: request.originLng ?? request.origin.lng,
        },
        destination: { label: request.destination.label },
        scheduledAt: request.scheduledAt,
        readyAt: request.readyAt,
        groupSize: request.groupSize,
        luggageCount: request.luggageCount,
        declineReason: request.declineReason,
      },
      driver: driverVisible
        ? {
            name: trip.driver.name,
            phone: trip.driver.phone, // guest DOES get the driver's number (D9)
            vehicleNumber: trip.driver.vehicleNumber,
            vehicleType: trip.driver.vehicleType,
            lat: trip.driver.lastLat,
            lng: trip.driver.lastLng,
            lastLocationAt: trip.driver.lastLocationAt,
          }
        : null,
      isShared: coPassengers > 0,
      coPassengers,
      stopsBeforeYou: stopsBeforeMine,
      plannedPickupAt: trip?.plannedPickupAt ?? null,
    }
  }

  /** FR-G3 — the tap that creates demand. */
  @Post('requests/:id/ready')
  async ready(@Principal() principal: AuthPrincipal, @Param('id') id: string) {
    await this.assertOwn(principal, id)
    await this.trips.markReady(id, 'GUEST')
    this.dispatch.trigger('guest-ready')
    return { state: 'QUEUED' }
  }

  /** FR-G9 — goes to ADMIN APPROVAL, never straight to the engine (FR-M25). */
  @Post('requests')
  async requestRide(@Principal() principal: AuthPrincipal, @Body() body: unknown) {
    const input = adHocSchema.parse(body)

    // E18: one pending request at a time, so a double tap cannot flood the approval queue.
    const pending = await this.prisma.tripRequest.count({
      where: { guestId: principal.guestId, state: 'PENDING_APPROVAL' },
    })
    if (pending > 0) {
      throw new DomainError('REQUEST_ALREADY_PENDING', 'You already have a pending request')
    }

    const created = await this.prisma.tripRequest.create({
      data: {
        guestId: principal.guestId!,
        tripType: 'AD_HOC',
        source: 'ON_DEMAND',
        originId: input.originId,
        destinationId: input.destinationId,
        groupSize: input.people,
        luggageCount: input.luggage,
        state: 'PENDING_APPROVAL',
        approvalNote: input.reason,
        scheduledAt: input.when === 'LATER' ? (input.scheduledAt ?? null) : new Date(),
      },
    })
    return { requestId: created.id, state: created.state }
  }

  /** FR-G15 — no self-cancel: this raises a note for ops, who decide. */
  @Post('requests/:id/no-longer-needed')
  async noLongerNeeded(@Principal() principal: AuthPrincipal, @Param('id') id: string) {
    await this.assertOwn(principal, id)
    await this.prisma.alert.create({
      data: {
        type: 'APPROVAL_PENDING',
        severity: 'info',
        entityType: 'request',
        entityId: id,
        message: 'Guest says this ride is no longer needed',
      },
    })
    return { acknowledged: true }
  }

  @Post('push-token')
  async pushToken(
    @Principal() principal: AuthPrincipal,
    @Body() body: { token: string; platform: string },
  ) {
    const input = z.object({ token: z.string().min(10), platform: z.string() }).parse(body)
    await this.prisma.notificationToken.upsert({
      where: { token: input.token },
      create: { userId: principal.userId, token: input.token, platform: input.platform },
      update: { userId: principal.userId, platform: input.platform },
    })
    return { stored: true }
  }

  /** Row-level check (layer 2): the row must belong to the caller even though it exists. */
  private async assertOwn(principal: AuthPrincipal, requestId: string): Promise<void> {
    const row = await this.prisma.tripRequest.findUnique({
      where: { id: requestId },
      select: { guestId: true },
    })
    if (!row) throw new DomainError('REQUEST_NOT_FOUND', 'Request not found', 404)
    assertOwnsRequest(principal, row)
  }
}
