// RD-PRODUCT-01E — organizer Organization Tax Profile.
//   GET   → the organizer's saved tax profile.
//   PATCH → validate + save the profile.
//
// Workspace-gated. The profile feeds the pricing-engine tax resolver
// (lib/platform/pricing/taxProfile.ts); no tax math lives here.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  loadOrganizationTaxProfile, saveOrganizationTaxProfile, validateOrganizationTaxProfile,
  type OrganizationTaxProfile,
} from '@/lib/platform/pricing/taxProfile'

const BOOL_KEYS = new Set<keyof OrganizationTaxProfile>(['enabled', 'taxEnabled', 'reverseCharge'])
const NUM_KEYS  = new Set<keyof OrganizationTaxProfile>(['defaultGstPercent'])
const STR_KEYS  = new Set<keyof OrganizationTaxProfile>([
  'legalBusinessName', 'gstin', 'pan', 'addressLine', 'state', 'country', 'currency',
  'timezone', 'defaultTaxMode', 'taxLabel', 'hsnSac', 'invoicePrefix', 'invoiceNumberFormat',
])

function parse(body: Record<string, unknown>): OrganizationTaxProfile {
  const out: OrganizationTaxProfile = {}
  for (const key of BOOL_KEYS) { if (key in body && typeof body[key] === 'boolean') (out[key] as boolean) = body[key] as boolean }
  for (const key of NUM_KEYS)  { if (key in body && typeof body[key] === 'number')  (out[key] as number)  = body[key] as number }
  for (const key of STR_KEYS)  {
    if (key in body && typeof body[key] === 'string') {
      const v = (body[key] as string).trim()
      // GSTIN/PAN are stored upper-case (validators expect canonical form).
      ;(out[key] as string) = (key === 'gstin' || key === 'pan') ? v.toUpperCase() : v
    }
  }
  return out
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const profile = await loadOrganizationTaxProfile(authz.workspaceUid)
  return NextResponse.json({ profile: profile ?? {} })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const patch = parse(body)
  const errs = validateOrganizationTaxProfile(patch)
  if (errs.length) return NextResponse.json({ error: 'Invalid tax profile', details: errs }, { status: 400 })
  await saveOrganizationTaxProfile(authz.workspaceUid, patch)
  return NextResponse.json({ ok: true, profile: patch })
}
