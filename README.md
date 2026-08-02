# EventRide — Event Fleet Dispatch System

Automated driver↔guest matching for a single large private event: airport/station pickups,
accommodation↔venue shuttles, and departures — dispatched in real time by capacity, timing and
live traffic.

**Nobody chooses anybody.** Guests never browse drivers, drivers never browse guests, and admins
never hand-pick a driver in the normal flow. The matching engine is the only allocator; humans only
load people into the system, approve ad-hoc requests, and override in emergencies.

**Live API:** https://eventride-api-production.up.railway.app — open it, the landing page shows the
live database state. Admin `admin@event.test` / `admin123`; guest and driver sign in with any seeded
phone and OTP `000000`.

---

## Reviewing this? Start here

**Nothing to install — 60 seconds:**

1. Open **https://eventride-api-production.up.railway.app** — the landing page reads the live
   database: guests, drivers, waiting, unmatched, dispatch rounds.
2. Click **`/ready`** — proves MySQL *and* Redis are reachable, not just that the process is up.
3. Get a token and look at what dispatch decided:

```bash
API=https://eventride-api-production.up.railway.app
TOKEN=$(curl -s -X POST $API/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@event.test","password":"admin123"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -s $API/api/v1/admin/dashboard -H "Authorization: Bearer $TOKEN"   # counts + demand-vs-supply
curl -s $API/api/v1/admin/rounds    -H "Authorization: Bearer $TOKEN"   # every matching round
curl -s $API/api/v1/admin/audit     -H "Authorization: Bearer $TOKEN"   # who did what, in order

# RBAC: a driver token on an admin route must be refused
curl -s -o /dev/null -w '%{http_code}\n' $API/api/v1/admin/dashboard -H "Authorization: Bearer <driver-token>"
```

**To see the two apps** (they are React Native, so the API URL above is the backend, not a UI):

| | How |
|---|---|
| Fastest | `pnpm install && pnpm guest` / `pnpm portal` — scan the QR with Expo Go |
| No install | web previews (see [docs/DEPLOY.md](docs/DEPLOY.md) §2 Option B) |
| Real app | downloadable APK via EAS ([DEPLOY.md](docs/DEPLOY.md) §2 Option C) |

**To judge the engine — the part that matters:**

```bash
pnpm install
pnpm sim:peak   # peak-arrival simulation with pass/fail gates, no DB or API key needed
pnpm test       # 290 tests, incl. property tests for capacity, starvation and deadlines
```

Then read **[docs/DESIGN-matching.md](docs/DESIGN-matching.md)** (algorithm + trade-offs) and
**[docs/TRACEABILITY.md](docs/TRACEABILITY.md)** — every requirement, how it was verified, and an
explicit list of what is **not** verified.

---

Docs: [PRD](docs/PRD.md) · [HLD](docs/HLD.md) · [LLD](docs/LLD.md) · **[Matching design](docs/DESIGN-matching.md)** · [Traceability](docs/TRACEABILITY.md) · **[Deploy](docs/DEPLOY.md)**

---

## Status

| Component | State |
|---|---|
| `packages/shared` — enums, state machines, config, geo/time | ✅ done, tested |
| `packages/engine` — the matching engine (pure, no I/O) | ✅ done, 128 tests incl. property tests |
| `packages/routing` — provider interface, Google, caching, metering | ✅ done, 21 tests |
| `apps/sim` — seed data, peak-arrival simulation, CI gate | ✅ done, gates green |
| `apps/api` — NestJS + Prisma/MySQL, REST, sockets, sweeper | ✅ done, verified live end-to-end |
| `apps/guest` — Expo mobile app (guest) | ✅ done, bundles clean |
| `apps/portal` — Expo mobile app (Admin/Ops + Driver roles) | ✅ done, bundles clean |

**290 unit/property tests + 12 integration tests against real MySQL. Lint clean. Typecheck clean
across all 10 workspaces. Simulation gate green. Both apps typecheck and bundle.**

