// GET /api/admin/organizers
//
// Admin-only, cursor-paginated list of organizers (users/{uid}).
//
// Query params:
//   pageSize — results per page (default 25, max 100)
//   cursor   — last uid from the previous page (createdAt-desc cursor)
//   search   — case-insensitive substring over name / email / organizationName
//   status   — 'active' | 'suspended' | 'banned' (effective; missing → active)
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
import type {
  AccountStatus,
  AdminOrganizerSummary,
  AdminOrganizersListResponse,
} from '@/lib/admin/organizerTypes'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

interface UserDoc {
  role?:             unknown
  name?:             string
  email?:            string
  organizationName?: string
  accountStatus?:    AccountStatus
  statusReason?:     string
  createdAt?:        unknown
}

function effectiveStatus(s: AccountStatus | undefined): AccountStatus {
  return s === 'suspended' || s === 'banned' ? s : 'active'
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10)))
  const cursor   = searchParams.get('cursor') ?? ''
  const search   = (searchParams.get('search') ?? '').trim().toLowerCase()
  const statusRaw = searchParams.get('status') ?? ''
  const status: AccountStatus | null =
    statusRaw === 'active' || statusRaw === 'suspended' || statusRaw === 'banned' ? statusRaw : null

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

  // Resume from the caller's cursor (last uid of the previous scan).
  if (cursor) {
    const curSnap = await adminDb.doc(`users/${cursor}`).get()
    if (curSnap.exists) scanAfter = curSnap
  }

  while (items.length < pageSize && scanned < SCAN_CAP) {
    let q = adminDb.collection('users').orderBy('createdAt', 'desc').limit(SCAN_BATCH)
    if (scanAfter) q = q.startAfter(scanAfter) as typeof q
    const snap = await q.get()
    if (snap.empty) { exhausted = true; break }

    for (const doc of snap.docs) {
      scanned++
      lastRawId = doc.id
      scanAfter = doc
      const d = doc.data() as UserDoc
      if (!isOrganizer(d)) continue                    // canonical organizer definition (M-C)
      const item: AdminOrganizerSummary = {
        uid:              doc.id,
        name:             d.name ?? '',
        email:            d.email ?? '',
        organizationName: d.organizationName ?? '',
        accountStatus:    effectiveStatus(d.accountStatus),
        statusReason:     d.statusReason ?? null,
        createdAt:        tsToISO(d.createdAt),
      }
      if (status && item.accountStatus !== status) continue
      if (!matchesSearch(item)) continue
      items.push(item)
      if (items.length >= pageSize) break
    }

    if (snap.docs.length < SCAN_BATCH) { exhausted = true; break }
  }

  // Cursor advances over the raw scan. null once the collection is exhausted; otherwise
  // the last raw uid scanned (the client keeps paging until it's null). If the scan cap
  // was hit before filling the page, the cursor is still returned so nothing is dropped.
  const nextCursor = exhausted ? null : lastRawId

  return NextResponse.json({ items, nextCursor } satisfies AdminOrganizersListResponse)
}
