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
import { findCommercialPricingChanges } from '@/lib/events/editing/pricingIntegrity'
import { introducedValueIssues } from '@/lib/events/eventValueRules'

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

      // ── 4a. Commercial pricing is frozen after publish (RD-PRICING-SAFETY-01) ──
      const commercial = findCommercialPricingChanges(live.pricing, dn.pricing, { ignoreFeeModel: true })
      if (commercial.length > 0) {
        throw new SaveRefusal(
          `Ticket prices and free/paid settings can’t be changed on a published event. ` +
          `Changed: ${commercial.join('; ')}. Undo these changes to save your other edits.`,
          409,
        )
      }

      // ── 4a'. RD-CE-FIX H5 · identity is frozen after publish ──────────────
      // Save Changes pushes whole content blocks, so it enforces the identity keys PATCH /edit
      // lists as RESTRICTED (eventType/eventSubtype/campaignType, registrationMode, currency). The
      // draft API and firestore.rules already refuse these on a published draft; this catches a
      // draft that drifted before that lock existed, so it can never re-type the live event.
      const strOf = (v: unknown) => (typeof v === 'string' ? v : null)
      const regMode = (x: Record<string, unknown>) =>
        strOf(((x.registrationForm as Record<string, unknown> | null)?.registrationRules as Record<string, unknown> | null)?.registrationMode)
      const currencyOf = (x: Record<string, unknown>) => strOf((x.pricing as Record<string, unknown> | null)?.currency)
      // Only identity the LIVE document records is compared: a legacy live doc without a value has
      // nothing to drift from, and an unknown must never block an ordinary content save.
      const differs = (a: string | null, b: string | null) => b !== null && a !== b
      const identityDrift = [
        ...(['eventType', 'eventSubtype', 'campaignType'] as const).filter(k => differs(strOf(dn[k]), strOf(live[k]))),
        ...(differs(regMode(dn), regMode(live)) ? ['registrationMode'] : []),
        ...(differs(currencyOf(dn), currencyOf(live)) ? ['currency'] : []),
      ]
      if (identityDrift.length > 0) {
        throw new SaveRefusal(
          `These settings can’t be changed on a published event: ${identityDrift.join(', ')}. ` +
          `Duplicate the event to publish it with different settings.`,
          409,
        )
      }

      // ── 4a''. RD-CE-FIX H1 · the VALUES pushed must pass the server's rules ─
      // Only issues this save introduces (vs the live event) are refused, so a legacy event with
      // an old inconsistency can still be edited — but no save can make it invalid.
      const introduced = introducedValueIssues(
        { eventDetails: live.eventDetails, pricing: live.pricing },
        { eventDetails: dn.eventDetails, pricing: dn.pricing },
      )
      if (introduced.length > 0) throw new SaveRefusal(introduced.map(i => i.message).join(' '), 422)

      // ── 4b. Pricing integrity guard (parity with PATCH /edit) ─────────────
      // /edit blocks lowering a pass capacity below its sold count on a published event
      // (edit/route.ts RangeError). save-changes pushes the whole draft.pricing, so it
      // enforces the identical invariant, reading the authoritative per-pass sold counter.
      const draftPasses = Array.isArray((dn.pricing as Record<string, unknown> | null)?.passes)
        ? ((dn.pricing as Record<string, unknown>).passes as Record<string, unknown>[])
        : []
      const passCounts = (counterNow.data()?.passCounts ?? {}) as Record<string, number>
      for (const pass of draftPasses) {
        const pid  = typeof pass.id === 'string' ? pass.id : ''
        const sold = passCounts[pid] ?? 0
        const qty  = pass.unlimited === true ? null : (typeof pass.quantity === 'number' ? pass.quantity : null)
        if (qty !== null && qty < sold) {
          throw new SaveRefusal(
            `Pass "${typeof pass.name === 'string' ? pass.name : pid}" capacity (${qty}) cannot be less than its sold count (${sold}).`,
            400,
          )
        }
      }

      // ── 4c. Change-log fields (schedule + venue) ─────────────────────────
      const details     = (dn.eventDetails as Record<string, unknown>) ?? {}
      const liveSched   = ((live.eventDetails as Record<string, unknown>)?.schedule   as Record<string, unknown>) ?? {}
      const liveVenue   = ((live.eventDetails as Record<string, unknown>)?.venue      as Record<string, unknown>) ?? {}
      const livePhys    = (liveVenue.physical as Record<string, unknown>) ?? {}
      const liveOnline  = (liveVenue.online   as Record<string, unknown>) ?? {}
      const draftSched  = (details.schedule   as Record<string, unknown>) ?? {}
      const draftVenue  = (details.venue      as Record<string, unknown>) ?? {}
      const draftPhys   = (draftVenue.physical as Record<string, unknown>) ?? {}
      const draftOnline = (draftVenue.online   as Record<string, unknown>) ?? {}

      const changed: string[] = []
      const checkField = (key: string, draftVal: unknown, liveVal: unknown) => {
        const a = typeof draftVal === 'string' ? draftVal.trim() : draftVal
        const b = typeof liveVal  === 'string' ? liveVal.trim()  : liveVal
        if (a !== b) changed.push(key)
      }
      checkField('startDate',      draftSched.startDate,    liveSched.startDate)
      checkField('startTime',      draftSched.startTime,    liveSched.startTime)
      checkField('endDate',        draftSched.endDate,      liveSched.endDate)
      checkField('endTime',        draftSched.endTime,      liveSched.endTime)
      checkField('venueType',      draftVenue.type,         liveVenue.type)
      checkField('venueName',      draftPhys.name,          livePhys.name)
      checkField('venueCity',      draftPhys.city,          livePhys.city)
      checkField('venueAddress',   draftPhys.addressLine1,  livePhys.addressLine1)
      checkField('onlinePlatform', draftOnline.platform,    liveOnline.platform)
      checkField('onlineMeetingUrl', draftOnline.meetingUrl, liveOnline.meetingUrl)

      // ── 4d. Writes: touch draft + sync all content fields to live event ───
      const ts = FieldValue.serverTimestamp()
      txn.update(draftRef, { updatedAt: ts, updatedBy: uid })
      // The public slug is IDENTITY, not content. `eventDetails` is pushed wholesale, so
      // without this the draft's `seo.urlSlug` would be copied onto the live document —
      // and since the document id can never change, that would leave the live page
      // disagreeing with its own address. `urlSlug` is already RESTRICTED_EDIT_KEYS
      // (frozen after publish); this is that policy enforced on the one path that writes
      // the whole block. Saving can change what the page says, never where it lives.
      const liveDetails = dn.eventDetails
        ? { ...(dn.eventDetails as Record<string, unknown>),
            seo: { ...((dn.eventDetails as Record<string, unknown>).seo as Record<string, unknown> ?? {}), urlSlug: slug } }
        : null
      // RD-EVENT-COMMERCE-05E — the live fee model is preserved exactly (absent stays absent).
      const livePricing = (live.pricing ?? null) as Record<string, unknown> | null
      const draftPricing = (dn.pricing ?? null) as Record<string, unknown> | null
      let nextPricing: Record<string, unknown> | null = draftPricing
      if (draftPricing) {
        const { feeModel: _draftFeeModel, ...rest } = draftPricing
        void _draftFeeModel
        nextPricing = livePricing && 'feeModel' in livePricing ? { ...rest, feeModel: livePricing.feeModel } : rest
      }
      txn.update(eventRef, {
        eventDetails:     liveDetails,
        pricing:          nextPricing,
        registrationForm: dn.registrationForm ?? null,
        accessControl:    dn.accessControl    ?? null,
        updatedAt:        ts,
        updatedBy:        uid,
      })
      impactful = changed
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