The full dispatch loop has been driven end-to-end against real MySQL + Redis: guest OTP login →
"I have arrived" → engine assigns a driver automatically → driver accepts → arrived → boarded →
dropped → completed, with all 10 state transitions recorded in the audit trail with the correct
actor, and a driver-role token correctly refused (403) on an admin route.

---

## Quick start

### 1. Logic only — no database, no API key, no network

```bash
pnpm install
pnpm test          # 290 unit + property tests
pnpm lint
pnpm sim:peak      # peak-arrival simulation + metrics + CI gate
```

### 2. The full system

```bash
# If port 3306 is already taken locally, use MYSQL_PORT=3307 and match it in .env
docker compose up -d
cp .env.example apps/api/.env
pnpm --filter @eventride/api prisma migrate deploy
pnpm db:seed       # 1 event · 6 locations · 40 drivers · 200 guests · 1 admin
pnpm api:dev       # http://localhost:3000  (/health, /ready, /metrics)

pnpm guest         # Expo — guest app
pnpm portal        # Expo — Admin/Ops + Driver portal
```

The seed prints the credentials it created:

```
Admin  : admin@event.test / admin123
Driver : +919000001000    OTP 000000
Guest  : +919900001000    OTP 000000
```

### 3. Container (verified)

```bash
docker build -f apps/api/Dockerfile -t eventride-api .
docker run -p 3000:3000 \
  -e DATABASE_URL="mysql://root:root@host.docker.internal:3306/eventride?timezone=UTC" \
  -e REDIS_URL="redis://host.docker.internal:6379" \
  -e JWT_SECRET="change-me" -e NODE_ENV=production -e DEV_OTP_ENABLED=false \
  eventride-api
```

Boots healthy, runs `prisma migrate deploy` on start, connects to MySQL and Redis, and runs as a
non-root user. Hosting steps: [docs/DEPLOY.md](docs/DEPLOY.md).

### 4. Integration tests (needs the database)

```bash
docker exec <mysql> mysql -uroot -proot -e "CREATE DATABASE IF NOT EXISTS eventride_test"
DATABASE_URL="mysql://root:root@127.0.0.1:3307/eventride_test?timezone=UTC" \
  pnpm --filter @eventride/api prisma migrate deploy
DATABASE_URL="mysql://root:root@127.0.0.1:3307/eventride_test?timezone=UTC" pnpm test:integration
```

These truncate every table, so the suite **refuses to start** unless `DATABASE_URL` names a database
containing "test" — it wiped a seeded roster once during development, and the guard exists because of
that.

Everything runs with **no Google API key and no billing account**: routing defaults to a keyless
deterministic provider (`ROUTING_PROVIDER=mock`), and the in-app maps are drawn from plain
OpenStreetMap tiles, so there is no native map SDK to configure either.

Dev sign-in: any seeded phone number with OTP `000000` (the server returns the code in dev mode).

---

## Architecture in one page

```
apps/guest        Expo mobile app — guests
apps/portal       Expo mobile app — Admin/Ops and Driver roles behind RBAC
apps/api          NestJS · MySQL (source of truth) · Redis (live positions, locks, pub/sub)
apps/sim          Runs the REAL engine against a fake world with a virtual clock

packages/engine       PURE: (snapshot, config, now) → Decision[].  No DB, no HTTP, no clock.
packages/routing      RoutingProvider interface: caching(google | mock) + metering
packages/shared       Types, enums, state machines, config defaults — one source of truth
packages/api-client   Typed REST + socket client shared by both apps
packages/ui           Shared React Native components, incl. a keyless OSM tile map
```

The load-bearing decision is that **the engine is pure**. It receives a snapshot and returns
proposals; a transactional applier re-validates and commits them. That makes invariants
property-testable without infrastructure, lets the simulator run production logic unchanged, and
means an engine failure can never corrupt state.

---

## The matching algorithm

**One cost function, three entry points** — real-time, batch, and the re-optimisation tick all call
the same scorer and the same hard filter. They differ only in how many (driver, request) pairs they
consider, so "good" means the same thing everywhere.

