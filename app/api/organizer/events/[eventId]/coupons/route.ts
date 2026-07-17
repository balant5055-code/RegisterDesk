// GET  /api/organizer/events/[eventId]/coupons — list coupons
// POST /api/organizer/events/[eventId]/coupons — create coupon
//
// eventId is the Firestore draft doc ID (users/{uid}/eventDrafts/{eventId}).
// Coupons are stored in the published event's subcollection:
//   events/{slug}/coupons/{couponId}

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import type { CouponDocument, CouponType } from '@/lib/coupons/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

async function resolveSlug(uid: string, eventId: string): Promise<string | null> {
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  // Slug lives at eventDetails.seo.urlSlug (publish writes it there) — NOT a
  // top-level `slug` field.
  const seo  = (snap.data() as Record<string, unknown>)?.eventDetails as Record<string, unknown> | undefined
  const slug = (seo?.seo as Record<string, unknown> | undefined)?.urlSlug
  return typeof slug === 'string' && slug ? slug : null
}

async function authAndSlug(
  req: NextRequest,
  eventId: string,
): Promise<{ uid: string; slug: string } | NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return err(authz.error, authz.status)
  const uid = authz.workspaceUid

  const slug = await resolveSlug(uid, eventId)
  if (!slug) return err('Event not found', 404)

  return { uid, slug }
}

// ─── Serialise coupon for response ────────────────────────────────────────────

function serialiseCoupon(doc: CouponDocument & { id: string }) {
  return {
    id:                doc.id,
    code:              doc.code,
    description:       doc.description,
    type:              doc.type,
    value:             doc.value,
    active:            doc.active,
    validFrom:         doc.validFrom  ?? null,
    validUntil:        doc.validUntil ?? null,
    maxUses:           doc.maxUses    ?? null,
    currentUses:       doc.currentUses,
    applicablePassIds: doc.applicablePassIds,
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndSlug(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  const snap = await adminDb
    .collection('events').doc(slug)
    .collection('coupons')
    .orderBy('createdAt', 'desc')
    .get()

  const coupons = snap.docs.map(d => serialiseCoupon({ ...(d.data() as CouponDocument), id: d.id }))
  return NextResponse.json({ coupons })
}

// ─── POST ─────────────────────────────────────────────────────────────────────

interface CreateCouponBody {
  code:              string
  description:       string
  type:              CouponType
  value:             number
  active?:           boolean
  validFrom?:        string | null
  validUntil?:       string | null
  maxUses?:          number | null
  applicablePassIds?: string[]
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndSlug(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  let body: CreateCouponBody
  try {
    body = (await req.json()) as CreateCouponBody
  } catch {
    return err('Invalid request body', 400)
  }

  const code = (body.code ?? '').toString().trim().toUpperCase()
  if (!code)                          return err('code is required', 400)
  if (!/^[A-Z0-9_-]{2,30}$/.test(code)) {
    return err('code must be 2–30 uppercase letters, digits, hyphens, or underscores', 400)
  }
  if (!body.description?.trim())      return err('description is required', 400)
  if (!['percentage', 'fixed', 'free'].includes(body.type)) {
    return err('type must be percentage, fixed, or free', 400)
  }
  if (body.type === 'percentage' && (body.value < 1 || body.value > 100)) {
    return err('percentage value must be between 1 and 100', 400)
  }
  if (body.type === 'fixed' && (typeof body.value !== 'number' || body.value <= 0)) {
    return err('fixed value must be a positive number (paise)', 400)
  }

  // Uniqueness check within this event's coupons
  const existing = await adminDb
    .collection('events').doc(slug)
    .collection('coupons')
    .where('code', '==', code)
    .limit(1)
    .get()
  if (!existing.empty) {
    return err(`Coupon code "${code}" already exists for this event`, 409)
  }

  const couponData: Omit<CouponDocument, 'id' | 'createdAt' | 'updatedAt'> = {
    code,
    description:       body.description.trim(),
    type:              body.type,
    value:             body.type === 'free' ? 100 : (body.value ?? 0),
    active:            body.active !== false,
    currentUses:       0,
    applicablePassIds: Array.isArray(body.applicablePassIds) ? body.applicablePassIds : [],
    ...(body.validFrom  ? { validFrom:  body.validFrom  } : {}),
    ...(body.validUntil ? { validUntil: body.validUntil } : {}),
    ...(typeof body.maxUses === 'number' && body.maxUses > 0 ? { maxUses: body.maxUses } : {}),
  }

  const docRef = await adminDb
    .collection('events').doc(slug)
    .collection('coupons')
    .add({
      ...couponData,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

  return NextResponse.json({
    coupon: serialiseCoupon({ ...couponData, id: docRef.id, createdAt: null, updatedAt: null }),
  }, { status: 201 })
}
