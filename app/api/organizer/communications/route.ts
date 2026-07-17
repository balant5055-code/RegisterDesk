// GET /api/organizer/communications
//
// READ-ONLY data source for the organizer Communication Center. Reads the unified
// communication log (emailLogs — email + WhatsApp) for the workspace, applies the
// requested filters, and returns the notification rows plus KPI / usage rollups.
// It sends nothing and mutates nothing.
//
// Query params (all optional): event, dateFrom, dateTo, channel, status,
// notificationType, recipient, limit.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { NOTIFICATION_META }         from '@/lib/notifications'
import type { NotificationType }     from '@/lib/notifications'
import type { CommunicationChannel, EmailLogStatus } from '@/lib/email-logs/types'

// Attendee-directed email template keys (not NotificationType values).
const ATTENDEE_TEMPLATE_KEYS = new Set([
  'registration_confirmation', 'registration_submitted', 'registration_approved',
  'registration_rejected', 'registration_cancelled', 'refund_confirmed',
  'waitlist_joined', 'spot_available',
])

export type CommAudience = 'attendee' | 'organizer' | 'platform'

export interface CommRow {
  id:                string
  createdAt:         string
  eventSlug:         string
  eventName:         string
  recipientName:     string
  recipientEmail:    string
  recipientPhone:    string
  notificationType:  string
  channel:           CommunicationChannel
  status:            EmailLogStatus
  provider:          string
  providerMessageId: string
  costPaise:         number
  audience:          CommAudience
  subject:           string
  error:             string
  registrationId:    string
}

export interface CommKpis {
  emailsSent:          number
  whatsappSent:        number
  failed:              number
  skipped:             number
  deliverySuccessRate: number   // 0–100, over sent+failed (skips excluded)
  whatsappChargesPaise: number
  platformFree:        number
  organizerFree:       number
}

export interface CommUsage {
  emailsFree:              number
  whatsappPaid:            number
  walletDeductionPaise:    number   // total across the returned window
  walletDeductionThisMonthPaise: number
  platformFree:            number
  organizerFree:           number
  attendeePaidPaise:       number
}

function tsToIso(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date(0).toISOString()
}