A round runs in this order, and the order is the design:

1. **Reservations** — hold the only feasible driver for an imminent hard deadline (FR-M22).
2. **Detour insertion into trips already in progress** — a vehicle already going that way beats a
   fresh empty drive for both guest wait *and* driver idleness. Uses the driver's live position,
   only considers insertion points ahead of it, capped at +10 min per onboard guest and one
   inserted stop per trip.
3. **Assignment** — demand-aware bundling, then Hungarian (LAP), then greedy pooling of leftovers,
   then a salvage pass.
4. **Bookkeeping** — pass-over counting and fleet-shortfall quantification.

### Cost function

```
cost = w_deadhead·travel_to_pickup + w_wait·guest_wait + w_late·deadline_risk
     + w_detour·delay_to_committed + w_waste·unused_seats + w_break·break_pressure
     − w_pool·pooling_bonus − w_age·minutes_waited − w_vip·is_vip
```
subject to a hard filter (capacity, shift, break, deadline reachability, reject cooldown). Every
weight lives in config, so tuning needs no deploy. Every assignment stores its score breakdown and
runner-up; every non-assignment stores a typed reason.

### Three properties worth calling out

- **Starvation is structurally impossible.** An aging weight alone is tunable and therefore
  breakable. Once a request has been passed over 3 times it gets a `+1,000,000` priority bonus and
  outranks everything — including a VIP. This also had to be pushed into the Hungarian cost matrix
  as a negative offset, because LAP minimises *total* cost and would otherwise ignore row priority.
- **Capacity is checked at every stop, not per request.** `seats_delta` prefix-sums over the stop
  sequence, so a mid-sequence overflow (3 + 3 aboard between two pickups in a 4-seater) is caught.
  The same function is used by the engine, the applier, and the tests.
- **Pooling is demand-aware.** Target load per vehicle = `ceil(queued seats / available drivers)`.
  With enough vehicles it pools nothing (sharing would only slow rides down and leave drivers idle);
  under a surge it packs up to the vehicle capacity.

---

## What the simulation proves

`pnpm sim:peak` runs two scenarios, because they answer different questions:

| Scenario | Result |
|---|---|
| **Stress** — 200 guests, 40 drivers, 80 ready within 30 min, one mid-trip breakdown | All 200 served · 0 capacity violations · 0 starvation · 0 deadline misses · **15 shortfall alerts raised** · wait p95 125 min |
| **Sized** — 200 guests, 80 drivers | Wait **p50 2 min / p95 5 min** · 0 violations · round p95 1.4 ms |

The stress fleet is *deliberately* undersized: an airport round trip plus repositioning is ~230
minutes, so no algorithm can hit a 15-minute SLA with 40 cars. The correct behaviour there is to
serve everyone in fair order, break no invariant, and **tell ops the fleet is short** — which is
what the gate asserts. The wait SLA is gated on the sized run, where it measures dispatch logic
rather than vehicle count.

External API budget is measured, not claimed: **4 upstream calls** for a full 200-guest event,
~98.8% cache hit rate (static POI matrix pre-computed once, 50 m grid snapping, 15-minute traffic
buckets, batched lookups).

---

## Bugs the tests caught during development

Kept here because they are the argument for building this way:

1. **Detour insertion was impossible on any in-progress trip.** The capacity prefix-sum started at
   zero, so an onboard guest's drop drove the running load negative and every insertion was
   rejected as malformed. Fixed by giving the primitive an initial load.
2. **Starvation protection didn't work in batch mode.** Hungarian minimises total cost and ignored
   the priority sort, so a cheap VIP could out-compete a guest already passed over 3 times.
3. **The engine assigned trips to drivers who were already driving.** The applier then dropped those
   decisions silently, so guests waited while the queue looked "handled" — the exact failure this
   system exists to prevent. Found by the simulation's idle-driver metric.
4. **Pooling ran only on leftovers**, so a surge handed every driver one guest and the rest queued
   behind full round trips. Fixed by bundling before assignment.
