import {
  DRIVER_COMMITTED_STATES,
  addMinutes,
  isAfter,
  maxDate,
  minutesBetween,
  type DriverView,
  type Rejection,
  type RequestView,
} from '@eventride/shared'
import type { Snapshot } from './types.js'

export interface Timing {
  /** When the driver can start moving toward the pickup. */
  startAt: Date
  pickupAt: Date
  dropAt: Date
  deadheadMin: number
  rideMin: number
  /** Guest wait measured from readyAt (PRD D8) — the metric G1 is judged on. */
  waitMin: number
}

/** Travel arithmetic shared by the filter, the scorer and the planners. */
export function timingFor(d: DriverView, r: RequestView, s: Snapshot): Timing {
  const startAt = maxDate(s.now, d.predictedFreeAt ?? s.now)
  const deadheadMin = s.travel.minutes(d.freeLocation, r.origin)
  const pickupAt = addMinutes(startAt, deadheadMin)
  const rideMin = s.travel.minutes(r.origin, r.destination)
  const dropAt = addMinutes(pickupAt, rideMin)
  const waitMin = r.readyAt ? Math.max(0, minutesBetween(r.readyAt, pickupAt)) : 0
  return { startAt, pickupAt, dropAt, deadheadMin, rideMin, waitMin }
}

/**
 * Hard feasibility filter (FR-M9…M11), applied before any scoring.
 *
 * Returns the typed reason instead of a boolean, because FR-A11 requires the admin to see *why*
 * no driver was available, and INV-2 requires every (queued request, available driver) pair to
 * carry a recorded reason when it does not result in an assignment.
 */
export function checkFeasible(d: DriverView, r: RequestView, s: Snapshot): Rejection | null {
  const rej = (reason: Rejection['reason']): Rejection => ({
    requestId: r.id,
    driverId: d.id,
    reason,
  })

  // A group no vehicle in the fleet can carry is a split problem (FR-M16), not a capacity rejection.
  if (r.groupSize > s.fleetMaxSeats || r.luggageCount > s.fleetMaxLuggage) {
    return rej('GROUP_TOO_LARGE')
  }

  if (d.state === 'OFFLINE') return rej('NO_DRIVER_ONLINE')
  if (d.state === 'UNAVAILABLE') return rej('NO_DRIVER_ONLINE')

  // Driver welfare comes before utilisation (D15): a driver owed a break is not assignable.
  if (d.state === 'ON_BREAK' || d.breakState === 'DUE' || d.breakState === 'ON_BREAK') {
    return rej('ALL_DRIVERS_ON_BREAK')
  }

  // INV-3: a committed driver only ever receives a detour insertion, never a second independent
  // trip. Chaining is permitted solely for pre-day batch planning, where nobody is driving yet.
  if (DRIVER_COMMITTED_STATES.includes(d.state)) {
    if (!s.allowCommittedDrivers || !d.predictedFreeAt) return rej('ALL_DRIVERS_BUSY')
  }

  if (r.groupSize > d.seatCapacity || r.luggageCount > d.luggageCapacity) {
    return rej('NO_CAPACITY')
  }

  if (d.cooldownRequestIds.includes(r.id)) return rej('COOLDOWN_ONLY_CANDIDATES')

  const t = timingFor(d, r, s)

  if (isAfter(t.dropAt, d.shiftEnd)) return rej('OUTSIDE_SHIFT_HOURS')

  // FR-M10: a hard deadline is either met or the request is explicitly UNMATCHED — never silently late.
  if (r.isHardDeadline && r.deadlineAt && isAfter(t.dropAt, r.deadlineAt)) {
    return rej('DEADLINE_INFEASIBLE')
  }

  return null
}

/**
 * The dominant reason across all rejections for one request — what the admin sees on the
 * exception queue (FR-A11). Ordered by how actionable the reason is for ops.
 */
const REASON_PRIORITY: Rejection['reason'][] = [
  'GROUP_TOO_LARGE',
  'DEADLINE_INFEASIBLE',
  'NO_CAPACITY',
  'ALL_DRIVERS_ON_BREAK',
  'OUTSIDE_SHIFT_HOURS',
  'COOLDOWN_ONLY_CANDIDATES',
  'ALL_DRIVERS_BUSY',
  'NO_DRIVER_ONLINE',
]

export function dominantReason(rejections: readonly Rejection[]): Rejection['reason'] {
  if (rejections.length === 0) return 'NO_DRIVER_ONLINE'
  const counts = new Map<Rejection['reason'], number>()
  for (const r of rejections) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1)
  let best = rejections[0]!.reason
  let bestCount = -1
  for (const reason of REASON_PRIORITY) {
    const c = counts.get(reason) ?? 0
    if (c > bestCount && c > 0) {
      best = reason
      bestCount = c
    }
  }
  return best
}
