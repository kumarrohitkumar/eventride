import type {
  DriverRecord,
  Repositories,
  RequestRecord,
  StatusEventRecord,
  TripRecord,
  TripStopRecord,
} from './ports.js'

/**
 * In-memory implementation of the repository ports.
 *
 * Lets the entire state machine, every invariant and the whole audit trail be tested with no MySQL,
 * which keeps the domain tests fast enough to run on every save. The Prisma adapter implements the
 * same interface, so these tests constrain the real thing too.
 */
export class MemoryRepositories implements Repositories {
  readonly requestRows = new Map<string, RequestRecord>()
  readonly driverRows = new Map<string, DriverRecord>()
  readonly tripRows = new Map<string, TripRecord>()
  readonly stopRows = new Map<string, TripStopRecord>()
  readonly auditRows: StatusEventRecord[] = []

  private stopSeq = 0

  requests: Repositories['requests'] = {
    find: async (id) => this.requestRows.get(id) ?? null,
    update: async (id, patch) => {
      const current = this.requestRows.get(id)
      if (!current) throw new Error(`request ${id} missing`)
      const next = { ...current, ...patch }
      this.requestRows.set(id, next)
      return next
    },
    findByTrip: async (tripId) =>
      [...this.requestRows.values()].filter((r) => r.tripId === tripId),
  }

  drivers: Repositories['drivers'] = {
    find: async (id) => this.driverRows.get(id) ?? null,
    update: async (id, patch) => {
      const current = this.driverRows.get(id)
      if (!current) throw new Error(`driver ${id} missing`)
      const next = { ...current, ...patch }
      this.driverRows.set(id, next)
      return next
    },
  }

  trips: Repositories['trips'] = {
    find: async (id) => this.tripRows.get(id) ?? null,
    create: async (trip, stops) => {
      const record: TripRecord = { ...trip, version: 0 }
      this.tripRows.set(record.id, record)
      stops.forEach((s, i) => {
        const id = `stop-${++this.stopSeq}`
        this.stopRows.set(id, { ...s, id, tripId: record.id, seq: i })
      })
      return record
    },
    update: async (id, patch) => {
      const current = this.tripRows.get(id)
      if (!current) throw new Error(`trip ${id} missing`)
      const next = { ...current, ...patch }
      this.tripRows.set(id, next)
      return next
    },
    /**
     * Mirrors the DB's generated-column unique index (INV-5): only trips in an active state
     * occupy a driver, so completed and rejected trips do not block a new assignment.
     */
    activeForDriver: async (driverId) =>
      [...this.tripRows.values()].find(
        (t) =>
          t.driverId === driverId &&
          ['OFFERED', 'ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'].includes(t.state),
      ) ?? null,
    stops: async (tripId) =>
      [...this.stopRows.values()].filter((s) => s.tripId === tripId).sort((a, b) => a.seq - b.seq),
    updateStop: async (id, patch) => {
      const current = this.stopRows.get(id)
      if (!current) throw new Error(`stop ${id} missing`)
      const next = { ...current, ...patch }
      this.stopRows.set(id, next)
      return next
    },
    replaceStops: async (tripId, stops) => {
      for (const [id, stop] of this.stopRows) {
        if (stop.tripId === tripId) this.stopRows.delete(id)
      }
      const created: TripStopRecord[] = []
      stops.forEach((s, i) => {
        const id = `stop-${++this.stopSeq}`
        const record = { ...s, id, tripId, seq: i }
        this.stopRows.set(id, record)
        created.push(record)
      })
      return created
    },
  }

  audit: Repositories['audit'] = {
    // Append-only: there is deliberately no update or delete method to call (D36).
    append: async (event) => {
      this.auditRows.push(event)
    },
  }
}