5. **Pooled guests' deadlines were validated against their solo timings**, ignoring that a guest
   dropped second arrives later.
6. **Fleet shortfall was only reported when guests were unmatched** — so a fleet that was merely too
   slow (everyone assigned to a car 78 minutes away) triggered no warning at all.
7. **A STORED generated column is impossible on this table.** MySQL refuses one derived from a column
   whose foreign key has `ON UPDATE CASCADE` (Prisma's default), reporting the misleading
   `ERROR 1215: Cannot add foreign key constraint`. `VIRTUAL` is accepted and supports the unique
   index identically — found by running the migration, not by reading docs.
8. **The request never passed through `EN_ROUTE`** — the service tried `ACCEPTED → ARRIVED_PICKUP`
   and the state machine refused it.
9. **A no-show only skipped the pickup stop**, leaving the drop pending, so the driver would have
   driven to the hotel with nobody aboard.
10. **Return-trip pooling used fixed time buckets**, splitting guests seconds apart whenever they
    straddled a boundary — the opposite of the intended rolling window.
11. **`pnpm typecheck` was failing and had never been run** across all workspaces. It exposed a wrong
    import (`Decision` from `@eventride/shared`, where it does not exist) that **17 passing test files
    could not catch, because vitest strips types via esbuild without checking them.** CI would have
    failed on first push.
12. **The integration suite wiped the seeded database.** It truncates every table and nothing stopped
    it being pointed at the live one. It now refuses to run unless the connection string names a test
    database.
13. **An append-only audit log ordered only by timestamp is ambiguous** — several transitions in one
    transaction share a millisecond, so "who did what in which order" was unanswerable. Added a
    monotonic `seq` column (hand-written migration: Prisma emits `ADD COLUMN NOT NULL` with no
    default, which MySQL rejects on a populated table).

---

## Verified behaviours

Driven with curl against the running API, real MySQL and real Redis:

| Behaviour | Evidence |
|---|---|
| Full trip lifecycle | ready → auto-assigned → accept → arrive → board → drop → completed |
| RBAC | driver token on an admin route → `403 FORBIDDEN_ROLE` |
| Guest privacy (D9) | grepped the live driver payload for the guest's phone number — absent |
| INV-5 in the database | second active trip for one driver → `Duplicate entry for uniq_driver_active_trip` |
| Audit trail | all 10 transitions recorded, each attributed to the correct actor |
| Batch preview is non-committing | two previews proposed 8 trips each with the trip count frozen at 12; publish then created exactly 8 |
| CSV all-or-nothing | a file with one bad row imported **nothing**; `"Beta, Bob"` (quoted comma) parsed correctly |
| Automatic dispatch | 12 queued guests were assigned by the background tick with no human action |
| **Guest app, rendered and driven** | Headless browser: sign in → "I have arrived" → "Finding your ride" → dispatch picked Driver 2 / KA01B1001 → driver accepted → the guest screen updated **without a reload** to show driver, vehicle, ETA and a live OSM map |
| **Admin portal, rendered** | Signed in, dashboard rendered with demand-vs-supply, guest/fleet counters and the fleet map |

## Known limitations

Single event · one driver bound to one vehicle · pooling caps at 2 drop stops and detours at 1
inserted stop (near-optimal, not globally optimal) · batch is LAP + greedy pooling, not a full VRP ·
no live flight/train status ingestion · driver location streams only while a trip is active, and only
with the app foregrounded · no offline write queue (screens degrade to cached reads) · the in-app map
is a static tile view with no gestures, chosen so the apps need no native map SDK or API key ·
`active_driver_id` is a hand-written generated column because Prisma cannot express one ·
the apps have been rendered and driven in a headless browser (see below), but never on a physical
device, so native-only behaviour is unproven · push
registration and sending are implemented and tested (registration verified live for all three roles),
but actual delivery to a physical device is unverified · no load test against the real API, and
multi-instance scale-out is designed for but untested.
