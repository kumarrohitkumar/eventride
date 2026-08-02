import {
  addMinutes,
  haversineKm,
  minutesBetween,
  type DriverView,
  type Rejection,
  type RequestView,
} from '@eventride/shared'
import { assignPlannedTimes, buildStopsForRequests } from './capacity.js'
import { findBestDetourAcrossTrips } from './detour.js'
import { checkFeasible, dominantReason, timingFor } from './feasibility.js'
import { solveAssignment, INFEASIBLE } from './hungarian.js'
import { FORCE_TO_FRONT_BONUS, isForcedToFront, sortByPriority } from './priority.js'
import { canPoolTogether, dropStopCount, tryAddToTrip, type PlannedTrip } from './pooling.js'
import { scorePair } from './score.js'
import type { Decision, RoundResult, Snapshot } from './types.js'

/** Horizon used when quantifying a fleet shortfall for ops (FR-M17). */
const SHORTFALL_HORIZON_MIN = 60

interface Candidate {
  driver: DriverView
  score: number
}

/**
 * Real-time incremental match (FR-M2) — one request against the feasible fleet.
 *
 * O(D log D). Only the top-K candidates were given live-traffic lookups by SnapshotBuilder
 * (NFR-4), so the cost of a decision is bounded to one batched routing call.
 */
export function matchIncremental(
  r: RequestView,
  s: Snapshot,
  excludedDriverIds: ReadonlySet<string> = new Set(),
): { decision: Decision; rejections: Rejection[] } {
  const rejections: Rejection[] = []
  const feasible: DriverView[] = []

  for (const d of s.drivers) {
    if (excludedDriverIds.has(d.id)) continue
    const rejection = checkFeasible(d, r, s)
    if (rejection) rejections.push(rejection)
    else feasible.push(d)
  }

  if (feasible.length === 0) {
    // A group no single vehicle can carry is a split problem, not a dead end (FR-M16).
    if (r.groupSize > s.fleetMaxSeats) {
      const split = splitDecision(r, s)
      if (split) return { decision: split, rejections }
    }
    return {
      decision: { kind: 'UNMATCHED', requestId: r.id, reason: dominantReason(rejections) },
      rejections,
    }
  }

  // Pre-rank by straight-line distance, then score only the top K — this is the shape that keeps
  // external routing calls bounded (NFR-4).
  const topK = [...feasible]
    .sort((a, b) => haversineKm(a.freeLocation, r.origin) - haversineKm(b.freeLocation, r.origin))
    .slice(0, s.config.candidate_topk_for_live_eta)

  const scored: Candidate[] = topK
    .map((d) => ({ driver: d, score: scorePair(d, r, s).total }))
    .sort((a, b) => a.score - b.score || a.driver.id.localeCompare(b.driver.id))

  const best = scored[0]!
  const runnerUp = scored[1]
  const timing = timingFor(best.driver, r, s)

  return {
    decision: {
      kind: 'ASSIGN',
      driverId: best.driver.id,
      requestIds: [r.id],
      stops: assignPlannedTimes(
        buildStopsForRequests([r]),
        best.driver.freeLocation,
        timing.startAt,
        s.travel,
      ),
      score: scorePair(best.driver, r, s),
      ...(runnerUp ? { runnerUpDriverId: runnerUp.driver.id } : {}),
      plannedPickupAt: timing.pickupAt,
      plannedDropAt: timing.dropAt,
    },
    rejections,
  }
}

/**
 * Batch plan (FR-M1, D29): optimal 1:1 assignment via Hungarian, then a greedy pooling pass.
 *
 * The trade-off is explicit — we give up global optimality over the *pooled* problem (a true VRP)
 * in exchange for something that runs in milliseconds, is deterministic, and can be explained in
 * a paragraph.
 */
