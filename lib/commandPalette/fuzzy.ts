// Tiny in-house fuzzy matcher for the Global Command Palette (Phase H.4.2).
//
// Pure and dependency-free (no cmdk / fuse.js added) so it also runs under tsx
// for unit tests. Case-insensitive subsequence matching with positional bonuses
// (exact, prefix, word-boundary, consecutive) so short queries rank the obvious
// command first — e.g. "reg" ranks "Registrations" above "Manage Coverage".

const WORD_BOUNDARY = /[\s\-_/.:·]/

/**
 * Score how well `query` matches `target`.
 * Returns a number (higher = better) or `null` when it does not match at all.
 * An empty query returns 0 (used to mean "keep original order").
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  if (!t) return null

  if (t === q)          return 1000
  if (t.startsWith(q))  return 900 - (t.length - q.length)   // shorter prefix wins

  let qi = 0
  let score = 0
  let prevMatchIdx = -2

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let charScore = 10
      if (ti === prevMatchIdx + 1) charScore += 15                                   // consecutive
      if (ti === 0 || WORD_BOUNDARY.test(t[ti - 1]!)) charScore += 20                 // word boundary
      score += charScore
      prevMatchIdx = ti
      qi++
    }
  }

  if (qi < q.length) return null              // not every query char was consumed → no match
  score -= Math.floor(t.length / 10)          // gently prefer tighter targets
  return score
}

export function fuzzyMatches(query: string, target: string): boolean {
  return fuzzyScore(query, target) !== null
}

/**
 * Rank `items` by the best fuzzy score across each item's searchable strings.
 * Empty query → returns all items in their original order.
 * Non-empty query → returns only matching items, best first (stable for ties).
 */
export function rankBy<T>(
  query: string,
  items: T[],
  getStrings: (item: T) => string[],
): T[] {
  const q = query.trim()
  if (!q) return [...items]

  const scored: { item: T; score: number; idx: number }[] = []
  items.forEach((item, idx) => {
    let best: number | null = null
    for (const s of getStrings(item)) {
      const sc = fuzzyScore(q, s)
      if (sc !== null && (best === null || sc > best)) best = sc
    }
    if (best !== null) scored.push({ item, score: best, idx })
  })

  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))   // stable on ties
  return scored.map(s => s.item)
}
