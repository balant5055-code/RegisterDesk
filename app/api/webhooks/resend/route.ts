// POST /api/webhooks/resend
//
// Processes Resend delivery webhooks (Svix-signed). Handles:
//   • email.bounced / email.complained → suppress the address PLATFORM-WIDE (like SES), add it to
//     the sending organizer's list, and mark a bounced log failed (a complaint was delivered).
//   • email.delivered                  → advance the matching log(s) to delivered.
//
// Security: the Svix signature is verified against RESEND_WEBHOOK_SECRET. When the
// secret is unset, the route fails closed (401) — it never processes unsigned data.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { updateEmailLog }            from '@/lib/email-logs/write'
import { addToSuppressionList, suppressEmailPlatformWide } from '@/lib/firebase/firestore/emailSuppressionList'
import { verifySvix }                from '@/lib/email/svix'
import { RESEND_WEBHOOK_SECRET }     from '@/lib/env'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const LOG_QUERY_LIMIT = 50

// Svix signature + replay-window verification lives in lib/email/svix.ts.

interface ResendEvent {
  type?: string
  data?: { email_id?: string; to?: string[] | string }
}


/**
 * RD-INTEG — the address fallback may only reach a log that was never linked to a provider
 * message (no providerMessageId) — a log WITH an id is provably a different message — and only
 * the newest such log per address. It used to update EVERY log for the address (up to the query
 * limit), so one bounce flipped an organizer's unrelated historical messages to failed.
 */
function newestUnlinked<T extends FirebaseFirestore.QueryDocumentSnapshot>(docs: T[]): T | null {
  let best: T | null = null, bestMs = -1
  for (const d of docs) {
    const x = d.data() as { providerMessageId?: unknown; createdAt?: { toMillis?: () => number } }
    if (typeof x.providerMessageId === 'string' && x.providerMessageId) continue
    const ms = typeof x.createdAt?.toMillis === 'function' ? x.createdAt.toMillis() : 0
    if (ms >= bestMs) { best = d; bestMs = ms }
  }
  return best
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!RESEND_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 401 })
  }

  const raw = await req.text()
  if (!verifySvix(raw, req.headers, RESEND_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: ResendEvent
  try { event = JSON.parse(raw) as ResendEvent } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const type      = event.type ?? ''
  const messageId = event.data?.email_id ?? ''
  const toField   = event.data?.to
  const recipients = Array.isArray(toField) ? toField : (typeof toField === 'string' ? [toField] : [])

  // Resolve the affected email-log docs: by provider message id first (exact),
  // else by recipient address. Bounded by LOG_QUERY_LIMIT.
  const col = adminDb.collection('emailLogs')
  const matched = new Map<string, { organizerUid?: string; recipientEmail?: string; status?: string }>()

  if (messageId) {
    const snap = await col.where('providerMessageId', '==', messageId).limit(LOG_QUERY_LIMIT).get()
    snap.docs.forEach(d => matched.set(d.id, d.data() as { organizerUid?: string; recipientEmail?: string; status?: string }))
  }
  if (matched.size === 0) {
    // RD-EMAIL-PROVIDER — the address fallback is inexact, so it MUST be constrained to
    // logs this provider actually sent. Both providers are live simultaneously and an
    // address can appear under either; without this filter a Resend bounce would mark an
    // unrelated SES log failed and suppress the recipient for mail that never bounced.
    // Filtered after the read (not in the query) so no new composite index is required.
    // RD-INTEG — only the newest log never linked to a provider message (see newestUnlinked).
    for (const email of recipients.slice(0, 5)) {
      const snap = await col.where('recipientEmail', '==', email).limit(LOG_QUERY_LIMIT).get()
      const d = newestUnlinked(snap.docs.filter(x => (x.data() as { provider?: unknown }).provider === 'resend'))
      if (d) matched.set(d.id, d.data() as { organizerUid?: string; recipientEmail?: string; status?: string })
    }
  }

  if (type === 'email.bounced' || type === 'email.complained') {
    const reason = type === 'email.bounced' ? 'bounce' : 'complaint'
    // RD-RESEND-WEBHOOK — parity with the SES webhook: a hard bounce or a complaint suppresses the
    // address PLATFORM-WIDE (the provider gate checks that scope for every send), whether or not a
    // log matched. It used to suppress only for the one organizer whose log matched, so an address
    // that bounced on Resend kept receiving every other mail — the reputation damage this prevents.
    for (const address of recipients.slice(0, 50)) {
      await suppressEmailPlatformWide(address, reason, { ...(messageId ? { providerMessageId: messageId } : {}) })
        .catch(err => console.error('[resend-webhook] platform suppression failed:', err instanceof Error ? err.message : err))
    }
    for (const [logId, d] of matched) {
      // A complaint means the mail WAS delivered (the recipient marked it as spam): recorded, not "Failed".
      if (reason === 'bounce') await updateEmailLog(logId, 'failed', { error: reason })
      else await col.doc(logId).update({ lastProviderEvent: 'complaint' }).catch(() => { /* best-effort */ })
      if (d.recipientEmail && d.organizerUid) {
        await addToSuppressionList(d.recipientEmail, d.organizerUid, reason).catch(() => { /* best-effort */ })
      }
    }
  } else if (type === 'email.delivered') {
    for (const [logId, d] of matched) {
      if (d.status !== 'failed') await updateEmailLog(logId, 'delivered')   // never override a bounce
    }
  }
  // Other event types are acknowledged without action.

  return NextResponse.json({ ok: true, type, matched: matched.size })
}
