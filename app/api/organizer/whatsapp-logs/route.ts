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
import { BROADCAST_TEMPLATE_KEY as BROADCAST_KEY } from '@/lib/email-logs/types'
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
  /**
   * True when the send ended in a TIMEOUT / network abort, so RegisterDesk never learned
   * whether Meta accepted the message. `status` is still 'failed' for compatibility, but the
   * UI must NOT claim non-delivery, and retry is withheld — see retryAvailable.
   */
  deliveryUnknown:   boolean
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

/**
 * Message TYPE is DERIVED from the row rather than stored: broadcast rows are the ones the
 * broadcast job writes with templateKey 'broadcast' (and a campaignId); everything else is a
 * transactional send. Derived on purpose — no writer changes, and existing history stays
 * classifiable without a backfill.
 *
 * Both live in lib/email-logs/types (client-safe) and are re-exported here for callers that
 * already import from this route. This module imports the Admin SDK, so a client component
 * must never import a VALUE from it.
 */
export type { WhatsAppLogType } from '@/lib/email-logs/types'
export { BROADCAST_TEMPLATE_KEY } from '@/lib/email-logs/types'

/** Server-enforced page size. A client-supplied `limit` is clamped to this, never trusted. */
export const WA_LOGS_MAX_PAGE = 50
export const WA_LOGS_DEFAULT_PAGE = 25

/**
 * How many documents ONE request may read while refining server-side for a filter Firestore
 * cannot express (see type=transactional). Bounds the worst case so a page can never become
 * an unbounded scan; when it is hit the response still carries a cursor, so the client asks
 * again rather than mistaking a short page for the end of the data.
 */
const REFINE_SCAN_CAP = 500

