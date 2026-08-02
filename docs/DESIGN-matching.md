# Design Document — Matching & Dispatch Algorithm

**Deliverable 4:** the matching algorithm's approach and the key trade-offs made.
Companion docs: [PRD](PRD.md) · [HLD](HLD.md) · [LLD](LLD.md) · [Traceability](TRACEABILITY.md)

---

## 1. The problem, stated precisely

At every moment we hold a set of **demand** (guests who are ready, each with a group size, luggage
count, origin, destination and possibly a hard deadline) and a set of **supply** (drivers, each with
a seat and luggage capacity, a position, a shift window and an accrued driving-time debt).

We must repeatedly answer: **which driver serves which guests, and in what order** — such that

1. no vehicle is ever over capacity, at any point of its route,
2. no hard deadline is silently missed,
3. no guest is starved,
4. no driver idles while a guest they could serve is waiting,
5. and the decision arrives in seconds, not minutes.

This is a dynamic pickup-and-delivery problem with time windows. It is NP-hard in general. Everything
below is about getting decisions that are good enough, fast enough, and — crucially — *explainable*.

---

## 2. The shape of the solution

### 2.1 One cost function, three entry points

The single most important structural decision. Real-time matching, pre-day batch planning and the
periodic re-optimisation tick all call the **same** hard-feasibility filter and the **same** scoring
function. They differ only in how many `(driver, request)` pairs they consider:

| Entry point | Candidates | Algorithm |
|---|---|---|
| Real-time (one new request) | 1 × D | filter → score → best |
| Batch (a burst) | bundles × D | cluster-first bundling → Hungarian → greedy pooling → salvage |
| Re-optimise (every 90 s) | pending only | same batch path over unaccepted requests, plus detour insertion |

Why it matters: "a good assignment" means the same thing everywhere. There is one thing to tune, one
thing to test, one thing to explain. The alternative — a fast heuristic for live traffic and a
separate optimiser for batches — guarantees the two eventually disagree, and the disagreement shows
up as a guest who would have been served better if they had arrived at a different minute.

### 2.2 The engine is a pure function

```
runRound(snapshot) → { decisions[], rejections[], passedOverIds[] }
```

No database, no HTTP, no clock, no randomness. Everything it needs — including every travel time —
is resolved into the snapshot before it is called.

Four things follow, and each one is why the decision was made:

- **Invariants become property tests.** "Capacity is never violated" is asserted over 300 randomised
  fleets in milliseconds, with no infrastructure.
- **The simulator runs production logic.** The peak-arrival harness feeds a fake world to the *real*
  engine, so what the simulation proves is what production does.
- **An engine bug cannot corrupt state.** It emits a *proposal*; a transactional applier re-validates
  it against freshly-read rows and commits or skips.
- **A bad round is reproducible.** Same snapshot in, byte-identical decisions out.

### 2.3 Round order is part of the design

```
1. Reservations      hold a driver for an imminent hard deadline
2. Detour insertion  into trips ALREADY IN PROGRESS
3. Assignment        bundle → Hungarian → pool → salvage
4. Bookkeeping       pass-over counts, shortfall quantification
```

Detours run **before** new assignments deliberately: a vehicle already travelling that way beats
starting a fresh empty drive on *both* metrics we care about — the guest waits less (the car is
nearby) and the fleet idles less (no deadhead). Running assignment first would consume the free
drivers and leave the passing vehicle half empty.

---

## 3. The algorithms

### 3.1 Hard feasibility filter — before any scoring

A driver is a candidate only if: seats and luggage fit · inside shift hours · not on or owed a
mandatory break · the drop is reachable before a hard deadline · not cooling down from having
rejected this exact request.

The filter returns a **typed reason** rather than a boolean:

```
NO_DRIVER_ONLINE · ALL_DRIVERS_BUSY · NO_CAPACITY · DEADLINE_INFEASIBLE
ALL_DRIVERS_ON_BREAK · GROUP_TOO_LARGE · OUTSIDE_SHIFT_HOURS · COOLDOWN_ONLY_CANDIDATES
```

This is what turns "the system did nothing" into "no vehicle is large enough for this group — split
it or bring a bigger one on duty". Every rejection is persisted, so any non-assignment can be
explained afterwards.

### 3.2 Cost function

```
cost(d, r) =  w_deadhead · travel_time(d.free_location → r.origin)
            + w_wait     · expected_guest_wait
            + w_late     · lateness_risk(deadline)
            + w_detour   · added_delay_to_already_committed_guests
            + w_waste    · unused_seats
            + w_break    · break_pressure(d)
            − w_pool     · shares_destination_cluster
            − w_age      · minutes_already_waited
            − w_vip      · is_vip
```

