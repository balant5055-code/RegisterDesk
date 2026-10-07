// GET /api/organizer/dashboard/activity?eventId=&cursor=
//
// Pages the dashboard's Recent Activity feed.
//
// ═══ WHY THIS EXISTS RATHER THAN A PARAMETER ON THE DASHBOARD ROUTE ══════════
// /api/organizer/dashboard runs roughly forty reads to assemble one screen. Turning a page
// of a ten-row feed must not re-run them. This endpoint shares the SAME reader
// (lib/dashboard/activityFeed) and the SAME scope resolution as page 1, so it is one
// implementation with a cheap second entry point — not a second feed.
//
// The scope rules are re-derived here from the caller's own workspace, never trusted from
// the query string: `eventId` is a REQUEST, and it is resolved against
// `users/{workspaceUid}/eventDrafts/{eventId}` exactly as the dashboard route resolves it.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { isArchivedTabEvent } from '@/lib/events/listingTabs'
import { readActivityPage, ACTIVITY_PAGE_SIZE } from '@/lib/dashboard/activityFeed'
import { resolveOwnedEventSlugs } from '@/lib/events/liveEventRef'

export const dynamic = 'force-dynamic'

/** The feed window. Must match the dashboard route's, or page 1 and page 2 disagree. */
const WINDOW_DAYS = 90

/** Ceiling on the draft enumeration. An organizer's event list is small and bounded. */
const MAX_DRAFTS = 500

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const uid = authz.workspaceUid
  const requestedEventId = req.nextUrl.searchParams.get('eventId')
  // Length-capped before it reaches Firestore or the decoder; an oversized cursor is simply
  // not a cursor, and decoding failure already degrades to page 1.
  const cursor = (req.nextUrl.searchParams.get('cursor') ?? '').slice(0, 512) || null

  let drafts: Array<{ id: string; data: Record<string, unknown> }>
  try {
    const snap = await adminDb.collection('users').doc(uid).collection('eventDrafts')
      .orderBy('updatedAt', 'desc').limit(MAX_DRAFTS).get()
    drafts = snap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }))
  } catch {
    return NextResponse.json({ error: 'Could not load activity.' }, { status: 500 })
  }

  // The SAME canonical set the dashboard aggregates over: published, and not filed under the
  // Archived tab. An archived event's registrations do not belong in this feed.
  // RD-CE-FIX C1 — the SAME verified slug rule as the dashboard's page one: only slugs the live
  // documents prove belong to THIS workspace's drafts (the draft pointer is client-writable).
  const ownedSlugs = await resolveOwnedEventSlugs(uid, drafts)
  const dashboardSlugs = drafts
    .filter(d => d.data.publishedAt && !isArchivedTabEvent(d.data))
    .map(d => ownedSlugs.get(d.id) ?? null)
    .filter((s): s is string => !!s)

  // An explicitly selected event is answered even when the archive rule excludes it from the
  // workspace set — an organizer reviewing a finished event selected it by name.
  const selected = requestedEventId ? drafts.find(d => d.id === requestedEventId) ?? null : null
  if (requestedEventId && !selected) {
    return NextResponse.json({ error: 'Event not found in this workspace.' }, { status: 403 })
  }
  const selectedSlug = selected ? ownedSlugs.get(selected.id) ?? null : null

  // A selected draft with no slug was never published: it can have no registrations, so the
  // honest answer is an empty page rather than an unscoped workspace feed.
  if (selected && !selectedSlug) {
    return NextResponse.json(
      { items: [], pageSize: ACTIVITY_PAGE_SIZE, hasMore: false, nextCursor: null, skipped: 0, exact: true },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  let page
  try {
    page = await readActivityPage({
      organizerUid: uid,
      eventSlug:    selectedSlug,
      dashboardSlugs,
      since:        new Date(Date.now() - WINDOW_DAYS * 86_400_000),
      // RD-ANALYTICS-12-17 · the union that already grants attendee names in this product:
      // `registrations` (registration lists and exports) or `transactions` (payment issues).
      // Neither ⇒ the name is not read and not returned. See ActivityScope for the reasoning.
      canReadAttendeeName: authz.permissions.includes('registrations')
                        || authz.permissions.includes('transactions'),
    }, { cursor })
  } catch {
    return NextResponse.json({ error: 'Could not load activity.' }, { status: 500 })
  }

  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
