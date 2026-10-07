// RD-CHECKIN-2.0 — turning operator uids into names, WITHOUT an N+1.
//
// The recent-check-ins strip and the already-checked-in card both need to name the
// person who admitted someone. The registration stores `checkedInBy`, which is a
// uid. The naive implementation reads one document per row; on a twenty-row strip
// that is twenty round-trips, refreshed after every scan, for the whole event.
//
// So: collect the DISTINCT uids first, then fetch them in ONE batched `getAll`.
// Twenty rows written by three operators cost three document reads, not twenty.
//
// A uid that resolves to nothing is returned as null, never as a fabricated name
// and never as the raw uid — an operator id on a gate screen is noise at best and a
// leak of internal identifiers at worst.

import { adminDb } from '@/lib/firebase/admin'

/** Firestore's getAll takes a bounded argument list; this keeps it sane. */
const MAX_OPERATORS = 40

/**
 * Display names for a set of operator uids.
 *
 * Looks in `staffAccounts` first — a gate operator is far more likely to be a staff
 * credential than an organizer — and falls back to `users` for owners and
 * email-invited team members. Both are batched, so the whole resolution is at most
 * two round-trips regardless of how many rows are on screen.
 */
export async function resolveOperatorNames(uids: string[]): Promise<Record<string, string | null>> {
  const distinct = [...new Set(uids.filter(u => typeof u === 'string' && u))].slice(0, MAX_OPERATORS)
  if (distinct.length === 0) return {}

  const out: Record<string, string | null> = {}
  for (const uid of distinct) out[uid] = null

  const staffRefs = distinct.map(u => adminDb.collection('staffAccounts').doc(u))
  const staffSnaps = await adminDb.getAll(...staffRefs).catch(() => [])
  const unresolved: string[] = []
  staffSnaps.forEach((snap, i) => {
    const name = snap.exists ? (snap.data()?.displayName as string | undefined) : undefined
    if (name) out[distinct[i]] = name
    else unresolved.push(distinct[i])
  })

  if (unresolved.length) {
    const userRefs  = unresolved.map(u => adminDb.collection('users').doc(u))
    const userSnaps = await adminDb.getAll(...userRefs).catch(() => [])
    userSnaps.forEach((snap, i) => {
      const d = snap.exists ? snap.data() as Record<string, unknown> : null
      // `name` is what createOrganizerProfile actually writes; the other two are
      // tolerant fallbacks for rows written by other paths, and the organization
      // name is the last resort rather than a preference.
      const name = (typeof d?.name === 'string' && d.name)
        || (typeof d?.fullName === 'string' && d.fullName)
        || (typeof d?.organizationName === 'string' && d.organizationName)
        || null
      if (name) out[unresolved[i]] = name as string
    })
  }

  return out
}
