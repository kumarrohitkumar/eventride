# PRD — Event Fleet Dispatch System ("EventRide")

**Version:** 1.0 — **FROZEN. No open questions.**
**Date:** 2026-07-31
**Rule followed in this document:** every ambiguity in the assignment brief has been **decided here**, choosing the
option that is *simplest to build* while still satisfying the stated evaluation criteria. Every decision is recorded
in §16 (Decision Log) with its reason. Nothing is left for the developer to guess.

> **How to read this doc**
> §1–§5 = context and roles · §6 = data model & state machines · §7–§11 = numbered requirements
> §12 = **all magic numbers in one config table** · §13–§15 = NFR / edge cases / notifications
> §16 = **decision log (why each choice)** · §17 = accepted limitations · §18 = build order

---

## 1. Context & Problem

One large private event (conference / corporate offsite / multi-day gathering) brings a few hundred attendees to a
single city. Every attendee must be moved:

- **Arrival:** airport / railway station → their assigned accommodation
- **Event day:** accommodation → venue, and venue → accommodation
- **Departure:** accommodation → airport / railway station
- **Ad-hoc:** any extra trip a guest needs during the event (admin-approved)

Today ops staff do this by phone and spreadsheet. It breaks at scale: guests wait unpredictably, vehicles idle while
other guests wait, capacity is guessed, peak arrival windows collapse, and nobody has live visibility.

We are building a **private, single-event, closed-fleet dispatch system** that allocates drivers to guests
automatically using location, time, capacity and live traffic.

### 1.1 The rule that shapes everything

**Nobody chooses anybody.**

| Actor | Can they pick? |
|---|---|
| Guest | ❌ never sees a driver list |
| Driver | ❌ never sees a guest queue |
| Admin | ❌ not in normal flow — only explicit, logged override |
| **Matching engine** | ✅ **the only allocator** |

Humans do exactly three manual things: **(1)** load drivers and guests into the system, **(2)** approve/decline
ad-hoc ride requests, **(3)** override in an emergency. Everything else is automatic.

---

## 2. Goals & Success Metrics

| ID | Goal | Measurable target (asserted by the simulation in §19) |
|----|------|--------|
| G1 | No guest waits unreasonably | p95 wait (`ready_at` → boarded) ≤ 15 min; **zero** guests > 30 min without an admin alert being raised |
| G2 | No driver idles while guests wait | If any request is `QUEUED`, no `AVAILABLE` driver may be unassigned **unless a machine-readable infeasibility reason is recorded** |
| G3 | Capacity respected | **Zero** seat or luggage violations, ever. Mean seat utilisation ≥ 60% on pooled trips |
| G4 | Multi-destination correctness | 100% of trips end at the correct destination for the guest + event phase |
| G5 | Allocation fully automated | 100% of assignments produced by the engine; every manual assignment carries an override reason in the audit log |
| G6 | Near-real-time | Ad-hoc request → driver assigned ≤ 5 s p95 at 100 drivers / 300 guests |
| G7 | Graceful degradation | Engine down ⇒ in-progress trips unaffected, new requests queue durably, admin override still works |

## 3. Non-Goals

Payments/fares · public marketplace or driver self-signup · multi-event / multi-tenant · ratings & reviews ·
surge pricing · automatic flight/train status ingestion · full offline sync · driver payroll/shift bidding ·
route drawing for the driver (we deep-link to a nav app instead of building navigation).

---

## 4. Personas

| Persona | Situation | Needs one sentence answered |
|---|---|---|
| **Guest — Priya** | Attendee, non-technical, landing 02:10, tired, mobile data | "Who is picking me up, where do I stand, how many minutes?" |
| **Admin/Ops — Rahul** | Event-day coordinator, laptop in the ops room, 12-hour shift | "Is anyone stuck, where is every vehicle, what is about to break?" |
| **Driver — Suresh** | Pre-registered fleet driver, low-end Android, limited English | "Where do I go now, who do I pick up, when is my break?" |

---

## 5. Applications & Roles

| App | Users | Contents |
|---|---|---|
| **Guest App** (mobile) | Guests only | Own trips, live tracking, ad-hoc request |
| **Admin Portal** (single app, two roles) | Admin/Ops **and** Drivers | Role-gated views; one codebase, one auth system, one RBAC layer |

### 5.1 RBAC matrix — hard requirement, explicitly evaluated

| Capability | Admin/Ops | Driver | Guest |
|---|---|---|---|
| See all drivers' live location & status | ✅ | ❌ | ❌ |
| See full guest queue | ✅ | ❌ | ❌ |
| See own current trip | ✅ (all) | ✅ (own only) | ✅ (own only) |
| Accept / reject an offered trip | ❌ | ✅ | ❌ |
| Update trip status | ✅ (override) | ✅ (own trip) | ❌ |
| Approve / decline ad-hoc request | ✅ | ❌ | ❌ |
| Create / edit driver records | ✅ | ❌ | ❌ |
| Create / edit guest records | ✅ | ❌ | own limited fields only |
| Manual override assignment | ✅ | ❌ | ❌ |
| Mark unavailable / break | ✅ (anyone) | ✅ (own, request) | ❌ |
| Browse & choose a counterpart | ❌ | ❌ | ❌ |

**Enforcement (NFR-6):** authorisation is server-side, **per endpoint AND per row**. A driver token resolving
`GET /trips/:id` must return 403 unless `trip.driver_id == token.driver_id`. Hiding UI is not enforcement.
This is covered by dedicated authorisation tests (§19.4).

---

## 6. Domain Model

### 6.1 Entities

