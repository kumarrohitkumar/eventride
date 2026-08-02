import { Inject, Injectable } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import type {
  DriverRecord,
  Repositories,
  RequestRecord,
  StatusEventRecord,
  TripRecord,
  TripStopRecord,
} from '../trips/ports.js'

/**
 * Prisma adapter for the repository ports.
 *
 * Deliberately mechanical: all the interesting behaviour lives in TripService and the engine, both
 * of which are tested against MemoryRepositories. This class only maps rows to records, so a bug
 * here is a mapping bug, not a logic bug.
 */
@Injectable()
export class PrismaRepositories implements Repositories {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  requests: Repositories['requests'] = {
    find: async (id) => {
      const row = await this.prisma.tripRequest.findUnique({ where: { id } })
      return row ? (row as unknown as RequestRecord) : null
    },
    update: async (id, patch) =>
      (await this.prisma.tripRequest.update({
        where: { id },
        data: patch as never,
      })) as unknown as RequestRecord,
    findByTrip: async (tripId) =>
      (await this.prisma.tripRequest.findMany({ where: { tripId } })) as unknown as RequestRecord[],
  }

  drivers: Repositories['drivers'] = {
    find: async (id) => {
      const row = await this.prisma.driver.findUnique({ where: { id } })
      return row ? (row as unknown as DriverRecord) : null
    },
    update: async (id, patch) =>
      (await this.prisma.driver.update({
        where: { id },
        data: patch as never,
      })) as unknown as DriverRecord,
  }

  trips: Repositories['trips'] = {
    find: async (id) => {
      const row = await this.prisma.trip.findUnique({ where: { id } })
      return row ? (row as unknown as TripRecord) : null
    },

    /**
     * Trip + stops in ONE transaction. A trip without its stops would be an un-drivable row, and
     * the DB's unique index on the generated active_driver_id column rejects a double-booking here
     * rather than letting it reach a driver's screen (INV-5).
     */
    create: async (trip, stops) =>
      (await this.prisma.$transaction(async (tx) => {
        const created = await tx.trip.create({ data: stripGenerated(trip) as never })
        await tx.tripStop.createMany({
          data: stops.map((s, i) => ({ ...s, tripId: created.id, seq: i })) as never,
        })
        return created
      })) as unknown as TripRecord,

    update: async (id, patch) =>
      (await this.prisma.trip.update({
        where: { id },
        data: stripGenerated(patch) as never,
      })) as unknown as TripRecord,

    activeForDriver: async (driverId) => {
      const row = await this.prisma.trip.findFirst({
        where: {
          driverId,
          state: { in: ['OFFERED', 'ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'] },
        },
      })
      return row ? (row as unknown as TripRecord) : null
    },

    stops: async (tripId) =>
      (await this.prisma.tripStop.findMany({
        where: { tripId },
        orderBy: { seq: 'asc' },
      })) as unknown as TripStopRecord[],

    updateStop: async (id, patch) =>
      (await this.prisma.tripStop.update({
        where: { id },
        data: patch as never,
      })) as unknown as TripStopRecord,

    replaceStops: async (tripId, stops) =>
      (await this.prisma.$transaction(async (tx) => {
        await tx.tripStop.deleteMany({ where: { tripId } })
        await tx.tripStop.createMany({
          data: stops.map((s, i) => ({ ...s, tripId, seq: i })) as never,
        })
        return tx.tripStop.findMany({ where: { tripId }, orderBy: { seq: 'asc' } })
      })) as unknown as TripStopRecord[],
  }

  audit: Repositories['audit'] = {
    // Append only. There is intentionally no update or delete method to call (D36).
    append: async (event: StatusEventRecord) => {
      await this.prisma.statusEvent.create({ data: event as never })
    },
  }
}

/**
 * `active_driver_id` is a MySQL generated column (HLD §2.2): the database computes it, so writing
 * it would fail. It is stripped from every payload before it reaches Prisma.
 */
function stripGenerated<T extends Record<string, unknown>>(data: T): Omit<T, 'activeDriverId'> {
  const { activeDriverId: _generated, ...rest } = data as T & { activeDriverId?: unknown }
  return rest
}
