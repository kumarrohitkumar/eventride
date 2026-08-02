# LLD — Event Fleet Dispatch System ("EventRide")

**Version:** 1.0
**Date:** 2026-07-31
**Inputs:** [PRD.md](PRD.md) v1.0 · [HLD.md](HLD.md) v1.0
**Purpose:** the implementation contract — schema, enums, transition tables, API and socket contracts, engine
algorithms with complexity, screen specs, and the test plan. A developer should be able to build from this without
asking a design question.

---

## 1. Enums (single source: `packages/shared/enums.ts`)

```ts
export const Role            = ['ADMIN','DRIVER','GUEST'] as const
export const LocationType    = ['AIRPORT','STATION','ACCOMMODATION','VENUE','CUSTOM'] as const
export const TripType        = ['ARRIVAL','TO_VENUE','FROM_VENUE','DEPARTURE','AD_HOC'] as const
export const RequestSource   = ['SCHEDULED','WAVE','ON_DEMAND'] as const

export const RequestState = [
  'REGISTERED','PENDING_APPROVAL','APPROVED','DECLINED',
  'QUEUED','ASSIGNED','ACCEPTED','EN_ROUTE','ARRIVED_PICKUP','BOARDED','COMPLETED',
  'UNMATCHED','NO_SHOW','CANCELLED',
] as const

export const DriverState = [
  'OFFLINE','AVAILABLE','OFFERED','EN_ROUTE_TO_PICKUP','AT_PICKUP','ON_TRIP',
  'ON_BREAK','UNAVAILABLE',
] as const

export const TripState = [
  'OFFERED','ACCEPTED','EN_ROUTE','AT_PICKUP','ON_TRIP','COMPLETED',
  'REJECTED','EXPIRED','CANCELLED',
] as const

export const StopKind        = ['PICKUP','DROP'] as const
export const StopState       = ['PENDING','ARRIVED','DONE','SKIPPED'] as const
export const Actor           = ['ENGINE','ADMIN','DRIVER','GUEST','SYSTEM'] as const
export const BreakState      = ['NONE','DUE','ON_BREAK'] as const

export const UnmatchedReason = [
  'NO_DRIVER_ONLINE','ALL_DRIVERS_BUSY','NO_CAPACITY','DEADLINE_INFEASIBLE',
  'ALL_DRIVERS_ON_BREAK','GROUP_TOO_LARGE','OUTSIDE_SHIFT_HOURS','COOLDOWN_ONLY_CANDIDATES',
] as const

export const AlertType = [
  'WAIT_WARN','WAIT_CRITICAL','UNMATCHED','FLEET_SHORTFALL','BREAKDOWN',
  'CONSECUTIVE_REJECTS','STALE_LOCATION','DUTY_CAP','APPROVAL_PENDING','DEADLINE_RISK',
] as const
```

**Note on `RequestState` vs `TripState`:** the *request* tracks the guest's journey; the *trip* tracks the driver's
commitment. They are separate because one trip serves several pooled requests, and a rejected trip must not reset the
guest's accumulated wait time (`ready_at` is preserved — the basis of PRD D8).

---

## 2. Database Schema (PostgreSQL 16 / Prisma)

Conventions: `id` = `uuid` default `gen_random_uuid()` · all timestamps `timestamptz` stored UTC (NFR-9) ·
`created_at` / `updated_at` on every table · soft delete only where noted.

### 2.1 `event` (exactly one row)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| timezone | text | IANA, e.g. `Asia/Kolkata` |
| starts_at / ends_at | timestamptz | |
| config | jsonb | **every key from PRD §12**, validated by a zod schema on write |

### 2.2 `location`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| type | LocationType | |
| label | text | "Grand Hyatt", "T2 Arrivals" |
| lat / lng | double precision | |
| pickup_instruction | text null | "Gate 5, Pillar 7" — shown to guest and driver |
| is_active | boolean | |

Index: `(type)`.

### 2.3 `app_user`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| role | Role | |
| phone | text unique null | guests and drivers |
| email | text unique null | admins |
| password_hash | text null | admins only, bcrypt |
| name | text | |
| is_active | boolean | |

One users table for all three roles keeps auth to a single code path (T12). `guest.user_id` and `driver.user_id` are
the role-specific extensions.

### 2.4 `guest`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → app_user unique | |
| name / phone | text | |
| group_size | int, `CHECK > 0` | |
| luggage_count | int, `CHECK >= 0` | |
| accommodation_id | uuid FK → location null | null = not yet allotted |
| arrival_mode | text null | `FLIGHT` / `TRAIN` / `OWN` |
| arrival_ref | text null | flight/train number |
| arrival_at | timestamptz null | |
| arrival_location_id | uuid FK → location null | |
| departure_mode / departure_ref / departure_at | | |
| departure_location_id | uuid FK → location null | |
| is_vip | boolean default false | admin-only (D12) |
| notes | text null | |
| is_walk_in | boolean default false | created on event day (FR-A7) |

Indexes: `(accommodation_id)`, `(arrival_at)`, `(is_vip)`.