type GetResponse =
  | { success: true;  items: WhatsAppLog[]; logs: WhatsAppLog[]; nextCursor: string | null; hasMore: boolean }
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
  const eventSlug   = searchParams.get('eventSlug')   ?? ''
  const campaignId  = searchParams.get('campaignId')  ?? ''
  const type        = searchParams.get('type')        ?? ''
  const dateFrom    = searchParams.get('dateFrom')    ?? ''
  const dateTo      = searchParams.get('dateTo')      ?? ''
  const cursor      = searchParams.get('cursor')      ?? ''

  // The page size is the SERVER decision: a client asking for 10000 receives WA_LOGS_MAX_PAGE.
  const rawLimit = parseInt(searchParams.get('limit') ?? String(WA_LOGS_DEFAULT_PAGE), 10)
  const limit    = Math.min(Math.max(1, isNaN(rawLimit) ? WA_LOGS_DEFAULT_PAGE : rawLimit), WA_LOGS_MAX_PAGE)

  // Every query is anchored on (organizerUid, channel). The workspace scope is part of the
  // QUERY, not a filter applied after reading, so another organizer rows are never fetched
  // and cannot leak through a bug further down this handler.
  function buildQuery(withFilters: boolean): FirebaseFirestore.Query {
    let q = adminDb.collection('emailLogs')
      .where('organizerUid', '==', uid)
      .where('channel',      '==', 'whatsapp') as FirebaseFirestore.Query

    if (withFilters) {
      if (status)      q = q.where('status',      '==', status)
      if (templateKey) q = q.where('templateKey', '==', templateKey)
      if (eventSlug)   q = q.where('eventSlug',   '==', eventSlug)
      if (campaignId)  q = q.where('campaignId',  '==', campaignId)

      // Only the BROADCAST half of the type filter is expressible as an equality.
      // "transactional" means anything BUT broadcast, which Firestore can express only as an
      // inequality — and an inequality forces its own field to be the first orderBy, which
      // would destroy the newest-first ordering this screen exists to provide. It is refined
      // server-side below instead, bounded by REFINE_SCAN_CAP.
      if (type === 'broadcast') q = q.where('templateKey', '==', BROADCAST_KEY)

      if (dateFrom) {
        const from = new Date(dateFrom)
        if (!isNaN(from.getTime())) q = q.where('createdAt', '>=', from)
      }
      if (dateTo) {
        const to = new Date(dateTo)
        if (!isNaN(to.getTime())) { to.setHours(23, 59, 59, 999); q = q.where('createdAt', '<=', to) }
      }
    }
    return q.orderBy('createdAt', 'desc')
  }

  const needsRefine = type === 'transactional'

  // Cursor pagination: startAfter a DOCUMENT SNAPSHOT, never an offset. Offset paging bills
  // every skipped document, so page 40 would cost 40 pages of reads; startAfter seeks.
  function pageQuery(after: FirebaseFirestore.DocumentSnapshot | null, take: number, withFilters: boolean) {
    let q = buildQuery(withFilters).limit(take)
    if (after) q = q.startAfter(after)
    return q.get()
  }

  async function resolveCursorDoc(): Promise<FirebaseFirestore.DocumentSnapshot | null> {
    if (!cursor) return null
    const d = await adminDb.collection('emailLogs').doc(cursor).get()
    // A cursor pointing at another workspace row is refused, not silently honoured.
    if (!d.exists || (d.data() as { organizerUid?: string }).organizerUid !== uid) return null
    return d
  }

  let docs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  let hasMore = false
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null

  try {
    let after = await resolveCursorDoc()
    let scanned = 0

    // ONE pass when Firestore can answer the whole filter. The loop runs a second time only
    // for the transactional refinement, where a fetched page may not fill the requested page.
    for (;;) {
      const snap = await pageQuery(after, limit + 1, true)
      if (snap.empty) break

      scanned += snap.size
      const raw   = snap.docs
      const more  = raw.length > limit
      const slice = more ? raw.slice(0, limit) : raw

      const kept = needsRefine
        ? slice.filter(d => (d.data() as { templateKey?: string }).templateKey !== BROADCAST_KEY)
        : slice

      docs.push(...kept)
      lastDoc = slice[slice.length - 1] ?? lastDoc
      after   = lastDoc
      hasMore = more

      if (docs.length >= limit || !more || scanned >= REFINE_SCAN_CAP) break
    }
    docs = docs.slice(0, limit)
  } catch {
    // A filter combination with no composite index degrades to the base (indexed) query
    // instead of 500ing — the same fallback the per-event registrations route uses. The
    // remaining predicates are applied here, SERVER-side, over one bounded page.
    const after = await resolveCursorDoc()
    const snap  = await pageQuery(after, limit + 1, false)
    const raw   = snap.docs
    hasMore     = raw.length > limit
    const slice = hasMore ? raw.slice(0, limit) : raw
    lastDoc     = slice[slice.length - 1] ?? null
    docs = slice.filter(d => {
      const x = d.data() as Record<string, unknown>
      if (status      && x.status      !== status)      return false
      if (templateKey && x.templateKey !== templateKey) return false
      if (eventSlug   && x.eventSlug   !== eventSlug)   return false
      if (campaignId  && x.campaignId  !== campaignId)  return false
      if (type === 'broadcast'     && x.templateKey !== BROADCAST_KEY) return false
      if (type === 'transactional' && x.templateKey === BROADCAST_KEY) return false
      return true
    })
  }

  const snap = { docs }

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
    const deliveryUnknown = d.deliveryUnknown === true
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
      deliveryUnknown,
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
                         && !!str(d.registrationId)
                         // An indeterminate send is never offered a retry: resending could
                         // double-message an attendee Meta may already have reached.
                         && !deliveryUnknown,
      createdAt:         tsToIso(d.createdAt),
      updatedAt:         tsToIso(d.updatedAt),
      deliveredAt:       tsToIsoOrNull(d.deliveredAt),
      readAt:            tsToIsoOrNull(d.readAt),
      failedAt:          tsToIsoOrNull(d.failedAt),
    }
  })

  // `logs` is returned alongside `items` so any existing consumer keeps working unchanged
  // while the paginated shape is adopted. They are the SAME array — never a second query.
  return NextResponse.json({
    success:    true,
    items:      logs,
    logs,
    nextCursor: hasMore && lastDoc ? lastDoc.id : null,
    hasMore,
  })
}
