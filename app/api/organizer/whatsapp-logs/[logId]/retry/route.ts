// POST /api/organizer/whatsapp-logs/[logId]/retry
//
// RD-WA-LOGS-01 — MANUAL re-send of one failed attendee registration confirmation.
// There is no automatic retry, no queue, no cron: an organizer presses a button.
//
// ═══ THE CLAIM IS THE CONCURRENCY CONTROL ════════════════════════════════════
// Two organizers (or two tabs) can press Retry at the same moment. Every eligibility rule
// is therefore asserted INSIDE a transaction that also flips `failed → queued`, so the
// second caller reads a non-failed row and is refused. Without the flip, both would pass a
// plain read and both would send — a duplicate WhatsApp to a real attendee.
//
// ═══ MONEY ══════════════════════════════════════════════════════════════════
// The wallet is never touched here. `retryWhatsAppConfirmation` debits only after Meta
// confirms the send, through the same deterministic ledger id the live path uses, so a
// failed retry costs nothing and a registration can be charged at most once.
//
// A failed attempt RELEASES the claim (queued → failed) so the row stays retryable rather
// than being stranded in `queued` forever.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { retryWhatsAppConfirmation, RETRYABLE_WHATSAPP_TEMPLATE_KEY } from '@/lib/email-logs/whatsappRetry'
import { isWalletSkippedWhatsAppLog } from '@/lib/email-logs/types'
import { sanitizeProviderResponse }  from '@/lib/email-logs/whatsappDiagnostics'
import type { EmailLog }             from '@/lib/email-logs/types'

export interface RetryWhatsAppLogResponse {
  success:   boolean
  error?:    string
  /** Meta Graph error code when the provider rejected the send. */
  code?:     number
  httpStatus?: number
  messageId?: string
  /** Paise actually debited for this attempt — 0 when free or already billed. */
  costPaise?: number
}

/** Maps a retry outcome to the HTTP status that describes it honestly. */
const REASON_STATUS: Record<string, number> = {
  not_configured:       503,
  channel_disabled:     503,
  event_disabled:       422,
  registration_missing: 404,
  already_sent:         409,
  no_phone:             422,
  insufficient_balance: 402,
  template_unresolved:  422,
  send_failed:          502,
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ logId: string }> },
): Promise<NextResponse<RetryWhatsAppLogResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { logId } = await params
  const logRef = adminDb.collection('emailLogs').doc(logId)

  // ── Atomic claim: ownership + channel + template + failed-status, then failed → queued.
  const claim = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(logRef)
    if (!snap.exists) return { ok: false as const, status: 404, error: 'Log entry not found' }
    const l = { id: snap.id, ...snap.data() } as EmailLog

    if (l.organizerUid !== uid) return { ok: false as const, status: 403, error: 'Forbidden' }
    if (l.channel !== 'whatsapp') {
      return { ok: false as const, status: 422, error: 'This log entry is not a WhatsApp message.' }
    }
    if (l.templateKey !== RETRYABLE_WHATSAPP_TEMPLATE_KEY) {
      return { ok: false as const, status: 422, error: `Retry not supported for template "${l.templateKey}"` }
    }
    // The claim accepts exactly the two histories the logs route offers a button for:
    // a `failed` attempt, or a `skipped` one whose stored reason was the wallet. Anything
    // else — sent, delivered, queued (a claim already held), or a skip for a DIFFERENT
    // reason such as a missing phone — is refused here regardless of what the UI showed.
    // The UI is not the security boundary; this transaction is.
    if (l.status !== 'failed' && !isWalletSkippedWhatsAppLog(l)) {
      return { ok: false as const, status: 409, error: 'This message is not in a retryable state (already retried or in progress).' }
    }
    if (!l.registrationId) {
      return { ok: false as const, status: 422, error: 'This log entry has no registration to re-send for.' }
    }

    tx.update(logRef, { status: 'queued', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true as const, log: l }
  })

  if (!claim.ok) {
    return NextResponse.json({ success: false, error: claim.error }, { status: claim.status })
  }
  const log = claim.log

  const result = await retryWhatsAppConfirmation({
    registrationId: log.registrationId,
    organizerUid:   uid,
    eventSlug:      log.eventSlug,
    eventName:      log.eventName,
  })

  if (!result.ok) {
    // Release the claim so the row stays retryable, and persist the fresh diagnostics so
    // the table shows why THIS attempt failed rather than the original reason.
    const providerResponse = sanitizeProviderResponse(result.providerResponse)
    await logRef.update({
      status:    'failed',
      error:     result.error,
      ...(providerResponse ? { providerResponse } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(err => console.error('[whatsapp-retry] claim release failed:', err))

    return NextResponse.json(
      { success: false, error: result.error, code: result.code, httpStatus: result.httpStatus },
      { status: REASON_STATUS[result.reason] ?? 500 },
    )
  }

  await logRef.update({
    status:    'sent',
    costPaise: result.costPaise,
    ...(result.messageId ? { providerMessageId: result.messageId } : {}),
    error:     FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  }).catch(err => console.error('[whatsapp-retry] log update failed:', err))

  return NextResponse.json({
    success: true, messageId: result.messageId, costPaise: result.costPaise,
  })
}