export function planBatch(
  requests: readonly RequestView[],
  s: Snapshot,
  excludedDriverIds: ReadonlySet<string> = new Set(),
): { decisions: Decision[]; rejections: Rejection[] } {
  const decisions: Decision[] = []
  const rejections: Rejection[] = []
  if (requests.length === 0) return { decisions, rejections }

  const drivers = s.drivers.filter((d) => !excludedDriverIds.has(d.id))
  if (drivers.length === 0) {
    for (const r of requests) {
      decisions.push({ kind: 'UNMATCHED', requestId: r.id, reason: 'NO_DRIVER_ONLINE' })
    }
    return { decisions, rejections }
  }

  const ordered = sortByPriority(requests, s.now, s.config)

  // --- cluster-first bundling (FR-M15) ---
  //
  // Pooling must happen BEFORE assignment, not after. If the 1:1 layer runs first it hands every
  // available driver a single guest, and during an arrival surge the rest of the queue then waits
  // behind full round trips — throughput collapses even though half the seats are empty.
  // Grouping compatible guests into vehicle-loads first is what makes a fixed fleet keep up.
  const bundles = buildBundles(ordered, s, drivers)

  // --- 1:1 layer: cost matrix + Hungarian ---
  //
  // Priority ordering alone is NOT enough here: Hungarian minimises TOTAL cost and is free to
  // ignore row order, so a cheap VIP could out-compete a request that has already been passed over
  // three times. Forced-to-front rows therefore carry a large negative offset, which makes any
  // solution that includes them strictly cheaper than one that does not — INV-4 holds on the batch
  // path as well as the incremental one.
  const cost: number[][] = bundles.map((bundle) => {
    const primary = bundle[0]!
    const forcedBonus = bundle.some((r) => isForcedToFront(r, s.config)) ? FORCE_TO_FRONT_BONUS : 0
    const seats = bundle.reduce((sum, r) => sum + r.groupSize, 0)
    const bags = bundle.reduce((sum, r) => sum + r.luggageCount, 0)

    return drivers.map((d) => {
      // Per-member checks run FIRST so the recorded reason is the specific one the admin needs
      // (GROUP_TOO_LARGE, DEADLINE_INFEASIBLE …) rather than a generic capacity failure.
      for (const r of bundle) {
        const rejection = checkFeasible(d, r, s)
        if (rejection) {
          rejections.push(rejection)
          return INFEASIBLE
        }
      }
      // A bundle is only feasible if the WHOLE load fits — never "mostly fits".
      if (seats > d.seatCapacity || bags > d.luggageCapacity) {
        rejections.push({ requestId: primary.id, driverId: d.id, reason: 'NO_CAPACITY' })
        return INFEASIBLE
      }
      // Deadlines must be checked against the POOLED sequence, not each guest's solo timing:
      // a guest dropped second on a shared ride arrives later than they would alone (FR-M10).
      if (bundle.length > 1 && poolBreachesDeadline(bundle, d, s)) {
        rejections.push({ requestId: primary.id, driverId: d.id, reason: 'DEADLINE_INFEASIBLE' })
        return INFEASIBLE
      }
      return scorePair(d, primary, s, { poolsWithCluster: bundle.length > 1 }).total - forcedBonus
    })
  })

  const assignment = solveAssignment(cost)

  const plannedByDriver = new Map<string, PlannedTrip>()
  const servedRequestIds = new Set<string>()

  bundles.forEach((bundle, i) => {
    const col = assignment[i]!
    if (col < 0) return
    const d = drivers[col]!
    const primary = bundle[0]!
    const timing = timingFor(d, primary, s)
    plannedByDriver.set(d.id, {
      driverId: d.id,
      requests: [...bundle],
      stops: buildStopsForRequests(bundle),
      plannedPickupAt: timing.pickupAt,
      plannedDropAt: timing.dropAt,
    })
    bundle.forEach((r) => servedRequestIds.add(r.id))
  })

  // --- pooling pass (FR-M15): leftovers ride along where it is genuinely free ---
  const driversById = new Map(drivers.map((d) => [d.id, d]))
  for (const r of ordered) {
    if (servedRequestIds.has(r.id)) continue
    let bestTrip: { trip: PlannedTrip; added: number } | null = null

    for (const trip of plannedByDriver.values()) {
      const d = driversById.get(trip.driverId)
      if (!d) continue
      const attempt = tryAddToTrip(trip, r, d, s)
      if (!attempt.ok) continue
      if (!bestTrip || attempt.addedMinutes < bestTrip.added) {
        bestTrip = { trip: attempt.trip, added: attempt.addedMinutes }
      }
    }

    if (bestTrip) {
      plannedByDriver.set(bestTrip.trip.driverId, bestTrip.trip)
      servedRequestIds.add(r.id)
    }
  }

  // --- salvage pass: a poisoned bundle must not strand its members ---
  //
  // A bundle is infeasible for a driver if ANY member is (e.g. one guest's deadline cannot be
  // met). Without this pass, the other members of that bundle would be stranded through no fault
  // of their own — including a forced-to-front guest, which would break INV-4.
  for (const r of ordered) {
    if (servedRequestIds.has(r.id)) continue
    const freeDrivers = drivers.filter((d) => !plannedByDriver.has(d.id))
    if (freeDrivers.length === 0) break

    const candidates = freeDrivers
      .filter((d) => checkFeasible(d, r, s) === null)
      .map((d) => ({ d, score: scorePair(d, r, s).total }))
      .sort((a, b) => a.score - b.score || a.d.id.localeCompare(b.d.id))

    const winner = candidates[0]
    if (!winner) continue
    const timing = timingFor(winner.d, r, s)
    plannedByDriver.set(winner.d.id, {
      driverId: winner.d.id,
      requests: [r],
      stops: buildStopsForRequests([r]),
      plannedPickupAt: timing.pickupAt,
      plannedDropAt: timing.dropAt,
    })
    servedRequestIds.add(r.id)
  }

  for (const trip of plannedByDriver.values()) {
    const primary = trip.requests[0]!
    const d = driversById.get(trip.driverId)!
    const startAt = timingFor(d, primary, s).startAt
    decisions.push({
      kind: 'ASSIGN',
      driverId: trip.driverId,
      requestIds: trip.requests.map((r) => r.id),
      stops: assignPlannedTimes(trip.stops, d.freeLocation, startAt, s.travel),
      score: scorePair(d, primary, s, { poolsWithCluster: trip.requests.length > 1 }),
      plannedPickupAt: trip.plannedPickupAt,
      plannedDropAt: trip.plannedDropAt,
    })
  }

  // --- unserved: split if oversized, otherwise an explained UNMATCHED (FR-A11) ---
  for (const r of ordered) {
    if (servedRequestIds.has(r.id)) continue
    if (r.groupSize > s.fleetMaxSeats) {
      const split = splitDecision(r, s)
      if (split) {
        decisions.push(split)
        continue
      }
    }
    const own = rejections.filter((x) => x.requestId === r.id)
    decisions.push({ kind: 'UNMATCHED', requestId: r.id, reason: dominantReason(own) })
  }

  return { decisions, rejections }
}

