import { DEFAULT_CONFIG } from '@eventride/shared'
import { buildScenario } from './scenario.js'
import { runSimulation, percentile, type SimResult } from './simulator.js'

/**
 * Peak-arrival simulation and CI gate (PRD §19, HLD §13).
 *
 * Two scenarios, because they answer two different questions:
 *
 *  1. STRESS (40 drivers / 200 guests) — the fleet is deliberately undersized. Each airport round
 *     trip plus repositioning is ~230 minutes, so no dispatch algorithm can hit a 15-minute wait
 *     SLA here; the correct behaviour is to serve everyone in fair order, never violate an
 *     invariant, and TELL OPS the fleet is short (FR-M17). Those are what we gate on.
 *
 *  2. SIZED (80 drivers / 200 guests) — an adequately resourced fleet. Here the wait SLA is
 *     achievable, so the p95 gate applies and it is the dispatch logic being measured, not the
 *     vehicle count.
 *
 * Gating only the stress run on wait time would fail forever for a reason no code change can fix;
 * gating only the sized run would hide starvation and capacity bugs that appear under pressure.
 */

interface Gate {
  name: string
  actual: string
  limit: string
  passed: boolean
}

function invariantGates(result: SimResult): Gate[] {
  return [
    {
      name: 'Capacity violations (INV-1)',
      actual: String(result.capacityViolations),
      limit: '0',
      passed: result.capacityViolations === 0,
    },
    {
      // Not the raw pass-over count: that climbs legitimately when the whole fleet is busy.
      // Starvation is specifically "skipped in favour of someone lower priority".
      name: 'Starvation violations (INV-4)',
      actual: String(result.starvationViolations),
      limit: '0',
      passed: result.starvationViolations === 0,
    },
    {
      name: 'Guests never served (G1)',
      actual: String(result.neverServed.length),
      limit: '0',
      passed: result.neverServed.length === 0,
    },
    {
      name: 'Hard-deadline misses (FR-M10)',
      actual: String(result.deadlineMisses),
      limit: '0',
      passed: result.deadlineMisses === 0,
    },
    {
      name: 'Round duration p95 (NFR-2)',
      actual: `${percentile(result.roundDurationsMs, 95).toFixed(1)} ms`,
      limit: '<= 5000 ms',
      passed: percentile(result.roundDurationsMs, 95) <= 5000,
    },
  ]
}

function slaGate(result: SimResult): Gate {
  const waitP95 = percentile(result.waitsMin, 95)
  return {
    name: 'Guest wait p95 (G1)',
    actual: `${waitP95.toFixed(1)} min`,
    limit: `<= ${DEFAULT_CONFIG.guest_wait_warn_min} min`,
    passed: waitP95 <= DEFAULT_CONFIG.guest_wait_warn_min,
  }
}

function report(result: SimResult, gates: Gate[], label: string): void {
  const waits = result.waitsMin
  const utilisation =
    result.seatUtilisation.length > 0
      ? result.seatUtilisation.reduce((a, b) => a + b, 0) / result.seatUtilisation.length
      : 0

  const lines = [
    '',
    `═══ ${label} ═══`,
    '',
    `  Guests served / never served : ${result.completed} / ${result.neverServed.length}`,
    `  Wait p50 / p95 / max         : ${percentile(waits, 50).toFixed(0)} / ${percentile(waits, 95).toFixed(0)} / ${Math.max(0, ...waits).toFixed(0)} min`,
    `  Max pass-over count          : ${result.maxPassedOverCount} (informational)`,
    '',
    `  Mean seat utilisation        : ${(utilisation * 100).toFixed(0)}%`,
    `  Pooled trips / detours       : ${result.pooledTrips} / ${result.detours}`,
    `  Group splits (FR-M16)        : ${result.splits}`,
    `  Shortfall alerts (FR-M17)    : ${result.shortfallAlerts}`,
    `  Driver rejections handled    : ${result.rejections}`,
    `  Idle-driver-min while queued : ${result.idleDriverMinutesWhileQueueNonEmpty}`,
    '',
    `  Routing API calls            : ${result.routing.apiCalls} (${result.routing.elementsRequested} elements, ${((result.routing.cacheHits / Math.max(1, result.routing.elementsRequested)) * 100).toFixed(1)}% cached)`,
    `  Round duration p95           : ${percentile(result.roundDurationsMs, 95).toFixed(1)} ms`,
    '',
  ]

  for (const gate of gates) {
    lines.push(
      `  ${gate.passed ? '✅' : '❌'} ${gate.name.padEnd(34)} ${gate.actual.padStart(10)}  (limit ${gate.limit})`,
    )
  }
  process.stdout.write(lines.join('\n') + '\n')
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'peak'
  const verbose = process.argv.includes('--verbose')
  const started = Date.now()
  const allGates: Gate[] = []

  if (mode === 'quiet') {
    const result = await runSimulation(buildScenario({ guestCount: 40, peakGuests: 5, driverCount: 20 }), { verbose })
    const gates = [...invariantGates(result), slaGate(result)]
    report(result, gates, 'QUIET PERIOD (40 guests, 20 drivers)')
    allGates.push(...gates)
  } else {
    // 1. Stress: undersized fleet, 80 guests ready inside 30 minutes, one mid-trip breakdown.
    const stress = await runSimulation(buildScenario({ driverCount: 40 }), {
      verbose,
      rejectRate: 0.08,
      breakdownAtMinute: 45,
    })
    const stressGates = [
      ...invariantGates(stress),
      {
        name: 'Fleet shortfall reported (FR-M17)',
        actual: String(stress.shortfallAlerts),
        limit: '>= 1',
        passed: stress.shortfallAlerts >= 1,
      },
    ]
    report(stress, stressGates, 'PEAK STRESS — undersized fleet (200 guests, 40 drivers)')
    process.stdout.write(
      `\n  Note: wait p95 is ${percentile(stress.waitsMin, 95).toFixed(0)} min here BY DESIGN — the fleet is short,\n` +
        `  which the engine reports rather than hides. The SLA is measured on the sized run below.\n`,
    )
    allGates.push(...stressGates)

    // 2. Sized: adequate fleet, so the wait SLA measures the dispatch logic itself.
    const sized = await runSimulation(buildScenario({ driverCount: 80 }), { rejectRate: 0.08 })
    const sizedGates = [...invariantGates(sized), slaGate(sized)]
    report(sized, sizedGates, 'PEAK SIZED — adequate fleet (200 guests, 80 drivers)')
    allGates.push(...sizedGates)
  }

  process.stdout.write(`\n  Wall-clock runtime: ${Date.now() - started} ms\n\n`)

  const failed = allGates.filter((g) => !g.passed)
  if (failed.length > 0) {
    process.stderr.write(`FAILED ${failed.length} gate(s): ${failed.map((g) => g.name).join(', ')}\n`)
    process.exit(1)
  }
  process.stdout.write('  All gates passed.\n\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`Simulation crashed: ${String(error)}\n`)
  process.exit(1)
})
