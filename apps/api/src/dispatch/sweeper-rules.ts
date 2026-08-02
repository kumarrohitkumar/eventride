import { addMinutes, minutesBetween, type EventConfig } from '@eventride/shared'

/**
 * Sweeper rules (FR-M26, D32, LLD §7) as PURE predicates.
 *
 * Every timer in the system — offer expiry, no-show, auto-queue, break due, duty cap, SLA breach,
 * stale location — is "scan for rows whose deadline has passed". One loop, no per-entity scheduled
 * jobs, no durable job state to reconcile after a crash: the next tick simply recomputes.
 *
 * Pure so each rule is unit-testable with an injected clock rather than by waiting in real time.
 */

export interface OfferRow {
  tripId: string
  offeredAt: Date
}

/** FR-D5 / E3: an ignored offer auto-rejects so the guest is not left waiting on a silent driver. */
export function expiredOffers(
  offers: readonly OfferRow[],
  now: Date,
  config: EventConfig,
): string[] {
  return offers
    .filter((o) => minutesBetween(o.offeredAt, now) * 60 >= config.offer_expiry_sec)
    .map((o) => o.tripId)
}

export interface ScheduledRow {
  requestId: string
  scheduledAt: Date
  hasTappedReady: boolean
}

/** FR-G4 / D1: a guest who never opens the app is still served. */
export function autoQueueable(
  rows: readonly ScheduledRow[],
  now: Date,
  config: EventConfig,
): string[] {
  return rows
    .filter((r) => !r.hasTappedReady)
    .filter((r) => now >= addMinutes(r.scheduledAt, config.auto_queue_fallback_min))
    .map((r) => r.requestId)
}

export interface ArrivedStopRow {
  tripId: string
  requestId: string
  arrivedAt: Date
}

/**
 * FR-D11 / E4: after the wait timer the driver may declare a no-show.
 * Bounds the worst case — one absent guest cannot idle a vehicle indefinitely.
 */
export function noShowEligible(
  rows: readonly ArrivedStopRow[],
  now: Date,
  config: EventConfig,
): string[] {
  return rows
    .filter((r) => minutesBetween(r.arrivedAt, now) >= config.no_show_wait_min)
    .map((r) => r.requestId)
}

export interface DriverDutyRow {
  driverId: string
  drivingMinutesToday: number
  tripsSinceBreak: number
  breakState: 'NONE' | 'DUE' | 'ON_BREAK'
  breakStartedAt: Date | null
  shiftStart: Date
}

/** FR-D9 / D15: either trigger — minutes driven or trips completed — makes a break due. */
export function breakDue(rows: readonly DriverDutyRow[], config: EventConfig): string[] {
  return rows
    .filter((d) => d.breakState === 'NONE')
    .filter(
      (d) =>
        d.drivingMinutesToday >= config.break_after_driving_min ||
        d.tripsSinceBreak >= config.break_after_trips,
    )
    .map((d) => d.driverId)
}

/** FR-D9: a break ends on its own; the driver becomes assignable again with counters reset. */
export function breaksToEnd(
  rows: readonly DriverDutyRow[],
  now: Date,
  config: EventConfig,
): string[] {
  return rows
    .filter((d) => d.breakState === 'ON_BREAK' && d.breakStartedAt !== null)
    .filter((d) => now >= addMinutes(d.breakStartedAt as Date, config.break_duration_min))
    .map((d) => d.driverId)
}

/** D15: the hard stop on a driver's day. Safety rule — not negotiable by queue pressure. */
export function dutyCapReached(
  rows: readonly DriverDutyRow[],
  now: Date,
  config: EventConfig,
): string[] {
  return rows
    .filter((d) => minutesBetween(d.shiftStart, now) >= config.max_duty_hours * 60)
    .map((d) => d.driverId)
}

export interface QueuedRow {
  requestId: string
  readyAt: Date
}

/** FR-A4: surface a waiting guest to ops before they become a complaint. */
export function waitBreaches(
  rows: readonly QueuedRow[],
  now: Date,
  config: EventConfig,
): { warn: string[]; critical: string[] } {
  const warn: string[] = []
  const critical: string[] = []
  for (const row of rows) {
    const waited = minutesBetween(row.readyAt, now)
    if (waited > config.guest_wait_critical_min) critical.push(row.requestId)
    else if (waited > config.guest_wait_warn_min) warn.push(row.requestId)
  }
  return { warn, critical }
}

export interface TrackedDriverRow {
  driverId: string
  onActiveTrip: boolean
  lastLocationAt: Date | null
}

/** E20: a driver whose app died mid-trip must be visible to ops, not silently frozen on the map. */
export function staleLocations(
  rows: readonly TrackedDriverRow[],
  now: Date,
  config: EventConfig,
): string[] {
  return rows
    .filter((d) => d.onActiveTrip)
    .filter(
      (d) =>
        d.lastLocationAt === null ||
        minutesBetween(d.lastLocationAt, now) > config.stale_location_min,
    )
    .map((d) => d.driverId)
}
