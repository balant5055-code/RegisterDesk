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
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { stageAdminAudit } from '@/lib/admin/audit'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
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

/** RD-PHASE4-S3 · Q4 — money fields of the retired adminOverride layer. */
const RETIRED_PRICING_FIELDS = ['platformFeeAmount', 'platformGstPercent', 'gatewayPercent', 'gatewayGstPercent', 'convenienceFee'] as const

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
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const { slug } = await params
  const snap = await adminDb.collection('events').doc(slug).get()
  if (!snap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const configuration = await resolveEffectivePlatformConfiguration(eventViewOf(snap.data() ?? {}))
  return NextResponse.json({ slug, configuration })
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // RD-PHASE4-S2 — an event PRICING override (platform fee, GST, gateway %, convenience fee, limit) is
  // Super Admin only (ADMIN_UIDS), decided from the verified token. Authorization only — the Stage 3
  // event-pricing workflow is not implemented here. GET (read) keeps admin access.
  if (!(await resolveAdminUid(req.headers.get('authorization')))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Only a Super Admin can change event pricing.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })

  const { slug } = await params
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // RD-PHASE4-S3 · Q4 — `adminOverride` is RETIRED as a pricing layer: events/{slug}.commercial is the
  // single event pricing layer (POST /api/admin/events/[slug]/commercial). Its money fields are no
  // longer written (and no resolver reads them); `registrationLimit` keeps its existing behaviour.
  const retired = RETIRED_PRICING_FIELDS.filter(k => Object.prototype.hasOwnProperty.call(body, k))
  if (retired.length) {
    return NextResponse.json({
      error: `These event pricing fields are retired here — set event pricing in the event's commercial terms instead: ${retired.join(', ')}`,
      code:  'PRICING_LAYER_RETIRED',
    }, { status: 410 })
  }

  const { override, typeErrors } = parseAdminOverride(body)
  if (typeErrors.length) return NextResponse.json({ error: 'Invalid override', details: typeErrors }, { status: 400 })
  if (Object.keys(override).length === 0) {
    return NextResponse.json({ error: 'No overridable fields supplied' }, { status: 400 })
  }
  const check = validateAdminEventOverride(override)
  if (!check.ok) return NextResponse.json({ error: 'Invalid override', details: check.errors }, { status: 400 })
  // RD-PHASE4-S4 · D3 — a reason (3–500 characters).
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)

  // RD-PHASE4-S4 · D6 — read, merge, write and audit in ONE transaction (the change and its
  // audit row commit together; a concurrent edit can no longer be merged over a stale read).
  const ref = adminDb.collection('events').doc(slug)
  const done = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    // Merge onto the existing override; stamp provenance.
    const existing = (snap.data()?.adminOverride as AdminEventOverride | undefined) ?? {}
    const next: AdminEventOverride = {
      ...existing,
      ...override,
      updatedAt: new Date().toISOString(),
      updatedBy: adminUid,
    }
    tx.update(ref, { adminOverride: next })
    const fields = Object.keys(override)
    const ex = existing as Record<string, unknown>, ov = override as Record<string, unknown>
    stageAdminAudit(tx, {
      adminUid, actorRole: 'super_admin', action: 'pricing_override.set', entityType: 'event', entityId: slug,
      reason: r.reason,
      changedFields: fields,
      before: Object.fromEntries(fields.map(k => [k, ex[k] ?? null])),
      after:  Object.fromEntries(fields.map(k => [k, ov[k] ?? null])),
      metadata: { scope: 'admin', fields },
      correlation: { eventId: slug },
    })
    return { data: snap.data() ?? {}, next }
  })
  if (!done) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const configuration = await resolveEffectivePlatformConfiguration(eventViewOf({ ...done.data, adminOverride: done.next }))
  return NextResponse.json({ slug, configuration })
}

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // RD-PHASE4-S2 — an event PRICING override (platform fee, GST, gateway %, convenience fee, limit) is
  // Super Admin only (ADMIN_UIDS), decided from the verified token. Authorization only — the Stage 3
  // event-pricing workflow is not implemented here. GET (read) keeps admin access.
  if (!(await resolveAdminUid(req.headers.get('authorization')))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Only a Super Admin can change event pricing.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })

  const { slug } = await params
  // RD-PHASE4-S4 · D3 — a reason (3–500 characters), in the JSON body or `?reason=`.
  let body: Record<string, unknown> = {}
  try { body = await req.json() as Record<string, unknown> } catch { body = {} }
  const r = parseFinancialReason(body.reason, req.nextUrl.searchParams.get('reason'))
  if (!r.ok) return reasonErrorResponse(r)

  const ref = adminDb.collection('events').doc(slug)
  const data = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const existing = (snap.data()?.adminOverride as AdminEventOverride | undefined) ?? null
    tx.update(ref, { adminOverride: FieldValue.delete() })
    stageAdminAudit(tx, {
      adminUid, actorRole: 'super_admin', action: 'pricing_override.cleared', entityType: 'event', entityId: slug,
      reason: r.reason,
      changedFields: ['adminOverride'],
      before: { adminOverride: existing },
      after:  { adminOverride: null },
      metadata: { scope: 'admin' },
      correlation: { eventId: slug },
    })
    return snap.data() ?? {}
  })
  if (!data) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const configuration = await resolveEffectivePlatformConfiguration(eventViewOf({ ...data, adminOverride: undefined }))
  return NextResponse.json({ slug, configuration })
}