Lower is better. Every weight lives in a config row, so tuning during an event needs no deploy. Each
assignment stores its full breakdown plus the runner-up driver.

The negative terms are the interesting half: aging and VIP status are expressed as *discounts* rather
than as a separate priority pass, which means a long-waiting guest can out-compete a marginally
closer pairing instead of waiting for a tiebreak that never comes.

### 3.3 Cluster-first bundling — pooling before assignment

Guests are grouped into vehicle-loads **before** any driver is chosen. Pooling as an afterthought
(assign 1:1, then squeeze leftovers in) collapses under a surge: the first round hands every
available driver a single guest, and everyone else queues behind full round trips while half the
seats in the fleet travel empty.

Bundling rules: same pickup point · within ±15 min · destinations in one cluster (same hotel, or two
within 2 km) · at most 2 drop stops · VIPs never pooled · a forced-to-front guest never pooled.

**Pooling is demand-aware**, which is the part I would defend hardest:

```
target load per vehicle = ceil(queued seats / available drivers)   capped at the modal vehicle size
```

With 40 guests and 40 drivers the target is 1 — **it pools nothing**, because sharing would only make
rides slower and leave drivers idle. With 200 guests and 40 drivers it packs up to capacity. Pooling
is a response to scarcity, not a virtue in itself. (I got this wrong first: unconditional bundling
produced 10 four-seat trips and left 30 drivers parked. The simulation's idle-driver metric caught it.)

Bundles are capped at the **modal** vehicle capacity, not the largest. Capping at the largest builds
12-seat loads that only two vehicles in the fleet can take, and those guests then queue behind them.

### 3.4 Hungarian algorithm for the 1:1 layer

Bundles × drivers becomes a cost matrix, solved with the Jonker–Volgenant shortest-augmenting-path
variant, O(n²m). At 100 × 100 it runs in single-digit milliseconds and is **provably optimal** for
the 1:1 layer — verified against a brute-force reference over 200 randomised matrices.

Two implementation details that matter:

- **Infeasible pairs use a large finite sentinel, not `Infinity`.** The algorithm accumulates row and
  column potentials, and `Infinity − Infinity` is `NaN`, which silently corrupts every subsequent
  comparison. Sentinel assignments are filtered out afterwards.
- **Forced-to-front rows carry a large negative offset.** Hungarian minimises *total* cost and is free
  to ignore the order rows were sorted in, so priority alone does not protect a starving guest — a
  cheap VIP can out-compete them. The offset makes any solution containing that row strictly cheaper.
  (This was a real bug: starvation protection worked on the incremental path and not the batch path.)

### 3.5 Detour insertion into live trips

For each active trip, using the driver's **live position**, we try inserting the new guest's pickup
and drop at every position *after* that position — so a vehicle is never asked to double back.
Cheapest insertion wins, subject to: remaining capacity at every stop, at most **+10 min** added for
any guest already aboard, no committed guest pushed past their deadline, at most **one** inserted stop
per trip per round, and never on an admin-pinned trip.

Bounding it to one inserted stop keeps the search a linear scan over ≤ 4 remaining stops, cheap
enough to run for every active trip on every 90-second tick — and keeps the driver's screen
comprehensible, which matters as much as the arithmetic.

### 3.6 Anti-starvation

Two mechanisms, deliberately layered:

1. `− w_age · minutes_waited` in the cost function — a gentle, tunable pull.
2. A **hard override**: once a request has been passed over 3 times it receives a `+1,000,000`
   priority bonus and outranks everything, including a VIP with a hard deadline 60 seconds away.

Why both: an aging weight alone is tunable and therefore breakable — someone lowers `w_age` for
throughput and starvation silently returns. The counter makes it structural and, more importantly,
*testable*: a property test asserts that a request at the limit is always served whenever any
feasible driver exists.

A pass-over is defined precisely as *a higher-priority request left queued while a lower-priority one
was served*. A counter climbing because the whole fleet is genuinely busy is scarcity, not starvation,
and the simulation gates on the former, not the latter.

### 3.7 Capacity as a prefix sum

Each stop carries `seats_delta` (`+n` at pickup, `−n` at drop). Capacity is valid iff the running sum
never exceeds the vehicle at any stop:

```ts
for (const stop of stops) {
  seats += stop.seatsDelta
  if (seats < 0 || seats > d.seatCapacity) return false
}
```

This catches the failure a per-request check cannot: two groups of 3 in a 4-seater, where neither
group alone violates anything but both are aboard between the two pickups. The same function is used
by the engine, by the applier's transaction, and by the tests — one implementation, three enforcement
points, so a single bug cannot produce a capacity violation. The database backstops it with a unique
index.

---

## 4. Key trade-offs

| Decision | What we gain | What we give up |
|---|---|---|
| **Hungarian + greedy pooling instead of a full VRP solver (OR-Tools)** | Millisecond rounds, provable optimality on the 1:1 layer, an algorithm explainable in a paragraph, no solver dependency | Global optimality across the *pooled* problem. A VRP would find better multi-stop routes. `planBatch()` is the seam where one could be dropped in |
| **Max 2 drop stops per pooled trip** | Stop ordering is trivially pickup-order — no travelling-salesman step, no route-permutation search | Genuinely efficient 3–4 stop shuttle routes are unreachable |
| **Max 1 inserted stop per trip per round** | Linear-scan insertion, cheap on every tick; a driver's screen never mutates confusingly | A vehicle that could absorb two nearby guests takes them over two rounds |
| **Accepted trips are locked** | Drivers are never yanked between guests; no plan-diff machinery | A later, better global arrangement cannot be applied. Only detour insertion, admin override or a breakdown can change an accepted trip |
| **Soft reservation only for hard deadlines, 20-min horizon** | Protects venue and departure deadlines | Deliberately idles a driver for up to 20 min. Kept narrow (only when the upcoming request has exactly one feasible driver) so it cannot become general-purpose idling |
| **The engine is pure; routing is pre-resolved** | Testable, replayable, simulatable; API cost bounded in one place | The snapshot must over-fetch slightly — distances for candidates that scoring then discards |
| **Top-K = 5 candidates get live-traffic lookups** | Bounded, measurable API spend (≈4 upstream calls for a 200-guest event, 98.8% cache hit) | The 6th-nearest driver is scored on an estimate. In practice the ranking rarely changes |
| **Symmetric travel-time cache (A→B = B→A)** | Halves paid elements | Wrong on one-way systems and asymmetric traffic. Acceptable at 15-minute bucket granularity |
| **Re-planning from a full snapshot each round** | No incremental-state staleness bugs | Recomputes work every 90 s. At 100×500 this costs milliseconds, so the trade is free at this scale |
| **Demand-aware pooling** | No idle fleet at low demand, high throughput under surge | The pooling decision depends on fleet state, so identical requests can be pooled or not depending on the minute — correct, but harder to explain to a guest |

---

## 5. What the numbers say

`pnpm sim:peak` runs two scenarios, because they answer different questions.

| | Stress: 200 guests, 40 drivers | Sized: 200 guests, 80 drivers |
|---|---|---|
| Served | 200 / 200 | 200 / 200 |
| Wait p50 / p95 | 2 min / 125 min | **2 min / 5 min** |
| Capacity violations | 0 | 0 |
| Starvation violations | 0 | 0 |
| Deadline misses | 0 | 0 |
| Round duration p95 | 4.3 ms | 1.4 ms |
| Shortfall alerts raised | 15 | 7 |

The stress fleet is **deliberately** undersized: an airport round trip plus repositioning is ~230
minutes, so 40 vehicles cannot deliver a 15-minute p95 to 200 guests — no algorithm can. The correct
behaviour there is to serve everyone in fair order, violate no invariant, and **tell ops the fleet is
short**, which is what the gate asserts. The wait SLA is gated on the sized run, where it measures
dispatch quality rather than vehicle count.

Being able to state that distinction is, I think, more valuable than a single flattering number.

---

## 6. Known limitations

1. **Not globally optimal.** LAP + greedy pooling with bounded insertion. A VRP solver would do better
   on multi-stop routing; the interface is left open for one.
2. **Symmetric travel times** — wrong on one-way road systems.
3. **No predictive positioning.** The engine reacts to demand; it does not pre-move vehicles toward an
   expected surge (beyond the narrow hard-deadline reservation). Staging is an ops decision, and it
   dominates outcomes — the simulation showed staging matters more than the algorithm.
4. **Deadlines assume the configured buffers are right.** A wrong airport buffer produces confidently
   wrong dispatch.
5. **Single-instance rounds.** A Redis lock serialises them; a multi-instance deployment is designed
   for but not load-tested.
6. **Break scheduling is reactive** — a break becomes due and the driver is withdrawn. It does not
   pre-place breaks in demand troughs, which FR-M21 permits and the cost function only nudges toward.
