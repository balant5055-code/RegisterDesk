// PATCH  /api/organizer/events/[eventId]/coupons/[couponId] — update coupon
// DELETE /api/organizer/events/[eventId]/coupons/[couponId] — delete coupon

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import type { CouponType }           from '@/lib/coupons/types'

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

async function authAndSlug(
  req:     NextRequest,
  eventId: string,
): Promise<{ uid: string; slug: string } | NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return err(authz.error, authz.status)
  const uid = authz.workspaceUid

  // Slug lives at eventDetails.seo.urlSlug (publish writes it there) — NOT a
  // top-level `slug` field.
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return err('Event not found', 404)
  const seo  = (snap.data() as Record<string, unknown>)?.eventDetails as Record<string, unknown> | undefined
  const slug = (seo?.seo as Record<string, unknown> | undefined)?.urlSlug
  if (typeof slug !== 'string' || !slug) return err('Event not found', 404)

  return { uid, slug }
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface PatchCouponBody {
  code?:              string
  description?:       string
  type?:              CouponType
  value?:             number
  active?:            boolean
  validFrom?:         string | null
  validUntil?:        string | null
  maxUses?:           number | null
  applicablePassIds?: string[]
}

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string; couponId: string }> },
): Promise<NextResponse> {
  const { eventId, couponId } = await context.params
  const auth                  = await authAndSlug(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  const couponRef = adminDb
    .collection('events').doc(slug)
    .collection('coupons').doc(couponId)
  const snap = await couponRef.get()
  if (!snap.exists) return err('Coupon not found', 404)

  let body: PatchCouponBody
  try {
    body = (await req.json()) as PatchCouponBody
  } catch {
    return err('Invalid request body', 400)
  }

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (body.code !== undefined) {
    const code = body.code.trim().toUpperCase()
    if (!/^[A-Z0-9_-]{2,30}$/.test(code)) {
      return err('code must be 2–30 uppercase letters, digits, hyphens, or underscores', 400)
    }
    // Check uniqueness (exclude self)
    const dup = await adminDb
      .collection('events').doc(slug)
      .collection('coupons')
      .where('code', '==', code)
      .limit(1)
      .get()
    if (!dup.empty && dup.docs[0].id !== couponId) {
      return err(`Coupon code "${code}" already exists for this event`, 409)
    }
    updates.code = code
  }

  if (body.description !== undefined) {
    if (!body.description.trim()) return err('description cannot be empty', 400)
    updates.description = body.description.trim()
  }
  if (body.type !== undefined) {
    if (!['percentage', 'fixed', 'free'].includes(body.type)) {
      return err('type must be percentage, fixed, or free', 400)
    }
    updates.type = body.type
  }
  if (body.value !== undefined)             updates.value  = body.value
  if (typeof body.active === 'boolean')     updates.active = body.active
  if ('validFrom'  in body)                 updates.validFrom  = body.validFrom  ?? FieldValue.delete()
  if ('validUntil' in body)                 updates.validUntil = body.validUntil ?? FieldValue.delete()
  if ('maxUses'    in body) {
    updates.maxUses = typeof body.maxUses === 'number' && body.maxUses > 0
      ? body.maxUses
      : FieldValue.delete()
  }
  if (Array.isArray(body.applicablePassIds)) updates.applicablePassIds = body.applicablePassIds

  await couponRef.update(updates)
  return NextResponse.json({ success: true })
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string; couponId: string }> },
): Promise<NextResponse> {
  const { eventId, couponId } = await context.params
  const auth                  = await authAndSlug(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  const couponRef = adminDb
    .collection('events').doc(slug)
    .collection('coupons').doc(couponId)
  const snap = await couponRef.get()
  if (!snap.exists) return err('Coupon not found', 404)

  await couponRef.delete()
  return NextResponse.json({ success: true })
}
