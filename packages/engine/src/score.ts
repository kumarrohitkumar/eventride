import {
  minutesBetween,
  type DriverView,
  type EventConfig,
  type RequestView,
  type ScoreBreakdown,
} from '@eventride/shared'
import { timingFor } from './feasibility.js'
import type { Snapshot } from './types.js'

/** Slack below which a hard deadline starts costing (minutes). */
const LATENESS_ALERT_SLACK_MIN = 15

/**
 * How overdue a break is, normalised to [0, 1] (D15).
 * Either trigger — minutes driven or trips completed — can raise the pressure, and the result is
 * capped so driver welfare can nudge an assignment but never dominate it.
 */
export function breakPressure(d: DriverView, c: EventConfig): number {
  const byMinutes = d.drivingMinutesToday / c.break_after_driving_min
  const byTrips = d.tripsSinceBreak / c.break_after_trips
  return Math.min(1, Math.max(byMinutes, byTrips))
}

export interface ScoreContext {
  /** True when this request shares a destination cluster with the driver's existing load. */
  poolsWithCluster?: boolean
  /** Extra minutes this assignment would add for guests already committed to the driver. */
  addedDelayToCommittedMin?: number
}

/**
 * The single cost function (PRD §11.5, D21). Lower is better.
 *
 * All three entry points — real-time, batch and re-optimisation — call this exact function.
 * They differ only in how many (driver, request) pairs they feed it, which is why "good" means
 * the same thing everywhere and there is only one thing to tune, test and explain.
 */
export function scorePair(
  d: DriverView,
  r: RequestView,
  s: Snapshot,
  ctx: ScoreContext = {},
): ScoreBreakdown {
  const c = s.config
  const t = timingFor(d, r, s)

  const slackMin =
    r.isHardDeadline && r.deadlineAt ? minutesBetween(t.pickupAt, r.deadlineAt) : Infinity
  const latenessRisk =
    slackMin < LATENESS_ALERT_SLACK_MIN ? LATENESS_ALERT_SLACK_MIN - slackMin : 0

  const waitedAlready = r.readyAt ? Math.max(0, minutesBetween(r.readyAt, s.now)) : 0

  const parts = {
    // --- costs (push the score up) ---
    deadhead: c.w_deadhead * t.deadheadMin,
    wait: c.w_wait * t.waitMin,
    late: c.w_late * latenessRisk,
    detour: c.w_detour * (ctx.addedDelayToCommittedMin ?? 0),
    waste: c.w_waste * Math.max(0, d.seatCapacity - r.groupSize),
    break: c.w_break * breakPressure(d, c),
    // --- credits (pull the score down) ---
    pool: -c.w_pool * (ctx.poolsWithCluster ? 1 : 0),
    age: -c.w_age * waitedAlready,
    vip: -c.w_vip * (r.isVip ? 1 : 0),
  }

  const total = Object.values(parts).reduce((a, x) => a + x, 0)
  return { total, parts }
}
