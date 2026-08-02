import { minutesBetween, type EventConfig, type RequestView } from '@eventride/shared'

/**
 * Anti-starvation hard override (PRD D26, INV-4).
 *
 * An aging *weight* alone is tunable and therefore breakable — someone lowers w_age and starvation
 * silently returns. This bonus makes it structural: once a request has been passed over
 * `max_passed_over_count` times it outranks everything else in the queue, unconditionally.
 * Deliberately far larger than any reachable combination of the other terms.
 */
export const FORCE_TO_FRONT_BONUS = 1_000_000

/** Horizon over which a hard deadline ramps from "not urgent" to "maximum urgency". */
const URGENCY_HORIZON_MIN = 120

/** FR-M14 ordering: deadline urgency → VIP → aging → group size, with a FIFO tiebreak. */
export function priorityScore(r: RequestView, now: Date, c: EventConfig): number {
  const since = r.readyAt ?? r.createdAt
  const waitedMin = Math.max(0, minutesBetween(since, now))

  const urgency =
    r.isHardDeadline && r.deadlineAt
      ? Math.min(
          1,
          Math.max(0, URGENCY_HORIZON_MIN - minutesBetween(now, r.deadlineAt)) / URGENCY_HORIZON_MIN,
        )
      : 0

  const base =
    c.w_urgency * urgency +
    c.w_vip * (r.isVip ? 1 : 0) +
    c.w_age * waitedMin +
    c.w_group * r.groupSize

  return r.passedOverCount >= c.max_passed_over_count ? base + FORCE_TO_FRONT_BONUS : base
}

/**
 * Highest priority first. Ties break by createdAt (FIFO), then by id, so a round is fully
 * deterministic — required for the replayability guarantee in HLD §5.2.
 */
export function sortByPriority(
  requests: readonly RequestView[],
  now: Date,
  c: EventConfig,
): RequestView[] {
  return [...requests].sort((a, b) => {
    const diff = priorityScore(b, now, c) - priorityScore(a, now, c)
    if (Math.abs(diff) > 1e-9) return diff
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime()
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id)
  })
}

/** True when this request has hit the point where it must be served before anything else. */
export function isForcedToFront(r: RequestView, c: EventConfig): boolean {
  return r.passedOverCount >= c.max_passed_over_count
}
