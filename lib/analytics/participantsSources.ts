// RD-ANALYTICS-12-29 · registration composition by SOURCE, as aggregates. Server-only, READ-ONLY.
//
// ═══ WHAT THIS MODULE READS, AND WHAT IT REFUSES TO ═══════════════════════════
// It reads exactly one persisted field of the registration document: `registrationSource`,
// the platform's own record of how a seat was created — `'walkin'` at the gate, `'online'`
// through the public form, ABSENT on every row written before the field existed. Nothing
// here reads `attendee.*`, `formResponses`, the CRM collections, or any field that could
// identify a person. There is no identity in this module because the audit
// (RD-ANALYTICS-12-29) proved the platform cannot supply one: a registration is a seat, and
// one person may legitimately hold several.
//
// ═══ WHY "UNRECORDED" IS ITS OWN FIGURE ═════════════════════════════════════
// The type says "absent ⇒ treat as online", and that is the right rule for a GATE deciding
// whether a row is a walk-in. It is the wrong rule for a chart: publishing pre-field rows
// as "online" would assert a fact the platform never recorded. So `online` is the rows that
// SAY online, `walkin` the rows that say walk-in, and `unrecorded` the remainder, named for
// what it is. The three sum to the status total.
//
// ═══ COST ═══════════════════════════════════════════════════════════════════
// Every figure is a `count()` aggregate over equality filters only — served by merging
// single-field indexes, zero documents transferred, no composite required, no page to
// overflow. Two sources × (1 + 5 statuses) = 12 aggregates whatever the event's size.

import { adminDb } from '@/lib/firebase/admin'

/** A count that may not have been measured. Never zero for "we could not read it". */
type Count = number | null

/** The persisted `registrationSource` values. Declared once; the reads and the tests share it. */
export const REGISTRATION_SOURCES = ['online', 'walkin'] as const
export type RegistrationSourceValue = typeof REGISTRATION_SOURCES[number]

/** The registration statuses the split is taken across — the same five the contract names. */
export const COMPOSITION_STATUSES = ['confirmed', 'pending', 'cancelled', 'rejected', 'waitlisted'] as const
export type CompositionStatus = typeof COMPOSITION_STATUSES[number]

export interface SourceCounts {
  online:     Count
  walkin:     Count
  /** Rows with no `registrationSource` — written before the field existed. Never "online". */
  unrecorded: Count
}

export interface RegistrationSourceComposition {
  /** Lifetime, every status. */
  lifetime: SourceCounts
  /** Lifetime, per status. `unrecorded` is that status's total − online − walkin. */
  byStatus: Record<CompositionStatus, SourceCounts>
}

const countOf = (q: FirebaseFirestore.Query): Promise<Count> =>
  q.count().get().then(s => s.data().count).catch(() => null)

const remainder = (total: Count, online: Count, walkin: Count): Count =>
  total === null || online === null || walkin === null ? null : Math.max(0, total - online - walkin)

/**
 * Source composition for one event, lifetime and per status.
 *
 * `totals` are the status counts the producer already read (`aggregateRegistrationStatusCounts`),
 * passed in so the remainder is taken against the SAME population every other module uses
 * rather than against a second total that could disagree by a row.
 *
 * Every filter is an equality on `organizerUid`, `eventSlug`, `registrationSource` and
 * `status` — the workspace and the event are in every query, so a caller cannot point this
 * read at another workspace's rows, and no result depends on the caller filtering afterwards.
 */
export async function readRegistrationSourceComposition(
  organizerUid: string,
  eventSlug: string,
  totals: { total: Count } & Record<CompositionStatus, Count>,
): Promise<RegistrationSourceComposition | null> {
  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug',    '==', eventSlug)

  const pair = (q: FirebaseFirestore.Query) => Promise.all([
    countOf(q.where('registrationSource', '==', 'online')),
    countOf(q.where('registrationSource', '==', 'walkin')),
  ])

  const [lifetimePair, ...statusPairs] = await Promise.all([
    pair(base),
    ...COMPOSITION_STATUSES.map(s => pair(base.where('status', '==', s))),
  ])

  const [lo, lw] = lifetimePair
  const lifetime: SourceCounts = { online: lo, walkin: lw, unrecorded: remainder(totals.total, lo, lw) }

  const byStatus = Object.fromEntries(COMPOSITION_STATUSES.map((s, i) => {
    const [o, w] = statusPairs[i]
    return [s, { online: o, walkin: w, unrecorded: remainder(totals[s], o, w) }]
  })) as Record<CompositionStatus, SourceCounts>

  // Nothing answered ⇒ the collection could not be read at all; the block is null, which
  // the contract distinguishes from "measured, and every figure happens to be zero".
  const anyMeasured = lo !== null || lw !== null || statusPairs.some(([o, w]) => o !== null || w !== null)
  return anyMeasured ? { lifetime, byStatus } : null
}
