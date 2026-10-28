// GET/POST /api/cron/review-deadlines
//
// RD-REVIEW-02 — advances the two 24-hour review deadlines that follow a Super Admin's change
// request: reminders (+12 h, +22 h; and 4 h before closure in the second window), the move into
// Action Required when the first deadline passes, and the automatic closure when the second passes.
//
// Finds work through `events/{slug}.reviewDeadlineNextAt <= now` (a single-field range — Firestore
// indexes it automatically), oldest first, in a bounded batch. Each event is then decided by
// advanceReviewDeadline, which re-reads the draft in a transaction and compares status, review cycle
// and deadline state before writing — so overlapping or repeated runs never duplicate a step, a
// history entry or a notice, and an event resubmitted, approved or closed meanwhile is left alone.
// The server also enforces the deadline at action time (resubmit / close refuse once it passed), so
// a late run never extends the organizer's window. Never moves money.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (fail-closed). Scheduled every 10 minutes in
// .github/workflows/cron-recovery.yml (Group B) and NOT in vercel.json — one scheduler per route.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }                 from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics }           from '@/lib/cron/withMetrics'
import { advanceReviewDeadline, type DeadlineAdvanceOutcome } from '@/lib/events/lifecycle'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const BATCH = 50
/** Stop starting new events with this much of the function's time left (each step is one or two transactions). */
const TIME_BUDGET_MS = 45_000

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  const start = Date.now()
  const snap = await adminDb.collection('events')
    .where('reviewDeadlineNextAt', '<=', Timestamp.fromMillis(start))
    .orderBy('reviewDeadlineNextAt', 'asc')
    .limit(BATCH)
    .get()

  const counts: Partial<Record<DeadlineAdvanceOutcome, number>> = {}
  let processed = 0
  for (const doc of snap.docs) {
    if (Date.now() - start > TIME_BUDGET_MS) break
    const ev = doc.data() as { uid?: unknown; draftId?: unknown }
    const uid = typeof ev.uid === 'string' ? ev.uid : ''
    const draftId = typeof ev.draftId === 'string' ? ev.draftId : ''
    let outcome: DeadlineAdvanceOutcome
    if (!uid || !draftId) {
      // A live document without its owner / draft references can never be advanced: unschedule it.
      await doc.ref.update({ reviewDeadlineNextAt: null }).catch(() => null)
      outcome = 'missing'
    } else {
      outcome = await advanceReviewDeadline(uid, draftId, doc.id)
    }
    counts[outcome] = (counts[outcome] ?? 0) + 1
    processed++
    if (outcome === 'failed') console.error('[cron/review-deadlines] event step failed', { slug: doc.id })
  }

  return NextResponse.json({
    scanned: snap.size, processed, more: snap.size === BATCH || processed < snap.size,
    outcomes: counts, durationMs: Date.now() - start,
  })
}

export const GET  = withCronMetrics('review-deadlines', handle)
export const POST = withCronMetrics('review-deadlines', handle)