| Entity | Key fields | Notes |
|---|---|---|
| **Event** | name, timezone, start/end, phase schedule, config blob (§12) | Exactly one row. Simplifies everything |
| **Location (POI)** | type (`AIRPORT`/`STATION`/`ACCOMMODATION`/`VENUE`/`CUSTOM`), lat, lng, label, pickup instruction text | Pickup instruction is free text: *"Terminal 2, Gate 5, Pillar 7"* |
| **Guest** | name, phone, group_size, luggage_count, accommodation_id, arrival mode/ref/time, departure mode/ref/time, is_vip, notes | Loaded by admin pre-event or created as a walk-in |
| **Driver** | name, phone, vehicle_number, vehicle_type, seat_capacity, luggage_capacity, shift_start/end, status, last_location, last_location_at, predicted_free_at, predicted_free_location, driving_minutes_today, trips_since_break, break_state | **Vehicle is modelled as fields on the driver (D20)** — no separate vehicle entity |
| **TripRequest** | guest_id, trip_type, origin_id, destination_id, ready_at, deadline_at, priority_score, state, source (`SCHEDULED`/`WAVE`/`ON_DEMAND`), group_ref, wave_id, requeue_count, passed_over_count, created_at | The unit of **demand** |
| **Trip (Assignment)** | driver_id, ordered stop list, request_ids[], planned/actual timestamps per stop, state, score_breakdown, runner_up_driver_id, override_reason | The unit of **supply commitment**. One trip may serve several requests (pooling) |
| **StatusEvent** | entity, from_state, to_state, actor (`ENGINE`/`ADMIN`/`DRIVER`/`GUEST`/`SYSTEM`), reason, at | Append-only audit log. Powers G2/G5 and admin debugging |

### 6.2 Trip types

| Type | Origin | Destination | Deadline |
|---|---|---|---|
| `ARRIVAL` | Airport / Station | Guest's accommodation | **Soft** — minimise wait after `ready_at` |
| `TO_VENUE` | Accommodation | Venue | **Hard** — arrive by session start − buffer |
| `FROM_VENUE` | Venue | Accommodation | **Soft** — minimise wait during the exit surge |
| `DEPARTURE` | Accommodation | Airport / Station | **Hard** — arrive by flight/train time − buffer (§12) |
| `AD_HOC` | any POI | any POI | **Soft** — admin approved |

*Hard deadline = if it cannot be met, the request goes `UNMATCHED` with a reason and the admin is alerted. It is
never silently allowed to run late.*

### 6.3 State machines

**TripRequest**

```
REGISTERED
   ├─(on-demand only)→ PENDING_APPROVAL ─→ DECLINED
   │                        └────────────→ APPROVED ─┐
   └────────────────────────(ready_at reached)───────┴→ QUEUED
QUEUED → ASSIGNED → ACCEPTED → EN_ROUTE → ARRIVED_PICKUP → BOARDED → COMPLETED
Exceptions from any active state:
  UNMATCHED   (no feasible driver — admin escalation)
  REQUEUED    (driver rejected / offer expired / breakdown)  → back to QUEUED
  NO_SHOW     (guest absent after wait timer)
  CANCELLED   (admin only)
```

**Driver**

```
OFFLINE → AVAILABLE → OFFERED → EN_ROUTE_TO_PICKUP → AT_PICKUP → ON_TRIP → AVAILABLE
                         │(reject/expire)→ AVAILABLE
AVAILABLE ⇄ ON_BREAK
any → UNAVAILABLE  (breakdown / admin-marked)   any → OFFLINE (shift end)
```

### 6.4 Invariants — a violation is a defect, each is unit-tested

| ID | Invariant |
|---|---|
| INV-1 | For every trip, at every point of its stop sequence: `Σ group_size ≤ seat_capacity` **and** `Σ luggage_count ≤ luggage_capacity` |
| INV-2 | A `QUEUED` request may not coexist with an `AVAILABLE` driver unless a typed infeasibility reason is recorded for that pair in this matching round |
| INV-3 | A driver in `OFFERED` / `EN_ROUTE` / `AT_PICKUP` / `ON_TRIP` / `ON_BREAK` / `UNAVAILABLE` is never offered a *new independent* trip — only a detour insertion into the current trip |
| INV-4 | A request's `passed_over_count` may not exceed 3 (§11 FR-M8 forces it to the front after that) |
| INV-5 | Exactly one active trip per driver at any time |
| INV-6 | No trip state transition occurs except through the server-side state machine; clients never write state directly |

---

## 7. Event Timeline (drives destination logic — G4)

| Phase | Window | Dominant trip type | Demand shape |
|---|---|---|---|
| **P1 Arrival** | T−2 days → T0 | `ARRIVAL` | Spiky — flight/train clusters, some at 02:00 |
| **P2 Event morning** | each event day AM | `TO_VENUE` | **Massive simultaneous surge, one shared destination** → handled as waves (§11.2) |
| **P3 Event day** | during sessions | `AD_HOC` | Trickle, admin-approved |
| **P4 Event evening** | session end | `FROM_VENUE` | **Massive simultaneous surge, many destinations** → pooled by accommodation |
| **P5 Departure** | last day → T+2 days | `DEPARTURE` | Hard-deadline driven, spread out |

The engine reads the current phase to choose destination defaults and which dispatch mode to use.

---

