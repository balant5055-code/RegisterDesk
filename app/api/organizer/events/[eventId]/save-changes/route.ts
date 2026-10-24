// POST /api/organizer/events/[eventId]/save-changes
//
// Syncs the full current draft content to the live events/{slug} document for
// an already-published event. Called by the wizard's "Save Changes" CTA in
// Step 7 when draftStatus === 'published'.
//
// Only content fields are written (eventDetails, pricing, registrationForm,
// accessControl). Lifecycle fields (status, publishedAt, lifecycleStatus, etc.)
// are never touched.
//
// RD-PRICING-SAFETY-01 — the COMMERCIAL part of `pricing` is frozen once an event is
// published: ticket prices, early-bird pricing, free/paid (event and pass), the fee model,
// taxes/fees/discounts, and the set of tickets. The draft is client-writable, so this route
// compares the draft against the LIVE document and refuses (409) any commercial difference —
// the same rule PATCH /edit has always enforced by key. Validation and write happen in ONE
// Firestore transaction over the draft, the live event and the sold counter, so what is
// validated is exactly what is written and a concurrent change forces a retry.
//
// RD-EVENT-COMMERCE-05E — the Fee Collection Method is the one exception: it is organizer-
// editable after publish, but ONLY through PATCH /edit `feeModel` (validated, engine-gated,
// audited). Save Changes therefore neither refuses a draft/live fee-model difference nor copies
// it: the live event keeps its own fee model, whatever the draft says.
//
// Also writes a change-log entry when schedule or venue fields changed,
// identical to the behaviour of the PATCH /edit endpoint.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import {
  resolveLiveEventRef, liveEventLookupMessage, liveEventLookupStatus,
} from '@/lib/events/liveEventRef'
import { buildLiveContentSync } from '@/lib/events/editing/liveContentSync'

/** A refusal decided inside the transaction — carried out so no write is committed. */
class SaveRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<{ success: boolean; error?: string }>> {
  const { eventId } = await context.params

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Load draft ──────────────────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  const d       = draftSnap.data() as Record<string, unknown>

  // Only valid for published events
  if (d.status !== 'published') {
    return NextResponse.json(
      { success: false, error: 'Use the publish flow for draft events.' },
      { status: 400 },
    )
  }

  // ── 3. Locate the live document ───────────────────────────────────────────
  //
  // Via the shared resolver, NOT a bare `events/{urlSlug}` read. The draft's urlSlug is
  // written by the browser, so a client-side normalisation can leave it naming nothing —
  // which this route used to report as "Live event document not found.", indistinguishable
  // from an event that genuinely has no public page. The resolver consults
  // `events/{id}.draftId` (server-written, unreachable from any client path) to tell a
  // STALE POINTER from a MISSING DOCUMENT and says which it is.
  //
  // It deliberately does not self-heal: the slug is a public URL, and relinking one is an
  // explicit operation, never a side effect of pressing Save.
  const lookup = await resolveLiveEventRef(eventId, d, uid)
  if (!lookup.ok) {
    if (lookup.reason === 'SLUG_MISMATCH') {
      console.error('[save-changes] draft/live slug mismatch', {
        eventId, draftSlug: lookup.slug, liveSlug: lookup.canonicalSlug,
      })
    }
    return NextResponse.json(
      { success: false, error: liveEventLookupMessage(lookup) },
      { status: liveEventLookupStatus(lookup) },
    )
  }
  const { slug, ref: eventRef } = lookup

  // ── 4. Validate + write, atomically ──────────────────────────────────────
  //
  // Everything that is validated is re-read INSIDE the transaction: the draft (what will be
  // written), the live event (the authoritative baseline) and the per-pass sold counter. A
  // concurrent edit of any of them makes Firestore retry the whole body, so a stale read can
  // never slip a price change or a below-sold capacity past the checks.
  const counterRef = adminDb.collection('registrationCounters').doc(slug)
  let impactful: string[] = []

  try {
    await adminDb.runTransaction(async (txn) => {
      const [draftNow, liveNow, counterNow] = await Promise.all([
        txn.get(draftRef), txn.get(eventRef), txn.get(counterRef),
      ])
      if (!draftNow.exists) throw new SaveRefusal('Event not found', 404)
      if (!liveNow.exists)  throw new SaveRefusal('Live event document not found.', 404)

      const dn = draftNow.data() as Record<string, unknown>
      const live = liveNow.data() as Record<string, unknown>

      // Re-assert the preconditions checked above against the snapshots being written.
      if (dn.status !== 'published') throw new SaveRefusal('Use the publish flow for draft events.', 400)
      if (typeof live.draftId === 'string' && live.draftId !== eventId) {
        throw new SaveRefusal('This event’s live page belongs to a different draft.', 409)
      }

      // ── 4a–4d. The copy rule — commercial + identity freeze, value rules, sold-count floor,
      // change-log fields, and exactly which content fields move — lives in ONE place, shared
      // with the resubmit / republish lifecycle transitions (lib/events/editing/liveContentSync).
      const sync = buildLiveContentSync(dn, live, slug, (counterNow.data()?.passCounts ?? {}) as Record<string, number>)
      if (!sync.ok) throw new SaveRefusal(sync.message, sync.status)

      const ts = FieldValue.serverTimestamp()
      txn.update(draftRef, { updatedAt: ts, updatedBy: uid })
      txn.update(eventRef, { ...sync.update, updatedAt: ts, updatedBy: uid })
      impactful = sync.changed
    })
  } catch (err) {
    if (err instanceof SaveRefusal) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status })
    }
    console.error('[save-changes] Transaction failed:', err)
    return NextResponse.json({ success: false, error: 'Failed to save changes.' }, { status: 500 })
  }

  // ── 5. Change-log (fire-and-forget) ───────────────────────────────────────
  if (impactful.length > 0) {
    adminDb
      .collection('events').doc(slug)
      .collection('changeLog').add({
        changedFields: impactful,
        changedAt:     FieldValue.serverTimestamp(),
        changedBy:     uid,
      })
      .catch(err => console.error('[save-changes] Change-log write failed:', err))
  }

  return NextResponse.json({ success: true })
}