### 2.5 `driver`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → app_user unique | |
| name / phone | text | |
| vehicle_number | text | 1 driver : 1 vehicle (D19) |
| vehicle_type | text | "Sedan", "Innova", "Tempo" |
| seat_capacity | int `CHECK > 0` | excludes the driver's own seat |
| luggage_capacity | int `CHECK >= 0` | standard pieces |
| shift_start / shift_end | timestamptz | |
| state | DriverState default `OFFLINE` | |
| last_lat / last_lng | double precision null | 30 s-sampled mirror of Redis (L2 fallback) |
| last_location_at | timestamptz null | staleness detection (E20) |
| predicted_free_at | timestamptz null | written by the applier |
| predicted_free_location_id | uuid null | |
| predicted_free_lat / lng | double precision null | for mid-route predictions |
| driving_minutes_today | int default 0 | break trigger |
| trips_since_break | int default 0 | break trigger |
| break_state | BreakState default `NONE` | |
| break_started_at | timestamptz null | |
| unavailable_reason | text null | |
| version | int default 0 | optimistic lock |

Indexes: `(state)`, `(predicted_free_at)`.

### 2.6 `trip_request` — the demand unit

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| guest_id | uuid FK → guest | |
| trip_type | TripType | |
| source | RequestSource | |
| origin_id / destination_id | uuid FK → location | |
| origin_lat / origin_lng | double precision null | **overridden on breakdown re-queue** (E5) |
| scheduled_at | timestamptz null | planned pickup time |
| ready_at | timestamptz null | set by the guest tap or the auto-queue sweeper — **never reset on requeue** (D8) |
| deadline_at | timestamptz null | computed for hard-deadline types |
| is_hard_deadline | boolean default false | |
| group_size / luggage_count | int | snapshotted from guest at creation, admin-editable |
| state | RequestState | |
| priority_score | double precision default 0 | recomputed each round |
| passed_over_count | int default 0 | INV-4 |
| requeue_count | int default 0 | |
| unmatched_reason | UnmatchedReason null | FR-A11 |
| group_ref | uuid null | links split sub-requests (FR-M16) |
| wave_id | uuid FK → wave null | FR-M4 |
| trip_id | uuid FK → trip null | current serving trip |
| approval_note | text null | guest's stated reason (ad-hoc) |
| decline_reason | text null | shown to guest |
| created_at | timestamptz | FIFO tiebreak |

