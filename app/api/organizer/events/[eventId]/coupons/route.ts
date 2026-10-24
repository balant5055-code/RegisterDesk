// GET  /api/organizer/events/[eventId]/coupons — list coupons
// POST /api/organizer/events/[eventId]/coupons — create coupon
//
// eventId is the Firestore draft doc ID (users/{uid}/eventDrafts/{eventId}).
// Coupons are stored in the published event's subcollection:
//   events/{slug}/coupons/{couponId}
//
// ═══ RD-EVENT-14 ═════════════════════════════════════════════════════════════
// Four things changed here, all of them because the previous version could not tell the
// truth apart from a failure:
//
//  1. A DRAFT event has no slug, so `resolveSlug` returned null and the route answered
//     404 "Event not found" — for an event the organizer is looking at. The workspace
//     painted a red error box on a perfectly healthy draft. A draft that has never been
//     published now returns 200 with `eventPublished: false`, which is a STATE. A draft
//     that does not exist, or belongs to someone else, still returns 404 and still says
//     nothing about which of the two it was.
//  2. The coupon read was unbounded. RD-DASH-15 measured 2,000 coupons on one event; this
//     route would have transferred all of them. Capped at COUPON_DOC_BUDGET with an
//     honest `truncated` flag.
//  3. A Firestore failure escaped as an unhandled rejection, so the client received a
//     Next.js digest. It is now a fixed-copy 503.
//  4. Validation moved to `validateCouponInput`, shared with PATCH — see couponInput.ts
//     for what PATCH was letting through.

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { COUPON_DOC_BUDGET }           from '@/lib/analytics/couponPerformance'
import { couponToday }                 from '@/lib/coupons/couponState'
import { validateCouponInput, type CouponInput } from '@/lib/coupons/couponInput'
import { getFeatureFlags }             from '@/lib/config/resolveFeatureFlags'
import { getEventCouponSwitch, COUPONS_OFF_EVENT } from '@/lib/coupons/eventCouponSwitch'
import type { CouponDocument }         from '@/lib/coupons/types'
import type { CouponRow }              from '@/lib/coupons/couponView'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

export interface CouponsListResponse {
  coupons: CouponRow[]
  /**
   * The date the VALIDATOR compares against, computed server-side.
   *
   * The workspace resolves each coupon's state from this, not from the browser's clock, so
   * an organizer in a different zone cannot see "Active" on a code the server has expired.
   */
  today:          string
  /** false = this event has never been published, so it has no coupon collection yet. */
  eventPublished: boolean
  /** true = more coupons exist than were read. The list is a prefix, not the whole set. */
  truncated:      boolean
  /**
   * The platform-wide coupons switch. When false NO attendee can redeem anything here,
   * whatever is configured — the workspace has to say so rather than look functional.
   */
  couponsEnabled: boolean
  /**
   * RD-COUPON-SWITCH-01 — a Super Admin switched coupons OFF for THIS event. Codes are refused at
   * checkout while true; the configuration below is kept. Optional so older clients ignore it.
   */
  couponsDisabledForEvent?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

interface EventContext {
  uid: string
  /** null = the event exists and is the caller's, but has never been published. */
  slug: string | null
  /** The event's real pass ids — read from the draft we already fetched. Zero extra reads. */
  passIds: string[]
}

/**
 * Authorizes, then resolves the event.
 *
 * A missing draft and a draft owned by someone else are indistinguishable in the response:
 * both are 404 with the same words, so the route never confirms that an event exists to
 * someone who may not see it.
 */
async function authAndEvent(
  req: NextRequest,
  eventId: string,
): Promise<EventContext | NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return err(authz.error, authz.status)
  const uid = authz.workspaceUid

  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return err('Event not found', 404)

  const data = snap.data() as Record<string, unknown>
  // Slug lives at eventDetails.seo.urlSlug (publish writes it there) — NOT a
  // top-level `slug` field.
  // RD-CE-FIX C1 · the pointer is client-writable — only a slug proven to be THIS workspace's live
  // event is used; anything else reads as "not published".
  const slug    = await resolveOwnedEventSlug(uid, eventId, data)

  const pricing = data?.pricing as Record<string, unknown> | undefined
  const passes  = Array.isArray(pricing?.passes) ? pricing.passes as Record<string, unknown>[] : []
  const passIds = passes.map(p => p?.id).filter((id): id is string => typeof id === 'string')

  return { uid, slug, passIds }
}

// ─── Serialise coupon for response ────────────────────────────────────────────

/**
 * `currentUses` is `number | null`, and the null is load-bearing.
 *
 * A document written before the counter existed carries no field. Coercing that to 0 would
 * print "0 used" — a claim — where the truth is "we do not know". The workspace renders the
 * null as a dash; the VALIDATOR still treats a missing counter as below any cap, which is
 * why `resolveCouponState` is fed a 0 while the display is not.
 */
