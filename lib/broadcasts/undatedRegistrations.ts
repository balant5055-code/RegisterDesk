// RD-BCAST-DATE-01 · how many registrations a date filter CANNOT see. Server-only.
//
// Firestore omits a document from a field's index when the field is absent, so a
// `registeredAt` range query does not merely rank such documents last — it cannot return
// them at all. No error, no empty row, nothing. For a feature whose whole promise is
// "these are the people who registered that day", that blind spot has to be measured and
// shown, not assumed away.

import { DATED_LOWER_BOUND, DATED_UPPER_BOUND } from '@/lib/broadcasts/registrationDateFilter'

/**
 * Counts registrations in `baseQuery` that have no usable `registeredAt`.
 *
 * Returns `null` when the count could not be established — NEVER 0. Zero means "every
 * registration is date-filterable", which is a claim; null means "we do not know". The
 * distinction is the whole value of this function, so collapsing the two would be worse
 * than not counting at all.
 *
 * NON-FATAL BY CONSTRUCTION. This is a diagnostic that qualifies the primary recipient
 * count; it is not the recipient count. It once threw a FAILED_PRECONDITION for a missing
 * composite index and took the entire broadcast preview down with it — HTTP 500 on both
 * channels, for a warning line. A secondary signal must never be able to do that, whatever
 * the underlying cause, so every failure is swallowed here and reported as "unknown".
 *
 * `baseQuery` must be the audience query WITHOUT the date range applied — once the range
 * is on, the undated documents are already invisible and cannot be counted.
 *
 * Two `count()` aggregates: index-only, zero document reads.
 *
 * The upper bound is not decoration. Firestore orders values by TYPE before value, and
 * strings sort above timestamps, so a lower bound alone would also count a `registeredAt`
 * that is a string rather than a Timestamp — and a string can never satisfy a Timestamp
 * range either. Bounding above keeps "dated" meaning "genuinely date-filterable".
 */
export async function countUndatedRegistrations(
  baseQuery: FirebaseFirestore.Query,
): Promise<number | null> {
  try {
    const [totalSnap, datedSnap] = await Promise.all([
      baseQuery.count().get(),
      baseQuery
        .where('registeredAt', '>=', DATED_LOWER_BOUND)
        .where('registeredAt', '<',  DATED_UPPER_BOUND)
        .count().get(),
    ])

    // Clamped: the two aggregates are not a single snapshot, so a registration created
    // between them could otherwise produce a negative count.
    return Math.max(0, totalSnap.data().count - datedSnap.data().count)
  } catch (err) {
    // Logged server-side so a missing index is still diagnosable — it simply no longer
    // reaches the organizer as a dead preview.
    console.error('[broadcast-undated] diagnostic aggregate failed:', err instanceof Error ? err.message : err)
    return null
  }
}
