// Session counter reconciliation (Phase G.5). Source of truth: registrations
// (selectedSessions of ACTIVE registrations) + sessionCheckIns. This is the
// CANONICAL session reconciler — lib/sessions/reconciliation.ts delegates here, so
// the standalone session cron and the global framework share one implementation.
//
//   eventSessions/{id}.registeredCount = # ACTIVE registrations holding the session
//   eventSessions/{id}.checkedInCount  = # sessionCheckIns for the session
//
// ACTIVE = status confirmed|pending AND paymentStatus != 'refunded' (cancelled /
// rejected / refunded release their seats — see P1-1).

import { FieldValue, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { SESSIONS, SESSION_CHECKINS, type EventSessionDoc } from '@/lib/sessions/types'
import { mismatch, RECON_PAGE_DEFAULT, RECON_BUDGET_MS, RECON_CURSOR_FLUSH, type CounterMismatch, type ReconcileOptions, type ReconcileResult } from '@/lib/reconciliation/types'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'

const ACTIVE = new Set(['confirmed', 'pending'])
const holdsSeats = (r: { status?: string; paymentStatus?: string }) =>
  ACTIVE.has(r.status ?? '') && r.paymentStatus !== 'refunded'

export async function reconcileSessions(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const repair = opts?.repair ?? true
  const pageSize = opts?.limit ?? RECON_PAGE_DEFAULT
  const budgetMs = opts?.budgetMs ?? RECON_BUDGET_MS
  const start = Date.now()
  const cursorKey = 'recon:session'

  // Bounded, cursor-resumed page of session docs (ordered by document id) — replaces
  // the former full `eventSessions` scan. Processed in doc-id order so the resume
  // cursor is always well-defined; the per-event registrations tally is memoized, so
  // multiple sessions of the same event still share ONE registrations read.
  const after = await readCursor(cursorKey)
  let sq = adminDb.collection(SESSIONS).orderBy(FieldPath.documentId()).limit(pageSize)
  if (after) sq = sq.startAfter(after)
  const sessSnap = await sq.get()

  // Memoized per-event active-holder tally (slug → sessionId → count). The projected
  // registrations read stays O(attendees) but is shared across an event's sessions;
  // session-bearing events are conference-scale, well below the aggregation cliff.
  const regCache = new Map<string, Map<string, number>>()
  async function getRegistered(slug: string): Promise<Map<string, number>> {
    const cached = regCache.get(slug)
    if (cached) return cached
    const registered = new Map<string, number>()
    const regs = await adminDb.collection('registrations').where('eventSlug', '==', slug)
      .select('status', 'paymentStatus', 'selectedSessions').get()
    for (const r of regs.docs) {
      const d = r.data() as { status?: string; paymentStatus?: string; selectedSessions?: string[] }
      if (!holdsSeats(d)) continue
      for (const sid of d.selectedSessions ?? []) registered.set(sid, (registered.get(sid) ?? 0) + 1)
    }
    regCache.set(slug, registered)
    return registered
  }

  const all: CounterMismatch[] = []
  let scanned = 0
  let lastCompletedId: string | null = null
  let budgetHit = false
  for (const doc of sessSnap.docs) {
    // GA-7C P1-1: stop before the timeout and persist progress so the cursor always
    // advances (previously it was written only after the whole loop).
    if (Date.now() - start > budgetMs) { budgetHit = true; break }
    const data = doc.data() as EventSessionDoc
    const id = doc.id
    try {
      const registered = await getRegistered(data.eventSlug)
      scanned++
      const expectedReg = registered.get(id) ?? 0
      const ci = await adminDb.collection(SESSION_CHECKINS).where('sessionId', '==', id).count().get()
      const expectedCi = ci.data().count
      const repairs: Record<string, unknown> = {}
      if ((data.registeredCount ?? 0) !== expectedReg) { all.push(mismatch('session', id, 'registeredCount', expectedReg, data.registeredCount ?? 0, repair)); if (repair) repairs.registeredCount = expectedReg }
      if ((data.checkedInCount ?? 0) !== expectedCi) { all.push(mismatch('session', id, 'checkedInCount', expectedCi, data.checkedInCount ?? 0, repair)); if (repair) repairs.checkedInCount = expectedCi }
      if (repair && Object.keys(repairs).length > 0) {
        repairs.updatedAt = FieldValue.serverTimestamp()
        await adminDb.collection(SESSIONS).doc(id).set(repairs, { merge: true })
      }
    } catch (err) {
      captureError(err, { scope: 'global_reconciliation', entityType: 'session', eventSlug: data.eventSlug })
    }
    lastCompletedId = id
    if (scanned % RECON_CURSOR_FLUSH === 0) await writeCursor(cursorKey, lastCompletedId)
  }

  // Advance the cursor (see events.ts): budget-hit → resume after last completed;
  // full page → after last id; short page → clear to wrap to the start.
  if (budgetHit) {
    await writeCursor(cursorKey, lastCompletedId ?? after)
  } else {
    const lastId = sessSnap.docs.length ? sessSnap.docs[sessSnap.docs.length - 1].id : null
    await writeCursor(cursorKey, sessSnap.size === pageSize ? lastId : null)
  }

  return { entityType: 'session', scanned, mismatches: all, repaired: all.filter(m => m.repaired).length }
}
