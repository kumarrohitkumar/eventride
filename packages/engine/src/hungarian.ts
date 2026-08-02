/**
 * Linear assignment problem solver — the batch layer of the dispatch engine (FR-M1, D29).
 *
 * Jonker-Volgenant shortest-augmenting-path variant of the Hungarian algorithm, O(n²m).
 * At our scale (≤ 100 requests × ≤ 100 drivers) this runs in single-digit milliseconds and is
 * provably optimal for the 1:1 layer — pooling is then applied greedily on top (D29).
 *
 * Why a finite sentinel instead of Infinity: the algorithm accumulates row/column potentials, and
 * `Infinity - Infinity` produces NaN, which silently corrupts every subsequent comparison.
 * A large finite cost keeps the arithmetic total and lets us filter infeasible pairs afterwards.
 */
export const INFEASIBLE = 1e9

/** Any assignment at or above this cost is treated as "not actually assignable". */
const INFEASIBLE_THRESHOLD = INFEASIBLE / 2

/**
 * @param cost rows = requests, cols = drivers. Use INFEASIBLE for pairs the hard filter rejected.
 * @returns for each row, the assigned column index, or -1 if the row could not be assigned.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length
  if (n === 0) return []
  const m = cost[0]!.length
  if (m === 0) return new Array(n).fill(-1)

  // The algorithm requires rows ≤ cols; transpose and map back when that does not hold.
  if (n > m) {
    const transposed = Array.from({ length: m }, (_, j) =>
      Array.from({ length: n }, (_, i) => cost[i]![j]!),
    )
    const colToRow = solveAssignment(transposed)
    const result = new Array<number>(n).fill(-1)
    colToRow.forEach((row, col) => {
      if (row >= 0) result[row] = col
    })
    return result
  }

  const INF = Number.MAX_SAFE_INTEGER
  const u = new Array<number>(n + 1).fill(0) // row potentials
  const v = new Array<number>(m + 1).fill(0) // column potentials
  const p = new Array<number>(m + 1).fill(0) // p[col] = 1-indexed row matched to col
  const way = new Array<number>(m + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(INF)
    const used = new Array<boolean>(m + 1).fill(false)

    // Grow a shortest augmenting path from row i until it reaches a free column.
    for (;;) {
      used[j0] = true
      const i0 = p[j0]!
      let delta = INF
      let j1 = -1
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!
        if (cur < minv[j]!) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j]! < delta) {
          delta = minv[j]!
          j1 = j
        }
      }
      if (j1 === -1) break // no reachable column left
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!]! += delta
          v[j]! -= delta
        } else {
          minv[j]! -= delta
        }
      }
      j0 = j1
      if (p[j0] === 0) break // reached a free column → augment
    }

    if (j0 === 0) continue // row i could not be placed at all
    // Walk the path back, flipping matches.
    for (;;) {
      const j1 = way[j0]!
      p[j0] = p[j1]!
      j0 = j1
      if (j0 === 0) break
    }
  }

  const assignment = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) {
    const row = p[j]!
    if (row > 0) assignment[row - 1] = j - 1
  }

  // Drop pairs the hard filter had marked infeasible: a mathematically optimal solution may still
  // use a sentinel cell when a row has no real option, and dispatching that would break FR-M9/M10.
  for (let i = 0; i < n; i++) {
    const col = assignment[i]!
    if (col >= 0 && cost[i]![col]! >= INFEASIBLE_THRESHOLD) assignment[i] = -1
  }
  return assignment
}