/**
 * Group compatible requests into vehicle-loads before assignment (FR-M15).
 *
 * Bundles are capped at the MOST COMMON vehicle capacity rather than the largest, so a bundle
 * stays assignable to most of the fleet. Capping at the largest would build 12-seat loads that
 * only two vehicles in the fleet could take, and those guests would queue behind them.
 *
 * Greedy by priority: each request joins the first bundle it is compatible with (same pickup
 * point, within the time window, same destination cluster, capacity and drop-stop caps intact),
 * otherwise it opens a new one. O(R × B) with tiny constants.
 */
function buildBundles(
  ordered: readonly RequestView[],
  s: Snapshot,
  drivers: readonly DriverView[],
): RequestView[][] {
  const vehicleCap = mostCommonSeatCapacity(drivers)

  // Pooling is demand-driven, not unconditional. If there are enough vehicles for everyone,
  // sharing only makes rides slower and leaves drivers idle — which violates G2 as surely as a
  // bad assignment does. So the target load per vehicle is exactly the supply shortfall:
  //   40 guests / 40 drivers → 1 (no pooling)   80 guests / 40 drivers → 2   200/40 → 5 (capped)
  const totalSeats = ordered.reduce((sum, r) => sum + r.groupSize, 0)
  const availableDrivers = Math.max(1, drivers.length)
  const targetLoad = Math.max(1, Math.min(vehicleCap, Math.ceil(totalSeats / availableDrivers)))

  const capacityCap = targetLoad
  const bundles: RequestView[][] = []

  for (const r of ordered) {
    // A VIP always travels alone (D12), so it never joins or accepts company.
    //
    // A forced-to-front request also gets its own bundle: a bundle is infeasible if ANY member is,
    // so grouping a starving guest with others would let someone else's infeasibility strand them.
    // INV-4 must not depend on its bundle-mates.
    if (r.isVip || isForcedToFront(r, s.config)) {
      bundles.push([r])
      continue
    }

    let placed = false
    for (const bundle of bundles) {
      if (bundle.some((x) => x.isVip)) continue

      if (bundle.some((x) => isForcedToFront(x, s.config))) continue

      const seats = bundle.reduce((sum, x) => sum + x.groupSize, 0)
      const bags = bundle.reduce((sum, x) => sum + x.luggageCount, 0)
      if (seats + r.groupSize > capacityCap) continue
      if (bags + r.luggageCount > capacityCap) continue
      if (bundle.some((x) => canPoolTogether(x, r, s) !== null)) continue
      if (dropStopCount(buildStopsForRequests([...bundle, r])) > s.config.pool_max_drop_stops) continue

      bundle.push(r)
      placed = true
      break
    }
    if (!placed) bundles.push([r])
  }

  return bundles
}

