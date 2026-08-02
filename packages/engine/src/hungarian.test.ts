import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { solveAssignment, INFEASIBLE } from './hungarian.js'

/**
 * Reference implementation: exhaustive search over all injective row→column mappings.
 * Note it must consider *which* rows get served when rows outnumber columns — with 3 requests and
 * 2 drivers, the optimum may leave the expensive request unassigned.
 */
function bruteForce(cost: number[][]): number {
  const n = cost.length
  const m = cost[0]!.length
  const target = Math.min(n, m)
  let best = Infinity

  const search = (row: number, usedCols: Set<number>, assignedCount: number, total: number) => {
    if (assignedCount === target) {
      best = Math.min(best, total)
      return
    }
    // Not enough rows left to reach the target number of assignments.
    if (n - row < target - assignedCount) return

    for (let col = 0; col < m; col++) {
      if (usedCols.has(col)) continue
      usedCols.add(col)
      search(row + 1, usedCols, assignedCount + 1, total + cost[row]![col]!)
      usedCols.delete(col)
    }
    // Skipping this row is legal when rows outnumber columns.
    search(row + 1, usedCols, assignedCount, total)
  }

  search(0, new Set(), 0, 0)
  return best
}

const totalOf = (cost: number[][], assignment: number[]): number =>
  assignment.reduce((sum, col, row) => (col < 0 ? sum : sum + cost[row]![col]!), 0)

describe('solveAssignment (FR-M1 batch layer)', () => {
  it('finds the optimal assignment for a known 3×3 matrix', () => {
    // Optimal is (0→1, 1→0, 2→2) = 2 + 3 + 4 = 9
    const cost = [
      [10, 2, 8],
      [3, 20, 9],
      [7, 6, 4],
    ]
    const assignment = solveAssignment(cost)
    expect(totalOf(cost, assignment)).toBe(9)
    expect(assignment).toEqual([1, 0, 2])
  })

  it('assigns every row when there are more drivers than requests', () => {
    const cost = [
      [5, 1, 9, 12],
      [8, 6, 2, 11],
    ]
    const assignment = solveAssignment(cost)
    expect(assignment).toHaveLength(2)
    expect(new Set(assignment).size).toBe(2) // no driver used twice
    expect(totalOf(cost, assignment)).toBe(3) // 1 + 2
  })

  it('leaves rows unassigned when there are fewer drivers than requests', () => {
    const cost = [[4, 9], [3, 7], [8, 2]]
    const assignment = solveAssignment(cost)
    const assigned = assignment.filter((c) => c >= 0)
    expect(assigned).toHaveLength(2) // only 2 drivers exist
    expect(new Set(assigned).size).toBe(2)
  })

  it('never assigns an infeasible pair, even if that leaves a row unassigned', () => {
    // Row 1 can only go to column 0, which row 0 wants far more cheaply.
    const cost = [
      [1, 5],
      [2, INFEASIBLE],
    ]
    const assignment = solveAssignment(cost)
    for (const [row, col] of assignment.entries()) {
      if (col >= 0) expect(cost[row]![col]).toBeLessThan(INFEASIBLE)
    }
  })

  it('returns all -1 when every pair is infeasible (FR-M10 → UNMATCHED)', () => {
    const cost = [
      [INFEASIBLE, INFEASIBLE],
      [INFEASIBLE, INFEASIBLE],
    ]
    expect(solveAssignment(cost)).toEqual([-1, -1])
  })

  it('handles a single cell', () => {
    expect(solveAssignment([[7]])).toEqual([0])
    expect(solveAssignment([[INFEASIBLE]])).toEqual([-1])
  })

  it('handles an empty problem', () => {
    expect(solveAssignment([])).toEqual([])
  })

  it('is deterministic across repeated runs (HLD §5.2 replayability)', () => {
    const cost = [
      [3, 3, 3],
      [3, 3, 3],
      [3, 3, 3],
    ]
    const first = solveAssignment(cost)
    for (let i = 0; i < 5; i++) expect(solveAssignment(cost)).toEqual(first)
  })

  it('matches brute force on random small matrices (optimality proof)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 25, maxLength: 25 }),
        (n, m, flat) => {
          const cost = Array.from({ length: n }, (_, i) =>
            Array.from({ length: m }, (_, j) => flat[(i * 5 + j) % 25]!),
          )
          const got = totalOf(cost, solveAssignment(cost))
          return Math.abs(got - bruteForce(cost)) < 1e-9
        },
      ),
      { numRuns: 200 },
    )
  })

  it('solves a 100 requests × 100 drivers matrix well inside the latency budget (NFR-2)', () => {
    const size = 100
    const cost = Array.from({ length: size }, (_, i) =>
      Array.from({ length: size }, (_, j) => ((i * 31 + j * 17) % 97) + 1),
    )
    const start = performance.now()
    const assignment = solveAssignment(cost)
    const ms = performance.now() - start
    expect(assignment.filter((c) => c >= 0)).toHaveLength(size)
    expect(new Set(assignment).size).toBe(size)
    expect(ms).toBeLessThan(500)
  })
})
