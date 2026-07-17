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
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
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

  let query = adminDb.collection('users')
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1)

  if (cursor) {
    const curSnap = await adminDb.doc(`users/${cursor}`).get()
    if (curSnap.exists) query = query.startAfter(curSnap) as typeof query
  }

  const snap = await query.get()
  const docs = snap.docs
  const hasMore = docs.length > pageSize
  const pageDocs = hasMore ? docs.slice(0, pageSize) : docs

  let items: AdminOrganizerSummary[] = pageDocs.map(doc => {
    const d = doc.data() as UserDoc
    return {
      uid:              doc.id,
      name:             d.name ?? '',
      email:            d.email ?? '',
      organizationName: d.organizationName ?? '',
      accountStatus:    effectiveStatus(d.accountStatus),
      statusReason:     d.statusReason ?? null,
      createdAt:        tsToISO(d.createdAt),
    } satisfies AdminOrganizerSummary
  })

  if (status) items = items.filter(i => i.accountStatus === status)
  if (search) {
    items = items.filter(i =>
      i.name.toLowerCase().includes(search) ||
      i.email.toLowerCase().includes(search) ||
      i.organizationName.toLowerCase().includes(search),
    )
  }

  // Cursor advances over the raw scan (last page doc), independent of filtering.
  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null

  return NextResponse.json({ items, nextCursor } satisfies AdminOrganizersListResponse)
}