/** Would this pooled sequence push any member past their own hard deadline? (FR-M10) */
function poolBreachesDeadline(
  bundle: readonly RequestView[],
  d: DriverView,
  s: Snapshot,
): boolean {
  if (!bundle.some((r) => r.isHardDeadline && r.deadlineAt)) return false

  const primary = bundle[0]!
  const startAt = timingFor(d, primary, s).startAt
  const stops = assignPlannedTimes(buildStopsForRequests(bundle), d.freeLocation, startAt, s.travel)
  const deadlines = new Map(
    bundle.filter((r) => r.isHardDeadline && r.deadlineAt).map((r) => [r.id, r.deadlineAt!]),
  )

  return stops.some((stop) => {
    if (stop.kind !== 'DROP' || !stop.plannedAt) return false
    const deadline = deadlines.get(stop.requestId)
    return deadline !== undefined && stop.plannedAt.getTime() > deadline.getTime()
  })
}

function mostCommonSeatCapacity(drivers: readonly DriverView[]): number {
  if (drivers.length === 0) return 4
  const counts = new Map<number, number>()
  for (const d of drivers) counts.set(d.seatCapacity, (counts.get(d.seatCapacity) ?? 0) + 1)
  let best = drivers[0]!.seatCapacity
  let bestCount = 0
  for (const [capacity, count] of counts) {
    // Tie-break toward the larger vehicle so bundles do not shrink unnecessarily.
    if (count > bestCount || (count === bestCount && capacity > best)) {
      best = capacity
      bestCount = count
    }
  }
  return best
}

/**
 * FR-M16 / E8: a party larger than any single vehicle is split into linked sub-requests.
 * Greedy fill (9 with a 6-seat maximum → 6 + 3) matches the documented ops behaviour, and the
 * result is capped by auto_split_max_vehicles — beyond that it is an ops decision, not ours.
 */
function splitDecision(r: RequestView, s: Snapshot): Decision | null {
  const maxSeats = s.fleetMaxSeats
  const partsNeeded = Math.ceil(r.groupSize / maxSeats)
  if (partsNeeded > s.config.auto_split_max_vehicles) return null

  const parts: { groupSize: number; luggageCount: number }[] = []
  let remainingSeats = r.groupSize
  let remainingBags = r.luggageCount
  for (let i = 0; i < partsNeeded; i++) {
    const seats = Math.min(maxSeats, remainingSeats)
    // Luggage follows the people, with the remainder on the last vehicle.
    const bags =
      i === partsNeeded - 1 ? remainingBags : Math.min(remainingBags, Math.round(seats * (r.luggageCount / r.groupSize)))
    parts.push({ groupSize: seats, luggageCount: bags })
    remainingSeats -= seats
    remainingBags -= bags
  }
  return { kind: 'SPLIT', requestId: r.id, parts }
}

/**
 * FR-M22 soft reservation: hold a driver for an imminent hard-deadline request rather than send
 * them on a long soft trip. Deliberately narrow — only when the upcoming request has a single
 * feasible driver — so this cannot become general-purpose idling and undermine G2.
 */
function computeReservations(s: Snapshot): Decision[] {
  const upcoming = s.upcoming ?? []
  const reservations: Decision[] = []

  for (const r of upcoming) {
    if (!r.isHardDeadline || !r.deadlineAt) continue
    const startsInMin = minutesBetween(s.now, r.scheduledAt ?? r.deadlineAt)
    if (startsInMin > s.config.reservation_horizon_min || startsInMin < 0) continue

    const feasible = s.drivers.filter((d) => checkFeasible(d, r, s) === null)
    if (feasible.length !== 1) continue

    reservations.push({
      kind: 'RESERVE',
      driverId: feasible[0]!.id,
      requestId: r.id,
      untilAt: addMinutes(s.now, s.config.reservation_horizon_min),
      reason: 'ONLY_FEASIBLE_DRIVER_FOR_HARD_DEADLINE',
    })
  }
  return reservations
}

/**
 * One matching round (LDD §6.9). Order matters:
 *
 *   1. reservations  — protect imminent hard deadlines first
 *   2. detours       — a vehicle already going that way beats a fresh deadhead (better for G1 AND G2)
 *   3. assignment    — batch when there is a burst, incremental for a trickle
 *   4. bookkeeping   — pass-over counting (INV-4) and shortfall aggregation (FR-M17)
 */