Indexes: `(state)`, `(state, ready_at)`, `(guest_id)`, `(wave_id)`, `(trip_id)`, `(group_ref)`,
partial index `WHERE state = 'QUEUED'` (the round's hot query).

### 2.7 `trip` — the supply commitment

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| driver_id | uuid FK → driver | |
| state | TripState | |
| offered_at / accepted_at / started_at / completed_at | timestamptz null | |
| offer_expires_at | timestamptz null | sweeper input |
| seats_used / luggage_used | int | rollup, guarded by a CHECK against driver capacity |
| planned_pickup_at / planned_drop_at | timestamptz null | |
| score_breakdown | jsonb null | FR-M23 |
| runner_up_driver_id | uuid null | FR-M23 |
| decision_round_id | uuid null | links to the decision log |
| is_pinned | boolean default false | admin override → engine must not touch (E16) |
| override_reason | text null | mandatory on override (FR-A9) |
| reject_reason | text null | |
| version | int default 0 | optimistic lock |

Constraint: **partial unique index** `(driver_id) WHERE state IN ('OFFERED','ACCEPTED','EN_ROUTE','AT_PICKUP','ON_TRIP')`
→ enforces INV-5 (one active trip per driver) **in the database**, not just in code.

### 2.8 `trip_stop`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| trip_id | uuid FK → trip | |
| seq | int | ordering; rewritten on detour insertion |
| kind | StopKind | |
| request_id | uuid FK → trip_request | |
| location_id | uuid FK → location | |
| lat / lng | double precision | resolved coordinates |
| state | StopState default `PENDING` | |
| planned_at | timestamptz null | |
| arrived_at / departed_at | timestamptz null | |
| seats_delta / luggage_delta | int | `+n` at pickup, `−n` at drop → the running-load check for INV-1 |

Unique: `(trip_id, seq)`. Index: `(request_id)`.

**Why `seats_delta`:** capacity is validated by a prefix-sum over `seats_delta` ordered by `seq`. That is the exact
formalisation of "capacity respected at every point of the stop sequence" (INV-1), and it makes the check a 5-line
function used identically by the engine, the applier, and the test suite.

### 2.9 `wave` (FR-M4 — a tag, not a subsystem)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| trip_type | TripType | `TO_VENUE` / `FROM_VENUE` |
| origin_id / destination_id | uuid FK → location | |
| departs_at | timestamptz | |
| state | text | `PLANNED` / `DISPATCHED` / `CLOSED` |
| seats_needed / seats_assigned | int | |

### 2.10 Supporting tables

| Table | Columns (essentials) |
|---|---|
| `status_event` | entity_type, entity_id, from_state, to_state, actor, actor_user_id, reason, meta jsonb, at — **append-only** (D36) |
| `decision_round` | id, trigger, started_at, duration_ms, snapshot_digest, decisions jsonb, rejections jsonb, routing_calls int |
| `alert` | type (AlertType), severity, entity_type, entity_id, message, meta, created_at, acknowledged_at, acknowledged_by |
| `driver_position_history` | driver_id, lat, lng, at — sampled every 30 s, purged after the audit window (NFR-10) |
| `otp_code` | phone, code_hash, expires_at, consumed_at, attempts |
| `notification_token` | user_id, expo_push_token, platform, updated_at |
| `import_batch` | filename, uploaded_by, row_count, error_report jsonb, created_at |

**Redis keys** (T6): `pos:<driverId>` → `{lat,lng,at}` (TTL 120 s) · `cooldown:<driverId>:<requestId>` (TTL from
config) · `lock:matching-round` (NX, TTL 30 s) · `socket.io` pub/sub channels.

---

## 3. State Transition Tables

The authoritative tables live in `packages/shared/state-machines.ts` and are enforced by `TripService` (INV-6).
Any transition not listed throws `409 ILLEGAL_TRANSITION`.

### 3.1 `trip_request`

| From | To | Trigger | Guard |
|---|---|---|---|
| REGISTERED | PENDING_APPROVAL | guest submits ad-hoc | no other pending request for this guest (E18) |
| REGISTERED | QUEUED | guest taps ready · sweeper auto-queue · wave dispatch | request is not already served |
| PENDING_APPROVAL | APPROVED | admin approves | actor = ADMIN |
| PENDING_APPROVAL | DECLINED | admin declines | reason required |
| APPROVED | QUEUED | immediately (same transaction) | — |
| QUEUED | ASSIGNED | engine decision applied | driver locked, capacity re-checked |
| QUEUED | UNMATCHED | round found no feasible driver | `unmatched_reason` required |
| UNMATCHED | QUEUED | next round · admin retry · new driver online | — |
| ASSIGNED | ACCEPTED | driver accepts | actor = that driver |
| ASSIGNED | QUEUED | driver rejects · offer expires · admin unassigns | `ready_at` **preserved**, `passed_over_count++` |
| ACCEPTED | EN_ROUTE | driver starts | — |
| EN_ROUTE | ARRIVED_PICKUP | driver taps arrived | — |
| ARRIVED_PICKUP | BOARDED | driver taps boarded | — |
| ARRIVED_PICKUP | NO_SHOW | driver taps guest-not-found | ≥ `no_show_wait_min` since arrival |
| BOARDED | COMPLETED | driver taps arrived-at-drop | this request's DROP stop is last-relevant |
| BOARDED / EN_ROUTE / ARRIVED_PICKUP | QUEUED | breakdown / admin override | origin rewritten to live position if BOARDED (E5) |
| any active | CANCELLED | admin only | reason required |

### 3.2 `driver`

| From | To | Trigger | Guard |
|---|---|---|---|
| OFFLINE | AVAILABLE | driver goes online | inside shift window |
| AVAILABLE | OFFERED | engine assigns | no active trip (DB partial unique index) |
| OFFERED | EN_ROUTE_TO_PICKUP | accept | — |
| OFFERED | AVAILABLE | reject / expire | cooldown written |
| EN_ROUTE_TO_PICKUP | AT_PICKUP | arrived | — |
| AT_PICKUP | ON_TRIP | boarded | — |
| ON_TRIP | AVAILABLE | last drop completed | counters updated; break check runs |
| ON_TRIP | ON_TRIP | detour inserted | capacity + delay guards (FR-M13) |
| AVAILABLE | ON_BREAK | break granted | `break_state = DUE` or driver-requested + queue allows |
| ON_BREAK | AVAILABLE | break duration elapsed | counters reset |
| any | UNAVAILABLE | breakdown / admin | active requests re-queued first |
| any | OFFLINE | shift end / duty cap / driver toggle | not `ON_TRIP` (must complete or be overridden) |

**Counter rules:** on trip completion `driving_minutes_today += actual trip minutes`, `trips_since_break += 1`; on
break completion both `trips_since_break = 0` and continuous-driving accumulation resets.

---

## 4. REST API Contracts

Base `/api/v1`. Auth: `Authorization: Bearer <jwt>`. All errors use one envelope:

```json
{ "error": { "code": "DEADLINE_INFEASIBLE", "message": "human readable", "details": {} } }
```

### 4.1 Auth (public)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/otp/request` | `{phone}` | Rate-limited 3/10 min. Returns `{sent:true}` and never reveals whether the number exists |
| POST | `/auth/otp/verify` | `{phone, code}` | Dev mode accepts `000000`. Returns `{token, role, profile}` |
| POST | `/auth/login` | `{email, password}` | Admins |
| GET | `/auth/me` | — | Resolves token → role + profile |

### 4.2 Guest (`role = GUEST`, always self-scoped — **no id parameters**)

| Method | Path | Purpose | Response |
|---|---|---|---|
| GET | `/me/itinerary` | FR-G12 | `TripRequestSummary[]` for the event |
| GET | `/me/current` | FR-G2, G7 | `{ request, trip?, driver?, eta?, isShared, coPassengers, stopsBeforeYou, estimated }` — `driver` present **only after ACCEPTED** (HLD §6.1) |
| POST | `/me/requests/:id/ready` | FR-G3 | sets `ready_at`, → `QUEUED`, triggers a round |
| POST | `/me/requests` | FR-G9 | `{originId, destinationId, when, people, luggage, reason}` → `PENDING_APPROVAL`. `409 REQUEST_ALREADY_PENDING` if one exists |
| POST | `/me/requests/:id/no-longer-needed` | FR-G15 | creates an admin note; **does not cancel** |
| POST | `/me/push-token` | T10 | stores the Expo token |

`GET /me/current` deliberately returns **one flattened view-model** so the guest home screen is a single request with
no client-side joins — the "≤ 2 taps, zero onboarding" requirement (NFR-5) starts with a simple payload.

### 4.3 Driver (`role = DRIVER`, always self-scoped)

| Method | Path | Purpose |
|---|---|---|
| POST | `/me/duty` | `{online:boolean}` → FR-D2 |
| GET | `/me/trip` | FR-D3 — the one active trip, or `{trip:null}`. **Never returns another driver's trip; never returns a queue** |
| POST | `/me/trip/:id/accept` | FR-D5. `409 TRIP_STALE` if reassigned meanwhile |
| POST | `/me/trip/:id/reject` | `{reason}` → requeue + cooldown |
| POST | `/me/trip/:id/stops/:stopId/arrived` | FR-D6 |
| POST | `/me/trip/:id/stops/:stopId/boarded` | FR-D6 |
| POST | `/me/trip/:id/stops/:stopId/dropped` | FR-D6; completes the trip when the last stop is done |
| POST | `/me/trip/:id/guest-not-found` | FR-D11; `409 TOO_EARLY` before the wait timer |
| POST | `/me/location` | `{lat, lng, at}` — writes Redis, mirrors to Postgres every 30 s |
| POST | `/me/break/request` | FR-D9 → auto-granted or `PENDING_ADMIN` with a promised time |
| GET | `/me/shift` | FR-D10 — shift end, driving minutes, next break window |

The driver trip payload contains `guestNames[]`, `guestCount`, `luggageCount` and **no guest phone numbers** (D9, HLD §11).

### 4.4 Admin (`role = ADMIN`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/dashboard` | FR-A14 — counts, alerts, demand-vs-supply for the next 30/60 min |
| GET | `/admin/drivers` | FR-A2 — list + live positions + predicted free time |
| POST/PATCH | `/admin/drivers[/:id]` | FR-A6 |
| POST | `/admin/drivers/:id/unavailable` | `{reason}` → E5 recovery |
| POST | `/admin/drivers/:id/break` | grant/deny a break |
| GET | `/admin/guests` | FR-A3 — filter by state, sort by wait desc |
| POST/PATCH | `/admin/guests[/:id]` | FR-A7 (walk-ins, deviations) — re-plans unstarted trips |
| POST | `/admin/guests/import` | FR-A8 — multipart CSV → `{rowCount, errors[]}`, **all-or-nothing** |
| GET | `/admin/requests?state=` | queue views |
| POST | `/admin/requests/:id/approve` | FR-A5 — **no driver parameter exists on this endpoint** (FR-M25) |
| POST | `/admin/requests/:id/decline` | `{reason}` |
| POST | `/admin/requests/:id/retry` | re-queue an UNMATCHED request |
| POST | `/admin/requests/:id/override-assign` | `{driverId, reason}` — the **only** endpoint that names a driver; pins the trip; bypasses the engine (D35) |
| POST | `/admin/requests/:id/cancel` | `{reason}` |
| GET/POST/PATCH | `/admin/waves` | FR-A12 |
| POST | `/admin/waves/:id/dispatch` | dispatch now |
| POST | `/admin/batch-plan/preview` | FR-A13 — returns the proposed plan, commits nothing |
| POST | `/admin/batch-plan/publish` | applies a previewed plan |
| GET | `/admin/rounds/:id` | the decision log for one round (FR-M23) |
| GET | `/admin/audit?entity=` | FR-A16 |
| GET/PATCH | `/admin/config` | FR-A15 — PRD §12 values, zod-validated |
| GET | `/admin/alerts`, POST `/admin/alerts/:id/ack` | alert handling |
| GET | `/metrics` | NFR-7 (Prometheus text format) |

**The API surface itself enforces PRD G5:** exactly one endpoint accepts a `driverId` for assignment, and it demands
a reason and writes an audit row. There is no way to hand-pick a driver through the normal flow.

---

## 5. Socket Contracts

Handshake: `auth: { token }`. Rooms are derived server-side from the token (HLD §7); `socket.join` from the client is rejected.

| Event | To | Payload |
|---|---|---|
| `request.state` | guest, admins | `{requestId, state, unmatchedReason?}` |
| `trip.assigned` | guest | `{driverName, vehicleNumber, vehicleType, driverPhone, etaMin, estimated}` |
| `trip.location` | guest, admins | `{tripId, lat, lng, etaMin, estimated, at}` |
| `trip.eta` | guest, admins | `{tripId, etaMin, estimated}` |
| `trip.offered` | driver | full trip card + `expiresAt` |
| `trip.updated` | driver, affected guests | `{tripId, stops[], addedMinutes?}` — detour banner (FR-D8) |
| `trip.cancelled` | driver | `{tripId, reason}` |
| `break.granted` | driver | `{startsAt, durationMin}` |
| `driver.positions` | admins | `[{driverId, lat, lng, at}]` — **batched, 1 Hz aggregate** (HLD §7) |
| `driver.status` | admins | `{driverId, state}` |
| `alert.raised` / `alert.cleared` | admins | `{type, severity, message, entity}` |
| `metrics.tick` | admins | dashboard counters |

---

## 6. Engine LLD (`packages/engine`)

### 6.1 Interface

```ts
export interface Snapshot {
  now: Date
  config: EventConfig                    // PRD §12
  drivers: DriverView[]                  // assignable + active (for detour insertion)
  requests: RequestView[]                // QUEUED + UNMATCHED (retry) + pending (re-optimise)
  activeTrips: ActiveTripView[]          // for FR-M18
  travel: TravelOracle                   // pre-resolved durations — NO I/O
}

export interface TravelOracle {
  minutes(from: LatLng | LocationId, to: LatLng | LocationId): number   // always resolvable
  isEstimated(from: any, to: any): boolean
}

export type Decision =
  | { kind:'ASSIGN';         driverId; requestIds: string[]; stops: PlannedStop[]; score: ScoreBreakdown; runnerUpDriverId?: string }
  | { kind:'INSERT_DETOUR';  tripId; requestId; position: number; addedMinutes: number; score: ScoreBreakdown }
  | { kind:'RESERVE';        driverId; requestId; untilAt: Date }        // FR-M22
  | { kind:'SPLIT';          requestId; parts: { groupSize; luggage }[] } // FR-M16
  | { kind:'UNMATCHED';      requestId; reason: UnmatchedReason }
  | { kind:'SHORTFALL';      seatsShort: number; guestsAffected: number; horizonMin: number } // FR-M17

export function runRound(s: Snapshot): { decisions: Decision[]; rejections: Rejection[] }
```

`TravelOracle` is the seam that keeps the engine pure (HLD T15): `SnapshotBuilder` resolves every distance the round
could need *before* calling the engine, so the engine never awaits anything and is fully synchronous — which is why
it can be property-tested and replayed.

### 6.2 Priority score (FR-M14)

```ts
function priority(r: RequestView, now: Date, c: EventConfig): number {
  const waited      = minutesBetween(r.readyAt ?? r.createdAt, now)
  const urgency     = r.isHardDeadline
      ? Math.max(0, 120 - minutesBetween(now, r.deadlineAt)) / 120   // 0 → 1 as the deadline nears
      : 0
  return c.w_urgency * urgency
       + c.w_vip     * (r.isVip ? 1 : 0)
       + c.w_age     * waited
       + c.w_group   * r.groupSize
       + (r.passedOverCount >= c.max_passed_over_count ? 1_000_000 : 0)  // INV-4 hard override
}
```

The `1_000_000` term is intentionally brutal: after 3 pass-overs a request outranks *everything*, so starvation is
impossible by construction rather than by weight tuning (PRD D26). It is directly asserted by a property test.

### 6.3 Hard feasibility filter (FR-M9…M11)

```ts
function isFeasible(d: DriverView, r: RequestView, s: Snapshot): Rejection | null {
  if (d.state !== 'AVAILABLE' && !d.predictedFreeAt)   return rej('ALL_DRIVERS_BUSY')
  if (r.groupSize    > d.seatCapacity)                 return rej('NO_CAPACITY')
  if (r.luggageCount > d.luggageCapacity)              return rej('NO_CAPACITY')
  if (d.breakState === 'DUE' || d.state === 'ON_BREAK') return rej('ALL_DRIVERS_ON_BREAK')
  if (d.cooldownRequestIds.includes(r.id))             return rej('COOLDOWN_ONLY_CANDIDATES')

  const startAt  = maxDate(s.now, d.predictedFreeAt ?? s.now)
  const pickupAt = addMinutes(startAt, s.travel.minutes(d.freeLocation, r.origin))
  const dropAt   = addMinutes(pickupAt, s.travel.minutes(r.origin, r.destination))

  if (dropAt > d.shiftEnd)                             return rej('OUTSIDE_SHIFT_HOURS')
  if (r.isHardDeadline && dropAt > r.deadlineAt)        return rej('DEADLINE_INFEASIBLE')
  return null
}
```

Every rejection is returned, not discarded — that is the mechanism behind PRD INV-2 and the admin exception queue
(FR-A11). "No driver was available" is never an unexplained outcome.

### 6.4 Cost function (PRD §11.5)

```ts
function score(d: DriverView, r: RequestView, s: Snapshot): ScoreBreakdown {
  const c        = s.config
  const deadhead = s.travel.minutes(d.freeLocation, r.origin)
  const startAt  = maxDate(s.now, d.predictedFreeAt ?? s.now)
  const pickupAt = addMinutes(startAt, deadhead)
  const wait     = Math.max(0, minutesBetween(r.readyAt ?? s.now, pickupAt))
  const slack    = r.deadlineAt ? minutesBetween(pickupAt, r.deadlineAt) : Infinity

  const parts = {
    deadhead: c.w_deadhead * deadhead,
    wait:     c.w_wait     * wait,
    late:     c.w_late     * (slack < 15 ? (15 - slack) : 0),
    detour:   c.w_detour   * addedDelayToCommitted(d, r, s),
    waste:    c.w_waste    * (d.seatCapacity - r.groupSize),
    break:    c.w_break    * breakPressure(d, c),
    pool:    -c.w_pool     * (sharesDestinationCluster(d, r, s) ? 1 : 0),
    age:     -c.w_age      * minutesBetween(r.readyAt ?? r.createdAt, s.now),
    vip:     -c.w_vip      * (r.isVip ? 1 : 0),
  }
  return { total: sum(parts), parts }
}
```

The breakdown is persisted on the trip (`score_breakdown`) so any assignment can be explained after the fact
(FR-M23) — and so the design document can show real numbers rather than a formula.

### 6.5 Real-time match — `matchIncremental` (FR-M2)

```
1. candidates = drivers.filter(d => isFeasible(d, r))          // O(D)
2. if none → UNMATCHED with the most common rejection reason   // FR-A11
3. topK    = candidates.sortBy(haversine).take(5)              // SnapshotBuilder already
                                                              //   fetched live times for these only (NFR-4)
4. best    = topK.minBy(score)
5. if r.isHardDeadline and a nearer driver frees up within reservation_horizon_min
       and the best current option wastes a large vehicle → RESERVE                 // FR-M22
6. else → ASSIGN
```

Complexity **O(D log D)**; D ≤ 100 → sub-millisecond. The 5 s p95 budget (G6) is spent almost entirely on the single
batched routing call, which is why the call count per decision is capped at one.

### 6.6 Batch plan — `planBatch` (FR-M1)

```
1. requests = sortByPriorityDesc(queued)
2. Build cost matrix C[i][j] for feasible (request_i, driver_j); infeasible = +∞
3. Solve the linear assignment problem (Hungarian, O(n³))         // n = min(R, D) ≤ 100 → ~1ms
4. Pooling pass over the leftovers:
     for each unassigned request r (priority order):
        for each planned trip t (best-fit by cost):
           if sameDestinationCluster(t, r)
              and |t.readyAt − r.readyAt| ≤ pool_time_window_min
              and t.dropStops < pool_max_drop_stops
              and capacityOkAtEveryStop(t + r)                    // INV-1 prefix-sum
              and addedDelay(existing guests) ≤ detour_max_added_min
           then pool r into t and stop
5. Remaining requests with groupSize > max(seatCapacity) → SPLIT   // FR-M16
6. Still unassigned → UNMATCHED (+ SHORTFALL if aggregate demand > supply)
```

Hungarian is optimal for the 1:1 layer and pooling is greedy on top (PRD D29). The trade-off is explicit: we give up
global optimality across the pooled problem (a true VRP) in exchange for an algorithm that runs in milliseconds,
is deterministic, and can be explained in a paragraph.

### 6.7 Detour insertion — `tryInsertDetour` (FR-M18, D24)

```
for each activeTrip t with spare seats and luggage (and not pinned):
   remaining = t.stops.filter(s => s.state === 'PENDING')
   for pos in 0..remaining.length:                            // insertion after the live position only
       candidate = splice(remaining, pos, PICKUP(r), DROP(r))
       if not capacityOkAtEveryStop(candidate) → continue      // INV-1
       added = routeMinutes(driver.livePosition, candidate) − routeMinutes(driver.livePosition, remaining)
       if added > detour_max_added_min                → continue   // FR-M13
       if anyCommittedGuestDeadlineBreached(candidate) → continue   // FR-M13
       score this insertion; keep the best
emit at most detour_max_inserted_stops (=1) insertions per trip per round
```

Complexity **O(T × S)** with S ≤ 4 remaining stops — trivially cheap, which is what makes it safe to run on every
90 s tick for every active trip (the requirement that this apply to *in-progress* trips, not just unstarted ones).

### 6.8 Capacity check — the shared primitive (INV-1)

```ts
function capacityOkAtEveryStop(stops: PlannedStop[], d: DriverView): boolean {
  let seats = 0, bags = 0
  for (const s of stops) {
    seats += s.seatsDelta; bags += s.luggageDelta
    if (seats > d.seatCapacity || bags > d.luggageCapacity) return false
    if (seats < 0 || bags < 0) return false                  // catches malformed stop sequences
  }
  return true
}
```

Used by the engine, by the applier's transaction re-check, and by the DB rollup constraint. One function, three
enforcement points (HLD §9) — a single bug cannot produce a capacity violation.

### 6.9 Round orchestration

```
runRound(s):
  1. detours   = tryInsertDetour over activeTrips        // cheapest wins are taken first —
                                                        //   a passing vehicle beats dispatching a new one
  2. remaining = requests not served by a detour
  3. decisions = remaining.length > BATCH_THRESHOLD (=5)
                   ? planBatch(remaining)
                   : remaining.map(matchIncremental)
  4. mark passedOverCount++ on every request that stayed QUEUED while a
     lower-priority request got assigned                 // INV-4 bookkeeping
  5. aggregate SHORTFALL if unmatched seats > 0 in the next 60 min
  6. return { decisions, rejections }
```

Detours are evaluated **first** on purpose: using a vehicle already going that way is strictly better for both G1
(guest wait) and G2 (driver idleness) than starting a new deadhead trip.

---

## 7. Sweeper Job Table (HLD §5.4 — 10 s interval)

| Job | Query | Action |
|---|---|---|
| `expireOffers` | `trip.state='OFFERED' AND offer_expires_at < now` | reject + requeue + trigger round |
| `autoQueueScheduled` | `request.state='REGISTERED' AND scheduled_at + fallback < now` | → QUEUED (FR-G4) |
| `noShowEligible` | stop `ARRIVED` older than `no_show_wait_min` | expose action + alert |
| `breakDue` | `driving_minutes_today ≥ 240 OR trips_since_break ≥ 6` | `break_state='DUE'` |
| `dutyCap` | duty minutes ≥ `max_duty_hours` | force OFFLINE + alert |
| `waitSla` | `request.state='QUEUED' AND now − ready_at > warn/critical` | raise/refresh alert |
| `dispatchWaves` | `wave.departs_at ≤ now AND state='PLANNED'` | queue the wave's requests |
| `staleLocation` | driver on trip, `last_location_at` older than 2 min | alert (E20) |
| `endBreaks` | `break_started_at + duration < now` | → AVAILABLE, reset counters |
| `mirrorPositions` | Redis → Postgres, 30 s sample | L2 fallback + audit history |

Each job is an independent query with no shared memory, so a crash mid-sweep is harmless — the next tick redoes it.

---

## 8. Screen Specifications

### 8.1 Guest app (Expo)

| Screen | Content | States handled |
|---|---|---|
| **Login** | phone → OTP | unknown number → "Contact the event desk" |
| **Home / My Ride** | trip card: type, pickup + instruction, time, destination; big primary button whose label follows state | `REGISTERED` → "I have arrived" · `QUEUED` → "Finding your ride" spinner + waited-minutes · `ASSIGNED` → still "Finding your ride" (D: no driver shown pre-accept) · `ACCEPTED/EN_ROUTE` → driver card + map + ETA · `ARRIVED_PICKUP` → "Your driver has arrived" + vehicle number huge · `BOARDED` → "On the way to X" · `UNMATCHED` → "Arranging your ride — team notified" (FR-G11) |
| **Live map** | driver marker, route line, numeric ETA **always rendered above the map** so a map failure never hides the ETA (FR-G6) | offline → cached position + "last updated hh:mm" |
| **Shared-ride notice** | "Shared ride · 2 co-passengers · 1 stop before yours" | only when pooled (FR-G8) |
| **Itinerary** | grouped by day: arrival, wave times, departure | empty → "No trips scheduled yet" |
| **Request a ride** | from / to / now-or-later / people / luggage / reason | pending · approved · declined-with-reason (FR-G10); blocked if one pending (E18) |
| **Help** | ops helpdesk call button | always reachable |

Design constraints from NFR-5: one dominant action per screen; ETA always as text; vehicle number in the largest
type on the arrival screen (a tired guest at 02:00 is matching a number plate, not reading a UI).

### 8.2 Portal — Admin role

| Screen | Content |
|---|---|
| **Dashboard** | alert strip (critical first) · counters (waiting / assigned / in-transit / unmatched) · demand-vs-supply for next 30/60 min (FR-A14) · live map |
| **Live map** | drivers colour-coded by state, trip label on hover, click → driver detail |
| **Drivers** | table: name, vehicle, capacity, state, current trip, predicted free at, driving minutes, break state; actions: edit, mark unavailable, grant break |
| **Guests** | tabs Waiting / Assigned / In transit / Completed / Exceptions; Waiting sorted by wait desc with a red row past critical (FR-A4) |
| **Approvals** | pending ad-hoc requests with guest context; Approve / Decline (reason required). **No driver picker anywhere on this screen** |
| **Exceptions** | UNMATCHED list with typed reason + suggested action (split / add fleet / delay) + Retry and Override buttons |
| **Waves** | per accommodation per event day; create/edit/dispatch |
| **Batch plan** | Preview → proposed pairings table → Publish |
| **Round detail** | one round's decisions with score breakdowns, runner-up, and **all rejections with reasons** — the "why did it do that" screen |
| **Config** | every PRD §12 key, grouped, with defaults and inline validation |
| **Audit** | filterable timeline per guest/driver |

### 8.3 Portal — Driver role (same app, role-gated)

| Screen | Content |
|---|---|
| **Login** | phone → OTP |
| **Duty** | big Go online / Go offline toggle; shift + next break strip (FR-D10) |
| **No trip** | "You're online. Waiting for your next trip." — **no queue, no map of other drivers** |
| **Offer** | guest name(s), count, luggage, pickup + instruction, destination, target time, countdown ring; Accept / Reject(reason) |
| **Active trip** | current stop highlighted, one dominant action button that advances the state (`Arrived` → `Boarded` → `Dropped`), Open-in-Maps, ops call button, detour banner when a stop is inserted (FR-D8) |
| **Break** | driving minutes, next eligible window, Request break |
| **Problem** | Breakdown / Road blocked / Fuel → confirms, then releases the trip (FR-D12) |

Route guard: a driver-role session that navigates to any `/admin/*` route is redirected, **and** the API returns 403
independently (HLD §11) — the two are separate defences.

---

## 9. Notifications (T10)

| Channel | Used for |
|---|---|
| Expo Push → guest | assigned, driver arrived, detour ETA change, approved/declined, reassigning after breakdown |
| Socket + browser Notification → portal | trip offered (with sound — a driver must not miss a 60 s window), detour, break granted, admin alerts |
| In-app state | everything (the only channel that is guaranteed) |

`NotificationService` maps `(eventType, role) → template`, so adding a notification is a table entry, not a code path.
Push failures are logged and never block a state transition (NFR-3 L4).

---

## 10. Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `ILLEGAL_TRANSITION` | 409 | Not allowed by §3 |
| `TRIP_STALE` | 409 | Optimistic-lock loss (reassigned meanwhile) |
| `REQUEST_ALREADY_PENDING` | 409 | E18 |
| `TOO_EARLY` | 409 | no-show before the wait timer |
| `NO_CAPACITY` / `DEADLINE_INFEASIBLE` / `GROUP_TOO_LARGE` | 422 | override attempt that would break an invariant |
| `OVERRIDE_REASON_REQUIRED` | 422 | FR-A9 |
| `FORBIDDEN_ROLE` / `FORBIDDEN_ROW` | 403 | RBAC layers 1 and 2 |
| `OTP_INVALID` / `OTP_EXPIRED` / `OTP_RATE_LIMITED` | 401 / 429 | |
| `CSV_VALIDATION_FAILED` | 422 | with per-row errors; nothing imported |

Note that even an **admin override cannot break an invariant** — the applier validates capacity and deadlines on the
override path too, returning `422` with the reason. Override bypasses the *engine*, never the *invariants*.

---

## 11. Test Plan

### 11.1 Engine unit + property tests (`packages/engine`) — the heart of the suite

| Test | Asserts |
|---|---|
| Capacity property: random fleets × random groups × 1000 rounds | **no decision ever violates INV-1** |
| Starvation property: adversarial stream that always injects higher-priority newcomers | `passed_over_count` never exceeds 3; every request eventually assigned (INV-4) |
| Deadline test: tight `TO_VENUE` / `DEPARTURE` windows | either met with buffer or `UNMATCHED` + `DEADLINE_INFEASIBLE` — **never silently late** (FR-M10) |
| Idle-driver test: 1 queued request + 1 available feasible driver | always produces an ASSIGN (INV-2 / G2) |
| Rejection-reason test: every infeasible pair | produces a typed reason (FR-A11 completeness) |
| Detour test: en-route driver, spare seats, same destination | inserts when added ≤ 10 min; **refuses** at 11 min (FR-M13) |
| Detour deadline test: insertion that would make an onboard guest late | refused |
| Pooling tests | respects window, cluster radius, max 2 drop stops, never pools VIP (FR-M15) |
| Split test: group of 9, max vehicle 6 | SPLIT into 6+3 with a shared `group_ref` |
| Reservation test: hard deadline in 12 min, nearer driver frees in 6 | RESERVE, not a wasteful ASSIGN (FR-M22) |
| Determinism test: same snapshot twice | byte-identical decisions |

Because the engine is pure, all of the above run with no DB, no network, and no maps key.

### 11.2 Integration (API + Postgres, testcontainers)

State-machine guards reject illegal transitions · concurrent accept → one 200 + one `409 TRIP_STALE` ·
two simultaneous rounds → the second is a no-op (lock) · breakdown re-queues with the **live position** as origin ·
override works with the engine disabled (G7) · CSV import is all-or-nothing · routing-call ceiling per round asserted
(NFR-4) · round duration < 5 s at 100 drivers / 300 requests (NFR-2).

### 11.3 RBAC (explicitly scored — mechanical, parametrised)

- Every `/admin/*` route with a DRIVER token → `403`; with a GUEST token → `403`.
- Driver B's token on driver A's trip → `403`.
- Guest B's token on guest A's request → `403`.
- Driver trip payload snapshot test → **asserts no guest phone field is present** (D9).
- Socket: driver token attempting to join `admins` → not joined, and receives no admin events.

### 11.4 E2E (one happy path + one exception path)

Happy: guest logs in → taps arrived → driver receives offer → accepts → status walk → guest sees completion.
Exception: driver rejects → requeue → second driver assigned → guest never saw the first driver.

### 11.5 Simulation gate (`apps/sim`)

Peak run (200 guests, 40 drivers, 80 ready inside 30 min) prints the PRD §19.3 metrics and **exits non-zero** if
capacity violations > 0, `max_passed_over_count` > 3, or wait p95 > 15 min. The invariants become a CI gate rather
than a claim in a README.

---

## 12. Seed Data (`apps/sim seed`)

| Entity | Volume | Shape |
|---|---|---|
| Event | 1 | 3 days, `Asia/Kolkata` |
| Locations | 6 | 1 airport, 1 railway station, 1 venue, 3 accommodations (one 1.5 km from another → exercises the cluster rule, one 14 km away → exercises the opposite-direction case E11) |
| Drivers | 40 | mixed: 20 × 4-seat sedans, 12 × 6-seat SUVs, 6 × 12-seat tempos, 2 × 20-seat minibuses; staggered shifts |
| Guests | 200 | arrivals across 3 clusters (02:00, 09:30, 14:00) with a deliberate 80-guest spike; 6 VIPs; 4 groups of 8–9 (forces splits); mixed luggage |
| Waves | per day × 3 hotels | 08:00 / 08:30 / 09:00 to venue |
| Ad-hoc | 8 | raised mid-simulation, requiring admin approval |

Deliberately seeded edge cases: one flight delayed 3 h (E6), one walk-in guest (E7), one breakdown mid-trip (E5),
one guest no-show (E4), one group of 9 (E8), two drivers hitting the break threshold during the peak (E13).

---

## 13. Local Setup (README contract)

```bash
pnpm install
cp .env.example .env                 # ROUTING_PROVIDER=mock works with no API key
docker compose up -d                 # postgres + redis
pnpm --filter api prisma migrate dev
pnpm --filter sim seed               # 40 drivers, 200 guests
pnpm --filter api dev                # http://localhost:3000
pnpm --filter portal dev             # http://localhost:5173  (admin + driver)
pnpm --filter guest start            # Expo Go
pnpm --filter sim peak               # peak-arrival simulation + metrics report
```

Dev logins: admin `admin@event.test / admin123` · any seeded driver or guest phone with OTP `000000`.
`ROUTING_PROVIDER=google` + `GOOGLE_MAPS_API_KEY=…` switches to live traffic; everything works without it.

---

## 14. Build Sequence

1. `packages/shared` (enums, zod schemas, state machines, config defaults)
2. Prisma schema + migrations + seed
3. Auth + RBAC guards + row scoping — **with its test suite** (this is scored, so it is not left to the end)
4. `packages/engine` + its property tests (no I/O yet — the engine is finishable before any UI exists)
5. `packages/routing` (mock + caching + metering; Google last)
6. SnapshotBuilder + DecisionApplier + TripService state machine
7. Sweeper + matching tick + Redis lock
8. Driver API + portal driver role (the shortest path to a demonstrable end-to-end loop)
9. Guest API + guest app
10. Admin API + admin portal screens
11. `apps/sim` + metrics report
12. Waves, batch plan, detour insertion, breaks (PRD P1 items)
13. `DESIGN-matching.md` + README

Steps 1–9 give a working demonstrable system; 10–13 complete the deliverables.
