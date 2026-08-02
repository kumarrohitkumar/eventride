import { z } from 'zod'

/**
 * Every tunable threshold in the system (PRD §12).
 * D33: no magic number is hard-coded anywhere else in the codebase — the engine, the sweeper,
 * both mobile apps and the simulator all read from here.
 */
export const eventConfigSchema = z.object({
  // --- guest SLA (PRD D8, D9) ---
  guest_wait_warn_min: z.number().int().positive().default(15),
  guest_wait_critical_min: z.number().int().positive().default(30),
  auto_queue_fallback_min: z.number().int().positive().default(20),

  // --- driver offer handling (PRD D14) ---
  offer_expiry_sec: z.number().int().positive().default(60),
  driver_reject_cooldown_min: z.number().int().positive().default(15),
  consecutive_rejects_alert: z.number().int().positive().default(2),
  no_show_wait_min: z.number().int().positive().default(10),

  // --- pooling (PRD D23) ---
  pool_time_window_min: z.number().int().positive().default(15),
  pool_cluster_radius_km: z.number().positive().default(2),
  pool_max_drop_stops: z.number().int().positive().default(2),

  // --- detour insertion (PRD D24) ---
  detour_max_added_min: z.number().int().positive().default(10),
  detour_max_inserted_stops: z.number().int().positive().default(1),

  // --- deadline buffers (PRD D7) ---
  airport_departure_buffer_min: z.number().int().positive().default(150),
  station_departure_buffer_min: z.number().int().positive().default(45),
  venue_arrival_buffer_min: z.number().int().positive().default(15),

  // --- driver welfare (PRD D15) ---
  break_after_driving_min: z.number().int().positive().default(240),
  break_after_trips: z.number().int().positive().default(6),
  break_duration_min: z.number().int().positive().default(30),
  max_duty_hours: z.number().int().positive().default(10),

  // --- dispatch loop ---
  reoptimise_tick_sec: z.number().int().positive().default(90),
  sweeper_tick_sec: z.number().int().positive().default(10),
  round_debounce_ms: z.number().int().nonnegative().default(500),
  reservation_horizon_min: z.number().int().positive().default(20),
  max_passed_over_count: z.number().int().positive().default(3),
  auto_split_max_vehicles: z.number().int().positive().default(2),
  /**
   * Above this many queued requests a round uses the batch planner instead of per-request
   * incremental matching. Default 1: the batch planner is the only path that can POOL guests, and
   * at these sizes Hungarian costs microseconds — so a lone request takes the fast path and
   * anything more gets the planner that can share a vehicle.
   */
  batch_threshold: z.number().int().positive().default(1),

  // --- location & external API budget (NFR-4) ---
  location_ping_on_trip_sec: z.number().int().positive().default(5),
  location_ping_idle_sec: z.number().int().positive().default(30),
  candidate_topk_for_live_eta: z.number().int().positive().default(5),
  stale_location_min: z.number().int().positive().default(2),

  // --- ops ---
  ops_helpdesk_phone: z.string().default('+91-99999-00000'),

  // --- cost function weights (PRD §11.5) ---
  w_deadhead: z.number().default(1.0),
  w_wait: z.number().default(1.5),
  w_late: z.number().default(6.0),
  w_detour: z.number().default(2.0),
  w_waste: z.number().default(0.4),
  w_break: z.number().default(1.0),
  w_pool: z.number().default(8.0),
  w_age: z.number().default(0.8),
  w_vip: z.number().default(20.0),

  // --- priority weights (LLD §6.2) ---
  w_urgency: z.number().default(50.0),
  w_group: z.number().default(0.5),
})

export type EventConfig = z.infer<typeof eventConfigSchema>

/** Defaults straight from PRD §12 — used by the seed, the simulator and every test. */
export const DEFAULT_CONFIG: EventConfig = eventConfigSchema.parse({})

export function parseConfig(input: unknown): EventConfig {
  return eventConfigSchema.parse(input ?? {})
}
