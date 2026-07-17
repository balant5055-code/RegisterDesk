// GET /api/organizer/brand-kit — the organizer's brand kit (defaults if unset)
// PUT /api/organizer/brand-kit — upsert the brand kit
//
// One brand kit per organizer. Reuses workspace auth + the existing organizer-asset
// upload flow (the client uploads logo/seal/signature to organizer-assets/{uid}/…
// and PUTs the resulting URLs here). No new storage system.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace, authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getBrandKit, saveBrandKit } from '@/lib/brandkit/service'
import { validateBrandKit } from '@/lib/brandkit/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const kit = await getBrandKit(authz.workspaceUid)
  return NextResponse.json({ brandKit: kit })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = validateBrandKit(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const kit = await saveBrandKit(authz.workspaceUid, parsed.value, authz.callerUid)
  return NextResponse.json({ success: true, brandKit: kit })
}
