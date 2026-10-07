// PATCH  /api/organizer/events/[eventId]/coupons/[couponId] — update coupon
// DELETE /api/organizer/events/[eventId]/coupons/[couponId] — delete coupon
//
// ═══ RD-EVENT-14 · WHAT THIS ROUTE WAS LETTING THROUGH ═══════════════════════
// PATCH wrote `value` with no validation at all:
//
//     if (body.value !== undefined) updates.value = body.value
//
// POST had always checked percentage ∈ 1..100 and fixed > 0. PATCH checked neither, so the
// same authenticated organizer could set a percentage to 500, or to a NEGATIVE number.
// `computeDiscount` has no clamp, and `finalPaise = Math.max(0, original - discount)`
// guards the floor only — a negative discount raises the final price ABOVE the ticket.
// That is an overcharge reachable from a normal session.
//
// It also accepted a `type` change without re-checking `value` against the new type (a 20%
// coupon silently became a ₹0.20 fixed discount), arbitrary strings for `validFrom` /
// `validUntil` (which the validator compares LEXICALLY against 'YYYY-MM-DD'), an end date
// before its start date, and pass ids belonging to no pass.
//
// The fix is not more guards in PATCH. The body is merged over the stored document and the
// WHOLE coupon is validated by `validateCouponInput` — the same function POST uses — so
// every field is checked against the values it will actually be stored beside.
//
// `currentUses` is never writable here. It is money-adjacent state owned by the redemption
// transaction, and an organizer editing a description must not be able to reset it.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { validateCouponInput, type CouponInput } from '@/lib/coupons/couponInput'
import type { CouponDocument }       from '@/lib/coupons/types'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

interface EventContext {
  uid: string
  slug: string
  passIds: string[]
}

/**
 * Authorizes and resolves the published event.
 *
 * A draft that does not exist, one belonging to someone else, and one that was never
 * published all answer 404 with identical words — the route never confirms an event exists
 * to a caller who may not see it. (The list route separates the never-published case,
 * because that one is the caller's OWN event and is a state worth showing; there is nothing
 * to edit on it, so here it stays a 404.)
 */
async function authAndEvent(
  req:     NextRequest,
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
  // event is used.
  const rawSlug = await resolveOwnedEventSlug(uid, eventId, data)
  if (!rawSlug) return err('Event not found', 404)

  const pricing = data?.pricing as Record<string, unknown> | undefined
  const passes  = Array.isArray(pricing?.passes) ? pricing.passes as Record<string, unknown>[] : []
  const passIds = passes.map(p => p?.id).filter((id): id is string => typeof id === 'string')

  return { uid, slug: rawSlug, passIds }
}