## 8. Functional Requirements — Guest App

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-G1 | **Login** | Phone number + OTP. **No signup form** — the guest record already exists (admin-loaded); an unknown number sees "Contact the event desk". |
| FR-G2 | **Home = one trip card** | Opening the app shows the current or next trip: type, pickup point + instruction text + map pin, scheduled time, destination, group size, luggage count. ≤ 2 taps to "where is my ride". |
| FR-G3 | **"I have arrived / I am ready"** | One large primary button. Sets `ready_at = now` and moves the request `QUEUED`. This is the demand trigger. |
| FR-G4 | **Auto-queue fallback** | If the guest never taps, the system auto-queues the request at `scheduled_time + 20 min` (§12) so a guest who never opens the app is still served. |
| FR-G5 | **Match notification** | On assignment: push + in-app showing driver name, vehicle number, vehicle type, driver phone, live ETA. **No driver list, no choice, no reject.** |
| FR-G6 | **Live tracking** | Map with driver's live position and route line; refreshing ETA. **Numeric ETA is always visible even if the map fails to load.** |
| FR-G7 | **Progress states** | `Finding your ride` → `Driver assigned` → `Arriving in N min` → `Driver has arrived` → `On the way to <destination>` → `Completed`. |
| FR-G8 | **Shared-ride transparency** | If pooled: "Shared ride · 2 co-passengers · 1 stop before yours", with the resulting ETA. |
| FR-G9 | **Ad-hoc ride request** | Fields: from, to, when (now / later), people, luggage, reason. Submits to **admin approval** — never straight to the engine. Blocked if the guest already has one pending. |
| FR-G10 | **Pending / declined state** | `Request pending approval` → `Approved — finding your ride` or `Declined — <admin's reason>`. |
| FR-G11 | **Honest no-driver state** | When no driver is feasible: "Arranging your ride — our team has been notified", **never an infinite spinner**. |
| FR-G12 | **Itinerary** | Simple list of the guest's upcoming trips for the event (auto-generated, §11.2). |
| FR-G13 | **Help** | One-tap call to the ops helpdesk number, visible in every state. |
| FR-G14 | **Degraded network** | Shows last cached driver/ETA with a "last updated hh:mm" stamp instead of a blank screen. |
| FR-G15 | **No self-cancel** | Guest has no cancel button. A "I no longer need this ride" action raises a note to admin, who cancels. Prevents dispatch thrash. |

---

## 9. Functional Requirements — Admin/Ops Role

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-A1 | **Live ops map** | Every driver on one map, colour-coded by status, labelled with current trip. Refresh ≤ 10 s. |
| FR-A2 | **Driver list & detail** | Status, vehicle, capacity, current trip, `predicted_free_at` + predicted free location, break state, driving minutes today. |
| FR-A3 | **Guest board** | Tabs/columns: `Waiting` (sorted by wait desc), `Assigned`, `In transit`, `Completed`, `Exceptions`. |
| FR-A4 | **Wait-time alerting** | Queued > 15 min → warning; > 30 min → critical, pinned to the top of the screen. |
| FR-A5 | **Ad-hoc approval queue** | Pending requests with guest context; **Approve** → hands to the engine (admin does *not* pick the driver); **Decline** → reason required, shown to the guest. |
| FR-A6 | **Manual driver onboarding** | Create/edit driver: name, phone, vehicle number, vehicle type, seat capacity, luggage capacity, shift window. No self-signup exists anywhere in the system. |
| FR-A7 | **Manual guest management** | Create walk-in guest; edit arrival/departure time, mode, accommodation, group size, luggage, VIP flag. Any edit re-plans that guest's **unstarted** trips automatically. |
| FR-A8 | **Bulk guest import** | CSV upload with validation report (row-level errors, no partial-garbage import). Needed to reach realistic volume. |
| FR-A9 | **Manual override** | Force-assign a specific driver; unassign; reassign; cancel; mark driver `UNAVAILABLE` (breakdown). **Reason mandatory, logged, and it must work even when the engine is down.** Overridden assignments are pinned — the engine will not re-optimise them away. |
| FR-A10 | **Upcoming trips board** | Next N hours of planned trips with a planned-vs-live drift indicator. |
| FR-A11 | **Exception queue with reasons** | Every `UNMATCHED` request shows a typed reason — `NO_CAPACITY` / `ALL_DRIVERS_BUSY_UNTIL_hh:mm` / `DEADLINE_INFEASIBLE` / `ALL_DRIVERS_ON_BREAK` / `NO_DRIVER_ONLINE` — plus suggested actions (split group, add fleet, delay). |
| FR-A12 | **Wave management** | Create/edit shuttle waves for `TO_VENUE` and `FROM_VENUE` (origin, destination, departure time, guest allotment). One-click "dispatch wave now". |
| FR-A13 | **Batch plan control** | Run the pre-day batch assignment, preview the proposed plan, publish it. Re-runnable and idempotent. |
| FR-A14 | **Demand-vs-supply signal** | Queued guests + seats needed vs available seats in the next 30 / 60 min, so ops can escalate the fleet **before** the queue explodes. |
| FR-A15 | **Event configuration** | POIs, phase schedule, and every threshold in §12, editable in the UI. |
| FR-A16 | **Audit trail** | Per-guest and per-driver chronological event log (who / what / when / why). |

---

