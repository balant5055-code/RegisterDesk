// GET /api/organizer/notifications
//
// The organizer Notification Center feed (Phase H.4.3). Reads the per-workspace
// inbox `users/{workspaceUid}/notifications`, mirroring the cursor-pagination
// convention of /api/organizer/events. Any active workspace member or the owner
// may read (authorizeAnyWorkspace); categories are permission-filtered via the
// catalog so finance-sensitive items stay scoped. Filters (category / eventId /
// search / unread) are applied in-process so NO composite index is required.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }              from '@/lib/firebase/admin'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { toISO }                from '@/lib/reports/format'
import { isNotificationCategory, canSeeCategory, visibleCategories } from '@/lib/notifications/inbox/catalog'
import type { NotificationDoc, NotificationView, NotificationFeedResponse } from '@/lib/notifications/inbox/types'

const DEFAULT_PAGE_SIZE = 20
const UNREAD_SCAN_CAP    = 200   // bounded scan for the unread badge (index-free)

function toView(id: string, d: NotificationDoc & { createdAt?: unknown }): NotificationView {
  return {
    id,
    category:       d.category,
    type:           d.type,
    title:          d.title,
    body:           d.body,
    severity:       d.severity,
    actionRequired: d.actionRequired ?? false,
    link:           d.link ?? null,
    eventId:        d.eventId ?? null,
    eventName:      d.eventName ?? null,
    read:           d.read ?? false,
    createdAt:      toISO(d.createdAt),
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const url        = new URL(req.url)
  const cursorId   = url.searchParams.get('cursor')
  const categoryQ  = url.searchParams.get('category')
  const eventIdQ   = url.searchParams.get('eventId')
  const search     = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const unreadOnly = url.searchParams.get('unread') === 'true'
  const limitParam = Number(url.searchParams.get('limit'))
  const pageSize   = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 100
    ? Math.floor(limitParam) : DEFAULT_PAGE_SIZE

  const allowed = new Set(visibleCategories(authz.permissions))
  // A category filter must also be permission-visible.
  const categoryFilter = categoryQ && isNotificationCategory(categoryQ) && allowed.has(categoryQ)
    ? categoryQ : null

  const base = adminDb.collection(`users/${uid}/notifications`).orderBy('createdAt', 'desc')

  let query = base
  if (cursorId) {
    const cursorSnap = await adminDb.doc(`users/${uid}/notifications/${cursorId}`).get()
    if (cursorSnap.exists) query = query.startAfter(cursorSnap)
  }

  const pageSnap   = await query.limit(pageSize + 1).get()
  const hasMore    = pageSnap.docs.length > pageSize
  const pageDocs   = hasMore ? pageSnap.docs.slice(0, pageSize) : pageSnap.docs
  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]!.id : null

  const notifications: NotificationView[] = []
  for (const doc of pageDocs) {
    const d = doc.data() as NotificationDoc & { createdAt?: unknown }
    if (!allowed.has(d.category)) continue                                   // permission gate
    if (categoryFilter && d.category !== categoryFilter) continue
    if (eventIdQ && d.eventId !== eventIdQ) continue
    if (unreadOnly && d.read) continue
    if (search) {
      const hay = `${d.title} ${d.body} ${d.eventName ?? ''}`.toLowerCase()
      if (!hay.includes(search)) continue
    }
    notifications.push(toView(doc.id, d))
  }

  // Unread badge: bounded, index-free scan of the most recent notifications
  // (computed on the first page only; the client keeps it while paginating).
  let unreadCount = 0
  if (!cursorId) {
    const scan = await base.limit(UNREAD_SCAN_CAP).get()
    for (const doc of scan.docs) {
      const d = doc.data() as NotificationDoc
      if (!d.read && canSeeCategory(d.category, authz.permissions)) unreadCount++
    }
  }

  return NextResponse.json({ notifications, nextCursor, unreadCount } satisfies NotificationFeedResponse)
}
