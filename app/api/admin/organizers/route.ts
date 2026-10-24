// GET /api/admin/organizers
//
// Admin-only, cursor-paginated list of organizers (users/{uid}).
//
// Query params:
//   pageSize — results per page (default 25, max 100)
//   cursor   — last uid from the previous page (createdAt-desc cursor)
//   search   — case-insensitive substring over name / email / organizationName
//   status   — 'active' | 'pending' | 'suspended' | 'banned' (effective; missing → active)
//              Organizer visibility (Option A): the default, unfiltered list is EVERY
//              organizer, pending signups included — each row carries
//              `pendingVerification` so the console badges it instead of hiding it. The
//              'pending' filter still narrows to them. This makes "All" the same population
//              the admin stats organizer count already reports.
//
// Legacy rows: a document WITHOUT `createdAt` is invisible to orderBy('createdAt'). Once the
// createdAt-ordered scan is exhausted, a second pass ordered by document id returns ONLY the
// documents that lack the field (cursor prefix '~legacy:'), so they are listed last instead
// of never. Nothing is written to them.
//
// Search + status are applied IN MEMORY per fetched page (Firestore has no
// substring search, and 'active' is the absence of a field which can't be
// queried directly). The cursor advances over the RAW scan so pagination keeps
// working under filtering — the client pages until nextCursor is null. The base
// query stays lightweight (only pageSize+1 docs read per request).

import { NextRequest, NextResponse } from 'next/server'
import type { DocumentSnapshot }     from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { isOrganizer }               from '@/lib/organizer/identity'
import {
  resolveAccountStatus,
  resolveEmailVerification,
  isPendingVerification,
  isStatusRecorded,
  type AccountStatus,
  type AdminOrganizerSummary,
  type AdminOrganizersListResponse,
} from '@/lib/admin/organizerTypes'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

interface UserDoc {
  [k: string]:       unknown
  role?:             unknown
  name?:             string
  email?:            string
  organizationName?: string
  accountStatus?:    unknown
  statusReason?:     string
  createdAt?:        unknown
}

// RD-ORGANIZER-SIGNUP-02 · the local copy of this rule was one of three that each
// coerced an unrecognised value to 'active'. It now delegates to the one resolver that
// lives beside the type (lib/admin/organizerTypes.ts), so a new lifecycle value can
// never read as 'active' here by omission.
const effectiveStatus = resolveAccountStatus

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10)))
  const cursor   = searchParams.get('cursor') ?? ''
  const search   = (searchParams.get('search') ?? '').trim().toLowerCase()
  const statusRaw = searchParams.get('status') ?? ''
  const status: AccountStatus | null =
    statusRaw === 'active' || statusRaw === 'pending'
    || statusRaw === 'suspended' || statusRaw === 'banned' ? statusRaw : null

  // ── Scan-until-enough (RD-AUTH-01 Phase 5 / M-C + M-D) ──────────────────────
  // Previously status/search were filtered in memory AFTER a pageSize+1 limit, so a
  // page could come back short (or empty) even when matches existed further down. We
  // now scan the users collection in bounded batches, applying the canonical
  // isOrganizer() definition + status + search per doc, until we've collected pageSize
  // matches or the collection is exhausted. The cursor still advances over the RAW scan
  // and the {items, nextCursor} contract is unchanged. No new Firestore index is needed
  // (substring search + 'active' = absence-of-field can't be pushed down).
  const SCAN_BATCH = Math.max(pageSize, 50)   // raw docs read per iteration
  const SCAN_CAP   = 2000                       // safety ceiling on docs scanned per request

  const matchesSearch = (i: AdminOrganizerSummary): boolean =>
    !search ||
    i.name.toLowerCase().includes(search) ||
    i.email.toLowerCase().includes(search) ||
    i.organizationName.toLowerCase().includes(search)

  const items: AdminOrganizerSummary[] = []
  let scanAfter: DocumentSnapshot | null = null
  let lastRawId: string | null = null
  let scanned = 0
  let exhausted = false

  // Resume from the caller's cursor: a plain uid continues the createdAt-ordered pass (the
  // pre-existing contract); '~legacy:<uid>' continues the second pass over documents that
  // have no createdAt (and '~legacy:' starts it).
  const LEGACY = '~legacy:'
  let legacyPhase = cursor.startsWith(LEGACY)
  const cursorUid = legacyPhase ? cursor.slice(LEGACY.length) : cursor
  if (cursorUid) {
    const curSnap = await adminDb.doc(`users/${cursorUid}`).get()
    if (curSnap.exists) scanAfter = curSnap
  }

  while (items.length < pageSize && scanned < SCAN_CAP) {
    let q = legacyPhase
      ? adminDb.collection('users').orderBy('__name__').limit(SCAN_BATCH)
      : adminDb.collection('users').orderBy('createdAt', 'desc').limit(SCAN_BATCH)
    if (scanAfter) q = q.startAfter(scanAfter) as typeof q
    const snap = await q.get()
    let pageFull = false

    for (const doc of snap.docs) {
      scanned++
      lastRawId = doc.id
      scanAfter = doc
      const d = doc.data() as UserDoc
      // pass 2 lists ONLY the documents pass 1 cannot see (no createdAt field at all)
      if (legacyPhase && Object.prototype.hasOwnProperty.call(d, 'createdAt')) continue
      if (!isOrganizer(d)) continue                    // canonical organizer definition (M-C)
      const accountStatus     = effectiveStatus(d.accountStatus)
      const emailVerification = resolveEmailVerification(d)
      const item: AdminOrganizerSummary = {
        uid:              doc.id,
        name:             typeof d.name === 'string' ? d.name : '',
        email:            typeof d.email === 'string' ? d.email : '',
        organizationName: typeof d.organizationName === 'string' ? d.organizationName : '',
        accountStatus,
        statusReason:     typeof d.statusReason === 'string' ? d.statusReason : null,
        createdAt:        tsToISO(d.createdAt),
        statusRecorded:      isStatusRecorded(d.accountStatus),
        emailVerification,
        pendingVerification: isPendingVerification(accountStatus, emailVerification),
      }
      // Option A · the unfiltered list includes pending signups (badged, not hidden);
      // a status filter still narrows to exactly that effective status.
      if (status && item.accountStatus !== status) continue
      if (!matchesSearch(item)) continue
      items.push(item)
      if (items.length >= pageSize) { pageFull = true; break }
    }

    if (pageFull) break
    if (snap.docs.length < SCAN_BATCH) {
      if (legacyPhase) { exhausted = true; break }
      // createdAt pass exhausted → continue with the legacy pass from the beginning
      legacyPhase = true
      scanAfter = null
      lastRawId = null
    }
  }

  // Cursor advances over the raw scan. null once BOTH passes are exhausted; otherwise the
  // last raw uid scanned, prefixed in the legacy pass (the client keeps paging until null).
  // If the scan cap was hit before filling the page, the cursor is still returned so
  // nothing is dropped.
  const nextCursor = exhausted
    ? null
    : legacyPhase ? `${LEGACY}${lastRawId ?? ''}` : lastRawId

  return NextResponse.json({ items, nextCursor } satisfies AdminOrganizersListResponse)
}