## 10. Functional Requirements — Driver Role

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-D1 | **Login** | Phone + OTP, or credentials issued by admin. Driver-role token only. |
| FR-D2 | **Go online / offline** | Explicit duty toggle. Only `AVAILABLE` drivers are considered by the engine. |
| FR-D3 | **Exactly one trip at a time** | One trip card. **No queue, no other drivers, no guest list, no admin dashboard** — enforced server-side (§5.1). |
| FR-D4 | **Trip card content** | Pickup point + instruction text, guest name(s), guest count, luggage count, destination, target arrival time, "Open in Maps" deep link. |
| FR-D5 | **Accept / reject** | Accept → proceed. Reject → reason required; request re-queued with **raised priority**; that driver is cooled down for that request (§12). Offer auto-expires after 60 s = auto-reject + reassign. After 2 consecutive rejects, admin is alerted. |
| FR-D6 | **Status updates** | `Start` → `Arrived at pickup` → `Guest boarded` → `Arrived at drop` = `Completed`. These timestamps compute halt time and `predicted_free_at`. |
| FR-D7 | **Live location** | Shared continuously while on a trip (5 s), and while online-idle (30 s). Nothing sent while offline. Visible only to admin and the assigned guest. |
| FR-D8 | **Detour notification** | If the engine inserts a stop, the card shows the updated ordered stop list with a **"New stop added — +N min"** banner. |
| FR-D9 | **Break management** | Driver sees driving minutes today and next eligible break window. Can request a break — auto-granted if the queue allows, else admin-granted with a promised time. `ON_BREAK` drivers are not assignable. The engine also **schedules breaks proactively**, preferring demand troughs. |
| FR-D10 | **Shift strip** | Read-only strip: shift end time + next break window. **No upcoming trip list** (keeps the "one trip at a time" rule intact). |
| FR-D11 | **Guest no-show** | 10 min after `Arrived at pickup`, a `Guest not found` action appears → admin notified, driver released immediately, request `NO_SHOW`. |
| FR-D12 | **Report problem** | Breakdown / road block / fuel → driver `UNAVAILABLE`, in-progress requests re-queued at top priority **using the driver's live position as the new origin**, admin alerted. |
| FR-D13 | **Low-literacy usability** | Large touch targets, icon + text, exactly one dominant action per screen, English-only strings but externalised for future translation. |

---

## 11. Functional Requirements — Matching & Dispatch Engine

The evaluated core. **One cost function, three entry points** — this is the central simplification of the design.

### 11.1 Three entry points, shared scorer

| ID | Mode | When | How |
|---|---|---|---|
| FR-M1 | **Batch plan** | Pre-day / on admin trigger, for all requests with known times | Build a cost matrix of feasible (driver × request) pairs and solve as a linear assignment problem; then run the pooling pass. Produces a publishable plan with planned pickup times. Idempotent, re-runnable. |
| FR-M2 | **Real-time incremental** | New / approved / re-queued request between batches | Filter to feasible drivers → score with **the same cost function** → assign the best. ≤ 5 s p95. |
| FR-M3 | **Re-optimisation tick** | Every 90 s, plus on triggers (driver reject, breakdown, guest edit, traffic drift, new arrival cluster) | Recompute the **pending set only** — requests not yet accepted by a driver. Accepted trips are locked (detour insertion is the only allowed change). No plan-diffing machinery needed. |

**Why one scorer:** batch and real-time differ only in *how many pairs they consider*, not in *what "good" means*.
One function to write, one function to test, one function to explain in the design document.

### 11.2 Wave dispatch — how the venue surge is handled

`TO_VENUE` and `FROM_VENUE` are **not** individually hailed rides; 200 guests share one destination in one
30-minute window. That is a shuttle problem.

| ID | Requirement |
|---|---|
| FR-M4 | A **wave** is a set of auto-generated `TripRequest`s sharing the same origin, destination and `ready_at`. **It is not a new entity** — it is a `wave_id` tag on existing requests, so the entire pooling/assignment pipeline is reused unchanged. |
| FR-M5 | For each event day and accommodation, the system auto-generates `TO_VENUE` waves from the event schedule (e.g. 08:00 / 08:30 / 09:00), allots guests to a wave, and shows each guest their wave time in the itinerary (FR-G12). |
| FR-M6 | The engine assigns vehicles to a wave capacity-first: seats needed ÷ available capacity, largest vehicles first, until the wave's guests are covered. Shortfall → FR-M12 escalation. |
| FR-M7 | `FROM_VENUE` uses **guest-pull, not schedule-push**: the guest taps "ready to leave", and requests are pooled by accommodation over a rolling 10-minute window. Admin can also fire a manual wave (FR-A12) for a session end. |
| FR-M8 | A guest who misses their wave falls back to **normal individual matching** — no special-case code path. |

### 11.3 Hard constraints — violation = defect

| ID | Constraint |
|---|---|
| FR-M9 | Seats and luggage never exceeded, at every stop of every trip (INV-1). |
| FR-M10 | Hard deadlines (`TO_VENUE`, `DEPARTURE`) met with the §12 buffer, or the request becomes `UNMATCHED` with a reason. **Never silently late.** |
| FR-M11 | A driver is assignable only if `AVAILABLE` (or predicted free in the required window), inside shift hours, and not due a mandatory break. |
| FR-M12 | **Anti-starvation:** effective priority grows with waiting time; and if a request is passed over in favour of a lower-priority newer request 3 times, it is forced to the front of the queue (INV-4). |
| FR-M13 | Detour insertion may not push **any** committed guest past their deadline, nor add more than +10 min to any onboard guest's journey. |

### 11.4 Behaviour

