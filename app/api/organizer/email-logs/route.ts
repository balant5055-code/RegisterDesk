// GET /api/organizer/email-logs
//
// Returns up to 200 emailLogs entries for the authenticated organizer.
// Supports optional query params:
//   status        — queued|sent|delivered|failed
//   templateKey   — e.g. registration_submitted
//   dateFrom      — ISO date string (inclusive)
//   dateTo        — ISO date string (inclusive, end of day)
//   limit         — max 200 (default 100)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import type { EmailLog }             from '@/lib/email-logs/types'
import { authorizeWorkspace }        from '@/lib/team/workspace'

type GetResponse =
  | { success: true;  logs: EmailLog[]; total: number }
  | { success: false; error: string }

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

export async function GET(req: NextRequest): Promise<NextResponse<GetResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = req.nextUrl

  // ═══ RD-COMM-02 · per-event activity counts ══════════════════════════════════
  //
  // The event Communications surface shows Sent / Delivered / Failed for ONE
  // event. Three `count()` aggregates answer that exactly at any event size —
  // equality-only filters, which Firestore serves by merging single-field
  // indexes, so there is no composite to deploy and no migration.
  //
  // It lives on this route rather than a new one because the collection, the
  // permission (`broadcasts`) and the workspace scope are already resolved here.
  // `uid` is server-derived: a forged `eventSlug` can only ever narrow the
  // caller's OWN logs, never reach another organizer's.
  //
  // Each figure is `number | null`. A failed aggregate stays null and the client
  // renders "unable to load" — it is never coerced to 0, because 0 would tell an
  // organizer nothing was sent when in fact nothing was read.
  const countsFor = searchParams.get('eventSlug') ?? ''
  if (countsFor && searchParams.get('counts') === '1') {
    const scoped = adminDb.collection('emailLogs')
      .where('organizerUid', '==', uid)
      .where('eventSlug', '==', countsFor)
    const countOf = (s: string) =>
      scoped.where('status', '==', s).count().get()
        .then(r => r.data().count as number)
        .catch(() => null)
    // RD-INTEG — the finer figures: queued (pending), timeouts (delivery UNKNOWN — counted
    // apart from failed), and the WhatsApp share (the rest is email; a row with no channel is
    // email). Each is its own exact aggregate; a failed one stays null.
    const run = (q: FirebaseFirestore.Query) => q.count().get().then(r => r.data().count as number).catch(() => null)
    const wa = scoped.where('channel', '==', 'whatsapp')
    const [sent, delivered, failed, pending, unknown, waSent, waDelivered, waFailed, waUnknown] = await Promise.all([
      countOf('sent'), countOf('delivered'), countOf('failed'), countOf('queued'),
      run(scoped.where('status', '==', 'failed').where('deliveryUnknown', '==', true)),
      run(wa.where('status', '==', 'sent')), run(wa.where('status', '==', 'delivered')),
      run(wa.where('status', '==', 'failed')), run(wa.where('status', '==', 'failed').where('deliveryUnknown', '==', true)),
    ])
    return NextResponse.json(
      { success: true, counts: { sent, delivered, failed, pending, unknown,
        whatsapp: { sent: waSent, delivered: waDelivered, failed: waFailed, unknown: waUnknown } } } as unknown as GetResponse,
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const status      = searchParams.get('status')      ?? ''
  const templateKey = searchParams.get('templateKey') ?? ''
  // RD-COMM-04 · the event filter. RD-COMM-02 routed the event to this page but
  // nothing ever narrowed the query, so the list still showed every event. This is
  // the SAME parameter and the SAME predicate the WhatsApp logs route already uses
  // on this very collection — one pattern, not a second implementation.
  //
  // ⚠ COMPOSITE INDEXES REQUIRED IN PRODUCTION. This filter combines with
  // `orderBy('createdAt','desc')`, so Firestore cannot serve it by merging
  // single-field indexes. `organizerUid, eventSlug, status, createdAt DESC` and these
  // three are defined in firestore.indexes.json (RD-COMMS-FINAL) and must be DEPLOYED:
  //
  //   organizerUid, eventSlug,                      createdAt DESC
  //   organizerUid, eventSlug, templateKey,         createdAt DESC
  //   organizerUid, eventSlug, status, templateKey, createdAt DESC
  //
  // The emulator does not enforce indexes, so tests pass without them. Until they
  // are deployed, an event filter with "All Statuses" fails in production.
  const eventFilter = searchParams.get('eventSlug')   ?? ''
  const dateFrom    = searchParams.get('dateFrom')    ?? ''
  const dateTo      = searchParams.get('dateTo')      ?? ''
  const rawLimit    = parseInt(searchParams.get('limit') ?? '100', 10)
  const limit       = Math.min(isNaN(rawLimit) ? 100 : rawLimit, 200)

  // Build Firestore query
  let query = adminDb.collection('emailLogs')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc') as FirebaseFirestore.Query

  if (status)      query = query.where('status',      '==', status)
  if (templateKey) query = query.where('templateKey', '==', templateKey)
  // Applied to the QUERY, before the limit — so an event-filtered page is a full
  // page of THAT event, never a page of everything with the others removed after.
  if (eventFilter) query = query.where('eventSlug',   '==', eventFilter)

  if (dateFrom) {
    const from = new Date(dateFrom)
    from.setHours(0, 0, 0, 0)
    query = query.where('createdAt', '>=', from)
  }
  if (dateTo) {
    const to = new Date(dateTo)
    to.setHours(23, 59, 59, 999)
    query = query.where('createdAt', '<=', to)
  }

  const snap = await query.limit(limit).get()

  // RD-WA-LOGS-01 — WhatsApp rows live in this same collection and now have their own page.
  // Filtered IN MEMORY, deliberately: a Firestore `channel != 'whatsapp'` would exclude every
  // document MISSING the field, and most legacy email rows have no `channel` at all — the
  // query would silently hide the entire email history. The trade is that a page may render
  // slightly fewer than `limit` rows, which is cosmetic.
  const emailDocs = snap.docs.filter(doc => doc.data().channel !== 'whatsapp')

  const logs: EmailLog[] = emailDocs.map(doc => {
    const d = doc.data()
    return {
      id:                doc.id,
      organizerUid:      typeof d.organizerUid      === 'string' ? d.organizerUid      : '',
      eventId:           typeof d.eventId            === 'string' ? d.eventId            : '',
      eventSlug:         typeof d.eventSlug          === 'string' ? d.eventSlug          : '',
      eventName:         typeof d.eventName          === 'string' ? d.eventName          : '',
      templateKey:       typeof d.templateKey        === 'string' ? d.templateKey        : '',
      recipientEmail:    typeof d.recipientEmail     === 'string' ? d.recipientEmail     : '',
      recipientName:     typeof d.recipientName      === 'string' ? d.recipientName      : '',
      subject:           typeof d.subject            === 'string' ? d.subject            : '',
      status:            typeof d.status             === 'string' ? d.status             : 'queued',
      provider:          typeof d.provider           === 'string' ? d.provider           : '',
      providerMessageId: typeof d.providerMessageId  === 'string' ? d.providerMessageId  : undefined,
      error:             typeof d.error              === 'string' ? d.error              : undefined,
      registrationId:    typeof d.registrationId     === 'string' ? d.registrationId     : '',
      // RD-COMMS-P2-F — the outcome was never confirmed (RD-COMMS-P2-D); the page shows it as such.
      ...(d.deliveryUnknown === true ? { deliveryUnknown: true } : {}),
      createdAt:         tsToIso(d.createdAt),
      updatedAt:         tsToIso(d.updatedAt),
    } as EmailLog
  })

  return NextResponse.json({ success: true, logs, total: logs.length })
}
