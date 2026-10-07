// GET /api/organizer/wallet/usage
// Returns communication usage history for the organizer.
//
// RD-WALLET-REQ — optional, all additive: `event=<draftId>` (the workspace's own draft; records are
// attributed ONLY by the `eventSlug` every writer sets — `eventId` is inconsistent historically, so
// it is never used to attribute), `channel`, `from` / `to` (YYYY-MM-DD, India time) and `cursor`.
// Bounded per request by lib/wallet/activityScan.ts. Without them the behaviour is unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import type { CommunicationUsage, CommChannel } from '@/lib/wallet/types'
import { scanActivity, dayBound }   from '@/lib/wallet/activityScan'

const CHANNELS = new Set(['email', 'whatsapp', 'sms'])

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

function docToUsage(id: string, d: Record<string, unknown>): CommunicationUsage {
  return {
    id,
    organizerUid: typeof d.organizerUid === 'string' ? d.organizerUid : '',
    eventId:      typeof d.eventId      === 'string' ? d.eventId      : '',
    eventSlug:    typeof d.eventSlug    === 'string' ? d.eventSlug    : '',
    eventName:    typeof d.eventName    === 'string' ? d.eventName    : '',
    channel:      (d.channel as CommChannel) ?? 'email',
    quantity:     typeof d.quantity     === 'number' ? d.quantity     : 0,
    costPaise:    typeof d.costPaise    === 'number' ? d.costPaise    : 0,
    campaignId:   typeof d.campaignId   === 'string' ? d.campaignId   : '',
    templateKey:  typeof d.templateKey  === 'string' ? d.templateKey  : '',
    createdAt:    tsToIso(d.createdAt),
  }
}

export type GetCommUsageResponse =
  | { success: true;  usage: CommunicationUsage[]; nextCursor?: string | null; scanLimited?: boolean; event?: { draftId: string; name: string; slug: string | null } }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetCommUsageResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = new URL(req.url)
  const limitParam = parseInt(searchParams.get('limit') ?? '100', 10)
  const limit      = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 100, 1), 500)
  const channelParam = searchParams.get('channel')
  const channel    = channelParam && CHANNELS.has(channelParam) ? channelParam : null
  const from       = dayBound(searchParams.get('from'), 'start')
  const to         = dayBound(searchParams.get('to'), 'end')
  if (from && to && from > to) return NextResponse.json({ success: false, error: 'The start date is after the end date.' }, { status: 400 })

  let event: { draftId: string; name: string; slug: string | null } | null = null
  const eventParam = searchParams.get('event')
  if (eventParam !== null) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventParam)) return NextResponse.json({ success: false, error: 'Invalid event.' }, { status: 400 })
    const draft = await adminDb.doc(`users/${uid}/eventDrafts/${eventParam}`).get()
    if (!draft.exists) return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })
    const details = ((draft.data() as Record<string, unknown>).eventDetails ?? {}) as Record<string, Record<string, unknown> | undefined>
    event = {
      draftId: draft.id,
      // RD-INTEG — the slug only once events/{slug} confirms THIS organizer and THIS draft (the
      // draft's own urlSlug is client-writable, so it could name another event's records).
      slug: await resolveOwnedEventSlug(uid, draft.id, draft.data() as Record<string, unknown>),
      name: typeof details.info?.name === 'string' ? details.info.name : 'Untitled event',
    }
    // No public slug yet: nothing can be attributed to it.
    if (!event.slug) return NextResponse.json({ success: true, usage: [], nextCursor: null, scanLimited: false, event })
  }

  const slug = event?.slug ?? null
  const filtered = slug !== null || channel !== null
  const page = await scanActivity({
    collection: 'communicationUsage', uid, limit, cursor: searchParams.get('cursor'), from, to,
    keep: filtered ? d => (slug === null || d.eventSlug === slug) && (channel === null || d.channel === channel) : null,
    map: docToUsage,
  })
  return NextResponse.json({
    success: true, usage: page.rows, nextCursor: page.nextCursor,
    ...(event ? { event } : {}),
    ...(filtered ? { scanLimited: page.scanLimited } : {}),
  })
}
