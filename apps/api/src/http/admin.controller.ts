import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Inject,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import {
  addMinutes,
  eventConfigSchema,
  estimateMinutes,
  parseConfig,
  type EventConfig,
} from '@eventride/shared'
import { buildStopsForRequests } from '@eventride/engine'
import { TripService } from '../trips/trip.service.js'
import { DispatchService } from '../dispatch/dispatch.service.js'
import { AuthGuard, Principal, Roles, RolesGuard } from './guards.js'
import type { AuthPrincipal } from '../auth/rbac.js'
import { DomainError } from '../trips/ports.js'
import { computeDeadline, waitSeverity } from '../domain/deadlines.js'
import { allocateVehiclesForWave, planVenueWaves } from '../domain/waves.js'
import { NotificationService, messages } from '../realtime/notification.service.js'

const driverSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(6),
  vehicleNumber: z.string().min(3),
  vehicleType: z.string().min(2),
  seatCapacity: z.number().int().positive().max(60),
  luggageCapacity: z.number().int().nonnegative().max(60),
  shiftStart: z.coerce.date(),
  shiftEnd: z.coerce.date(),
})

const guestSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(6),
  groupSize: z.number().int().positive().max(30),
  luggageCount: z.number().int().nonnegative().max(60),
  accommodationId: z.string().optional(),
  arrivalMode: z.string().optional(),
  arrivalRef: z.string().optional(),
  arrivalAt: z.coerce.date().optional(),
  arrivalLocationId: z.string().optional(),
  departureAt: z.coerce.date().optional(),
  departureLocationId: z.string().optional(),
  isVip: z.boolean().default(false),
  isWalkIn: z.boolean().default(false),
})

/**
 * Admin API (LLD §4.4).
 *
 * The automation boundary is enforced by the SHAPE of this API, not by convention: `approve` takes
 * no driver id, and exactly one endpoint (`override-assign`) accepts one — and that one demands a
 * reason and writes an audit row (FR-M25, G5).
 */
