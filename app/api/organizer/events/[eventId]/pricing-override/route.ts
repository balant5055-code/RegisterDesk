// RD-PRICING-01D — Organizer per-event pricing override.
//
//   PATCH → set/merge the organizer override. Organizers may override ONLY the
//           allow-list: registrationLimit (DOWNWARD only — never above the event's paid capacity).
//           RD-PHASE4-S3 · Q4 — `convenienceFee` (and every other pricing field) is refused with
//           403 PRICING_NOT_ORGANIZER_EDITABLE: organizers do not configure pricing, and
//           `organizerOverride` is retired as a pricing layer (events/{slug}.commercial is the one
//           event pricing layer, Super Admin only). Stored legacy values are left in place and are
//           not read by any pricing resolver.
//
// Workspace-gated (authorizeEvent — the canonical event-scoped variant). Writes server-side via
// the Admin SDK to the draft and, if published, events/{slug}.organizerOverride — no schema
// migration; the field is optional and absent on every existing event until first set.
//
// RD-PHASE4-S1 · C1 — nothing the client can write decides WHERE this lands or HOW HIGH it may go:
//   • the live event is resolved through the reverse-pointer-checked resolveLiveEventRef AND must
//     belong to this workspace — a draft whose (client-writable) seo.urlSlug names another
//     organizer's event is refused before ANY write;
//   • the ceiling comes from server-only data — RD-LEGACY-01: the event's PAID REGISTRATION CAPACITY
//     (events/{slug}.totalCapacity when published, else the draft's PAID activation order), else the
//     free allowance. Never from the client-writable draft, and never from a licence tier: the old
//     tier lookup capped every capacity event at the V1 Starter limit (100), whatever it had paid for.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeEvent } from '@/lib/team/workspace'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import { getGlobalCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'
import { resolveLiveEventRef, liveEventLookupMessage, liveEventLookupStatus } from '@/lib/events/liveEventRef'
import {
  resolveEffectivePlatformConfiguration,
  validateOrganizerEventOverride,
  type AdminEventOverride,
  type OrganizerEventOverride,
} from '@/lib/platform/pricing'

type Ctx = { params: Promise<{ eventId: string }> }

const ALLOWED_FIELDS = new Set(['registrationLimit'])
/** RD-PHASE4-S3 — pricing fields an organizer might send here; each is an explicit 403 with a code. */
const PRICING_FIELDS = ['convenienceFee', 'platformFeeAmount', 'platformGstPercent', 'gatewayPercent', 'gatewayGstPercent', 'attendeeTransactionFeePercent', 'feeModel']

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/**
 * RD-LEGACY-01 — the registration ceiling from SERVER-ONLY data (events/* and licenseOrders/* are
 * Admin-SDK-only under firestore.rules): the live event's ENFORCED capacity when published, else
 * the capacity the draft's PAID activation order bought, else the free allowance. Never the
 * client-writable draft, and no licence tier.
 */
async function trustedRegistrationCeiling(
  draftId: string, liveData: Record<string, unknown> | null, workspaceUid: string,
): Promise<number> {
  if (liveData && isPositiveInt(liveData.totalCapacity)) return liveData.totalCapacity
  const ord = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${draftId}`).get()
  const o = ord.exists ? ord.data() as { status?: unknown; organizerUid?: unknown; capacityChange?: { capacity?: unknown } } : null
  if (o && o.status === 'paid' && o.organizerUid === workspaceUid && isPositiveInt(o.capacityChange?.capacity)) return o.capacityChange.capacity
  const terms = await getGlobalCommercialTerms()
  return isPositiveInt(terms.freeRegistrationCapacity) ? terms.freeRegistrationCapacity : 1
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { eventId } = await params

  // 1. Auth — workspace permission + the canonical event-scope rule (authorizeEvent).
  const authz = await authorizeEvent(req, 'events', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // 2. Parse + enforce the allow-list (reject any non-allowed field explicitly).
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const pricingAttempt = Object.keys(body).filter(k => PRICING_FIELDS.includes(k))
  if (pricingAttempt.length) {
    return NextResponse.json(
      { error: `Pricing is managed by RegisterDesk and cannot be set by organizers: ${pricingAttempt.join(', ')}`, code: 'PRICING_NOT_ORGANIZER_EDITABLE' },
      { status: 403 },
    )
  }
  const disallowed = Object.keys(body).filter(k => !ALLOWED_FIELDS.has(k))
  if (disallowed.length) {
    return NextResponse.json({ error: `Organizers may not override: ${disallowed.join(', ')}` }, { status: 403 })
  }
  const override: OrganizerEventOverride = {}
  if (body.registrationLimit !== undefined) {
    if (typeof body.registrationLimit !== 'number' || !Number.isFinite(body.registrationLimit)) {
      return NextResponse.json({ error: 'registrationLimit must be a number' }, { status: 400 })
    }
    override.registrationLimit = body.registrationLimit
  }
  if (Object.keys(override).length === 0) {
    return NextResponse.json({ error: 'No overridable fields supplied' }, { status: 400 })
  }

  // 3. Load draft → resolve the LIVE event (trusted) + the paid-capacity ceiling (trusted). Every refusal
  //    below happens BEFORE any write — to the draft or to any event.
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const draft = draftSnap.data() as Record<string, unknown>

  const live = await resolveLiveEventRef(eventId, draft, uid)
  let liveRef: FirebaseFirestore.DocumentReference | null = null
  let liveData: Record<string, unknown> | null = null
  if (live.ok) {
    liveData = (live.snap.data() ?? {}) as Record<string, unknown>
    // The live document must be THIS workspace's — the reverse pointer (draftId) alone is not an
    // owner check (draft ids are only unique per organizer).
    if (liveData.uid !== uid) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    liveRef = live.ref
  } else if (live.reason === 'SLUG_OWNED_BY_OTHER') {
    // RD-CE-FIX C1 — the resolver now detects another workspace's event itself: answered exactly as
    // the owner check above (404, nothing about the other event is revealed).
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  } else if (live.reason !== 'NO_SLUG' && live.reason !== 'MISSING') {
    // SLUG_OWNED_BY_OTHER / SLUG_MISMATCH / AMBIGUOUS — the draft's slug does not lead to its own
    // live page. Refused outright (the previous behaviour wrote to whatever the slug named).
    return NextResponse.json({ error: liveEventLookupMessage(live), code: live.reason }, { status: liveEventLookupStatus(live) })
  }
  // NO_SLUG / MISSING ⇒ not published: the override is stored on the draft only (as before).
  const ceiling = await trustedRegistrationCeiling(eventId, liveData, uid)

  // 4. Validate against the paid-capacity ceiling (downward-only rule).
  const check = validateOrganizerEventOverride(override, ceiling)
  if (!check.ok) return NextResponse.json({ error: 'Invalid override', details: check.errors }, { status: 400 })

  // 5. Merge onto any existing override + stamp; write to draft and, if published, the event.
  const existing = (draft.organizerOverride as OrganizerEventOverride | undefined) ?? {}
  const next: OrganizerEventOverride = {
    ...existing, ...override,
    updatedAt: new Date().toISOString(), updatedBy: uid,
  }
  await draftRef.update({ organizerOverride: next })

  let adminOverride: AdminEventOverride | null = null
  if (liveRef && liveData) {
    await liveRef.update({ organizerOverride: next })
    adminOverride = (liveData.adminOverride as AdminEventOverride | undefined) ?? null
  }

  const configuration = await resolveEffectivePlatformConfiguration({
    adminOverride, organizerOverride: next,
  })
  return NextResponse.json({ eventId, configuration })
}
