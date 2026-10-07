// /api/organizer/media-credits/purchases
//
//   POST — RETIRED (410). Media Credits are no longer sold (RD-PHOTO-01 / RD-LEGACY-01): photo
//          capacity is bought per event on License & Services. No purchase intent and no
//          Razorpay order can be created here any more.
//   GET  — the organizer's historical purchase records (read-only).
//
// Authorization stays `wallet` on both verbs (the moderation seam still applies).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { purchaseService } from '@/features/media-credits/services/purchaseService'
import { mediaCreditsRetiredResponse } from '@/features/media-credits/retired'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  return mediaCreditsRetiredResponse()
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const url    = new URL(req.url)
  const limit  = Number(url.searchParams.get('limit') ?? '25')
  const cursor = url.searchParams.get('cursor')

  const page = await purchaseService.listPurchases(
    authz.workspaceUid, Number.isFinite(limit) ? limit : 25, cursor,
  )
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
