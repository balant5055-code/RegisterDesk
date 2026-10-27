// RD-FEATURE-REQ-01 — one feature request for a Super Admin.
//   GET   → the request, its full history (with actors), internal notes, linked duplicates and
//           suggested duplicates (suggestions only — nothing is linked automatically)
//   PATCH → status / priority / organizer response / release note / duplicate link / rollout PLAN.
//           Whitelisted fields only (validateAdminPatch); history, audit and the organizer
//           notification commit in the same transaction. A rollout plan enables nothing.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { validateAdminPatch } from '@/lib/featureRequests/types'
import { adminGetRequest, adminUpdateRequest, FeatureRequestError, FLAG_KEYS } from '@/lib/featureRequests/service'

type Ctx = { params: Promise<{ id: string }> }
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const request = await adminGetRequest(id)
  if (!request) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ request, flagKeys: FLAG_KEYS }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const v = validateAdminPatch(body, FLAG_KEYS)
  if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0] ?? 'Invalid change.', fields: v.errors, code: 'INVALID' }, { status: 400 })
  try {
    const result = await adminUpdateRequest({ id, adminUid: gate.uid, patch: v.value })
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof FeatureRequestError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[feature-requests] admin update failed', id, err)
    return NextResponse.json({ error: 'Could not save the change.' }, { status: 500 })
  }
}