| ID | Requirement |
|---|---|
| FR-M14 | **Priority ordering:** hard-deadline urgency → VIP → aging (wait time) → group size → FIFO tiebreak. All weights come from §12. |
| FR-M15 | **Pooling / clustering:** requests are pooled when they share a pickup point, fall inside a ±15 min window, and share a destination cluster — same accommodation, or two accommodations within 2 km / 5 min drive. **Max 2 drop stops per trip** so route sequencing stays trivial. VIP guests are never pooled. |
| FR-M16 | **Group splitting:** a party larger than the largest available vehicle is split into linked sub-requests (`group_ref`), dispatched as close to simultaneously as feasible. **Max 2 vehicles automatically**; beyond that it escalates to admin. Guest is told "your group travels in 2 vehicles"; admin sees it as one group. |
| FR-M17 | **Fleet-shortfall escalation:** when demand cannot be met, raise an admin alert quantifying the gap — *"18 guests / 46 seats short in the next 40 min"*. |
| FR-M18 | **Opportunistic detour insertion, including in-progress trips:** using the driver's **live position**, evaluate inserting one extra pickup/drop into an active trip's stop sequence (cheapest-insertion), subject to FR-M13 and remaining capacity. **Limit: one inserted stop per active trip** — bounds the search and keeps the driver's screen understandable. Works for `ON_TRIP` drivers, not only unstarted trips. |
| FR-M19 | **Traffic-aware ETAs:** live-traffic routing is used for ETA display and for deadline feasibility near hard deadlines, recomputed on the 90 s tick and pushed to guest and admin. |
| FR-M20 | **Deadhead minimisation:** cost penalises empty travel time to pickup; prefer drivers whose predicted free location is near the next pickup. |
| FR-M21 | **Break-aware planning:** mandatory break windows are unavailability blocks in planning; the engine prefers to place breaks in demand troughs rather than during a surge. |
| FR-M22 | **Soft reservation:** for a **hard-deadline** request starting within the next 20 min, the engine may hold a driver idle rather than send them on a long soft trip. Deliberate trade-off: a little idle time to protect deadlines. Only for hard deadlines, so G2 is not undermined. |
| FR-M23 | **Explainability:** every assignment stores its score breakdown and the runner-up driver; every non-assignment stores a typed infeasibility reason. Powers FR-A11, the G2 audit, and debugging. |
| FR-M24 | **Concurrency safety:** assignment is transactional with optimistic locking on driver state; concurrent runs can never double-book a driver (INV-5). Matching rounds do not overlap — a round in progress makes the next tick a no-op. |
| FR-M25 | **Automation boundary:** the engine never asks a human which driver to use. Admin approval gates *entry* into the engine, not the allocation. |
| FR-M26 | **Timer-driven transitions use one periodic sweeper** (offer expiry, no-show timer, auto-queue fallback, break due, SLA breach) rather than per-entity scheduled jobs. One cron-like loop, easy to reason about and to restart. |

### 11.5 Cost function

```
cost(driver d, request r) =
      w_deadhead * travel_time(d.predicted_free_location → r.origin)   # driver efficiency, anti-deadhead
    + w_wait     * expected_guest_wait(r)                              # guest experience
    + w_late     * lateness_risk(r.deadline_at)                        # SLA protection
    + w_detour   * added_delay_to_already_committed_guests(d, r)       # fairness to onboard guests
    + w_waste    * capacity_waste(d, r)                                # don't send a 12-seater for 1 guest
    + w_break    * break_pressure(d)                                   # driver welfare
    - w_pool     * pooling_bonus(r shares destination cluster with d's load)
    - w_age      * waiting_minutes(r)                                   # anti-starvation
    - w_vip      * is_vip(r)

subject to (hard filter, applied before scoring):
    capacity ok · inside shift · not on/needing break · deadline reachable · not cooled-down for this request
```

Default weights are in §12 and are admin-editable, so tuning during the demo requires no code change.

---

## 12. Configuration Defaults — every magic number lives here

One `event_config` record. Admin-editable (FR-A15). No threshold is hard-coded anywhere in the codebase.

| Key | Default | Meaning |
|---|---|---|
`guest_wait_warn_min` | 15 | Warning threshold, measured from `ready_at`
`guest_wait_critical_min` | 30 | Critical alert threshold
`auto_queue_fallback_min` | 20 | Auto-queue a scheduled guest who never taps "arrived"
`offer_expiry_sec` | 60 | Driver offer auto-rejects after this
`driver_reject_cooldown_min` | 15 | That driver isn't re-offered the same request within this window
`consecutive_rejects_alert` | 2 | Alert admin after this many rejects in a row
`no_show_wait_min` | 10 | Driver wait at pickup before "guest not found" appears
`pool_time_window_min` | ±15 | Two requests may share a vehicle within this window
`pool_cluster_radius_km` | 2 | Two accommodations count as one destination cluster
`pool_max_drop_stops` | 2 | Max drop stops per trip
`detour_max_added_min` | 10 | Max extra time for an already-onboard guest
`detour_max_inserted_stops` | 1 | Max stops inserted into an active trip
`airport_departure_buffer_min` | 150 | Must reach airport this long before flight
`station_departure_buffer_min` | 45 | Must reach station this long before train
`venue_arrival_buffer_min` | 15 | Must reach venue this long before session start
`break_after_driving_min` | 240 | Mandatory break trigger (continuous driving)
`break_after_trips` | 6 | Alternative break trigger
`break_duration_min` | 30 | Break length
`max_duty_hours` | 10 | Hard stop for a driver's day
`reoptimise_tick_sec` | 90 | Re-optimisation loop interval
`reservation_horizon_min` | 20 | Hold a driver for a hard-deadline request inside this horizon
`max_passed_over_count` | 3 | Then the request is forced to the front (INV-4)
`auto_split_max_vehicles` | 2 | Beyond this, escalate to admin
`location_ping_on_trip_sec` | 5 | Driver location interval while on trip
`location_ping_idle_sec` | 30 | While online but idle
`candidate_topk_for_live_eta` | 5 | Only this many candidates get a live-traffic call
`ops_helpdesk_phone` | *(configured)* | Shown to guests and drivers everywhere
`w_*` weights | see §11.5 | Cost function tuning without a deploy

---

## 13. Non-Functional Requirements

