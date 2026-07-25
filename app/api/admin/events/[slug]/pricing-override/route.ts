// RD-PRICING-01D — Admin per-event pricing override.
//
//   GET    → the event's fully-resolved effective configuration (with source trace).
//   PATCH  → set/merge the admin override (any configurable field). Validated + audited.
//   DELETE → clear the admin override. Audited.
//
// Admin-gated (resolveAdminUid). Writes server-side via the Admin SDK to
// events/{slug}.adminOverride — no schema migration; the field is optional and absent
// on every existing event until first set.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { resolveAdminUid } from '@/lib/admin/auth'
import { logAdminAction } from '@/lib/admin/audit'
import {
  resolveEffectivePlatformConfiguration,
  validateAdminEventOverride,
  type AdminEventOverride,
  type PricingEventView,
} from '@/lib/platform/pricing'

type Ctx = { params: Promise<{ slug: string }> }

function eventViewOf(data: Record<string, unknown>): PricingEventView {
  const license = (data.license as { tier?: unknown } | null) ?? null
  return {
    license,
    adminOverride:     (data.adminOverride     as AdminEventOverride | null | undefined) ?? null,
    organizerOverride: (data.organizerOverride as PricingEventView['organizerOverride'])  ?? null,
  }
}

// Parse ONLY the known override fields, checking primitive types. `registrationLimit`
// accepts a number or null (unlimited); every other field is a number. Unknown keys
// are ignored; a present-but-wrong-typed field is a 400.
function parseAdminOverride(body: Record<string, unknown>): { override: AdminEventOverride; typeErrors: string[] } {
  const override: AdminEventOverride = {}
  const typeErrors: string[] = []
  const num = (key: string): number | undefined => {
    const v = body[key]
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v)) { typeErrors.push(`${key} must be a number`); return undefined }
    return v
  }
  if (body.registrationLimit !== undefined) {
    const v = body.registrationLimit
    if (v === null || (typeof v === 'number' && Number.isFinite(v))) override.registrationLimit = v as number | null
    else typeErrors.push('registrationLimit must be a number or null')
  }
  const pf = num('platformFeeAmount');  if (pf !== undefined) override.platformFeeAmount  = pf
  const pg = num('platformGstPercent'); if (pg !== undefined) override.platformGstPercent = pg
  const gp = num('gatewayPercent');     if (gp !== undefined) override.gatewayPercent     = gp
  const gg = num('gatewayGstPercent');  if (gg !== undefined) override.gatewayGstPercent  = gg
  const cf = num('convenienceFee');     if (cf !== undefined) override.convenienceFee     = cf
  return { override, typeErrors }
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  const snap = await adminDb.collection('events').doc(slug).get()
  if (!snap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const configuration = await resolveEffectivePlatformConfiguration(eventViewOf(snap.data() ?? {}))
  return NextResponse.json({ slug, configuration })
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { override, typeErrors } = parseAdminOverride(body)
  if (typeErrors.length) return NextResponse.json({ error: 'Invalid override', details: typeErrors }, { status: 400 })
  if (Object.keys(override).length === 0) {
    return NextResponse.json({ error: 'No overridable fields supplied' }, { status: 400 })
  }
  const check = validateAdminEventOverride(override)
  if (!check.ok) return NextResponse.json({ error: 'Invalid override', details: check.errors }, { status: 400 })

  const ref  = adminDb.collection('events').doc(slug)
  const snap = await ref.get()
  if (!snap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  // Merge onto the existing override; stamp provenance.
  const existing = (snap.data()?.adminOverride as AdminEventOverride | undefined) ?? {}
  const next: AdminEventOverride = {
    ...existing,
    ...override,
    updatedAt: new Date().toISOString(),
    updatedBy: adminUid,
  }
  await ref.update({ adminOverride: next })

  await logAdminAction({
    adminUid, action: 'pricing_override.set', entityType: 'event', entityId: slug,
    metadata: { scope: 'admin', fields: Object.keys(override) },
  })

  const configuration = await resolveEffectivePlatformConfiguration(eventViewOf({ ...(snap.data() ?? {}), adminOverride: next }))
  return NextResponse.json({ slug, configuration })
}

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  const ref  = adminDb.collection('events').doc(slug)
  const snap = await ref.get()
  if (!snap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  await ref.update({ adminOverride: FieldValue.delete() })
  await logAdminAction({
    adminUid, action: 'pricing_override.cleared', entityType: 'event', entityId: slug,
    metadata: { scope: 'admin' },
  })

  const configuration = await resolveEffectivePlatformConfiguration(eventViewOf({ ...(snap.data() ?? {}), adminOverride: undefined }))
  return NextResponse.json({ slug, configuration })
}