@Controller('api/v1/admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(TripService) private readonly trips: TripService,
    @Inject(DispatchService) private readonly dispatch: DispatchService,
    @Inject(NotificationService) private readonly notify: NotificationService,
  ) {}

  /** FR-A1 / FR-A14 — counters, alerts, and the demand-vs-supply signal. */
  @Get('dashboard')
  async dashboard() {
    const config = await this.config()
    const [queued, assigned, inTransit, completed, unmatched, drivers, alerts] = await Promise.all([
      this.prisma.tripRequest.findMany({
        where: { state: 'QUEUED' },
        select: { id: true, readyAt: true, groupSize: true },
      }),
      this.prisma.tripRequest.count({ where: { state: { in: ['ASSIGNED', 'ACCEPTED'] } } }),
      this.prisma.tripRequest.count({ where: { state: { in: ['EN_ROUTE', 'ARRIVED_PICKUP', 'BOARDED'] } } }),
      this.prisma.tripRequest.count({ where: { state: 'COMPLETED' } }),
      this.prisma.tripRequest.count({ where: { state: 'UNMATCHED' } }),
      this.prisma.driver.findMany({ select: { state: true, seatCapacity: true } }),
      this.prisma.alert.findMany({ where: { acknowledgedAt: null }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ])

    const now = new Date()
    const seatsNeeded = queued.reduce((sum, r) => sum + r.groupSize, 0)
    const seatsAvailable = drivers
      .filter((d) => d.state === 'AVAILABLE')
      .reduce((sum, d) => sum + d.seatCapacity, 0)

    return {
      counts: { queued: queued.length, assigned, inTransit, completed, unmatched },
      drivers: {
        total: drivers.length,
        available: drivers.filter((d) => d.state === 'AVAILABLE').length,
        onTrip: drivers.filter((d) => d.state === 'ON_TRIP').length,
        onBreak: drivers.filter((d) => d.state === 'ON_BREAK').length,
        offline: drivers.filter((d) => d.state === 'OFFLINE').length,
      },
      // The signal that lets ops escalate the fleet BEFORE the queue explodes.
      demandVsSupply: { seatsNeeded, seatsAvailable, gap: Math.max(0, seatsNeeded - seatsAvailable) },
      waiting: queued
        .filter((r) => r.readyAt)
        .map((r) => ({
          requestId: r.id,
          waitedMin: Math.round((now.getTime() - r.readyAt!.getTime()) / 60_000),
          severity: waitSeverity(r.readyAt!, now, config),
        }))
        .sort((a, b) => b.waitedMin - a.waitedMin),
      alerts,
    }
  }

  /** FR-A2 — includes predicted free time, which is what makes the board actionable. */
  @Get('drivers')
  async drivers() {
    const rows = await this.prisma.driver.findMany({
      include: { trips: { where: { state: { in: ['OFFERED', 'ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'] } } } },
      orderBy: { name: 'asc' },
    })
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      phone: d.phone,
      vehicleNumber: d.vehicleNumber,
      vehicleType: d.vehicleType,
      seatCapacity: d.seatCapacity,
      luggageCapacity: d.luggageCapacity,
      state: d.state,
      breakState: d.breakState,
      drivingMinutesToday: d.drivingMinutesToday,
      position: d.lastLat && d.lastLng ? { lat: d.lastLat, lng: d.lastLng, at: d.lastLocationAt } : null,
      predictedFreeAt: d.predictedFreeAt,
      currentTripId: d.trips[0]?.id ?? null,
    }))
  }

  /** FR-A6 — manual onboarding; there is no self-signup anywhere in the system. */
  @Post('drivers')
  async createDriver(@Body() body: unknown) {
    const input = driverSchema.parse(body)
    const user = await this.prisma.appUser.create({
      data: { role: 'DRIVER', phone: input.phone, name: input.name },
    })
    return this.prisma.driver.create({ data: { ...input, userId: user.id } })
  }

  @Patch('drivers/:id')
  async updateDriver(@Param('id') id: string, @Body() body: unknown) {
    const input = driverSchema.partial().parse(body)
    return this.prisma.driver.update({ where: { id }, data: input })
  }

  /** E5 — breakdown: re-queues onboard guests from the driver's live position. */
  @Post('drivers/:id/unavailable')
  async markUnavailable(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(body)
    const result = await this.trips.markDriverUnavailable(id, reason)
    // Guests who were aboard deserve to know immediately, not to wonder why they stopped moving.
    for (const requestId of result.requeued) {
      const request = await this.prisma.tripRequest.findUnique({ where: { id: requestId }, select: { guestId: true } })
      if (request) void this.notify.sendToGuest(request.guestId, messages.reassigning())
    }
    this.dispatch.trigger('driver-unavailable')
    return result
  }

  @Post('drivers/:id/break')
  async manageBreak(@Param('id') id: string, @Body() body: unknown) {
    const { grant } = z.object({ grant: z.boolean() }).parse(body)
    if (grant) await this.trips.grantBreak(id)
    else await this.trips.endBreak(id)
    return { grant }
  }

  /** FR-A3 — the guest board, sorted so the longest wait is first. */
  @Get('guests')
  async guests(@Query('state') state?: string) {
    const rows = await this.prisma.guest.findMany({
      include: { requests: { orderBy: { createdAt: 'desc' } }, accommodation: true },
      orderBy: { name: 'asc' },
    })
    return rows
      .map((g) => ({
        id: g.id,
        name: g.name,
        phone: g.phone,
        isVip: g.isVip,
        groupSize: g.groupSize,
        luggageCount: g.luggageCount,
        accommodation: g.accommodation?.label ?? null,
        arrivalAt: g.arrivalAt,
        currentState: g.requests[0]?.state ?? null,
        requests: g.requests.map((r) => ({ id: r.id, state: r.state, tripType: r.tripType })),
      }))
      .filter((g) => !state || g.currentState === state)
  }

  /** FR-A7 — walk-ins and deviations. Editing arrival time re-derives the deadline. */
  @Post('guests')
  async createGuest(@Body() body: unknown) {
    const input = guestSchema.parse(body)
    const user = await this.prisma.appUser.create({
      data: { role: 'GUEST', phone: input.phone, name: input.name },
    })
    return this.prisma.guest.create({ data: { ...input, userId: user.id } })
  }

  @Patch('guests/:id')
  async updateGuest(@Param('id') id: string, @Body() body: unknown) {
    const input = guestSchema.partial().parse(body)
    const guest = await this.prisma.guest.update({ where: { id }, data: input })

    // Any change to travel details re-plans that guest's UNSTARTED trips (FR-A7, E6).
    const config = await this.config()
    const unstarted = await this.prisma.tripRequest.findMany({
      where: { guestId: id, state: { in: ['REGISTERED', 'QUEUED', 'UNMATCHED'] } },
      include: { destination: true },
    })
    for (const request of unstarted) {
      const reference =
        request.tripType === 'DEPARTURE' ? guest.departureAt : request.scheduledAt
      const deadline = computeDeadline({
        tripType: request.tripType,
        referenceAt: reference ?? null,
        destinationType: request.destination.type,
        config,
      })
      await this.prisma.tripRequest.update({
        where: { id: request.id },
        data: {
          deadlineAt: deadline.deadlineAt,
          isHardDeadline: deadline.isHardDeadline,
          scheduledAt: request.tripType === 'ARRIVAL' ? (guest.arrivalAt ?? request.scheduledAt) : request.scheduledAt,
        },
      })
    }
    this.dispatch.trigger('guest-updated')
    return { guest, replanned: unstarted.length }
  }

  /**
   * FR-A8 — CSV upload, all-or-nothing, with a row-level error report.
   *
   * Accepts a real multipart file (what ops actually has: an export from the registration sheet) and
   * also a JSON `rows` array, so the endpoint is scriptable for tests and seeding.
   */
  @Post('guests/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async importGuests(@Body() body: unknown, @UploadedFile() file?: { buffer: Buffer }) {
    const rows = file
      ? parseCsv(file.buffer.toString('utf8'))
      : z.object({ rows: z.array(z.record(z.unknown())) }).parse(body).rows
    const errors: { row: number; message: string }[] = []
    const parsed: z.infer<typeof guestSchema>[] = []

    rows.forEach((row: Record<string, unknown>, index: number) => {
      const result = guestSchema.safeParse(coerceCsvRow(row))
      if (result.success) parsed.push(result.data)
      else errors.push({ row: index + 1, message: result.error.issues[0]?.message ?? 'invalid' })
    })

    // Refuse the whole file rather than importing a partial, half-trustworthy guest list: ops must
    // be able to trust that the roster is either fully loaded or untouched.
    if (errors.length > 0) {
      throw new DomainError(
        'CSV_VALIDATION_FAILED',
        `${errors.length} invalid row(s): ${errors.slice(0, 5).map((e) => `row ${e.row} — ${e.message}`).join('; ')}`,
        422,
      )
    }

    let imported = 0
    await this.prisma.$transaction(async (tx) => {
      for (const guest of parsed) {
        const user = await tx.appUser.create({
          data: { role: 'GUEST', phone: guest.phone, name: guest.name },
        })
        await tx.guest.create({ data: { ...guest, userId: user.id } })
        imported++
      }
    })
    return { imported, errors }
  }

  @Get('requests')
  async requests(@Query('state') state?: string) {
    return this.prisma.tripRequest.findMany({
      where: state ? { state: state as never } : {},
      include: { guest: true, origin: true, destination: true },
      orderBy: [{ readyAt: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    })
  }

  /** FR-A5 — approval gates ENTRY to the engine. Note: no driverId parameter exists here. */
  @Post('requests/:id/approve')
  async approve(@Principal() principal: AuthPrincipal, @Param('id') id: string) {
    await this.trips.approveRequest(id, principal.userId)
    const request = await this.prisma.tripRequest.findUnique({ where: { id }, select: { guestId: true } })
    if (request) void this.notify.sendToGuest(request.guestId, messages.requestApproved())
    this.dispatch.trigger('admin-approved')
    return { state: 'QUEUED' }
  }

  @Post('requests/:id/decline')
  async decline(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(body)
    await this.trips.declineRequest(id, reason, principal.userId)
    // The guest sees the admin's actual words, not a generic rejection.
    const request = await this.prisma.tripRequest.findUnique({ where: { id }, select: { guestId: true } })
    if (request) void this.notify.sendToGuest(request.guestId, messages.requestDeclined(reason))
    return { state: 'DECLINED' }
  }

  @Post('requests/:id/retry')
  async retry(@Param('id') id: string) {
    await this.trips.markReady(id, 'SYSTEM')
    this.dispatch.trigger('admin-retry')
    return { state: 'QUEUED' }
  }

  /**
   * FR-A9 — the ONLY endpoint that names a driver. Reason is mandatory, the trip is pinned so the
   * engine will not re-optimise it away, and it is a plain DB write path that works even when the
   * engine is down (D35, G7).
   */
  @Post('requests/:id/override-assign')
  async overrideAssign(
    @Principal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({ driverId: z.string().min(1), reason: z.string().min(3).max(500) })
      .parse(body)

    const request = await this.prisma.tripRequest.findUnique({
      where: { id },
      include: { origin: true, destination: true, guest: true },
    })
    if (!request) throw new DomainError('REQUEST_NOT_FOUND', 'Request not found', 404)

    const origin = { lat: request.originLat ?? request.origin.lat, lng: request.originLng ?? request.origin.lng }
    const destination = { lat: request.destination.lat, lng: request.destination.lng }
    const rideMinutes = estimateMinutes(origin, destination)
    const now = new Date()

    const stops = buildStopsForRequests([
      {
        id: request.id,
        guestId: request.guestId,
        guestName: request.guest.name,
        tripType: request.tripType,
        source: request.source,
        state: request.state,
        origin,
        originId: request.originId,
        destination,
        destinationId: request.destinationId,
        groupSize: request.groupSize,
        luggageCount: request.luggageCount,
        isVip: request.guest.isVip,
        isHardDeadline: request.isHardDeadline,
        deadlineAt: request.deadlineAt,
        readyAt: request.readyAt,
        scheduledAt: request.scheduledAt,
        createdAt: request.createdAt,
        passedOverCount: request.passedOverCount,
        groupRef: request.groupRef,
        waveId: request.waveId,
      },
    ])

    const trip = await this.trips.overrideAssign(
      id,
      input.driverId,
      input.reason,
      principal.userId,
      stops.map((s, i) => ({
        seq: i,
        kind: s.kind,
        requestId: s.requestId,
        locationId: s.locationId,
        lat: s.at.lat,
        lng: s.at.lng,
        state: 'PENDING' as const,
        plannedAt: null,
        arrivedAt: null,
        seatsDelta: s.seatsDelta,
        luggageDelta: s.luggageDelta,
      })),
      now,
      addMinutes(now, rideMinutes),
    )
    return { tripId: trip.id, pinned: trip.isPinned }
  }

  @Post('requests/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(body)
    await this.prisma.tripRequest.update({ where: { id }, data: { state: 'CANCELLED' } })
    await this.prisma.statusEvent.create({
      data: { entityType: 'request', entityId: id, toState: 'CANCELLED', actor: 'ADMIN', reason },
    })
    return { state: 'CANCELLED' }
  }

  /** FR-A12 — waves for the venue surge. */
  @Post('waves/plan')
  async planWaves(@Body() body: unknown) {
    const input = z
      .object({
        destinationId: z.string(),
        sessionStartsAt: z.coerce.date(),
        waveCount: z.number().int().positive().max(6).default(3),
        headwayMin: z.number().int().positive().max(120).default(30),
      })
      .parse(body)

    const config = await this.config()
    const accommodations = await this.prisma.location.findMany({
      where: { type: 'ACCOMMODATION' },
      include: { guestsAccommodated: true },
    })

    const planned = planVenueWaves({
      eventDay: input.sessionStartsAt,
      origins: accommodations.map((a) => ({ id: a.id, guestCount: a.guestsAccommodated.length })),
      destinationId: input.destinationId,
      sessionStartsAt: input.sessionStartsAt,
      waveCount: input.waveCount,
      headwayMin: input.headwayMin,
      config,
    })

    const created = await this.prisma.$transaction(
      planned.map((w) =>
        this.prisma.wave.create({
          data: {
            tripType: 'TO_VENUE',
            originId: w.originId,
            destinationId: w.destinationId,
            departsAt: w.departsAt,
            seatsNeeded: w.seatsNeeded,
          },
        }),
      ),
    )
    return { waves: created }
  }

  @Get('waves')
  async waves() {
    return this.prisma.wave.findMany({
      include: { origin: true, destination: true, requests: true },
      orderBy: { departsAt: 'asc' },
    })
  }

  /** FR-M6 — dispatch a wave: its requests become QUEUED, and the engine assigns the vehicles. */
  @Post('waves/:id/dispatch')
  async dispatchWave(@Param('id') id: string) {
    const wave = await this.prisma.wave.findUnique({ where: { id }, include: { requests: true } })
    if (!wave) throw new DomainError('WAVE_NOT_FOUND', 'Wave not found', 404)

    const available = await this.prisma.driver.findMany({
      where: { state: 'AVAILABLE' },
      select: { id: true, seatCapacity: true },
    })
    const allocation = allocateVehiclesForWave(wave.seatsNeeded, available)

    for (const request of wave.requests) {
      if (request.state === 'REGISTERED') await this.trips.markReady(request.id, 'SYSTEM')
    }
    await this.prisma.wave.update({ where: { id }, data: { state: 'DISPATCHED' } })

    if (allocation.seatsShort > 0) {
      await this.prisma.alert.create({
        data: {
          type: 'FLEET_SHORTFALL',
          severity: 'critical',
          entityType: 'wave',
          entityId: id,
          message: `Wave is ${allocation.seatsShort} seats short`,
        },
      })
    }
    this.dispatch.trigger('wave-dispatched')
    return allocation
  }

  /**
   * FR-A13 — preview a plan without committing it.
   *
   * Runs the real engine over the current snapshot and returns what it WOULD do, touching nothing.
   * Ops can see the proposed pairings, and every rejection with its reason, before publishing.
   */
  @Post('batch-plan/preview')
  async previewBatch() {
    const preview = await this.dispatch.previewRound()
    return {
      proposed: preview.decisions.filter((d) => d.kind === 'ASSIGN').length,
      detours: preview.decisions.filter((d) => d.kind === 'INSERT_DETOUR').length,
      unmatched: preview.decisions.filter((d) => d.kind === 'UNMATCHED').length,
      decisions: preview.decisions,
      rejections: preview.rejections,
      durationMs: preview.stats.durationMs,
    }
  }

  /** FR-A13 — publish: run for real and commit. */
  @Post('batch-plan/publish')
  async publishBatch() {
    return this.dispatch.runRoundSafely('admin-batch-publish')
  }

  /** Kept as an alias so existing callers and the dashboard button do not break. */
  @Post('batch-plan/run')
  async runBatch() {
    return this.dispatch.runRoundSafely('admin-batch')
  }

  /** FR-M23 — the "why did it do that" screen: decisions, scores and every rejection. */
  @Get('rounds')
  async rounds() {
    return this.prisma.decisionRound.findMany({ orderBy: { startedAt: 'desc' }, take: 20 })
  }

  @Get('rounds/:id')
  async round(@Param('id') id: string) {
    return this.prisma.decisionRound.findUnique({ where: { id } })
  }

  /** FR-A16 — per-entity audit timeline. */
  @Get('audit')
  async audit(@Query('entityId') entityId?: string) {
    return this.prisma.statusEvent.findMany({
      where: entityId ? { entityId } : {},
      // seq, not `at`: transitions inside one transaction share a millisecond.
      orderBy: { seq: 'desc' },
      take: 200,
    })
  }

  @Get('alerts')
  async alerts() {
    return this.prisma.alert.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  }

  @Post('alerts/:id/ack')
  async ackAlert(@Principal() principal: AuthPrincipal, @Param('id') id: string) {
    return this.prisma.alert.update({
      where: { id },
      data: { acknowledgedAt: new Date(), acknowledgedBy: principal.userId },
    })
  }

  /** FR-A15 — every threshold from PRD §12, tunable without a deploy. */
  @Get('config')
  async getConfig() {
    return this.config()
  }

  @Patch('config')
  async updateConfig(@Body() body: unknown) {
    const event = await this.prisma.event.findFirst()
    if (!event) throw new DomainError('EVENT_NOT_CONFIGURED', 'No event row', 404)
    const merged = eventConfigSchema.parse({ ...(event.config as object), ...(body as object) })
    await this.prisma.event.update({ where: { id: event.id }, data: { config: merged as never } })
    return merged
  }

  private async config(): Promise<EventConfig> {
    const event = await this.prisma.event.findFirst()
    return parseConfig(event?.config ?? {})
  }
}

/**
 * Minimal CSV parser: header row, comma-separated, double-quote escaping.
 *
 * Deliberately not a dependency — a guest roster is a flat file with no nested structures, and a
 * hand-rolled 20-line parser is easier to reason about than a configurable library. It handles the
 * one case that actually bites: commas inside quoted values ("Smith, John").
 */
function parseCsv(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return []

  const headers = splitCsvLine(lines[0]!).map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    const row: Record<string, unknown> = {}
    headers.forEach((header, i) => {
      row[header] = cells[i]?.trim() ?? ''
    })
    return row
  })
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (char === '"') {
      // A doubled quote inside a quoted value is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}

/** CSV values are all strings; coerce the ones the schema expects as numbers/booleans/dates. */
function coerceCsvRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const key of ['groupSize', 'luggageCount']) {
    if (typeof out[key] === 'string' && out[key] !== '') out[key] = Number(out[key])
  }
  for (const key of ['isVip', 'isWalkIn']) {
    if (typeof out[key] === 'string') out[key] = ['true', '1', 'yes', 'y'].includes(String(out[key]).toLowerCase())
  }
  // Drop empty optional strings so zod's .optional() applies instead of failing on ''.
  for (const [key, value] of Object.entries(out)) {
    if (value === '') delete out[key]
  }
  return out
}