| ID | Requirement | Target / method |
|---|---|---|
| NFR-1 | **Scale** | 10–100 drivers, 300–500 guests, one event. Designed peak: 80 guests becoming ready inside 60 min |
| NFR-2 | **Latency** | Ad-hoc match ≤ 5 s p95 · admin map refresh ≤ 10 s · guest ETA refresh ≤ 15 s · batch of 300 requests ≤ 60 s |
| NFR-3 | **Reliability & degradation ladder** | **(1)** Routing API down → fall back to the cached static distance matrix + straight-line-with-factor ETA, flagged "estimated". **(2)** Engine down → in-progress trips continue (state is in the DB, driver app works), new requests queue durably and drain on recovery, **admin override always available**. **(3)** Push down → in-app state still updates. Every level is documented and manually demonstrable |
| NFR-4 | **External API efficiency** | (a) POI×POI static distance matrix pre-computed **once** and cached — airport/station × accommodations × venue; (b) live-traffic calls only for **active trips** and the **top-5 candidates** per request; (c) Distance Matrix calls batched; (d) adaptive location ping (§12); (e) route polylines cached per stop-pair with a short TTL. **API call count per matching round is logged and asserted in tests** |
| NFR-5 | **Usability** | Guest: zero onboarding, ≤ 2 taps to "where is my ride". Driver: one dominant action per screen, works on low-end Android |
| NFR-6 | **Security / RBAC** | Server-side role **and** row-level checks on every endpoint; audit log append-only; driver cannot read another driver's trip; guest cannot read another guest |
| NFR-7 | **Observability** | Structured log of every matching decision (score breakdown + runner-up + rejections with reasons); metrics: queue length, wait p50/p95/max, idle-driver-minutes-while-queue-non-empty, capacity violations, deadline misses, external API calls |
| NFR-8 | **Data integrity** | One source of truth for trip state; all transitions validated against §6.3; clients never author state |
| NFR-9 | **Time** | Store UTC, display event-local. Single event timezone |
| NFR-10 | **Privacy** | Guest sees driver's name + phone. **Driver sees guest name only, no phone** — contact goes through the ops desk. Driver location retained for the event window + audit period only |

---

## 14. Edge Cases — all must be demonstrable

| # | Scenario | Required behaviour |
|---|---|---|
| E1 | No feasible driver | `UNMATCHED` + typed reason + critical admin alert + honest guest state (FR-G11) |
| E2 | Driver rejects | Re-queue with raised priority + 15 min cooldown for that pair; admin alerted on the 2nd consecutive reject |
| E3 | Offer ignored | Auto-reject at 60 s, immediate reassignment |
| E4 | Guest no-show | 10 min timer → `NO_SHOW`, driver released instantly for the next assignment |
| E5 | Breakdown mid-trip | Driver `UNAVAILABLE`; onboard requests re-queued at top priority **with the driver's live position as the new origin**; guest told "reassigning your ride" |
| E6 | Flight delayed 3 h | Admin edits arrival time → unstarted trip re-planned, any reserved driver released |
| E7 | Walk-in guest | Admin creates guest + request → normal engine flow, no special path |
| E8 | Group of 9, biggest vehicle seats 6 | Split 6 + 3, linked, dispatched together, visible as one group to both sides |
| E9 | Three flights land together | Batch clustering by accommodation + pooling + demand-vs-supply escalation; queue drains by priority + aging with **no starvation** |
| E10 | Traffic collapse doubles venue ETA | Re-optimisation flags deadline risk, reassigns unstarted trips, pushes new ETAs, alerts admin if unrecoverable |
| E11 | Two accommodations in opposite directions | Cluster rule prevents pooling them; destination correctness verified per trip type |
| E12 | Mid-trip detour opportunity | Driver en route, 2 of 6 seats used, passes a queued single guest with the same destination → inserted only if added delay ≤ 10 min and capacity allows |
| E13 | Driver hits 4 h driving | Break scheduled, driver excluded from assignment, admin sees the reason |
| E14 | Guest has no network | Cached last-known state with "last updated hh:mm" |
| E15 | Engine restarts mid-event | Queue and assignments rebuilt from the DB; no duplicates; in-progress trips untouched |
| E16 | Admin overrides an assignment | Pinned — the engine will not re-optimise it away; both decisions logged |
| E17 | Guest no longer needs the ride | No self-cancel; note goes to admin, admin cancels, driver released |
| E18 | Duplicate ad-hoc request | Blocked while one is pending for that guest |
| E19 | Session over-runs by 40 min | Admin shifts the `FROM_VENUE` wave; guest-pull model absorbs it naturally |
| E20 | Driver goes offline mid-trip (app killed) | Trip stays active with last-known location + stale-location warning to admin; admin can override-reassign |

---

## 15. Notification Matrix

| Event | Guest | Driver | Admin |
|---|---|---|---|
| Assignment made | push: driver, vehicle, ETA | push: new trip offer | dashboard |
| Driver accepted | push: "driver on the way" | — | dashboard |
| Driver rejected / expired | silent (stays "finding your ride") | — | alert on 2nd consecutive |
| Driver arrived | push + call prompt | — | dashboard |
| Detour stop added | push: updated ETA | push: new stop + added minutes | dashboard |
| Ad-hoc request raised | in-app pending state | — | **action-required alert** |
| Approved / declined | push (with reason if declined) | — | — |
| Wait SLA breached | — | — | **critical alert** |
| Unmatched / fleet shortfall | honest waiting state | — | **critical alert with quantified gap** |
| Break due / granted | — | push | dashboard |
| Breakdown reported | push: "reassigning your ride" | — | **critical alert** |
| Wave dispatched | push: wave time + vehicle | push: trip offer | dashboard |

---

## 16. Decision Log — every ambiguity in the brief, resolved

Format: **decision → why → what it saves the developer.**

### 16.1 Demand & trip generation