/** The stored document, as the shape the validator understands. */
function toInput(doc: Partial<CouponDocument>): Partial<CouponInput> {
  return {
    code:              doc.code,
    description:       doc.description,
    type:              doc.type,
    value:             doc.value,
    active:            doc.active !== false,
    validFrom:         doc.validFrom  ?? null,
    validUntil:        doc.validUntil ?? null,
    maxUses:           typeof doc.maxUses === 'number' ? doc.maxUses : null,
    applicablePassIds: Array.isArray(doc.applicablePassIds) ? doc.applicablePassIds : [],
  }
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

/** Only these may be sent. Anything else in the body is ignored, not merged. */
const PATCHABLE = [
  'code', 'description', 'type', 'value', 'active',
  'validFrom', 'validUntil', 'maxUses', 'applicablePassIds',
] as const

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string; couponId: string }> },
): Promise<NextResponse> {
  const { eventId, couponId } = await context.params
  const auth                  = await authAndEvent(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug, passIds } = auth

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    body = parsed as Record<string, unknown>
  } catch {
    return err('Invalid request body', 400)
  }

  const couponRef = adminDb
    .collection('events').doc(slug)
    .collection('coupons').doc(couponId)

  try {
    const snap = await couponRef.get()
    if (!snap.exists) return err('Coupon not found', 404)
    const stored = snap.data() as Partial<CouponDocument>

    // Merge the patch over what is stored, then validate the RESULT. A partial edit is
    // still checked as a whole coupon, so `type` and `value` can never disagree.
    const merged: Partial<CouponInput> = { ...toInput(stored) }
    for (const key of PATCHABLE) {
      if (key in body) (merged as Record<string, unknown>)[key] = body[key]
    }

    // A type change must carry its own amount.
    //
    // `value` means something different under each type — a whole percentage, or paise —
    // so inheriting it across a change silently reinterprets it: a 20% coupon patched to
    // `fixed` became 20 paise, ₹0.20 off. Twenty paise is a perfectly legal fixed amount,
    // so no value rule can catch this; only refusing the ambiguous request can.
    if ('type' in body && body.type !== stored.type && !('value' in body)) {
      return err('Send the new discount amount when you change the discount type.', 400)
    }

    // Pass ids the coupon ALREADY carries stay acceptable even if that pass has since been
    // removed from the event. Otherwise deleting a pass would lock its coupons: an
    // organizer could not switch one off, which is the very action they would want.
    // Anything NEWLY added is still checked against the passes that actually exist.
    const priorPassIds = Array.isArray(stored.applicablePassIds) ? stored.applicablePassIds : []
    const parsed = validateCouponInput(merged, [...new Set([...passIds, ...priorPassIds])])
    if (!parsed.ok) return err(parsed.error, 400)
    const input = parsed.value

    if (input.code !== stored.code) {
      const dup = await adminDb
        .collection('events').doc(slug)
        .collection('coupons')
        .where('code', '==', input.code)
        .limit(1)
        .get()
      if (!dup.empty && dup.docs[0].id !== couponId) {
        return err(`Coupon code "${input.code}" already exists for this event.`, 409)
      }
    }

    // The full validated coupon is written every time. An optional field that is now unset
    // is DELETED rather than stored as null, so the document keeps exactly the two shapes
    // `validate.ts` and `resolveCouponState` were written against: present, or absent.
    await couponRef.update({
      code:              input.code,
      description:       input.description,
      type:              input.type,
      value:             input.value,
      active:            input.active,
      applicablePassIds: input.applicablePassIds,
      validFrom:  input.validFrom  ?? FieldValue.delete(),
      validUntil: input.validUntil ?? FieldValue.delete(),
      maxUses:    input.maxUses    ?? FieldValue.delete(),
      updatedAt:  FieldValue.serverTimestamp(),
    })

    return NextResponse.json({ success: true, coupon: { id: couponId, ...input } })
  } catch {
    return err('The coupon could not be saved. Please try again.', 503)
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

/**
 * Deleting a REDEEMED coupon destroys the only record of what those attendees were given.
 *
 * Registrations keep `couponCode` as a bare string; the cap, the discount rule and the
 * redemption count live on this document alone. So a coupon with redemptions is refused
 * unless the caller explicitly acknowledges it (`?confirmUsed=1`), which the workspace
 * sends only after showing the organizer the number. An unused coupon deletes freely —
 * there is nothing to lose, and making that two steps would train the confirmation away.
 */
export async function DELETE(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string; couponId: string }> },
): Promise<NextResponse> {
  const { eventId, couponId } = await context.params
  const auth                  = await authAndEvent(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  const couponRef = adminDb
    .collection('events').doc(slug)
    .collection('coupons').doc(couponId)

  try {
    const snap = await couponRef.get()
    if (!snap.exists) return err('Coupon not found', 404)

    const stored = snap.data() as Partial<CouponDocument>
    const uses   = typeof stored.currentUses === 'number' ? stored.currentUses : 0
    const acknowledged = req.nextUrl.searchParams.get('confirmUsed') === '1'

    if (uses > 0 && !acknowledged) {
      return NextResponse.json({
        error: 'This coupon has already been redeemed.',
        currentUses: uses,
        requiresConfirmation: true,
      }, { status: 409 })
    }

    await couponRef.delete()
    return NextResponse.json({ success: true })
  } catch {
    return err('The coupon could not be deleted. Please try again.', 503)
  }
}