function serialiseCoupon(doc: Partial<CouponDocument>, id: string): CouponRow {
  return {
    id,
    code:              typeof doc.code === 'string' ? doc.code : '',
    description:       typeof doc.description === 'string' ? doc.description : '',
    type:              doc.type ?? 'percentage',
    value:             typeof doc.value === 'number' ? doc.value : 0,
    active:            doc.active !== false,
    validFrom:         doc.validFrom  ?? null,
    validUntil:        doc.validUntil ?? null,
    maxUses:           typeof doc.maxUses === 'number' ? doc.maxUses : null,
    currentUses:       typeof doc.currentUses === 'number' ? doc.currentUses : null,
    applicablePassIds: Array.isArray(doc.applicablePassIds) ? doc.applicablePassIds : [],
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndEvent(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  const today = couponToday(new Date())

  // The master switch is read regardless, because "no coupons configured" and "coupons are
  // switched off platform-wide" look identical on the surface and are not the same problem.
  let couponsEnabled = true
  try {
    couponsEnabled = (await getFeatureFlags()).coupons !== false
  } catch {
    // The flag defaults open elsewhere; a failed read must not invent a disabled platform.
    couponsEnabled = true
  }

  // Never published — there is no coupon collection to read, and that is not an error.
  if (!slug) {
    const body: CouponsListResponse =
      { coupons: [], today, eventPublished: false, truncated: false, couponsEnabled }
    return NextResponse.json(body)
  }

  // RD-COUPON-SWITCH-01 — the event switch, reported so the tab can say WHY codes will not apply.
  // A failed read reports 'not disabled' (display only — checkout enforces the switch fail-closed).
  const couponsDisabledForEvent = await getEventCouponSwitch(slug).then(sw => sw.disabled, () => false)

  try {
    // +1 so a full page is distinguishable from a page that happens to be exactly the cap.
    const snap = await adminDb
      .collection('events').doc(slug)
      .collection('coupons')
      .orderBy('createdAt', 'desc')
      .limit(COUPON_DOC_BUDGET + 1)
      .get()

    const truncated = snap.size > COUPON_DOC_BUDGET
    const docs      = truncated ? snap.docs.slice(0, COUPON_DOC_BUDGET) : snap.docs

    const body: CouponsListResponse = {
      coupons: docs.map(d => serialiseCoupon(d.data() as Partial<CouponDocument>, d.id)),
      today,
      eventPublished: true,
      truncated,
      couponsEnabled,
      couponsDisabledForEvent,
    }
    return NextResponse.json(body)
  } catch {
    // Fixed copy. A Firestore message, an index URL or a digest tells the organizer
    // nothing and tells everyone else too much.
    return err('Coupons could not be loaded. Please try again.', 503)
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndEvent(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug, passIds } = auth

  if (!slug) {
    return err('Publish this event before creating coupons.', 409)
  }

  // RD-COUPON-SWITCH-01 — no NEW coupon while RegisterDesk has switched coupons off for this event.
  // Fail-closed: an unreadable switch refuses the create rather than guess. Existing coupons are
  // untouched (checkout already refuses them via validateCoupon).
  const couponSwitch = await getEventCouponSwitch(slug).catch(() => null)
  if (!couponSwitch) return err('Coupons could not be checked. Please try again.', 503)
  if (couponSwitch.disabled) {
    return NextResponse.json({ error: COUPONS_OFF_EVENT, code: 'COUPONS_DISABLED_FOR_EVENT' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return err('Invalid request body', 400)
  }

  // The WHOLE coupon is validated, never a field at a time — see couponInput.ts.
  const parsed = validateCouponInput(body as Partial<CouponInput>, passIds)
  if (!parsed.ok) return err(parsed.error, 400)
  const input = parsed.value

  try {
    // Uniqueness within this event's coupons.
    const existing = await adminDb
      .collection('events').doc(slug)
      .collection('coupons')
      .where('code', '==', input.code)
      .limit(1)
      .get()
    if (!existing.empty) {
      return err(`Coupon code "${input.code}" already exists for this event.`, 409)
    }

    // Optional fields are OMITTED rather than written as null: `validate.ts` and
    // `resolveCouponState` both test for presence, and a stored null would be a third
    // shape neither of them was written against.
    const couponData: Omit<CouponDocument, 'id' | 'createdAt' | 'updatedAt'> = {
      code:              input.code,
      description:       input.description,
      type:              input.type,
      value:             input.value,
      active:            input.active,
      currentUses:       0,
      applicablePassIds: input.applicablePassIds,
      ...(input.validFrom  ? { validFrom:  input.validFrom  } : {}),
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.maxUses !== null ? { maxUses: input.maxUses } : {}),
    }

    const docRef = await adminDb
      .collection('events').doc(slug)
      .collection('coupons')
      .add({
        ...couponData,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })

    return NextResponse.json({ coupon: serialiseCoupon(couponData, docRef.id) }, { status: 201 })
  } catch {
    return err('The coupon could not be saved. Please try again.', 503)
  }
}
