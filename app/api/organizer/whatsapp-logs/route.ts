// GET /api/organizer/whatsapp-logs
//
// RD-WA-LOGS-01 — the WhatsApp half of the communication log, served on its own.
//
// ═══ WHY A SECOND ROUTE RATHER THAN A FLAG ON email-logs ═════════════════════
// WhatsApp rows live in the SAME `emailLogs` collection (channel discriminator, no new
// collection, no migration) — but the email route serialises an email-shaped record: it
// drops `recipientPhone`, `costPaise`, `providerResponse` and `waStatus`, which are exactly
// the four fields a WhatsApp operator needs. Widening that response would change the email
// contract for every existing consumer. This route owns the WhatsApp projection instead.
//
// ═══ WHY `channel == 'whatsapp'` IS SAFE HERE ════════════════════════════════
// Every WhatsApp writer sets the field explicitly, so equality is complete. The INVERSE is
// what is unsafe: Firestore `!=` excludes documents missing the field, and most legacy email
// rows have no `channel` at all — see the in-memory filter in the email route.
//
// Query params: status, templateKey, dateFrom, dateTo, limit (max 200, default 100).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { sanitizeProviderResponse, parseProviderDiagnostics } from '@/lib/email-logs/whatsappDiagnostics'
import { getWhatsAppTemplate, hasWhatsAppTemplate } from '@/lib/whatsapp/registry'
import { isWalletSkippedWhatsAppLog }  from '@/lib/email-logs/types'
import type { EmailLogStatus, WhatsAppDeliveryStatus } from '@/lib/email-logs/types'

/** The one template a failed row can be retried for. Kept in sync with the retry route. */
const RETRYABLE_TEMPLATE_KEY = 'registration_confirmation'

export interface WhatsAppLog {
  id:                string
  registrationId:    string
  eventId:           string
  eventSlug:         string
  eventName:         string
  templateKey:       string
  /** Approved Meta template name, resolved from the registry — not stored per row. */
  templateName:      string | null
  /** Locale the registry sends for this template (e.g. 'en'). */
  templateLanguage:  string | null
  recipientPhone:    string
  recipientName:     string
  status:            EmailLogStatus
  /** Finer Meta lifecycle from the status webhook: sent | delivered | read | failed. */
  waStatus:          WhatsAppDeliveryStatus | null
  provider:          string
  providerMessageId: string | null
  /** Normalized, organizer-facing reason. */
  error:             string | null
  /** Sanitised compact diagnostics — never contains credentials. */
  providerResponse:  string | null
  /** Meta Graph error code parsed out of the diagnostics, e.g. 132001. */
  errorCode:         number | null
  httpStatus:        number | null
  costPaise:         number
  campaignId:        string | null
  /** True when this row is eligible for the manual retry action. */
  retryAvailable:    boolean
  createdAt:         string
  updatedAt:         string
  deliveredAt:       string | null
  readAt:            string | null
  failedAt:          string | null
}

type GetResponse =
  | { success: true;  logs: WhatsAppLog[]; total: number }
  | { success: false; error: string }

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

function tsToIsoOrNull(ts: unknown): string | null {
  if (!ts) return null
  if (typeof ts === 'string') return ts
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export async function GET(req: NextRequest): Promise<NextResponse<GetResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = req.nextUrl
  const status      = searchParams.get('status')      ?? ''
  const templateKey = searchParams.get('templateKey') ?? ''
  const dateFrom    = searchParams.get('dateFrom')    ?? ''
  const dateTo      = searchParams.get('dateTo')      ?? ''
  const rawLimit    = parseInt(searchParams.get('limit') ?? '100', 10)
  const limit       = Math.min(isNaN(rawLimit) ? 100 : rawLimit, 200)

  let query = adminDb.collection('emailLogs')
    .where('organizerUid', '==', uid)
    .where('channel',      '==', 'whatsapp')
    .orderBy('createdAt', 'desc') as FirebaseFirestore.Query

  if (status)      query = query.where('status',      '==', status)
  if (templateKey) query = query.where('templateKey', '==', templateKey)

  if (dateFrom) {
    const from = new Date(dateFrom)
    if (!isNaN(from.getTime())) query = query.where('createdAt', '>=', from)
  }
  if (dateTo) {
    const to = new Date(dateTo)
    if (!isNaN(to.getTime())) { to.setHours(23, 59, 59, 999); query = query.where('createdAt', '<=', to) }
  }

  const snap = await query.limit(limit).get()

  const logs: WhatsAppLog[] = snap.docs.map(doc => {
    const d = doc.data()
    const key = str(d.templateKey)

    // The registry is the source of truth for the approved template name + locale; storing
    // them per row would let a log drift from what the sender actually uses.
    const def = hasWhatsAppTemplate(key.toUpperCase()) ? getWhatsAppTemplate(key.toUpperCase() as never) : null
    const registryDef = def ?? (key === RETRYABLE_TEMPLATE_KEY
      ? getWhatsAppTemplate('REGISTRATION_CONFIRMATION')
      : null)

    const providerResponse = sanitizeProviderResponse(strOrNull(d.providerResponse) ?? undefined) ?? null
    const { code, httpStatus } = parseProviderDiagnostics(providerResponse ?? undefined)
    const logStatus = (str(d.status) || 'queued') as EmailLogStatus
    const waStatus  = (strOrNull(d.waStatus) as WhatsAppDeliveryStatus | null)

    return {
      id:                doc.id,
      registrationId:    str(d.registrationId),
      eventId:           str(d.eventId),
      eventSlug:         str(d.eventSlug),
      eventName:         str(d.eventName),
      templateKey:       key,
      templateName:      registryDef?.templateName ?? null,
      templateLanguage:  registryDef?.language     ?? null,
      recipientPhone:    str(d.recipientPhone),
      recipientName:     str(d.recipientName),
      status:            logStatus,
      waStatus,
      provider:          str(d.provider) || 'meta',
      providerMessageId: strOrNull(d.providerMessageId),
      error:             strOrNull(d.error),
      providerResponse,
      errorCode:         code,
      httpStatus,
      costPaise:         typeof d.costPaise === 'number' ? d.costPaise : 0,
      campaignId:        strOrNull(d.campaignId),
      // Retry is manual, one template, failed-only. `waStatus === 'sent'` means Meta
      // accepted it, so a row that merely lacks a delivery receipt is NOT retryable.
      // Two histories qualify. `failed` means Meta was asked and refused. `skipped`
      // because the WALLET could not pay means the message never reached Meta at all, so
      // re-sending is the only way the attendee ever receives it.
      //
      // Eligibility reads the row's OWN historical reason and deliberately does NOT consult
      // the current fee or balance — those are re-checked by the SEND path at attempt time.
      // Lowering the fee to zero must not erase why an old row was skipped.
      retryAvailable:    (logStatus === 'failed'
                          || isWalletSkippedWhatsAppLog({ status: logStatus, error: strOrNull(d.error) }))
                         && key === RETRYABLE_TEMPLATE_KEY
                         && !!str(d.registrationId),
      createdAt:         tsToIso(d.createdAt),
      updatedAt:         tsToIso(d.updatedAt),
      deliveredAt:       tsToIsoOrNull(d.deliveredAt),
      readAt:            tsToIsoOrNull(d.readAt),
      failedAt:          tsToIsoOrNull(d.failedAt),
    }
  })

  return NextResponse.json({ success: true, logs, total: logs.length })
}
