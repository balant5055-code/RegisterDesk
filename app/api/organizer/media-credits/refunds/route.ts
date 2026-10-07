// /api/organizer/media-credits/refunds
//
//   POST — RETIRED (410). Media Credits are retired (RD-PHOTO-01 / RD-LEGACY-01); no new refund
//          request (and so no new credit hold) can be created. Unused paid PHOTO capacity is
//          refunded through the event Wallet's service refund requests instead.
//   GET  — this workspace's historical refund requests (read-only).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { refundService } from '@/features/media-credits/services/refundService'
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

  const page = await refundService.listRefundRequests(
    authz.workspaceUid, Number.isFinite(limit) ? limit : 25, cursor,
  )
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