function audienceOf(templateKey: string): CommAudience {
  if (ATTENDEE_TEMPLATE_KEYS.has(templateKey)) return 'attendee'
  const meta = NOTIFICATION_META[templateKey as NotificationType]
  if (meta) {
    if (meta.group === 'attendee') return 'attendee'
    if (meta.group === 'platform') return 'organizer'   // platform → organizer
  }
  return 'platform'
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const sp               = req.nextUrl.searchParams
  const fEvent           = sp.get('event')            ?? ''
  const fChannel         = sp.get('channel')          ?? ''
  const fStatus          = sp.get('status')           ?? ''
  const fType            = sp.get('notificationType') ?? ''
  const fRecipient       = (sp.get('recipient')       ?? '').toLowerCase().trim()
  const dateFrom         = sp.get('dateFrom')         ?? ''
  const dateTo           = sp.get('dateTo')           ?? ''
  const rawLimit         = parseInt(sp.get('limit') ?? '500', 10)
  const limit            = Math.min(isNaN(rawLimit) ? 500 : rawLimit, 1000)

  let query = adminDb.collection('emailLogs')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc') as FirebaseFirestore.Query

  if (dateFrom) { const f = new Date(dateFrom); f.setHours(0, 0, 0, 0);    query = query.where('createdAt', '>=', f) }
  if (dateTo)   { const t = new Date(dateTo);   t.setHours(23, 59, 59, 999); query = query.where('createdAt', '<=', t) }

  const snap = await query.limit(limit).get()

  const now       = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const rows: CommRow[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const channel = (d.channel === 'whatsapp' ? 'whatsapp' : 'email') as CommunicationChannel
    const templateKey = typeof d.templateKey === 'string' ? d.templateKey : ''
    const row: CommRow = {
      id:                doc.id,
      createdAt:         tsToIso(d.createdAt),
      eventSlug:         typeof d.eventSlug === 'string' ? d.eventSlug : '',
      eventName:         typeof d.eventName === 'string' ? d.eventName : '',
      recipientName:     typeof d.recipientName  === 'string' ? d.recipientName  : '',
      recipientEmail:    typeof d.recipientEmail === 'string' ? d.recipientEmail : '',
      recipientPhone:    typeof d.recipientPhone === 'string' ? d.recipientPhone : '',
      notificationType:  templateKey,
      channel,
      status:            (typeof d.status === 'string' ? d.status : 'queued') as EmailLogStatus,
      provider:          typeof d.provider === 'string' ? d.provider : '',
      providerMessageId: typeof d.providerMessageId === 'string' ? d.providerMessageId : '',
      costPaise:         typeof d.costPaise === 'number' ? d.costPaise : 0,
      audience:          audienceOf(templateKey),
      subject:           typeof d.subject === 'string' ? d.subject : '',
      error:             typeof d.error === 'string' ? d.error : '',
      registrationId:    typeof d.registrationId === 'string' ? d.registrationId : '',
    }

    // ── In-memory filters (single composite index kept for the query above) ────
    if (fEvent    && row.eventSlug !== fEvent)         continue
    if (fChannel  && row.channel !== fChannel)         continue
    if (fStatus   && row.status !== fStatus)           continue
    if (fType     && row.notificationType !== fType)   continue
    if (fRecipient) {
      const hay = `${row.recipientEmail} ${row.recipientPhone} ${row.recipientName}`.toLowerCase()
      if (!hay.includes(fRecipient)) continue
    }
    rows.push(row)
  }

  // ── KPIs + usage over the filtered result set ────────────────────────────────
  const kpis: CommKpis = {
    emailsSent: 0, whatsappSent: 0, failed: 0, skipped: 0,
    deliverySuccessRate: 0, whatsappChargesPaise: 0, platformFree: 0, organizerFree: 0,
  }
  const usage: CommUsage = {
    emailsFree: 0, whatsappPaid: 0, walletDeductionPaise: 0, walletDeductionThisMonthPaise: 0,
    platformFree: 0, organizerFree: 0, attendeePaidPaise: 0,
  }

  let sent = 0, failed = 0
  for (const r of rows) {
    if (r.status === 'failed')  { kpis.failed++;  failed++ }
    if (r.status === 'skipped')   kpis.skipped++
    if (r.status === 'sent' || r.status === 'delivered') {
      sent++
      if (r.channel === 'email')    { kpis.emailsSent++;   usage.emailsFree++ }
      if (r.channel === 'whatsapp') { kpis.whatsappSent++; if (r.costPaise > 0) usage.whatsappPaid++ }
    }
    if (r.channel === 'email') { /* free */ } else if (r.costPaise === 0) { /* free whatsapp */ }

    kpis.whatsappChargesPaise += r.costPaise
    usage.walletDeductionPaise += r.costPaise
    if (r.costPaise > 0) usage.attendeePaidPaise += r.costPaise
    if (new Date(r.createdAt).getTime() >= monthStart) usage.walletDeductionThisMonthPaise += r.costPaise

    if (r.audience === 'platform') { kpis.platformFree++;  usage.platformFree++ }
    if (r.audience === 'organizer') { kpis.organizerFree++; usage.organizerFree++ }
  }
  kpis.deliverySuccessRate = sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : 0

  // Distinct events present in the result (for the filter dropdown).
  const eventMap = new Map<string, string>()
  for (const r of rows) if (r.eventSlug) eventMap.set(r.eventSlug, r.eventName || r.eventSlug)
  const events = [...eventMap].map(([slug, name]) => ({ slug, name }))

  return NextResponse.json(
    { success: true, rows, kpis, usage, events, capped: snap.size >= limit },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
