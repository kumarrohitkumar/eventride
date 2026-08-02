import {
  HARD_DEADLINE_TRIP_TYPES,
  addMinutes,
  type EventConfig,
  type LocationType,
  type TripType,
} from '@eventride/shared'

/**
 * Deadline derivation (PRD D3, D7, FR-M10).
 *
 * A departure is not a booking — it is a deadline optimisation. The guest must REACH the airport
 * or station a configured buffer before their flight/train, and the engine works backwards from
 * that. Same for venue sessions. Everything else is soft.
 */

export interface DeadlineInput {
  tripType: TripType
  /** Flight/train departure time, or session start for TO_VENUE. */
  referenceAt: Date | null
  /** Where the guest is being dropped — decides which buffer applies. */
  destinationType: LocationType
  config: EventConfig
}

export interface DeadlineResult {
  deadlineAt: Date | null
  isHardDeadline: boolean
  /** Which config key produced it, so the admin UI can explain the number. */
  bufferKey: string | null
  bufferMinutes: number
}

export function computeDeadline(input: DeadlineInput): DeadlineResult {
  const { tripType, referenceAt, destinationType, config } = input
  const isHard = HARD_DEADLINE_TRIP_TYPES.includes(tripType)

  if (!isHard || !referenceAt) {
    return { deadlineAt: null, isHardDeadline: false, bufferKey: null, bufferMinutes: 0 }
  }

  const { key, minutes } = bufferFor(tripType, destinationType, config)
  return {
    deadlineAt: addMinutes(referenceAt, -minutes),
    isHardDeadline: true,
    bufferKey: key,
    bufferMinutes: minutes,
  }
}

function bufferFor(
  tripType: TripType,
  destinationType: LocationType,
  config: EventConfig,
): { key: string; minutes: number } {
  if (tripType === 'TO_VENUE') {
    return { key: 'venue_arrival_buffer_min', minutes: config.venue_arrival_buffer_min }
  }
  // DEPARTURE: an airport needs far more slack than a railway station (D7).
  return destinationType === 'STATION'
    ? { key: 'station_departure_buffer_min', minutes: config.station_departure_buffer_min }
    : { key: 'airport_departure_buffer_min', minutes: config.airport_departure_buffer_min }
}

/**
 * FR-G4 / D1: a scheduled guest who never taps "I have arrived" is still served.
 * The sweeper queues them automatically once the grace period after their scheduled time elapses.
 */
export function autoQueueDueAt(scheduledAt: Date, config: EventConfig): Date {
  return addMinutes(scheduledAt, config.auto_queue_fallback_min)
}

/** FR-A4: warning and critical thresholds for how long a guest has been waiting (D8, D9). */
export function waitSeverity(
  readyAt: Date,
  now: Date,
  config: EventConfig,
): 'OK' | 'WARN' | 'CRITICAL' {
  const waited = (now.getTime() - readyAt.getTime()) / 60_000
  if (waited > config.guest_wait_critical_min) return 'CRITICAL'
  if (waited > config.guest_wait_warn_min) return 'WARN'
  return 'OK'
}
