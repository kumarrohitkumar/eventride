# Loom walkthrough — script

**Target: 6–8 minutes.** Reviewers are watching several of these, so lead with the thing that is
hard to build, not with a tour of the folder tree.

Have these open in tabs before you hit record:

1. `https://eventride-api-production.up.railway.app` (live landing page)
2. `https://github.com/kumarrohitkumar/eventride`
3. `docs/DESIGN-matching.md`
4. A terminal in the repo
5. `packages/engine/src/round.ts`

---

## 0:00 — What it is (30s)

> "This is EventRide — automated vehicle dispatch for a single large private event. Airport pickups,
> venue shuttles, departures.
>
> The one rule that shapes the whole design: **nobody chooses anybody.** Guests never browse drivers,
> drivers never browse guests, and admins never hand-pick a driver in the normal flow. The matching
> engine is the only allocator. Humans only do three things — load people in, approve ad-hoc
> requests, and override in an emergency."

Show the live landing page. Point at the counts: *"this is reading the live database — 201 guests,
40 drivers."*

---

## 0:30 — Prove it is live (45s)

Click through in the browser:

- `/ready` — *"this one matters: it proves MySQL and Redis are actually reachable, not just that the
  process is alive."*
- `/metrics` — *"queue depth, available drivers, and the routing-API call count."*

---

## 1:15 — The algorithm, the part worth watching (2m 30s)

Open `docs/DESIGN-matching.md`. Do not read it out — pull out four things:

**1. One cost function, three entry points**
> "Real-time matching, batch planning and the re-optimisation tick all call the same scorer and the
> same hard filter. They differ only in how many pairs they consider. So 'a good assignment' means
> the same thing everywhere — one thing to tune, one thing to test, one thing to explain."

**2. The engine is a pure function**
> "`runRound(snapshot)` returns decisions. No database, no HTTP, no clock, no randomness. That means
> invariants are property-testable with no infrastructure, the peak simulator runs the *real* engine,
> and an engine fault produces a rejected proposal instead of corrupt state."

**3. Starvation is structurally impossible**
> "An aging weight alone is tunable, so somebody lowers it for throughput and starvation quietly
> comes back. Once a request has been passed over three times it gets a million-point bonus and
> outranks everything — including a VIP with a deadline a minute away.
>
> And this had to be pushed into the Hungarian cost matrix too, because the solver minimises *total*
> cost and will happily ignore the order I sorted the rows in. That was a real bug: starvation
> protection worked on the incremental path and not the batch path."

**4. Pooling is demand-aware**
> "Target load per vehicle is queued seats divided by available drivers. With enough vehicles it pools
> *nothing* — sharing would only slow rides down and leave drivers idle. Under a surge it packs to
> capacity. Pooling is a response to scarcity, not a virtue."

---

## 3:45 — The simulation (1m 30s)

```bash
pnpm sim:peak
```

While it runs:

> "Two scenarios, because they answer different questions.
>
> The stress run is 200 guests and 40 drivers — deliberately undersized. An airport round trip plus
> repositioning is about 230 minutes, so no algorithm hits a 15-minute wait target with 40 cars. The
> correct behaviour there is to serve everyone in fair order, break no invariant, and **tell ops the
> fleet is short** — and it raises 15 shortfall alerts.
>
> The sized run has 80 drivers, and there the wait SLA applies: **p50 two minutes, p95 five minutes**,
> zero capacity violations, zero starvation, zero deadline misses, and a matching round at 1.4
> milliseconds.
>
> Gating the stress run on wait time would fail forever for a reason no code change can fix. Being
> able to state that difference matters more to me than one flattering number."

---

## 5:15 — Tests and honesty (1m)

```bash
pnpm test
```

> "290 unit and property tests, plus 12 integration tests against a real MySQL. The property tests are
> the ones I care about — capacity respected, nobody starved, deadlines honoured, over randomised
> fleets."

Then open `docs/TRACEABILITY.md`:

> "Every requirement, with **how** it was verified — automated test, live run against the deployed API,
> or rendered-only. And a section on what is *not* verified: push delivery to a physical handset,
> live Google routing since that needs a billed key, and multi-instance scale-out.
>
> The README also lists thirteen real bugs that testing and deployment caught — including one where
> the engine assigned trips to drivers who were already driving, and the applier silently dropped
> those decisions, so guests waited while the queue looked handled. That is exactly the failure this
> system exists to prevent, and the simulation's idle-driver metric is what surfaced it."

---

## 6:15 — Close (30s)

> "Trade-offs I would defend: linear assignment plus greedy pooling instead of a full VRP solver —
> milliseconds and explainable, and I left the seam open for one. Pooling caps at two drop stops so
> stop ordering needs no travelling-salesman step. Accepted trips are locked, because yanking a driver
> between guests is worse than a slightly better global plan.
>
> Everything is in the repo — PRD, HLD, LLD, the design document, and the traceability matrix."

---

## If you have time for one more thing

The single most impressive live demo is the dispatch loop end to end. In the guest app: tap
**"I have arrived"** → it says *"Finding your ride"* → the engine assigns a driver with **no human
action** → accept as the driver → the guest screen updates to show the driver, vehicle, ETA and a live
map, **without a refresh**.

```bash
pnpm guest    # Expo Go
pnpm portal
```

---

## Do not do these

- Do not walk the folder tree file by file. Nobody watches that.
- Do not read the README aloud. Show the running system and explain the decisions.
- Do not claim the apps are verified on a device — they are not, and the docs say so. Reviewers trust
  a candidate who states limits far more than one who oversells.
