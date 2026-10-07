// GET /api/organizer/events/[eventId]/setup-signals
//
// RD-EVENT-04 · The Setup Center's non-draft signals, in ONE bounded request.
//
// ═══ WHY THIS ENDPOINT EXISTS ════════════════════════════════════════════════
// Setup previously fetched three endpoints from the browser — certificates/stats,
// identifiers and sessions. Each independently re-authorized AND re-read the event
// draft the page already had, so opening Setup cost three duplicate draft reads on top
// of the shell's, and `sessions` returned a full agenda bundle (sessions, tracks, halls,
// speakers) to display a single count.
//
// Two more signals the page needs — coupon count and waitlist count — had no cheap
// source at all: the existing coupons and waitlist routes both `.get()` their entire
// collection, which is exactly what §12 forbids for a count.
//
// So: one request, one draft read, then every signal in a single parallel wave, each
// one a `count()` aggregate or a single document. No collection is ever downloaded to
// be counted. This is NOT added because it is tidier — it removes three duplicate reads
// and an unbounded bundle, and it is the only bounded way to get the last two numbers.
//
// READ ONLY. This route performs no writes of any kind.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }            from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { COLLECTIONS } from '@/lib/certificates/constants'
import { SESSIONS } from '@/lib/sessions/types'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

/** Every signal is independently nullable: one failure must not sink the others. */
export interface SetupSignalsResponse {
  certificates: { generated: number; pending: number } | null
  identifiers:  { configured: boolean } | null
  sessions:     { count: number } | null
  coupons:      { count: number } | null
  waitlist:     { count: number } | null
}

const EMPTY: SetupSignalsResponse = {
  certificates: null, identifiers: null, sessions: null, coupons: null, waitlist: null,
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<SetupSignalsResponse | { error: string }>> {
  const { eventId } = await context.params

  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Ownership is structural: the draft lives under the caller's OWN uid, so a forged
  // eventId simply does not resolve. The slug is read from it rather than trusted.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const d       = draftSnap.data() as Record<string, unknown>
  // RD-CE-FIX C1 · the draft pointer is client-writable; these counts have no owner filter, so only
  // a slug the live document proves is THIS workspace's event is used.
  const slug    = await resolveOwnedEventSlug(uid, eventId, d)

  // An unpublished event has no slug, so none of these collections exist yet. That is a
  // real "nothing configured", not a failed read — every signal answers zero honestly.
  if (!slug) {
    return NextResponse.json({
      certificates: { generated: 0, pending: 0 },
      identifiers:  { configured: false },
      sessions:     { count: 0 },
      coupons:      { count: 0 },
      waitlist:     { count: 0 },
    })
  }

  // ═══ RD-CERT-02 · the CURRENT certificate store ════════════════════════════
  //
  // This counted `certificateRecords`, the legacy MVP collection. The engine writes
  // to `certificates` and leaves the MVP one untouched, so this signal read 0
  // generated on every modern event — and `pending` below, being `eligible −
  // generated`, then reported the entire confirmed roster as outstanding. That is
  // user-facing: it drives the event's setup/readiness signal.
  //
  // Scoped by eventId, which is how the modern collection is keyed, and by the
  // organizer — the slug alone would not carry ownership.
  const certBase = adminDb.collection(COLLECTIONS.CERTIFICATES)
    .where('eventId',      '==', eventId)
    .where('organizerUid', '==', uid)

  // `null` on failure — NEVER 0. A zero here would tell the organizer "no certificates
  // issued" about a read that never completed.
  const settle = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

  const [certGenerated, certEligible, identifierCfg, sessionCount, couponCount, waitlistCount] =
    await Promise.all([
      settle(certBase.count().get().then(s => s.data().count)),
      settle(
        adminDb.collection('registrations')
          .where('eventSlug', '==', slug)
          .where('status', '==', 'confirmed')
          .count().get().then(s => s.data().count),
      ),
      settle(adminDb.collection('identifierConfigs').doc(slug).get().then(s => s.exists)),
      settle(
        adminDb.collection(SESSIONS).where('eventSlug', '==', slug)
          .count().get().then(s => s.data().count),
      ),
      settle(
        adminDb.collection('events').doc(slug).collection('coupons')
          .count().get().then(s => s.data().count),
      ),
      settle(
        adminDb.collection('waitlists').where('eventSlug', '==', slug)
          .count().get().then(s => s.data().count),
      ),
    ])

  const body: SetupSignalsResponse = {
    ...EMPTY,
    certificates: certGenerated === null
      ? null
      : {
          generated: certGenerated,
          // "Eligible but not yet issued" — confirmed registrations minus issued records.
          // Both halves must have been read for this to mean anything.
          pending: certEligible === null ? 0 : Math.max(0, certEligible - certGenerated),
        },
    identifiers: identifierCfg === null ? null : { configured: identifierCfg },
    sessions:    sessionCount  === null ? null : { count: sessionCount },
    coupons:     couponCount   === null ? null : { count: couponCount },
    waitlist:    waitlistCount === null ? null : { count: waitlistCount },
  }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