export function runRound(s: Snapshot): RoundResult {
  const startedAt = performance.now()
  const decisions: Decision[] = []
  const rejections: Rejection[] = []

  const ordered = sortByPriority(s.requests, s.now, s.config)

  // 1. Reservations
  const reservations = computeReservations(s)
  const reservedDriverIds = new Set(
    reservations.map((d) => (d.kind === 'RESERVE' ? d.driverId : '')).filter(Boolean),
  )
  decisions.push(...reservations)

  // 2. Detour insertion into trips already in progress (FR-M18)
  const served = new Set<string>()
  const detouredTripIds = new Set<string>()
  for (const r of ordered) {
    const option = findBestDetourAcrossTrips(r, s)
    if (!option) continue
    // D24: at most one inserted stop per trip per round, so a driver's screen stays comprehensible.
    if (detouredTripIds.has(option.tripId)) continue
    detouredTripIds.add(option.tripId)
    served.add(r.id)
    decisions.push({
      kind: 'INSERT_DETOUR',
      tripId: option.tripId,
      driverId: option.driverId,
      requestId: option.requestId,
      position: option.position,
      addedMinutes: option.addedMinutes,
      stops: option.stops,
      score: { total: option.scoreTotal, parts: { detour: option.addedMinutes } },
    })
  }

  const remaining = ordered.filter((r) => !served.has(r.id))

  // 3. Assignment: batch for a burst, incremental for a trickle — same cost function either way (D21)
  if (remaining.length > s.config.batch_threshold) {
    const batch = planBatch(remaining, s, reservedDriverIds)
    decisions.push(...batch.decisions)
    rejections.push(...batch.rejections)
  } else {
    const busy = new Set(reservedDriverIds)
    for (const r of remaining) {
      const result = matchIncremental(r, s, busy)
      decisions.push(result.decision)
      rejections.push(...result.rejections)
      if (result.decision.kind === 'ASSIGN') busy.add(result.decision.driverId)
    }
  }

  // 4a. Pass-over bookkeeping (INV-4): who stayed queued while someone below them got served?
  const assignedIds = new Set<string>()
  for (const d of decisions) {
    if (d.kind === 'ASSIGN') d.requestIds.forEach((id) => assignedIds.add(id))
    if (d.kind === 'INSERT_DETOUR') assignedIds.add(d.requestId)
  }
  const lowestAssignedIndex = ordered.reduce(
    (acc, r, i) => (assignedIds.has(r.id) ? i : acc),
    -1,
  )
  const passedOverRequestIds = ordered
    .filter((r, i) => !assignedIds.has(r.id) && i < lowestAssignedIndex)
    .map((r) => r.id)

  // 4b. Fleet shortfall (FR-M17, FR-A14): quantify the gap so ops can escalate before it hurts.
  //
  // Two ways a fleet can be short, and ops needs warning about BOTH:
  //   - guests nobody can serve at all (UNMATCHED), and
  //   - guests who were assigned, but to a vehicle so far away that they will breach the wait SLA.
  // Counting only the first would stay silent through exactly the situation this system exists to
  // prevent: everyone "has a driver", and everyone is still standing at the kerb an hour later.
  const unmatched = decisions.filter((d) => d.kind === 'UNMATCHED')
  const unmatchedIds = new Set(unmatched.map((d) => (d.kind === 'UNMATCHED' ? d.requestId : '')))
  const affected = ordered.filter((r) => unmatchedIds.has(r.id))

  const requestsById = new Map(ordered.map((r) => [r.id, r]))
  const slaBreaching: RequestView[] = []
  for (const d of decisions) {
    if (d.kind !== 'ASSIGN') continue
    for (const id of d.requestIds) {
      const r = requestsById.get(id)
      if (!r?.readyAt) continue
      const projectedWait = minutesBetween(r.readyAt, d.plannedPickupAt)
      if (projectedWait > s.config.guest_wait_critical_min) slaBreaching.push(r)
    }
  }

  const allAffected = [...affected, ...slaBreaching]
  if (allAffected.length > 0) {
    decisions.push({
      kind: 'SHORTFALL',
      seatsShort: allAffected.reduce((sum, r) => sum + r.groupSize, 0),
      guestsAffected: allAffected.length,
      horizonMin: SHORTFALL_HORIZON_MIN,
    })
  }

  return {
    decisions,
    rejections,
    passedOverRequestIds,
    stats: {
      requestsConsidered: s.requests.length,
      driversConsidered: s.drivers.length,
      assigned: decisions.filter((d) => d.kind === 'ASSIGN').length,
      detours: decisions.filter((d) => d.kind === 'INSERT_DETOUR').length,
      unmatched: unmatched.length,
      durationMs: performance.now() - startedAt,
    },
  }
}
