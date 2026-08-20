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
 * `baseQuery` must be the audience query WITHOUT the date range applied — once the range
 * is on, the undated documents are already invisible and cannot be counted.
 *
 * Two `count()` aggregates: index-only, zero document reads, both served by the same
 * composite indexes the audience query already uses.
 *
 * The upper bound is not decoration. Firestore orders values by TYPE before value, and
 * strings sort above timestamps, so a lower bound alone would also count a `registeredAt`
 * that is a string rather than a Timestamp — and a string can never satisfy a Timestamp
 * range either. Bounding above keeps "dated" meaning "genuinely date-filterable".
 */
export async function countUndatedRegistrations(
  baseQuery: FirebaseFirestore.Query,
): Promise<number> {
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
}
