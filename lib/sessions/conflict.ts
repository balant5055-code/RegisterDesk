// Time-overlap helpers for conflict detection (attendee selections + hall scheduling).

/** Half-open overlap: [aStart,aEnd) intersects [bStart,bEnd). Touching edges OK. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** Returns the first overlapping pair among the given timed items, or null. */
export function firstOverlap<T extends { startTime: number; endTime: number }>(items: T[]): [T, T] | null {
  const sorted = [...items].sort((a, b) => a.startTime - b.startTime)
  for (let i = 1; i < sorted.length; i++) {
    // Sorted by start; an overlap exists iff the previous end is after this start.
    if (sorted[i - 1].endTime > sorted[i].startTime) return [sorted[i - 1], sorted[i]]
  }
  return null
}
