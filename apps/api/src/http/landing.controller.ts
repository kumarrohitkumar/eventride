import { Controller, Get, Header, Inject } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

/**
 * A landing page at `/`.
 *
 * A deployed API whose root returns 404 is a bad "live link": a reviewer opens it, sees nothing, and
 * has no idea whether anything works. This renders the live state of the system — real counts read
 * from the database — plus the credentials and the endpoints worth clicking.
 */
@Controller()
export class LandingController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async index(): Promise<string> {
    const [guests, drivers, requests, trips, queued, unmatched, rounds, event] = await Promise.all([
      this.prisma.guest.count(),
      this.prisma.driver.count(),
      this.prisma.tripRequest.count(),
      this.prisma.trip.count(),
      this.prisma.tripRequest.count({ where: { state: 'QUEUED' } }),
      this.prisma.tripRequest.count({ where: { state: 'UNMATCHED' } }),
      this.prisma.decisionRound.count(),
      this.prisma.event.findFirst(),
    ]).catch(() => [0, 0, 0, 0, 0, 0, 0, null] as const)

    const availableDrivers = await this.prisma.driver
      .count({ where: { state: 'AVAILABLE' } })
      .catch(() => 0)

    return page({
      eventName: event?.name ?? 'not seeded',
      guests,
      drivers,
      availableDrivers,
      requests,
      trips,
      queued,
      unmatched,
      rounds,
    })
  }
}

interface Stats {
  eventName: string
  guests: number
  drivers: number
  availableDrivers: number
  requests: number
  trips: number
  queued: number
  unmatched: number
  rounds: number
}

const page = (s: Stats): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EventRide — live dispatch API</title>
<style>
  :root { color-scheme: light dark }
  * { box-sizing: border-box }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; padding: 2.5rem 1.25rem; line-height: 1.6; background: #f7f8fa; color: #111827 }
  main { max-width: 54rem; margin: 0 auto }
  h1 { margin: 0 0 .25rem; font-size: 1.9rem; letter-spacing: -.02em }
  .sub { color: #6b7280; margin: 0 0 1.75rem }
  .live { display: inline-flex; align-items: center; gap: .45rem; background: #d1fae5; color: #065f46;
          padding: .2rem .6rem; border-radius: 999px; font-size: .78rem; font-weight: 700 }
  .dot { width: .5rem; height: .5rem; border-radius: 50%; background: #059669 }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .75rem; margin: 1.25rem 0 2rem }
  .stat { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: .9rem 1rem }
  .stat b { display: block; font-size: 1.6rem; line-height: 1.2 }
  .stat span { font-size: .74rem; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .03em }
  section { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.1rem 1.25rem; margin-bottom: 1rem }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; margin: 0 0 .6rem }
  code, kbd { background: #f3f4f6; padding: .12rem .4rem; border-radius: 5px; font-size: .88em }
  a { color: #1d4ed8 }
  ul { margin: .4rem 0; padding-left: 1.15rem }
  .note { background: #fef3c7; border-radius: 10px; padding: .8rem 1rem; font-size: .9rem; color: #78350f }
  footer { color: #6b7280; font-size: .82rem; margin-top: 1.5rem }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0f19; color: #e5e7eb }
    .stat, section { background: #111827; border-color: #1f2937 }
    code, kbd { background: #1f2937 }
    .note { background: #422006; color: #fde68a }
  }
</style></head><body><main>

<span class="live"><span class="dot"></span>API LIVE</span>
<h1>EventRide</h1>
<p class="sub">Automated fleet dispatch for a single large private event — ${s.eventName}</p>

<div class="grid">
  <div class="stat"><b>${s.guests}</b><span>Guests</span></div>
  <div class="stat"><b>${s.drivers}</b><span>Drivers</span></div>
  <div class="stat"><b>${s.availableDrivers}</b><span>Available</span></div>
  <div class="stat"><b>${s.requests}</b><span>Requests</span></div>
  <div class="stat"><b>${s.trips}</b><span>Trips</span></div>
  <div class="stat"><b>${s.queued}</b><span>Waiting</span></div>
  <div class="stat"><b>${s.unmatched}</b><span>Unmatched</span></div>
  <div class="stat"><b>${s.rounds}</b><span>Rounds</span></div>
</div>

<section>
  <h2>Try it — no tools needed</h2>
  <ul>
    <li><a href="/health">/health</a> — liveness</li>
    <li><a href="/ready">/ready</a> — proves MySQL <em>and</em> Redis are reachable</li>
    <li><a href="/metrics">/metrics</a> — queue depth, available drivers, routing-API call count</li>
  </ul>
</section>

<section>
  <h2>Sign in</h2>
  <ul>
    <li><strong>Admin / Ops</strong> — <code>admin@event.test</code> / <code>admin123</code></li>
    <li><strong>Guest &amp; Driver</strong> — any seeded phone number, OTP <code>000000</code></li>
  </ul>
  <p style="margin:.5rem 0 0">Get a token:</p>
  <pre style="overflow-x:auto"><code>curl -X POST $HOST/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"admin@event.test","password":"admin123"}'</code></pre>
</section>

<section>
  <h2>What the engine does</h2>
  <ul>
    <li><strong>Nobody chooses anybody.</strong> Guests never browse drivers, drivers never browse guests, admins never hand-pick — the engine is the only allocator.</li>
    <li>One cost function, three entry points: real-time, batch (Hungarian), and a re-optimisation tick.</li>
    <li>Mid-trip detour insertion using the driver's live position; capacity checked at every stop.</li>
    <li>Starvation is structurally impossible — a request passed over 3 times outranks everything, including a VIP.</li>
  </ul>
</section>

<section class="note">
  <strong>This is a demo deployment.</strong> OTP is fixed at <code>000000</code> so a reviewer can sign
  in without an SMS provider. In a real deployment that is refused at boot: the API will not start with
  <code>NODE_ENV=production</code> and a fixed OTP enabled.
</section>

<footer>
  Source, architecture and known trade-offs:
  <a href="https://github.com/kumarrohitkumar/eventride">github.com/kumarrohitkumar/eventride</a>
</footer>
</main></body></html>`