| ID | Decision | Reason / dev benefit |
|---|---|---|
| D1 | **Guest tap is the dispatch trigger; auto-queue at `scheduled_time + 20 min` as fallback.** | Tap alone strands guests who never open the app; time alone wastes vehicles on delayed flights. The fallback is one sweeper rule (FR-M26), not a new subsystem. |
| D2 | **`TO_VENUE` = auto-generated waves; `FROM_VENUE` = guest-pull pooling.** | 200 guests to one destination is a shuttle, not 200 hails. Modelling it as `wave_id` on existing requests means **zero new entities and zero new pipeline** — pooling code is reused. |
| D3 | **Departure pickup time computed from flight/train time − buffer**, admin-overridable per guest. | Makes departures a deadline optimisation the engine already understands, instead of a booking-slot feature. |
| D4 | **Multi-day trips auto-generated** from event schedule + guest's accommodation; admin can edit instances. | Ops staff would never hand-create 200 × 3 trips. Generation is one seed job. |
| D5 | **Arrival/departure data is always manual** (admin edit or guest tap). No flight/train status API. | The brief puts auto-detect out of scope. Removes an unreliable integration, a polling job, and a whole class of sync bugs. |

### 16.2 Guest experience

| ID | Decision | Reason / dev benefit |
|---|---|---|
| D6 | **No guest self-cancel** (request-to-admin instead). | Prevents dispatch thrash at a private event; removes cancel-window/race handling from the engine. |
| D7 | **Buffers: airport 150 min, station 45 min, venue 15 min** — configurable. | Standard practice; deadlines become simple arithmetic on one config value. |
| D8 | **Wait SLA measured from `ready_at`, not from assignment.** | Measuring from assignment would hide exactly the failure we are asked to prevent. Honest metric, single timestamp. |
| D9 | **Guest sees driver's phone; driver sees guest name only.** | Guest needs to find their car; driver doesn't need guest contact. **Avoids building call-masking infrastructure entirely.** |
| D10 | **Driver's "guest boarded" tap is authoritative**; no guest-side confirmation. | Two-sided confirmation doubles the failure modes and adds a screen for a tired guest at 02:00. |
| D11 | **Shared rides are disclosed** (co-passenger count + stops before yours). | Prevents "why are we going the wrong way" support calls; one string on an existing screen. |
| D12 | **VIP flag is admin-only.** | Self-elevation would break fairness. One boolean, no approval workflow. |

### 16.3 Driver experience

| ID | Decision | Reason / dev benefit |
|---|---|---|
| D13 | **Current trip only**, plus a read-only shift/break strip. | Satisfies the brief's "one at a time" rule and keeps the driver API to a single `GET /me/current-trip`. |
| D14 | **Free reject with a reason; 60 s expiry; alert admin after 2 consecutive.** | Respects real drivers while making abuse visible. Expiry is handled by the same sweeper as every other timer. |
| D15 | **Break: 30 min after 4 h driving or 6 trips; 10 h duty cap.** | The brief explicitly asks for driver breaks. Two counters on the driver record — no timesheet subsystem. |
| D16 | **No-show: 10 min wait, then driver is released.** | Bounds the worst case: one guest cannot idle a vehicle indefinitely. |
| D17 | **Background location required only while on an active trip**; best-effort when merely online, with a "keep the app open" instruction. | Reliable background tracking is the single biggest mobile time-sink. Scoping it to active trips keeps it achievable and honest. |
| D18 | **English only**, strings externalised. | Translation is a content task, not an architecture task. |
| D19 | **1 driver = 1 vehicle** (vehicle as fields on the driver). | Removes an entity, a join, and vehicle-assignment UI. Vehicle swap = admin edits the record. Listed in §17 as a limitation. |
| D20 | **Driver offers are push + in-app; no phone-call fallback.** | Out of scope for a software deliverable; the ops helpdesk number covers the human fallback. |

### 16.4 Matching policy

| ID | Decision | Reason / dev benefit |
|---|---|---|
| D21 | **One cost function, three entry points** (batch / real-time / re-optimise). | The single most valuable simplification: one thing to write, test, tune and explain. |
| D22 | **Re-optimisation recomputes only the pending set; accepted trips are locked.** | No plan-diff engine, no driver-facing churn. Reassignment of an accepted trip only via admin override or breakdown. |
| D23 | **Pooling: same pickup point, ±15 min, destination cluster ≤ 2 km, max 2 drop stops, VIP never pooled.** | Capping drop stops at 2 makes stop ordering trivial (no TSP), while still demonstrating multi-accommodation handling. |
| D24 | **Detour insertion: max 1 inserted stop per active trip, +10 min cap per onboard guest.** | Bounds the insertion search to a linear scan of positions — cheap enough to run on the 90 s tick, and the driver's screen stays comprehensible. |
| D25 | **Soft reservation only for hard-deadline requests within 20 min.** | Protects `TO_VENUE`/`DEPARTURE` deadlines without letting the engine idle drivers in general (which would violate G2). Documented as an explicit trade-off. |
| D26 | **Anti-starvation = aging bonus + hard force-to-front after 3 pass-overs.** | An aging weight alone is tunable-and-therefore-breakable. The counter makes starvation *provably* impossible and unit-testable (INV-4). |
| D27 | **Oversized groups auto-split into max 2 vehicles**, then escalate. | Covers the realistic case (family of 8) without building an n-way convoy coordinator. |
| D28 | **No feasible driver → typed `UNMATCHED` reason + admin alert + honest guest copy.** | Turns the worst case into visible, actionable ops information instead of a silent failure. The typed reason directly powers FR-A11. |
| D29 | **Batch = LAP/Hungarian-style 1:1 assignment, then a greedy pooling pass.** | At 100 × 500 this is milliseconds and fully explainable. A full VRP solver is deferred (§17) because its marginal gain is small next to its complexity and debugging cost. |
| D30 | **Weights live in config, not code.** | Tuning during the demo requires no deploy. |

