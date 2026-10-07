// /api/admin/media-credits/grants
//
//   POST — RETIRED (410). Media Credits are retired (RD-PHOTO-01 / RD-LEGACY-01): no credit can be
//          granted. This was the only endpoint that created credits without a payment.
//   GET  — historical grant records, platform-wide or for one organizer (Super Admin only).

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { grantService } from '@/features/media-credits/services/grantService'
import { mediaCreditsRetiredResponse } from '@/features/media-credits/retired'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Super Admin only, as before — a non-admin learns nothing about the retirement.
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response
  return mediaCreditsRetiredResponse()
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const url    = req.nextUrl
  const limit  = Number(url.searchParams.get('limit') ?? '25')
  const cursor = url.searchParams.get('cursor')
  const uid    = url.searchParams.get('organizerUid')

  const [page, totals] = await Promise.all([
    grantService.listGrants(uid, Number.isFinite(limit) ? limit : 25, cursor),
    grantService.grantTotals(),
  ])

  return NextResponse.json(
    { ...page, totals },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
