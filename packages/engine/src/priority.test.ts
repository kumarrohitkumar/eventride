import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { priorityScore, sortByPriority, FORCE_TO_FRONT_BONUS } from './priority.js'
import { request, withConfig, T0 } from './testkit.js'
import { DEFAULT_CONFIG, addMinutes } from '@eventride/shared'

const cfg = DEFAULT_CONFIG

describe('priorityScore (FR-M14)', () => {
  it('ranks a longer-waiting guest above a fresh one, all else equal', () => {
    const old = request({ readyAt: addMinutes(T0, -25) })
    const fresh = request({ readyAt: T0 })
    expect(priorityScore(old, T0, cfg)).toBeGreaterThan(priorityScore(fresh, T0, cfg))
  })

  it('ranks a VIP above a non-VIP with the same wait', () => {
    const vip = request({ isVip: true })
    const normal = request({ isVip: false })
    expect(priorityScore(vip, T0, cfg)).toBeGreaterThan(priorityScore(normal, T0, cfg))
  })

  it('escalates a hard deadline as it approaches', () => {
    const far = request({ isHardDeadline: true, deadlineAt: addMinutes(T0, 110) })
    const near = request({ isHardDeadline: true, deadlineAt: addMinutes(T0, 10) })
    expect(priorityScore(near, T0, cfg)).toBeGreaterThan(priorityScore(far, T0, cfg))
  })

  it('gives a soft-deadline request no urgency term', () => {
    const soft = request({ isHardDeadline: false, deadlineAt: addMinutes(T0, 5) })
    const noDeadline = request({ isHardDeadline: false, deadlineAt: null })
    expect(priorityScore(soft, T0, cfg)).toBeCloseTo(priorityScore(noDeadline, T0, cfg), 6)
  })

  it('prefers larger groups as a mild tiebreak', () => {
    const big = request({ groupSize: 4 })
    const small = request({ groupSize: 1 })
    expect(priorityScore(big, T0, cfg)).toBeGreaterThan(priorityScore(small, T0, cfg))
  })

  it('falls back to createdAt when the guest has not tapped ready yet', () => {
    const r = request({ readyAt: null, createdAt: addMinutes(T0, -40) })
    expect(priorityScore(r, T0, cfg)).toBeGreaterThan(0)
  })

  // --- INV-4: the anti-starvation hard override (PRD D26) ---

  it('forces a 3-times-passed-over request above ALL competition', () => {
    const starved = request({ passedOverCount: 3, readyAt: T0, groupSize: 1 })
    const superVip = request({
      isVip: true,
      groupSize: 12,
      isHardDeadline: true,
      deadlineAt: addMinutes(T0, 1),
      readyAt: addMinutes(T0, -120),
    })
    expect(priorityScore(starved, T0, cfg)).toBeGreaterThan(priorityScore(superVip, T0, cfg))
  })

  it('does not apply the override below the configured threshold', () => {
    const two = request({ passedOverCount: 2 })
    expect(priorityScore(two, T0, cfg)).toBeLessThan(FORCE_TO_FRONT_BONUS)
  })

  it('honours a lowered max_passed_over_count from config', () => {
    const c = withConfig({ max_passed_over_count: 1 })
    expect(priorityScore(request({ passedOverCount: 1 }), T0, c)).toBeGreaterThanOrEqual(
      FORCE_TO_FRONT_BONUS,
    )
  })
})

describe('sortByPriority', () => {
  it('returns highest priority first and does not mutate the input', () => {
    const a = request({ readyAt: T0 })
    const b = request({ readyAt: addMinutes(T0, -30) })
    const input = [a, b]
    const sorted = sortByPriority(input, T0, cfg)
    expect(sorted[0]!.id).toBe(b.id)
    expect(input[0]!.id).toBe(a.id) // original order intact
  })

  it('is deterministic for equal scores (FIFO by createdAt)', () => {
    const first = request({ readyAt: T0, createdAt: addMinutes(T0, -10) })
    const second = request({ readyAt: T0, createdAt: addMinutes(T0, -5) })
    const sorted = sortByPriority([second, first], T0, cfg)
    expect(sorted.map((r) => r.id)).toEqual([first.id, second.id])
  })
})

describe('starvation property (INV-4)', () => {
  it('a request at the pass-over threshold always outranks any newcomer, however privileged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 240 }),
        fc.boolean(),
        (groupSize, waitedMin, isVip) => {
          const starved = request({ passedOverCount: cfg.max_passed_over_count })
          const rival = request({
            groupSize,
            isVip,
            readyAt: addMinutes(T0, -waitedMin),
            isHardDeadline: true,
            deadlineAt: addMinutes(T0, 1),
          })
          return priorityScore(starved, T0, cfg) > priorityScore(rival, T0, cfg)
        },
      ),
      { numRuns: 300 },
    )
  })
})