### 16.5 Operations & platform behaviour

| ID | Decision | Reason / dev benefit |
|---|---|---|
| D31 | **CSV bulk import for guests; drivers stay manual-form.** | The brief mandates manual driver onboarding; guests need volume for a credible demo. |
| D32 | **All timers via one periodic sweeper**, not per-entity scheduled jobs. | Survives restarts trivially, no job-queue reconciliation, one place to debug all time-based behaviour. |
| D33 | **All thresholds in one config record (§12).** | No magic numbers scattered in the code; the whole system is tunable from one screen. |
| D34 | **Routing behind a provider interface with a cached/mock implementation.** | Tests and the simulation run with zero API spend, and the provider can be swapped without touching the engine. Directly serves NFR-4. |
| D35 | **Manual override must work even when the engine is down.** | It is the last line of defence on event day (G7); therefore it is a plain DB write path, independent of the engine. |
| D36 | **Audit log is append-only and covers every state change.** | Needed to *prove* G2/G5 to an evaluator, and it is the cheapest debugging tool during the peak-scenario demo. |

---

## 17. Accepted Limitations (deliberate, documented in the README)

1. One driver is bound to one vehicle for the whole event; vehicle swaps are an admin edit, not a modelled handover.
2. Pooling caps at 2 drop stops and detours at 1 inserted stop — near-optimal in practice, not globally optimal.
3. Batch planning is linear assignment + greedy pooling, not a full VRP solver; the interface is left open for one.
4. No live flight/train status ingestion — arrival changes are manual.
5. Background driver location is guaranteed only during an active trip.
6. No offline mode; apps degrade to cached last-known state.
7. Single event, single timezone, single city, road travel only.
8. Luggage is a count of standard pieces, not volume or weight.
9. No payments, ratings, or driver payouts.
10. Guest cannot self-cancel; ops must action it.

---

## 18. Build Order

Assumption (stated because no deadline was given): **a ~2-week build window.** If it is shorter, cut strictly from
the bottom of P1, then P2 — never from P0.

**P0 — the system must be judged on this**
Guest: login, trip card, "I'm ready", live track, honest states · Driver: login, online toggle, one-trip card,
accept/reject, status updates, live location · Admin: live map, driver list, guest board, ad-hoc approve/decline,
driver onboarding, guest CRUD, manual override, exception queue with reasons · Engine: real-time matching with the
full cost function, capacity, priority + aging + force-to-front, hard deadlines, typed unmatched reasons ·
RBAC enforced server-side · seed data + peak simulation + metrics · design document.

**P1 — the scoring criteria name these explicitly, so they follow immediately**
Mid-trip detour insertion (FR-M18) · pooling & destination clusters (FR-M15) · wave dispatch for venue surges
(FR-M4–M8) · traffic-aware re-optimisation tick (FR-M3, FR-M19) · pre-day batch plan (FR-M1) · break scheduling
(FR-M21) · push notifications · CSV import.

**P2 — polish**
Group-split UX, demand-vs-supply forecasting, metrics dashboard, audit-log UI, i18n scaffolding.

> Detour insertion, multiple accommodations and live-traffic handling are named in the evaluation criteria — if
> time is tight, they are the **last** things to cut, before anything in P2.

---

## 19. Demonstrability — how each goal gets proved

The scoring criteria include *"overall responsiveness under a simulated peak-arrival scenario"*, so the build
includes the harness to produce that.

1. **Seed dataset** — 1 event · airport + railway station · 1 venue · 3 accommodations · ~40 drivers with mixed
   seat/luggage capacities · ~200 guests with staggered arrivals and a few VIPs and large groups.
2. **Simulation harness** — fast-forwardable clock, virtual drivers that move along routes and emit positions, and a
   burst generator (80 guests becoming ready inside 30 min). Runs against the cached/mock routing provider (D34), so
   it costs nothing to run repeatedly.
3. **Metrics report** printed per run — wait p50/p95/max · starvation check (max `passed_over_count`) ·
   idle-driver-minutes while the queue was non-empty · **capacity violations (must be 0)** · deadline misses ·
   external API calls used.
4. **Test suite** — engine invariant tests (INV-1…INV-6), RBAC authorisation tests (driver token → 403 on admin
   routes and on another driver's trip), one end-to-end happy path.
5. **Design document** — algorithm, cost function, trade-offs, limitations (a required deliverable).

---

## 20. Deliverables Checklist

- [ ] Guest mobile app
- [ ] Admin Portal with Admin/Ops + Driver roles, RBAC enforced server-side
- [ ] Backend service with the matching / dispatch engine
- [ ] Design document: algorithm, cost function, trade-offs, limitations
- [ ] README: local setup, architecture overview, matching algorithm explanation, known trade-offs
- [ ] Seed data + peak-arrival simulation + metrics output
- [ ] Public GitHub repository
- [ ] Google Form submission

---

## 21. Deferred to the Solution Phase (not requirements)

These are *implementation* choices, intentionally not decided in a PRD. They are taken up in HLD, and none of them
blocks any requirement above.

Guest app framework · where the Driver role physically ships (portal shell vs mobile) · auth provider ·
maps/routing/traffic vendor · real-time transport · push delivery · backend language, database, cache/queue ·
optimiser library · hosting · background-location implementation · simulation implementation.

---

## 22. Next Step

**This PRD is frozen at v1.0 with no open questions.** Next: HLD — service decomposition, data flow, engine
architecture (the three entry points and the sweeper), external-API caching strategy, the degradation ladder, and
deployment topology. Then LLD: schema, API contracts, engine pseudocode, transition tables, screen specs, test plan.
